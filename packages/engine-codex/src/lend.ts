import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { chosenCommand, localCli, runJsonl } from "@tomradex/engine-claude-code";
import { transcriptOf, type ChatEvent, type ChatModel, type LentModel } from "@tomradex/llm";
import { CodexOptions, codexModel } from "./engine.js";

interface ExecLine {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: string;
  error?: { message?: string };
}

/**
 * The signed-in Codex answering one prompt in a read-only sandbox of an empty
 * folder. Codex has no system-prompt flag, so the instructions lead the prompt.
 */
export function codexLentModel(ctx: Context, ready: () => Promise<boolean>): LentModel {
  const model: ChatModel = {
    capabilities: { tools: false, streaming: false, json: false },
    async *chat(request, signal) {
      const options = CodexOptions.parse(ctx.get("agent")?.settingsOf().engines.codex ?? {});
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-codex-lent-"));
      const args = ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-C", tmp,
        ...(codexModel(options.model) ? ["-m", codexModel(options.model)!] : []),
        ...(options.effort ? ["-c", `model_reasoning_effort="${options.effort}"`] : [])];
      let text = "";
      let failure: string | null = null;
      const usage = { inputTokens: 0, outputTokens: 0 };
      try {
        const run = runJsonl(await localCli("codex").launch(chosenCommand(ctx, "codex")), args, {
          cwd: tmp,
          stdin: `${request.system}\n\n---\n\n${transcriptOf(request.messages)}`,
          signal: signal ?? new AbortController().signal,
          onLine: (raw) => {
            const line = raw as ExecLine;
            if (line.type === "item.completed" && line.item?.type === "agent_message" && line.item.text) text = line.item.text;
            else if (line.type === "turn.completed") {
              usage.inputTokens += line.usage?.input_tokens ?? 0;
              usage.outputTokens += line.usage?.output_tokens ?? 0;
            } else if (line.type === "turn.failed") failure = line.error?.message ?? "the turn failed";
            else if (line.type === "error") failure = line.message ?? "codex reported an error";
          }
        });
        const { code, stderr } = await run.done;
        if (failure || code !== 0 || !text) throw new Error(`Codex could not answer: ${failure ?? (stderr.trim().slice(-300) || `exit ${code}`)}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      const events: ChatEvent[] = [{ type: "usage", ...usage }, { type: "text", delta: text }, { type: "stop", reason: "end" }];
      yield* events;
    }
  };
  return { id: "codex", title: "Codex", ready, model };
}
