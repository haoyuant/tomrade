import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { chosenCommand, cliLentModel, NotSignedIn, runJsonl, type CliLocator } from "@tomradex/engine-claude-code";
import { transcriptOf, type LentModel } from "@tomradex/llm";

// No provider with a key, or the one picked has none.
const SIGNED_OUT = /api key|unauthorized|no providers?|not authenticated|401/i;

interface Tokens {
  input?: number;
  output?: number;
  cache?: { read?: number; write?: number };
}

interface RunLine {
  type?: string;
  part?: { type?: string; text?: string; tokens?: Tokens };
  error?: { name?: string; data?: { message?: string } };
}

/**
 * The signed-in OpenCode answering one prompt (`opencode run`) as an agent of
 * Tomrade's own, defined in a config for this call alone: the instructions are
 * its whole system prompt and every tool is denied, so no tool definitions,
 * skills or project rules ride along (about 18k tokens otherwise). External
 * plugins stay off; the transcript goes in on stdin.
 */
export function opencodeLentModel(ctx: Context, opts: { cli: CliLocator; found(): Promise<boolean>; options(): { model?: string } }): LentModel {
  return cliLentModel({
    id: "opencode",
    title: "OpenCode",
    // After Hermes: OpenCode starts its whole server for every call.
    rank: 70,
    found: opts.found,
    async ask(request, signal) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-opencode-lent-"));
      const system = path.join(tmp, "system.md");
      fs.writeFileSync(system, request.system);
      const config = path.join(tmp, "config.json");
      fs.writeFileSync(config, JSON.stringify({ agent: { "tomrade-worker": { description: "Answers one Tomrade request", mode: "primary", prompt: `{file:${system}}`, permission: { "*": "deny" } } } }));
      const { model } = opts.options();
      const args = ["run", "--format", "json", "--pure", "--agent", "tomrade-worker", ...(model ? ["-m", model] : [])];
      let text = "";
      let failure: string | null = null;
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      try {
        const run = runJsonl(await opts.cli.launch(chosenCommand(ctx, "opencode")), args, {
          cwd: tmp,
          env: { ...process.env, OPENCODE_CONFIG: config },
          stdin: transcriptOf(request.messages),
          signal: signal ?? new AbortController().signal,
          onLine: (raw) => {
            const line = raw as RunLine;
            if (line.type === "text" && line.part?.text) text += line.part.text;
            else if (line.type === "step_finish") {
              const tokens = line.part?.tokens ?? {};
              // `input` leaves out what the cache read and wrote.
              usage.inputTokens += (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
              usage.outputTokens += tokens.output ?? 0;
              usage.cacheReadTokens += tokens.cache?.read ?? 0;
            } else if (line.type === "error") failure = line.error?.data?.message ?? line.error?.name ?? "the run failed";
          }
        });
        const { code, stderr } = await run.done;
        if (failure || code !== 0 || !text) {
          const why = failure ?? (stderr.trim().split("\n").at(-1) || `exit ${code}`);
          if (SIGNED_OUT.test(why)) throw new NotSignedIn(`OpenCode has no model it can use (${why}) — run \`opencode auth login\` to add a provider`);
          throw new Error(`OpenCode could not answer: ${why}`);
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      return { text, ...usage };
    }
  });
}
