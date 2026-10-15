import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import { isSuspended, type Engine, type TurnIO, type TurnInput, type TurnResult } from "@tomradex/agent";
import type {} from "@tomradex/mcp";
import { localAvailability } from "./availability.js";
import { claudeSignedIn, lostConversation, runJsonl } from "./cli.js";
import { localCli } from "./locate.js";
import { buildSystem, promptOf } from "./system.js";
import { claudeMediaInput, looksRateLimited, resetTime, stepHint, stepSummary, withRecap } from "@tomradex/agent";
import { LiveUsage, cacheKnown, promptTokens, turnTokens, type ApiUsage, type ResultCounters } from "./usage.js";

export const ClaudeCodeOptions = z.object({
  transport: z.enum(["sdk", "cli"]).default("sdk"),
  command: z.string().default("claude"),
  /** Passed as --model; empty = whatever the user's Claude Code is configured with. */
  model: z.string().optional(),
  /** Passed as --effort; the CLI validates the level, so new levels need no release here. */
  effort: z.string().optional(),
  maxTurns: z.number().int().min(1).max(200).default(24),
  maxBudgetUsd: z.number().positive().optional(),
  /** Claude Code's own tools to allow besides the tomrade MCP tools (e.g. "WebSearch", "Read", "Bash"). */
  allowTools: z.array(z.string()).default([]),
  /** Optional coding turn ceiling; omitted uses the local agent's unlimited default. */
  codeMaxTurns: z.number().int().min(1).optional(),
  /** …and its own permission mode, in a worktree of its own. The user's settings.json allow-rules still apply. */
  codePermissionMode: z.enum(["acceptEdits", "bypassPermissions", "dontAsk", "default", "auto", "plan"]).optional()
});
export type ClaudeCodeOptions = z.infer<typeof ClaudeCodeOptions>;

/** Why Claude Code is sending a request again (its `api_retry` message), in a few words. */
export function retryReason(message: { error_status: number | null; error: string; no_response?: { waited_ms: number } }): string {
  if (message.no_response) return `no response in ${Math.round(message.no_response.waited_ms / 1000)}s`;
  if (message.error_status === null) return "connection dropped";
  return `${message.error.replace(/_/g, " ")} (HTTP ${message.error_status})`;
}

interface StreamLine extends ResultCounters {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  error?: string;
  no_response?: { waited_ms: number };
  message?: { content?: ({ type: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown } | Record<string, unknown>)[]; usage?: ApiUsage };
  event?: { type?: string; delta?: { type?: string; text?: string }; message?: { usage?: ApiUsage }; usage?: ApiUsage };
  result?: unknown;
  is_error?: boolean;
  errors?: string[];
  total_cost_usd?: number;
  rate_limit_info?: { status?: string; resetsAt?: number };
}

export function createClaudeCodeCliEngine(ctx: Context): Engine {
  const cli = localCli("claude");
  return {
    id: "claude-code",
    title: "Claude Code",
    author: "ai:claude-code",
    capabilities: ["backlog", "code", "general"],
    options: ClaudeCodeOptions,
    picks: () => [
      // aliases the CLI resolves itself, so they don't go stale with releases
      { key: "model", title: "Model", choices: [{ value: "sonnet" }, { value: "opus" }, { value: "haiku" }], freeText: true },
      { key: "effort", title: "Effort", choices: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }] }
    ],
    available: localAvailability(ctx, {
      engineId: "claude-code",
      title: "Claude Code",
      cli,
      install: "install Claude Code and sign in",
      signIn: { args: ["auth", "status"], says: claudeSignedIn, reason: "Claude Code is not signed in — run `claude` in a terminal and log in" },
      configDir: () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
    }),
    checkCli: (file) => cli.check(file),
    setup: {
      // The official installer first; npm still works and is what many already have.
      install: [process.platform === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash", "npm install -g @anthropic-ai/claude-code"],
      signIn: "claude",
      signInRuns: true,
      docs: "https://docs.anthropic.com/en/docs/claude-code/setup",
      suggested: true
    },
    async turn(input: TurnInput, io: TurnIO): Promise<TurnResult> {
      const options = ClaudeCodeOptions.parse(input.options ?? {});
      if (input.permissionMode) options.codePermissionMode = input.permissionMode === "local" ? undefined : ClaudeCodeOptions.shape.codePermissionMode.parse(input.permissionMode);
      const url = ctx.mcp.url;
      if (!url) return { stop: "error", error: "the MCP server is not running" };

      const token = randomUUID();
      let asked = false;
      const unbind = ctx.mcp.bindRun(token, {
        author: "ai:claude-code",
        projectId: input.projectId,
        execute: async (name, args) => {
          const result = await io.tools.execute(name, args);
          if (isSuspended(result)) {
            asked = true;
            return { question_posted: result.question.text, next: result.note };
          }
          return result;
        }
      });

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cc-"));
      const mcpFile = path.join(tmp, "mcp.json");
      const sysFile = path.join(tmp, "system.md");
      fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { tomrade: { type: "http", url, headers: { "X-Tomrade-Run": token } } } }));
      fs.writeFileSync(sysFile, buildSystem(input, io, "Claude Code"));

      // A headless turn is a guest in the app: only our MCP server. Loading the
      // user's other MCP servers here can hold every prompt on their startup
      // timeout; terminal sessions remain the place for the user's full setup.
      const code = input.purpose !== "backlog";
      const withMedia = input.input.kind === "text" && !!input.input.attachments?.length;
      // a session started without resume carries the thread's conversation so far
      const prompt = io.resume ? promptOf(input) : withRecap(io.recap?.(), promptOf(input));
      const args = [
        "-p",
        ...(withMedia ? ["--input-format", "stream-json"] : [prompt]),
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--mcp-config",
        mcpFile,
        ...(!code ? ["--strict-mcp-config"] : []),
        ...(options.codePermissionMode ? ["--permission-mode", options.codePermissionMode] : []),
        "--allowedTools",
        "mcp__tomrade__*",
        ...options.allowTools,
        "--append-system-prompt-file",
        sysFile,
        ...((code ? options.codeMaxTurns : options.maxTurns) !== undefined
          ? ["--max-turns", String(code ? options.codeMaxTurns : options.maxTurns)] : [])
      ];
      if (options.maxBudgetUsd) args.push("--max-budget-usd", String(options.maxBudgetUsd));
      if (options.model) args.push("--model", options.model);
      if (options.effort) args.push("--effort", options.effort);
      if (io.resume) args.push("--resume", io.resume);

      const usage = { inputTokens: 0, outputTokens: 0 };
      const live = new LiveUsage();
      const running = new Map<string, { name: string; args: unknown; at: number }>();
      const metrics: import("@tomradex/agent").TurnMetrics = { transport: "cli", runtime: "cold" };
      const started = performance.now();
      let costUsd: number | undefined;
      let session: string | undefined;
      let failure: string | null = null;
      let limitUntil: number | null = null;

      try {
        const run = runJsonl(await cli.launch(options.command), args, {
          stdin: withMedia ? JSON.stringify({ type: "user", message: { role: "user", content: claudeMediaInput(input, io, prompt) } }) + "\n" : undefined,
          cwd: input.cwd ?? tmp,
          env: { ...process.env, ...input.env },
          signal: io.signal,
          onLine: (raw) => {
            const line = raw as StreamLine;
            if (line.type === "system" && line.subtype === "init") {
              session = line.session_id;
              metrics.readyMs = performance.now() - started;
            } else if (line.type === "system" && line.subtype === "api_retry") {
              io.progress(live.retry());
              io.retry?.({ attempt: line.attempt ?? 1, max: line.max_retries, reason: retryReason({ error_status: line.error_status ?? null, error: line.error ?? "unknown", no_response: line.no_response }), delayMs: line.retry_delay_ms });
            } else if (line.type === "stream_event") {
              const counted = live.observe(line.event, line.parent_tool_use_id ?? null);
              if (counted) io.progress(counted);
              if (line.event?.type === "content_block_delta" && line.event.delta?.type === "text_delta" && line.event.delta.text) {
                metrics.firstTokenMs ??= performance.now() - started;
                io.delta(line.event.delta.text);
              }
            } else if (line.type === "assistant") {
              io.retry?.(null);
              // A streamed reply arrives as one assistant line per content block, each with a partial usage; the totals come with the result.
              for (const block of line.message?.content ?? []) {
                if (block.type === "text" && typeof block.text === "string" && block.text.trim()) io.emit({ type: "text", text: block.text.trim() });
                else if (block.type === "tool_use" && typeof block.name === "string" && typeof block.id === "string" && !block.name.startsWith("mcp__")) {
                  running.set(block.id, { name: block.name, args: block.input ?? {}, at: Date.now() });
                  const hint = stepHint(block.input, 60);
                  io.activity?.(hint ? `${block.name} · ${hint}` : block.name);
                }
              }
            } else if (line.type === "user" && !line.parent_tool_use_id) {
              for (const block of line.message?.content ?? []) {
                const call = block.type === "tool_result" && typeof block.tool_use_id === "string" ? running.get(block.tool_use_id) : undefined;
                if (!call) continue;
                running.delete(block.tool_use_id as string);
                const ok = !block.is_error;
                io.emit({ type: "trace", tool: call.name, args: call.args, ok, summary: stepSummary(call.args, block.content, ok), ms: Date.now() - call.at });
              }
              if (!running.size) io.activity?.(null);
            } else if (line.type === "result") {
              session = line.session_id ?? session;
              costUsd = line.total_cost_usd;
              // One process serves one turn, so the result's counters are this turn's.
              const { turn } = turnTokens(line, null);
              metrics.uncachedInputTokens = turn.input;
              if (cacheKnown(line)) {
                metrics.cacheReadTokens = turn.cacheRead;
                metrics.cacheWriteTokens = turn.cacheWrite;
              }
              usage.inputTokens = promptTokens(turn);
              usage.outputTokens = turn.output;
              if (line.is_error) failure = typeof line.result === "string" ? line.result : line.errors?.length ? line.errors.join("\n") : (line.subtype ?? "Claude Code reported an error");
            } else if (line.type === "rate_limit_event" && line.rate_limit_info?.status === "rejected" && typeof line.rate_limit_info.resetsAt === "number") {
              const at = line.rate_limit_info.resetsAt;
              limitUntil = at < 1e12 ? at * 1000 : at;
            }
          }
        });
        const { code, stderr } = await run.done;
        if (io.signal.aborted) return { stop: "cancelled", usage, costUsd, resume: session };
        if (io.resume && lostConversation(`${failure ?? ""}\n${stderr}`)) return { stop: "error", error: failure ?? stderr.trim(), lostSession: true };
        if (failure) return { stop: "error", error: failure, usage, costUsd, resume: session, ...(limitUntil !== null || looksRateLimited(failure) ? { limit: { until: limitUntil ?? resetTime(failure) } } : {}) };
        if (code !== 0) return { stop: "error", error: `claude exited with ${code}: ${stderr.slice(-400)}`, usage, costUsd, resume: session };
        return { stop: asked ? "asked" : "end", usage, costUsd, resume: session, metrics };
      } finally {
        unbind();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  };
}

export default {
  name: "engine-claude-code",
  inject: ["agent", "mcp"],
  apply(ctx: Context) {
    ctx.agent.engine(createClaudeCodeCliEngine(ctx));
  }
};

export { runJsonl } from "./cli.js";
export { buildSystem, promptOf } from "./system.js";
