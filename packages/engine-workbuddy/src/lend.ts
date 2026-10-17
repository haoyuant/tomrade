import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { chosenCommand, cliLentModel, NotSignedIn, runJsonl, type CliLocator } from "@tomradex/engine-claude-code";
import { transcriptOf, type LentModel } from "@tomradex/llm";

// Its auto memory adds its whole manual (about 3k tokens) to every prompt, and every few prompts it titles the session.
const BARE_ENV = { CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: "1", CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: "1", CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1" };
const SIGNED_OUT = /Authentication (required|failed)/i;

interface PrintLine {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string | null;
  errors?: string[];
  usage?: { input_tokens?: number; cache_read_input_tokens?: number | null; output_tokens?: number };
}

/** The model the person last picked in CodeBuddy itself, which `--setting-sources ""` would leave out. */
export function ownModel(home = os.homedir()): string | undefined {
  try {
    const model = (JSON.parse(fs.readFileSync(path.join(home, ".codebuddy", "settings.json"), "utf8")) as { model?: unknown }).model;
    return typeof model === "string" && model.trim() ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The signed-in CodeBuddy CLI answering one prompt: no tools, MCP servers,
 * settings (so no hooks fire) or saved session. A kept stream-json session is
 * no faster here — CodeBuddy sends `/clear` to the model instead of clearing.
 */
export function codebuddyLentModel(
  ctx: Context,
  opts: { cli: CliLocator; found(): Promise<boolean>; options(): { model?: string; effort?: string }; signIn: string }
): LentModel {
  return cliLentModel({
    id: "workbuddy",
    title: "WorkBuddy",
    rank: 20,
    found: opts.found,
    async ask(request, signal) {
      const { model, effort } = opts.options();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-codebuddy-lent-"));
      // A file, not --system-prompt: a long prompt overruns a Windows command line.
      const system = path.join(tmp, "system.md");
      fs.writeFileSync(system, request.system);
      const picked = model || ownModel();
      const args = ["-p", "--output-format", "stream-json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
        "--system-prompt-file", system, ...(picked ? ["--model", picked] : []), ...(effort ? ["--effort", effort] : [])];
      let result: PrintLine | undefined;
      try {
        const run = runJsonl(await opts.cli.launch(chosenCommand(ctx, "workbuddy")), args, {
          cwd: os.tmpdir(),
          env: { ...process.env, ...BARE_ENV },
          stdin: transcriptOf(request.messages),
          signal: signal ?? new AbortController().signal,
          onLine: (line) => {
            if (line.type === "result") result = line as PrintLine;
          }
        });
        const { code, stderr } = await run.done;
        if (!result || result.is_error || typeof result.result !== "string") {
          // Signed out, it still exits 0: the reason is the result's error, or stderr from an older CLI.
          const why = result?.errors?.join("; ") || result?.result || stderr.trim().slice(-300) || result?.subtype || `exit ${code}`;
          if (SIGNED_OUT.test(why) || SIGNED_OUT.test(stderr)) throw new NotSignedIn(`WorkBuddy is not signed in (${why}) — ${opts.signIn}`);
          throw new Error(`WorkBuddy could not answer: ${why}`);
        }
        // input_tokens already includes what the cache read
        const read = result.usage?.cache_read_input_tokens;
        return { text: result.result, inputTokens: result.usage?.input_tokens ?? 0, outputTokens: result.usage?.output_tokens ?? 0, ...(read != null ? { cacheReadTokens: read } : {}) };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
}
