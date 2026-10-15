import type { Context } from "cordis";
import { z } from "zod";
import type { Engine } from "@tomradex/agent";
import { chosenCommand, localAvailability, localCli } from "@tomradex/engine-claude-code";
import { codexHome, readCodexAccount, type CodexAccount } from "./account.js";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/settings";

// Unknown keys are dropped, so a saved `transport` from older versions is ignored.
export const CodexOptions = z.object({
  command: z.string().default("codex"),
  model: z.string().optional(),
  /** Passed as -c model_reasoning_effort=…; the CLI validates the level. */
  effort: z.string().optional()
});
export type CodexOptions = z.infer<typeof CodexOptions>;

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

/** Codex can run when its provider needs no OpenAI sign-in or it has one; null when it cannot say. */
export function codexCanRun(account: CodexAccount | null, env: NodeJS.ProcessEnv = process.env): boolean | null {
  if (!account) return null;
  // `codex exec` also takes a key from CODEX_API_KEY, which account/read does not count.
  return !account.requiresOpenaiAuth || account.signedIn || (env.CODEX_API_KEY ? null : false);
}

/** Everything about the Codex engine except how a turn runs: identity, options, availability, setup. */
export function codexEngineInfo(ctx: Context): Omit<Engine, "turn"> {
  const cli = localCli("codex");
  // Models Codex listed, per CLI and CODEX_HOME, so switching either never shows the other's.
  const models = new Map<string, CodexAccount["models"]>();
  const modelsKey = (manual: string | undefined) => `${manual ?? ""}\0${codexHome()}`;
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
      { key: "model", title: "Model", choices: models.get(modelsKey(cli.manualOf(chosenCommand(ctx, "codex")))) ?? [], freeText: true },
      { key: "effort", title: "Effort", choices: [{ value: "minimal" }, { value: "low" }, { value: "medium" }, { value: "high" }] }
    ],
    available: localAvailability(ctx, {
      engineId: "codex",
      title: "Codex",
      cli,
      install: "install OpenAI Codex and sign in",
      signIn: {
        async ask(manual) {
          const key = modelsKey(manual);
          const account = await readCodexAccount(await cli.launch(manual));
          if (account) models.set(key, account.models);
          const verdict = codexCanRun(account);
          if (account) return verdict;
          // An older Codex without account/read: its login status is all there is to go on.
          const { stdout, stderr } = await cli.run(manual, ["login", "status"], 8000);
          return codexSignedIn(`${stdout}\n${stderr}`);
        },
        reason: "Codex is not signed in and its model provider needs an OpenAI account — run `codex login` in a terminal"
      },
      configDir: () => codexHome()
    }),
    checkCli: (file) => cli.check(file),
    setup: { install: ["npm install -g @openai/codex"], signIn: "codex login", docs: "https://github.com/openai/codex", suggested: true }
  };
}
