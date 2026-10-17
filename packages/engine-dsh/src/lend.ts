import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { chosenCommand, cliLentModel, NotSignedIn, runJsonl, type CliLocator } from "@tomradex/engine-claude-code";
import { transcriptOf, type LentModel } from "@tomradex/llm";

const SIGNED_OUT = /MISSING_CREDENTIAL|no API key|unauthori[sz]ed|not signed in|\b401\b/i;

interface RunLine {
  type?: string;
  text?: string;
  phase?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  reason?: { kind?: string; error?: { message?: string; code?: string } };
}

// Always the same folder, with nothing in it for the run to pick up as project rules.
export const dshWorkerDir = (): string => path.join(os.tmpdir(), "tomrade-dsh-worker");

/**
 * Loaded into the run through the patch: the call's instructions become the
 * whole system prompt, no tool schema or runtime context reaches the model, a
 * call to any tool is refused, and the model and effort the person chose apply.
 */
export const DSH_LENT_PLUGIN = `import fs from "node:fs";
export const name = "tomrade-lent";
export const inject = ["systemPrompt", "tools", "agentDefaultModel"];
export function apply(ctx, config) {
  const call = JSON.parse(fs.readFileSync(config.call, "utf8"));
  ctx.systemPrompt.section({ name: "tomrade:lent", order: 0, complete: true, interpolate: false, text: call.system });
  ctx.on("system-prompt/assemble", async (assembly, context, next) => ({ ...(await next(assembly)), tools: [], contexts: [] }));
  ctx.tools.guard(() => "Tomrade lends this run for one answer: no tools.");
  const own = ctx.agentDefaultModel;
  const current = own.currentSelection.bind(own);
  own.currentSelection = () => ({ ...current(), ...call.selection });
}
`;

/** "provider/model" names both; a bare model keeps the provider dsh would use. */
export function dshSelection(options: { model?: string; effort?: string }): Record<string, string> {
  const model = options.model?.trim();
  const at = model ? model.indexOf("/") : -1;
  return {
    ...(model ? (at > 0 ? { provider: model.slice(0, at), model: model.slice(at + 1) } : { model }) : {}),
    ...(options.effort?.trim() ? { reasoningEffort: options.effort.trim() } : {})
  };
}

/**
 * The person's dsh answering one prompt as `dsh --profile headless --json`,
 * through a patch for this run alone: the plugin above, skills, project
 * instructions and the title call off, and the session kept in a folder
 * removed afterwards, not among theirs.
 */
export function dshPatch(dir: string): string {
  const off = ["session-title-llm", "skill", "skill-filesystem", "tool-skill", "agent-instructions"];
  return [
    "- id: session-persistence-jsonl",
    "  config:",
    `    root: ${JSON.stringify(path.join(dir, "sessions"))}`,
    ...off.flatMap((id) => [`- id: ${id}`, "  disabled: true"]),
    "- insert:",
    "    - id: tomrade-lent",
    `      name: ${JSON.stringify(path.join(dir, "lent.mjs"))}`,
    "      config:",
    `        call: ${JSON.stringify(path.join(dir, "call.json"))}`,
    ""
  ].join("\n");
}

export function dshLentModel(ctx: Context, opts: { cli: CliLocator; found(): Promise<boolean>; options(): { model?: string; effort?: string } }): LentModel {
  return cliLentModel({
    id: "dsh",
    title: "DeepSeek Harness",
    rank: 45,
    found: opts.found,
    async ask(request, signal) {
      const cwd = dshWorkerDir();
      fs.mkdirSync(cwd, { recursive: true });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-dsh-lent-"));
      fs.writeFileSync(path.join(dir, "lent.mjs"), DSH_LENT_PLUGIN);
      fs.writeFileSync(path.join(dir, "call.json"), JSON.stringify({ system: request.system, selection: dshSelection(opts.options()) }));
      fs.writeFileSync(path.join(dir, "patch.yml"), dshPatch(dir));
      let text = "";
      let failure: { message?: string; code?: string } | undefined;
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      try {
        const run = runJsonl(await opts.cli.launch(chosenCommand(ctx, "dsh")), ["--profile", "headless", "--patch", path.join(dir, "patch.yml"), "--json", "-"], {
          cwd,
          stdin: transcriptOf(request.messages),
          signal: signal ?? new AbortController().signal,
          onLine: (raw) => {
            const line = raw as RunLine;
            if (line.type === "final") text = line.text ?? "";
            else if (line.phase === "step_end" && line.usage) {
              // dsh's inputTokens leave out what the cache read and wrote.
              const read = line.usage.cacheReadTokens ?? 0;
              usage.inputTokens += (line.usage.inputTokens ?? 0) + read + (line.usage.cacheWriteTokens ?? 0);
              usage.cacheReadTokens += read;
              usage.outputTokens += line.usage.outputTokens ?? 0;
            } else if (line.phase === "turn_end" && line.reason?.kind === "error") failure = line.reason.error ?? {};
          }
        });
        const { code, stderr } = await run.done;
        const why = failure?.message || stderr.trim().split("\n").at(-1) || `exit ${code}`;
        if (SIGNED_OUT.test(`${failure?.code ?? ""} ${why}`)) throw new NotSignedIn(`DeepSeek Harness has no DeepSeek account or API key (${why}) — sign in or add a key under Settings → Models in the DeepSeek Harness app (or \`dsh web\`), or set DEEPSEEK_API_KEY`);
        if (failure || code !== 0 || !text.trim()) throw new Error(`DeepSeek Harness could not answer: ${why}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { text, ...usage };
    }
  });
}
