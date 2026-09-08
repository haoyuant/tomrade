import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import { isSuspended, type Engine, type TurnIO, type TurnInput, type TurnResult } from "@tomrade/agent";
import { binaryOk, buildSystem, promptOf, runJsonl } from "@tomrade/engine-claude-code";
import type {} from "@tomrade/mcp";

export const CodexOptions = z.object({
  command: z.string().default("codex"),
  model: z.string().optional(),
  /** Passed as -c model_reasoning_effort=…; the CLI validates the level. */
  effort: z.string().optional()
});
export type CodexOptions = z.infer<typeof CodexOptions>;

interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: string;
}

const TOKEN_ENV = "TOMRADE_MCP_TOKEN";

export function createCodexEngine(ctx: Context): Engine {
  let probe: { at: number; state: { ok: boolean; reason?: string } } | null = null;
  return {
    id: "codex",
    title: "Codex",
    author: "ai:codex",
    capabilities: ["backlog", "code"],
    options: CodexOptions,
    picks: () => [
      { key: "model", title: "Model", choices: [{ value: "gpt-5-codex" }, { value: "gpt-5" }], freeText: true },
      { key: "effort", title: "Effort", choices: [{ value: "minimal" }, { value: "low" }, { value: "medium" }, { value: "high" }] }
    ],
    async available() {
      if (probe && Date.now() - probe.at < 30_000) return probe.state;
      const bin = await binaryOk("codex");
      const state = !bin.ok
        ? { ok: false, reason: "codex CLI not found — install OpenAI Codex and sign in" }
        : !ctx.get("mcp")?.url
          ? { ok: false, reason: "the MCP server is not running — enable the mcp plugin" }
          : { ok: true };
      probe = { at: Date.now(), state };
      return state;
    },
    async turn(input: TurnInput, io: TurnIO): Promise<TurnResult> {
      const options = CodexOptions.parse(input.options ?? {});
      const url = ctx.mcp.url;
      if (!url) return { stop: "error", error: "the MCP server is not running" };

      const token = randomUUID();
      let asked = false;
      const unbind = ctx.mcp.bindRun(token, {
        author: "ai:codex",
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

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-codex-"));
      // codex has no appended-system-prompt flag; the context rides ahead of the message.
      const prompt = buildSystem(input, io, "Codex") + "\n\n---\n\nUSER MESSAGE:\n" + promptOf(input);
      const shared = [
        "--json",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-C",
        tmp,
        "-c",
        `mcp_servers.tomrade.url="${url}"`,
        "-c",
        `mcp_servers.tomrade.bearer_token_env_var="${TOKEN_ENV}"`,
        ...(options.model ? ["-m", options.model] : []),
        ...(options.effort ? ["-c", `model_reasoning_effort="${options.effort}"`] : [])
      ];
      const args = io.resume ? ["exec", "resume", io.resume, ...shared, prompt] : ["exec", ...shared, prompt];

      const usage = { inputTokens: 0, outputTokens: 0 };
      let session: string | undefined;
      let failure: string | null = null;

      try {
        const run = runJsonl(options.command, args, {
          cwd: input.cwd ?? tmp,
          env: { ...process.env, [TOKEN_ENV]: token },
          signal: io.signal,
          onLine: (raw) => {
            const line = raw as CodexLine;
            if (line.type === "thread.started") session = line.thread_id;
            else if (line.type === "item.completed" && line.item?.type === "agent_message" && line.item.text?.trim()) io.emit({ type: "text", text: line.item.text.trim() });
            else if (line.type === "turn.completed") {
              usage.inputTokens += line.usage?.input_tokens ?? 0;
              usage.outputTokens += line.usage?.output_tokens ?? 0;
              io.progress(usage);
            } else if (line.type === "error") failure = line.message ?? "codex reported an error";
          }
        });
        const { code, stderr } = await run.done;
        if (io.signal.aborted) return { stop: "cancelled", usage, resume: session };
        if (failure) return { stop: "error", error: failure, usage, resume: session };
        if (code !== 0) return { stop: "error", error: `codex exited with ${code}: ${stderr.slice(-400)}`, usage, resume: session };
        return { stop: asked ? "asked" : "end", usage, resume: session };
      } finally {
        unbind();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  };
}

export default {
  name: "engine-codex",
  inject: ["agent", "mcp"],
  apply(ctx: Context) {
    ctx.agent.engine(createCodexEngine(ctx));
  }
};
