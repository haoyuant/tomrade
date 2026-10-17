import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { chosenCommand, cliLentModel, NotSignedIn, runJsonl, type CliLocator } from "@tomradex/engine-claude-code";
import { transcriptOf, type LentModel } from "@tomradex/llm";

const SIGNED_OUT = /authentication required|agent login|not logged in|unauthori[sz]ed|401/i;

interface ResultLine {
  type?: string;
  is_error?: boolean;
  result?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

// Always the same folder: cursor-agent keeps a background worker and a record in ~/.cursor/projects for each one it runs in.
export const cursorWorkerDir = (): string => path.join(os.tmpdir(), "tomrade-cursor-worker");

/**
 * The signed-in cursor-agent answering one prompt (`-p --output-format json`)
 * in ask mode, which reads but never edits or runs anything, from an empty
 * folder so no project rules ride along. It has no system-prompt flag, so the
 * instructions lead the prompt on stdin.
 */
export function cursorLentModel(ctx: Context, opts: { cli: CliLocator; found(): Promise<boolean>; options(): { model?: string } }): LentModel {
  return cliLentModel({
    id: "cursor",
    title: "Cursor",
    // Last: every call carries Cursor's own tool definitions (about 15k tokens) and counts against its plan.
    rank: 80,
    found: opts.found,
    async ask(request, signal) {
      const cwd = cursorWorkerDir();
      fs.mkdirSync(cwd, { recursive: true });
      const { model } = opts.options();
      const args = ["-p", "--output-format", "json", "--mode", "ask", "--trust", ...(model ? ["--model", model] : [])];
      let result: ResultLine | null = null;
      const run = runJsonl(await opts.cli.launch(chosenCommand(ctx, "cursor")), args, {
        cwd,
        stdin: `${request.system}\n\n---\n\n${transcriptOf(request.messages)}`,
        signal: signal ?? new AbortController().signal,
        onLine: (line) => {
          if ((line as ResultLine).type === "result") result = line as ResultLine;
        }
      });
      const { code, stderr } = await run.done;
      const answer = result as ResultLine | null;
      if (!answer || answer.is_error || code !== 0 || !answer.result) {
        const why = (answer?.is_error ? answer.result : undefined) || stderr.trim().split("\n").at(-1) || `exit ${code}`;
        if (SIGNED_OUT.test(why)) throw new NotSignedIn(`Cursor is not signed in (${why}) — run \`cursor-agent login\``);
        throw new Error(`Cursor could not answer: ${why}`);
      }
      const usage = answer.usage ?? {};
      // `inputTokens` leaves out what the cache read and wrote.
      const cacheRead = usage.cacheReadTokens ?? 0;
      return { text: answer.result, inputTokens: (usage.inputTokens ?? 0) + cacheRead + (usage.cacheWriteTokens ?? 0), outputTokens: usage.outputTokens ?? 0, cacheReadTokens: cacheRead };
    }
  });
}
