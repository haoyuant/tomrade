import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { query, type Query, type SDKMessage, type SDKUserMessage, type Options, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "cordis";
import type { TurnIO, TurnInput, TurnResult, TurnMetrics } from "@tomradex/agent";
import { claudeMediaInput, describeFailure, looksRateLimited, resetTime, stepHint, stepSummary } from "@tomradex/agent";
import { ClaudeCodeOptions, retryReason } from "./legacy.js";
import { localCli, spawnCli, type CliLaunch } from "./locate.js";
import { bindTurn, MessageQueue, runtimeDirectory, type Runtime } from "./runtime.js";
import { sessionSystem, turnPrompt } from "./system.js";
import { LiveUsage, cacheKnown, promptTokens, turnTokens, type Tokens } from "./usage.js";

function matchesTool(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * The SDK starts a native path itself; a Windows `.cmd` shim needs our launch
 * (node + script), which the SDK only takes as a custom spawn.
 */
export function sdkLaunch(launch: CliLaunch, onStderr?: (data: string) => void): Pick<Options, "pathToClaudeCodeExecutable" | "spawnClaudeCodeProcess"> {
  if (launch.argv([]).command === launch.file) return { pathToClaudeCodeExecutable: launch.file };
  return {
    pathToClaudeCodeExecutable: launch.file,
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
      const child = command === launch.file
        ? spawnCli(launch, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      // Unread, a full stderr pipe would stall the CLI.
      if (onStderr) child.stderr?.on("data", (chunk) => onStderr(String(chunk)));
      else child.stderr?.resume();
      return child as unknown as SpawnedProcess;
    }
  };
}

/** A steer goes into the CLI's queue as written, plus a word for when it lands after the reply was finished. */
const steerPrompt = (text: string) =>
  `${text}\n\n(Sent while you were working. If your reply is already finished, answer only what this adds or changes; do not repeat it.)`;

/** Which of the client's messages a CLI turn answers, when the CLI stamps it (null when it does not). */
const consumedBy = (message: SDKMessage): string[] | null => {
  const stamped = message as { user_message_uuids?: string[]; user_message_uuid?: string };
  return stamped.user_message_uuids ?? (stamped.user_message_uuid ? [stamped.user_message_uuid] : null);
};

export class ClaudeRuntime implements Runtime {
  token: string;
  cwd: string;
  alive = true;
  busy = false;
  session?: string;
  /** The files index this session was opened with, so a later turn can notice it went stale. */
  indexDigest: string | null = null;
  private queue = new MessageQueue<SDKUserMessage>();
  private query?: Query;
  private onMessage?: (message: SDKMessage) => void;
  private onFailure?: (error: unknown) => void;
  private cost = 0;
  /** Cumulative counters from the last result; the SDK reports running totals, so a turn is the difference. */
  private tokens: Tokens | null = null;
  private activeIO?: TurnIO;
  private stderr = "";
  private keepStderr = (data: string) => { this.stderr = (this.stderr + data).slice(-2000); };

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
    // Claude Code's own tools, from the call until their result comes back.
    const running = new Map<string, { name: string; args: unknown; at: number }>();
    const live = new LiveUsage();
    // Messages sent into this turn, by the uuid they carry into the CLI's queue. One that the
    // turn ends without reading runs as a turn of its own right after: this turn waits for it.
    const steers = new Map<string, string>();
    const unplaced = new Set<string>();
    const consumed = new Set<string>();
    let prompted = false;
    let over = false;
    const place = (uuids: Iterable<string>) => {
      for (const uuid of uuids) if (unplaced.delete(uuid)) io.steered?.(steers.get(uuid)!);
    };
    const waiting = () => [...steers.keys()].filter((uuid) => !consumed.has(uuid));
    io.steerTo?.(async (steer) => {
      if (!prompted || over || cancelled || !this.alive) return false;
      const uuid = randomUUID();
      steers.set(uuid, steer.id); unplaced.add(uuid);
      this.queue.push({ type: "user", message: { role: "user", content: steerPrompt(steer.text) }, parent_tool_use_id: null, session_id: this.session ?? "", uuid, priority: "next" });
      return true;
    });
    // A turn can span the CLI's turns for late steers: their figures add up.
    const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheKnown: false };
    // A subscription limit arrives as a rejected rate-limit event and a reply flagged rate_limit; the result only says it failed.
    let limit: { until: number | null; text: string | null } | null = null;
    const abort = () => {
      cancelled = true;
      // A plain interrupt leaves queued messages to run afterwards; ending the process drops them (the session resumes next turn).
      if (waiting().length) { this.close(); return; }
      // A protocol interrupt is scoped to this turn. Kill only on timeout.
      void this.query?.interrupt().catch(() => this.close());
      interruptTimer ??= setTimeout(() => this.close(), 3000).unref();
    };
    this.onFailure = (error) => finish({ stop: cancelled ? "cancelled" : "error", error: cancelled ? undefined : String(error),
      details: cancelled ? undefined : describeFailure({ error, stderr: this.stderr }), resume: this.session, metrics });
    this.onMessage = (message) => {
      // the first frame of a CLI turn names the messages it answers: a late steer is read there
      if (message.type !== "result") { const answers = consumedBy(message); if (answers) place(answers.filter((uuid) => steers.has(uuid))); }
      if (message.type === "system" && message.subtype === "init") {
        this.session = message.session_id;
        metrics.providerModel = message.model;
        if (input.purpose !== "backlog" && message.permissionMode) io.permissionMode?.(message.permissionMode);
          metrics.readyMs ??= performance.now() - start;
      } else if (message.type === "system" && message.subtype === "compact_boundary") {
        metrics.compactions!++;
      } else if (message.type === "system" && message.subtype === "api_retry") {
        io.progress(live.retry());
        io.retry?.({ attempt: message.attempt, max: message.max_retries, reason: retryReason(message), delayMs: message.retry_delay_ms });
      } else if (message.type === "stream_event") {
        // Subagent requests count too: the final figures include them.
        const counted = live.observe(message.event as Parameters<LiveUsage["observe"]>[0], message.parent_tool_use_id);
        if (counted) io.progress(counted);
        const event = message.event;
        if (!message.parent_tool_use_id && event.type === "content_block_delta" && event.delta.type === "text_delta") {
          metrics.firstTokenMs ??= performance.now() - start;
          io.delta(event.delta.text);
        }
      } else if (message.type === "rate_limit_event") {
        const info = message.rate_limit_info;
        if (info.status === "rejected") limit = { until: info.resetsAt ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : limit?.until ?? null, text: limit?.text ?? null };
      } else if (message.type === "assistant" && !message.parent_tool_use_id) {
        if (message.error === "rate_limit") {
          const said = message.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
          limit = { until: limit?.until ?? null, text: said || limit?.text || null };
        }
        io.retry?.(null);
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) io.emit({ type: "text", text: block.text.trim() });
          if (block.type === "tool_use" && !seenTools.has(block.id)) {
            seenTools.add(block.id); metrics.toolCalls!++;
            // Tomrade's own tools are traced by the gateway they run through.
            if (!block.name.startsWith("mcp__")) {
              running.set(block.id, { name: block.name, args: block.input, at: Date.now() });
              const hint = stepHint(block.input, 60);
              io.activity?.(hint ? `${block.name} · ${hint}` : block.name);
            }
          }
        }
      } else if (message.type === "user" && !message.parent_tool_use_id && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          const call = block.type === "tool_result" ? running.get(block.tool_use_id) : undefined;
          if (!call || block.type !== "tool_result") continue;
          running.delete(block.tool_use_id);
          const ok = !block.is_error;
          io.emit({ type: "trace", tool: call.name, args: call.args, ok, summary: stepSummary(call.args, block.content, ok), ms: Date.now() - call.at });
        }
        if (!running.size) io.activity?.(null);
        // what was queued while the tools ran rides into the next request
        if (message.message.content.some((block) => block.type === "tool_result")) place([...unplaced]);
      } else if (message.type === "result") {
        sum.cost += Math.max(0, message.total_cost_usd - this.cost);
        this.cost = message.total_cost_usd;
        this.session = message.session_id;
        const { turn: part, cumulative } = turnTokens(message, this.tokens);
        this.tokens = cumulative ?? this.tokens;
        sum.input += part.input; sum.output += part.output; sum.cacheRead += part.cacheRead; sum.cacheWrite += part.cacheWrite;
        sum.cacheKnown ||= cacheKnown(message);
        const turn = { input: sum.input, output: sum.output, cacheRead: sum.cacheRead, cacheWrite: sum.cacheWrite };
        const costUsd = sum.cost;
        metrics.uncachedInputTokens = turn.input;
        if (sum.cacheKnown) {
          metrics.cacheReadTokens = turn.cacheRead;
          metrics.cacheWriteTokens = turn.cacheWrite;
        }
        const usage = { inputTokens: promptTokens(turn), outputTokens: turn.output };
        io.progress(usage);
        const answered = consumedBy(message);
        // an older CLI does not say what it read: nothing is waited for
        for (const uuid of answered ?? steers.keys()) consumed.add(uuid);
        place([...unplaced].filter((uuid) => consumed.has(uuid)));
        if (!message.is_error && !cancelled && waiting().length) return;
        over = true;
        const budget = message.subtype === "error_max_turns" || message.subtype === "error_max_budget_usd";
        const error = message.subtype === "success" ? (message.is_error ? message.result || undefined : undefined) : message.errors.join("\n");
        const limited = message.is_error && !cancelled ? (limit ?? (looksRateLimited(error) ? { until: null, text: null } : null)) : null;
        finish({ stop: cancelled ? "cancelled" : budget ? "budget" : message.is_error ? "error" : binding.asked() ? "asked" : "end",
          error: limited?.text ?? error, usage, costUsd, resume: this.session, metrics,
          ...(message.is_error && !cancelled ? { details: describeFailure({ result: message, stderr: this.stderr }) } : {}),
          ...(limited ? { limit: { until: limited.until ?? resetTime(limited.text ?? error) } } : {}) });
      }
    };
    io.signal.addEventListener("abort", abort, { once: true });
    try {
      if (cancelled) return { stop: "cancelled", resume: this.session, metrics };
      if (!this.query) {
        const code = input.purpose !== "backlog";
        const launch = await localCli("claude").launch(options.command);
        const sdkOptions: Options = {
          ...sdkLaunch(launch, this.keepStderr), stderr: this.keepStderr, cwd: this.cwd,
          env: launch.env({ ...process.env, ...input.env }),
          model: options.model, effort: options.effort as Options["effort"],
          resume: io.resume, includePartialMessages: true,
          systemPrompt: { type: "preset", preset: "claude_code", append: sessionSystem(input, "Claude Code") },
          settingSources: ["user", "project", "local"],
          mcpServers: { tomrade: {
            type: "http", url: this.ctx.mcp.url!, headers: { "X-Tomrade-Run": this.token },
            // Pin the registry at session creation. Without this, newer SDK
            // versions may defer remote tools behind tool-search and report a
            // perfectly healthy MCP tool as "not enabled" in a turn.
            tools: this.ctx.tools.served().map((tool) => ({ name: tool.name, permission_policy: "always_allow" as const }))
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
          allowedTools: ["mcp__tomrade__*", ...this.ctx.tools.served().map((tool) => `mcp__tomrade__${tool.name}`)],
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
        this.indexDigest = input.filesIndex?.digest ?? null;
        void this.consume();
      }
      metrics.readyMs ??= warm ? 0 : undefined;
      const stale = !!input.filesIndex && !!this.indexDigest && input.filesIndex.digest !== this.indexDigest;
      const prompt = turnPrompt(input, io, { staleIndex: stale });
      const content = input.input.kind === "text" && input.input.attachments?.length
        ? claudeMediaInput(input, io, prompt) as SDKUserMessage["message"]["content"]
        : prompt;
      // with a uuid of its own, so the CLI says on each result which messages that turn answered
      this.queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: this.session ?? "", uuid: randomUUID() });
      prompted = true;
      const result = await done;
      // The SDK's maxBudgetUsd is query-wide. Reopen budgeted sessions on the
      // next turn to preserve Tomrade's existing per-run budget exactly.
      if (options.maxBudgetUsd || result.stop === "error" || result.stop === "budget") this.close();
      return result;
    } catch (error) {
      this.close();
      return { stop: cancelled ? "cancelled" : "error", error: String(error), details: cancelled ? undefined : describeFailure({ error, stderr: this.stderr }), resume: this.session, metrics };
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
