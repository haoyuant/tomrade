import fs from "node:fs";
import path from "node:path";
import { query, type Query, type SDKMessage, type SDKUserMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "cordis";
import type { TurnIO, TurnInput, TurnResult, TurnMetrics } from "@tomrade/agent";
import { claudeMediaInput } from "@tomrade/agent";
import { ClaudeCodeOptions } from "./legacy.js";
import { bindTurn, MessageQueue, runtimeDirectory, type Runtime } from "./runtime.js";
import { staticSystem, turnPrompt } from "./system.js";
import { LiveUsage, cacheKnown, promptTokens, turnTokens, type Tokens } from "./usage.js";

function matchesTool(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

export function executable(command: string): string {
  if (command.includes(path.sep)) return path.resolve(command);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.join(dir, command);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  throw new Error(`Claude Code executable not found: ${command}`);
}

export class ClaudeRuntime implements Runtime {
  token: string;
  cwd: string;
  alive = true;
  busy = false;
  session?: string;
  private queue = new MessageQueue<SDKUserMessage>();
  private query?: Query;
  private onMessage?: (message: SDKMessage) => void;
  private onFailure?: (error: unknown) => void;
  private cost = 0;
  /** Cumulative counters from the last result; the SDK reports running totals, so a turn is the difference. */
  private tokens: Tokens | null = null;
  private activeIO?: TurnIO;

  constructor(private ctx: Context, input: TurnInput) {
    const directory = runtimeDirectory(input);
    this.token = directory.token; this.cwd = directory.cwd;
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    this.queue.close();
    this.query?.close();
    this.onFailure?.(new Error("Claude runtime closed"));
  }

  async turn(input: TurnInput, io: TurnIO, warm: boolean): Promise<TurnResult> {
    this.activeIO = io;
    const options = ClaudeCodeOptions.parse(input.options ?? {});
    if (input.permissionMode) options.codePermissionMode = input.permissionMode === "local" ? undefined : ClaudeCodeOptions.shape.codePermissionMode.parse(input.permissionMode);
    const start = performance.now();
    const metrics: TurnMetrics = { transport: "sdk", runtime: warm ? "warm" : "cold", compactions: 0, toolCalls: 0 };
    const binding = bindTurn(this.ctx, this.token, io, input);
    let cancelled = io.signal.aborted;
    let interruptTimer: NodeJS.Timeout | undefined;
    let finish!: (result: TurnResult) => void;
    const done = new Promise<TurnResult>((resolve) => { finish = resolve; });
    const seenTools = new Set<string>();
    const live = new LiveUsage();
    const abort = () => {
      cancelled = true;
      // A protocol interrupt is scoped to this turn. Kill only on timeout.
      void this.query?.interrupt().catch(() => this.close());
      interruptTimer ??= setTimeout(() => this.close(), 3000).unref();
    };
    this.onFailure = (error) => finish({ stop: cancelled ? "cancelled" : "error", error: cancelled ? undefined : String(error), resume: this.session, metrics });
    this.onMessage = (message) => {
      if (message.type === "system" && message.subtype === "init") {
        this.session = message.session_id;
        metrics.providerModel = message.model;
        if (input.purpose !== "backlog" && message.permissionMode) io.permissionMode?.(message.permissionMode);
          metrics.readyMs ??= performance.now() - start;
      } else if (message.type === "system" && message.subtype === "compact_boundary") {
        metrics.compactions!++;
      } else if (message.type === "stream_event") {
        // Subagent requests count too: the final figures include them.
        const running = live.observe(message.event as Parameters<LiveUsage["observe"]>[0]);
        if (running) io.progress(running);
        const event = message.event;
        if (!message.parent_tool_use_id && event.type === "content_block_delta" && event.delta.type === "text_delta") {
          metrics.firstTokenMs ??= performance.now() - start;
          io.delta(event.delta.text);
        }
      } else if (message.type === "assistant" && !message.parent_tool_use_id) {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) io.emit({ type: "text", text: block.text.trim() });
          if (block.type === "tool_use" && !seenTools.has(block.id)) {
            seenTools.add(block.id); metrics.toolCalls!++;
            if (!block.name.startsWith("mcp__")) io.emit({ type: "trace", tool: block.name, args: block.input, ok: true, summary: "run by Claude Code itself", ms: 0 });
          }
        }
      } else if (message.type === "result") {
        const costUsd = Math.max(0, message.total_cost_usd - this.cost);
        this.cost = message.total_cost_usd;
        this.session = message.session_id;
        const { turn, cumulative } = turnTokens(message, this.tokens);
        this.tokens = cumulative ?? this.tokens;
        metrics.uncachedInputTokens = turn.input;
        if (cacheKnown(message)) {
          metrics.cacheReadTokens = turn.cacheRead;
          metrics.cacheWriteTokens = turn.cacheWrite;
        }
        const usage = { inputTokens: promptTokens(turn), outputTokens: turn.output };
        io.progress(usage);
        const budget = message.subtype === "error_max_turns" || message.subtype === "error_max_budget_usd";
        finish({ stop: cancelled ? "cancelled" : budget ? "budget" : message.is_error ? "error" : binding.asked() ? "asked" : "end",
          error: message.subtype === "success" ? undefined : message.errors.join("\n"), usage, costUsd, resume: this.session, metrics });
      }
    };
    io.signal.addEventListener("abort", abort, { once: true });
    try {
      if (cancelled) return { stop: "cancelled", resume: this.session, metrics };
      if (!this.query) {
        const code = input.purpose !== "backlog";
        const sdkOptions: Options = {
          pathToClaudeCodeExecutable: executable(options.command), cwd: this.cwd,
          env: { ...process.env, ...input.env },
          model: options.model, effort: options.effort as Options["effort"],
          resume: io.resume, includePartialMessages: true,
          systemPrompt: { type: "preset", preset: "claude_code", append: staticSystem("Claude Code") },
          settingSources: ["user", "project", "local"],
          mcpServers: { tomrade: {
            type: "http", url: this.ctx.mcp.url!, headers: { "X-Tomrade-Run": this.token },
            // Pin the registry at session creation. Without this, newer SDK
            // versions may defer remote tools behind tool-search and report a
            // perfectly healthy MCP tool as "not enabled" in a turn.
            tools: this.ctx.tools.list().map((tool) => ({ name: tool.name, permission_policy: "always_allow" as const }))
          } },
          strictMcpConfig: !code,
          // Explicitly expose the MCP registry and the configured native
          // tools. `allowedTools` controls approval only; `tools` controls
          // whether a tool is included in the model's tool set.
          tools: code ? { type: "preset", preset: "claude_code" } : ["mcp__tomrade__*", ...options.allowTools],
          // MCP tools must be listed for Claude Code to expose the HTTP server's
          // dynamic tool set. They are safe to auto-approve here because every
          // request still carries this runtime's run-scoped token and the MCP
          // server enforces the write policy. Native tools remain hook-gated.
          // Some SDK/CLI versions do not expand an MCP wildcard while the
          // server is discovering tools. Include the registry's concrete names
          // as well; retain the wildcard for tools registered after startup.
          allowedTools: ["mcp__tomrade__*", ...this.ctx.tools.list().map((tool) => `mcp__tomrade__${tool.name}`)],
          hooks: {
            PreToolUse: [{ hooks: [async (hookInput) => {
              const tool = (hookInput as { tool_name?: string }).tool_name ?? "";
              // Coding tools follow codePermissionMode and the user's rules.
              // Do not apply the backlog allowlist or auto-approve them here.
              if (code && !tool.startsWith("mcp__tomrade__")) return { continue: true };
              const allowed = tool.startsWith("mcp__tomrade__") || options.allowTools.some((pattern) => matchesTool(tool, pattern));
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: allowed ? "allow" : "deny",
                  permissionDecisionReason: allowed ? "Tomrade policy allows this tool" : "Tool is not enabled for this Tomrade turn"
                }
              };
            }] }]
          },
          canUseTool: code ? async (tool, args, request) => {
            const answer = await this.activeIO?.requestPermission?.(
              `${request.title ?? tool}\n${request.description ?? request.decisionReason ?? "Permission requested by Claude Code"}\n${JSON.stringify(args, null, 2)}`,
              ["Allow once", "Deny"], request.signal);
            return answer === "Allow once" && !request.signal.aborted && !this.activeIO?.signal.aborted ? { behavior: "allow", updatedInput: args } : { behavior: "deny", message: "Permission was denied or cancelled by the user" };
          } : undefined,
          permissionMode: code ? options.codePermissionMode : "dontAsk",
          allowDangerouslySkipPermissions: code && options.codePermissionMode === "bypassPermissions",
          maxTurns: code ? options.codeMaxTurns : options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd
        };
        this.query = query({ prompt: this.queue, options: sdkOptions });
        void this.consume();
      }
      metrics.readyMs ??= warm ? 0 : undefined;
      const content = input.input.kind === "text" && input.input.attachments?.length
        ? claudeMediaInput(input, io, turnPrompt(input, io)) as SDKUserMessage["message"]["content"]
        : turnPrompt(input, io);
      this.queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: this.session ?? "" });
      const result = await done;
      // The SDK's maxBudgetUsd is query-wide. Reopen budgeted sessions on the
      // next turn to preserve Tomrade's existing per-run budget exactly.
      if (options.maxBudgetUsd || result.stop === "error" || result.stop === "budget") this.close();
      return result;
    } catch (error) {
      this.close();
      return { stop: cancelled ? "cancelled" : "error", error: String(error), resume: this.session, metrics };
    } finally {
      io.signal.removeEventListener("abort", abort);
      clearTimeout(interruptTimer);
      this.onMessage = undefined; this.onFailure = undefined; this.activeIO = undefined;
      await binding.release();
    }
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query!) this.onMessage?.(message);
      this.onFailure?.(new Error("Claude input stream ended before the runtime was closed"));
    } catch (error) { this.onFailure?.(error); }
    finally { this.alive = false; this.queue.close(); }
  }
}
