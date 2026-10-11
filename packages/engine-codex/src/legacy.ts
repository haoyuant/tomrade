import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import { isSuspended, type Engine, type TurnIO, type TurnInput, type TurnResult } from "@tomradex/agent";
import { publishNativeImage } from "@tomradex/agent";
import { buildSystem, localAvailability, localCli, promptOf, runJsonl } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/settings";

export const CodexOptions = z.object({
  transport: z.enum(["app-server", "cli"]).default("app-server"),
  command: z.string().default("codex"),
  model: z.string().optional(),
  /** Passed as -c model_reasoning_effort=…; the CLI validates the level. */
  effort: z.string().optional()
});
export type CodexOptions = z.infer<typeof CodexOptions>;

interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string; result?: string; status?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: string;
}

const TOKEN_ENV = "TOMRADE_MCP_TOKEN";
const LEGACY_CHATGPT_MODEL = "gpt-5-codex";

/** This was once Tomrade's preset, but Codex now rejects it for ChatGPT accounts. */
export const codexModel = (model?: string): string | undefined => (model === LEGACY_CHATGPT_MODEL ? undefined : model);

export function migrateLegacyModel(ctx: Context): void {
  const all = ctx.settings.get();
  const agent = all.agent as { engines?: Record<string, unknown> } | undefined;
  const engines = agent?.engines ?? {};
  const current = engines.codex as Record<string, unknown> | undefined;
  if (current?.model !== LEGACY_CHATGPT_MODEL) return;
  const next = { ...current };
  delete next.model;
  ctx.settings.set({ ...all, agent: { ...agent, engines: { ...engines, codex: next } } });
}

/** `codex login status` says "Logged in using …" or "Not logged in". */
export function codexSignedIn(output: string): boolean | null {
  if (/not logged in/i.test(output)) return false;
  return /logged in/i.test(output) ? true : null;
}

export function createCodexCliEngine(ctx: Context): Engine {
  const cli = localCli("codex");
  return {
    id: "codex",
    title: "Codex",
    author: "ai:codex",
    capabilities: ["backlog", "code", "general"],
    options: CodexOptions,
    picks: () => [
      // Codex CLI resolves its authenticated account's current default. Model
      // ids change and differ between ChatGPT and API accounts, so custom ids
      // remain possible without shipping presets that become invalid.
      { key: "model", title: "Model", choices: [], freeText: true },
      { key: "effort", title: "Effort", choices: [{ value: "minimal" }, { value: "low" }, { value: "medium" }, { value: "high" }] }
    ],
    available: localAvailability(ctx, {
      engineId: "codex",
      title: "Codex",
      cli,
      install: "install OpenAI Codex and sign in",
      signIn: { args: ["login", "status"], says: codexSignedIn, reason: "Codex is not signed in — run `codex login` in a terminal" }
    }),
    checkCli: (file) => cli.check(file),
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
      // A code turn may write in its worktree; a backlog turn reads only.
      const mode = input.purpose !== "backlog" ? input.permissionMode : undefined;
      const sandbox = mode === "full-access" ? "danger-full-access" : mode === "read-only" ? "read-only" : "workspace-write";
      const shared = [
        "--json",
        "--skip-git-repo-check",
        ...(mode && mode !== "local" ? ["-c", `sandbox_mode="${sandbox}"`, "-c", `approval_policy="${mode === "full-access" ? "never" : "on-request"}"`, ...(mode === "full-access" ? ["-c", "sandbox_workspace_write.network_access=true"] : [])] : []),
        "-c",
        `mcp_servers.tomrade.url="${url}"`,
        "-c",
        `mcp_servers.tomrade.bearer_token_env_var="${TOKEN_ENV}"`,
        "-c",
        // The in-app runner cannot display Codex CLI approval prompts. Tomrade
        // already scopes this server to the run and applies its own write
        // policy, so its tools can execute without a second approval layer.
        'mcp_servers.tomrade.default_tools_approval_mode="approve"',
        ...(codexModel(options.model) ? ["-m", codexModel(options.model)!] : []),
        ...(options.effort ? ["-c", `model_reasoning_effort="${options.effort}"`] : [])
      ];
      // Resume has a smaller option set than the initial exec: its session
      // already remembers the working root and sandbox, and rejects -s/-C.
      const args = io.resume
        ? ["exec", "resume", ...shared, io.resume, prompt]
        : ["exec", ...shared, "-s", input.purpose !== "backlog" ? sandbox : "read-only", "-C", input.cwd ?? tmp, prompt];
      if (input.input.kind === "text") for (const ref of input.input.attachments ?? []) {
        if (!io.media) throw new Error("Media input is unavailable");
        args.splice(args.length - 1, 0, "--image", io.media.path(ref.id));
      }

      const usage = { inputTokens: 0, outputTokens: 0 };
      const metrics: import("@tomradex/agent").TurnMetrics = { transport: "cli", runtime: "cold" };
      let session: string | undefined;
      let failure: string | null = null;

      try {
        const run = runJsonl(await cli.launch(options.command), args, {
          cwd: input.cwd ?? tmp,
          env: { ...process.env, ...input.env, [TOKEN_ENV]: token },
          signal: io.signal,
          onLine: (raw) => {
            const line = raw as CodexLine;
            if (line.type === "item.completed" && line.item) publishNativeImage(line.item, io);
            if (line.type === "thread.started") session = line.thread_id;
            else if (line.type === "item.completed" && line.item?.type === "agent_message" && line.item.text?.trim()) io.emit({ type: "text", text: line.item.text.trim() });
            else if (line.type === "turn.completed") {
              metrics.cacheReadTokens = (line.usage as { cached_input_tokens?: number } | undefined)?.cached_input_tokens;
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
        return { stop: asked ? "asked" : "end", usage, resume: session, metrics };
      } finally {
        unbind();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  };
}

export default {
  name: "engine-codex",
  inject: ["agent", "mcp", "settings"],
  apply(ctx: Context) {
    migrateLegacyModel(ctx);
    ctx.agent.engine(createCodexCliEngine(ctx));
  }
};
