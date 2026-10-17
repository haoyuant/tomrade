import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { chosenCommand, cliLentModel, NotSignedIn, runJsonl, type CliLocator } from "@tomradex/engine-claude-code";
import { transcriptOf, type LentModel } from "@tomradex/llm";

const SIGNED_OUT = /authentication required|not authenticated/i;

interface StreamLine {
  event?: string;
  conversation_id?: string;
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    denied_actions?: { action?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number };
  };
}

/** Where agy keeps its conversations. */
export const agyDir = (home = os.homedir()): string => path.join(home, ".gemini", "antigravity-cli");

// Always the same folder, with nothing in it for a file tool to find.
export const agyWorkerDir = (): string => path.join(os.tmpdir(), "tomrade-agy-worker");

/** agy keeps every print-mode conversation; a lent call's holds the person's prompt and is nothing to resume. */
export function forgetAgyConversation(dir: string, id: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  for (const file of [`conversations/${id}.db`, `conversations/${id}.db-wal`, `conversations/${id}.db-shm`, `brain/${id}`, `annotations/${id}.pbtxt`, `presence/${id}.lock`])
    fs.rmSync(path.join(dir, file), { recursive: true, force: true });
}

/**
 * The signed-in Antigravity CLI answering one prompt in print mode, the
 * prompt on stdin as one stream-json message. agy has no flag to drop its
 * tools or the person's MCP servers; headless it denies every command and
 * MCP call it would have to ask for, so only its file reads remain, from an
 * empty folder. It has no system-prompt flag, so the instructions lead the prompt.
 */
export function agyLentModel(ctx: Context, opts: { cli: CliLocator; found(): Promise<boolean>; options(): { model?: string } }): LentModel {
  return cliLentModel({
    id: "agy",
    title: "Antigravity CLI",
    // Every call carries agy's own tool definitions (about 12k tokens).
    rank: 75,
    found: opts.found,
    async ask(request, signal) {
      const cwd = agyWorkerDir();
      fs.mkdirSync(cwd, { recursive: true });
      const { model } = opts.options();
      const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--sandbox", ...(model ? ["--model", model] : [])];
      const content = request.system ? `${request.system}\n\n---\n\n${transcriptOf(request.messages)}` : transcriptOf(request.messages);
      let result: StreamLine["result"];
      let conversation: string | undefined;
      const run = runJsonl(await opts.cli.launch(chosenCommand(ctx, "agy")), args, {
        cwd,
        stdin: `${JSON.stringify({ event: "user", message: { role: "user", content } })}\n`,
        signal: signal ?? new AbortController().signal,
        onLine: (raw) => {
          const line = raw as StreamLine;
          conversation ??= line.conversation_id;
          if (line.event === "result") result = line.result;
        }
      });
      const { code, stderr } = await run.done;
      const id = result?.conversation_id || conversation;
      if (id) forgetAgyConversation(agyDir(), id);
      if (SIGNED_OUT.test(stderr)) throw new NotSignedIn(`Antigravity CLI is not signed in — run \`agy\` and sign in`);
      if (!result || result.status !== "SUCCESS" || code !== 0 || !result.response?.trim()) {
        const denied = result?.denied_actions?.map((d) => d.action).filter(Boolean).join(", ");
        const why = result?.error || (denied ? `it tried to use ${denied}, which a lent call may not` : "") || stderr.trim().split("\n").at(-1) || `exit ${code}`;
        throw new Error(`Antigravity CLI could not answer: ${why}`);
      }
      const usage = result.usage ?? {};
      return { text: result.response, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, cacheReadTokens: usage.cache_read_tokens ?? 0 };
    }
  });
}
