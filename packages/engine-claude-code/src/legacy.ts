import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import { isSuspended, type Engine, type TurnIO, type TurnInput, type TurnResult } from "@tomrade/agent";
import type {} from "@tomrade/mcp";
import { binaryOk, runJsonl } from "./cli.js";
import { buildSystem, promptOf } from "./system.js";

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
  /** A turn that implements a ticket runs long: its own turn ceiling… */
  codeMaxTurns: z.number().int().min(1).max(1000).default(200),
  /** …and its own permission mode, in a worktree of its own. The user's settings.json allow-rules still apply. */
  codePermissionMode: z.enum(["acceptEdits", "bypassPermissions", "dontAsk", "default"]).default("acceptEdits")
});
export type ClaudeCodeOptions = z.infer<typeof ClaudeCodeOptions>;

interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ({ type: string; text?: string; name?: string; input?: unknown } | Record<string, unknown>)[]; usage?: { input_tokens?: number; output_tokens?: number } };
  event?: { type?: string; delta?: { type?: string; text?: string } };
  result?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function createClaudeCodeCliEngine(ctx: Context): Engine {
  let probe: { at: number; state: { ok: boolean; reason?: string } } | null = null;
  return {
    id: "claude-code",
    title: "Claude Code",
    author: "ai:claude-code",
    capabilities: ["backlog", "code"],
    options: ClaudeCodeOptions,
    picks: () => [
      // aliases the CLI resolves itself, so they don't go stale with releases
      { key: "model", title: "Model", choices: [{ value: "sonnet" }, { value: "opus" }, { value: "haiku" }], freeText: true },
      { key: "effort", title: "Effort", choices: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }] }
    ],
    async available() {
      if (probe && Date.now() - probe.at < 30_000) return probe.state;
      const bin = await binaryOk("claude");
      const state = !bin.ok
        ? { ok: false, reason: "claude CLI not found — install Claude Code and sign in" }
        : !ctx.get("mcp")?.url
          ? { ok: false, reason: "the MCP server is not running — enable the mcp plugin" }
          : { ok: true };
      probe = { at: Date.now(), state };
      return state;
    },
    async turn(input: TurnInput, io: TurnIO): Promise<TurnResult> {
      const options = ClaudeCodeOptions.parse(input.options ?? {});
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
      // dontAsk denies anything not allowlisted on backlog turns, while code
      // turns work in their own worktree and accept edits.
      const code = input.purpose === "code";
      const args = [
        "-p",
        promptOf(input),
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--mcp-config",
        mcpFile,
        "--strict-mcp-config",
        "--permission-mode",
        code ? options.codePermissionMode : "dontAsk",
        "--allowedTools",
        "mcp__tomrade__*",
        ...options.allowTools,
        "--append-system-prompt-file",
        sysFile,
        "--max-turns",
        String(code ? options.codeMaxTurns : options.maxTurns)
      ];
      if (options.maxBudgetUsd) args.push("--max-budget-usd", String(options.maxBudgetUsd));
      if (options.model) args.push("--model", options.model);
      if (options.effort) args.push("--effort", options.effort);
      if (io.resume) args.push("--resume", io.resume);

      const usage = { inputTokens: 0, outputTokens: 0 };
      const metrics: import("@tomrade/agent").TurnMetrics = { transport: "cli", runtime: "cold" };
      const started = performance.now();
      let costUsd: number | undefined;
      let session: string | undefined;
      let failure: string | null = null;

      try {
        const run = runJsonl(options.command, args, {
          cwd: input.cwd ?? tmp,
          env: { ...process.env, ...input.env },
          signal: io.signal,
          onLine: (raw) => {
            const line = raw as StreamLine;
            if (line.type === "system" && line.subtype === "init") {
              session = line.session_id;
              metrics.readyMs = performance.now() - started;
            } else if (line.type === "stream_event") {
              if (line.event?.type === "content_block_delta" && line.event.delta?.type === "text_delta" && line.event.delta.text) {
                metrics.firstTokenMs ??= performance.now() - started;
                io.delta(line.event.delta.text);
              }
            } else if (line.type === "assistant") {
              if (line.message?.usage) {
                usage.inputTokens += line.message.usage.input_tokens ?? 0;
                usage.outputTokens += line.message.usage.output_tokens ?? 0;
                io.progress(usage);
              }
              for (const block of line.message?.content ?? []) {
                if (block.type === "text" && typeof block.text === "string" && block.text.trim()) io.emit({ type: "text", text: block.text.trim() });
                else if (block.type === "tool_use" && typeof block.name === "string" && !block.name.startsWith("mcp__"))
                  io.emit({ type: "trace", tool: block.name, args: block.input ?? {}, ok: true, summary: "run by Claude Code itself", ms: 0 });
              }
            } else if (line.type === "result") {
              session = line.session_id ?? session;
              costUsd = line.total_cost_usd;
              // per-message usage was already streamed; the result's total wins over the running sum
              if (line.usage) {
                const counters = line.usage as typeof line.usage & { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
                metrics.cacheReadTokens = counters.cache_read_input_tokens;
                metrics.cacheWriteTokens = counters.cache_creation_input_tokens;
                metrics.uncachedInputTokens = counters.input_tokens;
                usage.inputTokens = Math.max(usage.inputTokens, line.usage.input_tokens ?? 0);
                usage.outputTokens = Math.max(usage.outputTokens, line.usage.output_tokens ?? 0);
              }
              if (line.is_error) failure = typeof line.result === "string" ? line.result : (line.subtype ?? "Claude Code reported an error");
            }
          }
        });
        const { code, stderr } = await run.done;
        if (io.signal.aborted) return { stop: "cancelled", usage, costUsd, resume: session };
        if (failure) return { stop: "error", error: failure, usage, costUsd, resume: session };
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

export { binaryOk, runJsonl } from "./cli.js";
export { buildSystem, promptOf } from "./system.js";
