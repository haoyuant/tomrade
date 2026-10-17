import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { chosenCommand, cliLentModel, NotSignedIn, runJsonl, type CliLocator } from "@tomradex/engine-claude-code";
import { transcriptOf, type LentModel } from "@tomradex/llm";
import { PiOptions } from "./options.js";

const SIGNED_OUT = /No API key found|No models available|Use \/login/i;

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface JsonLine {
  type?: string;
  message?: { role?: string; content?: { type?: string; text?: string }[]; stopReason?: string; errorMessage?: string; usage?: Usage };
}

/**
 * The signed-in pi answering one prompt, bare: no tools, MCP, extensions,
 * skills, context files, project files or saved session. The transcript goes
 * in on stdin, which pi takes as the prompt.
 */
export function piLentModel(ctx: Context, opts: { cli: CliLocator; found(): Promise<boolean> }): LentModel {
  return cliLentModel({
    id: "pi",
    title: "Pi",
    // After Gemini CLI: pi waits on whichever provider it is signed in to.
    rank: 50,
    found: opts.found,
    async ask(request, signal) {
      const { model, effort } = PiOptions.parse(ctx.get("agent")?.settingsOf().engines.pi ?? {});
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-lent-"));
      // A file, not the text: a long prompt overruns a Windows command line.
      const system = path.join(tmp, "system.md");
      fs.writeFileSync(system, request.system);
      const args = ["-p", "--mode", "json", "--no-session", "-ne", "-nt", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", "-na", "--offline",
        "--system-prompt", system, ...(model ? ["--model", model] : []), ...(effort ? ["--thinking", effort] : [])];
      let answer: JsonLine["message"];
      try {
        const run = runJsonl(await opts.cli.launch(chosenCommand(ctx, "pi")), args, {
          cwd: tmp,
          stdin: transcriptOf(request.messages),
          signal: signal ?? new AbortController().signal,
          onLine: (raw) => {
            const line = raw as JsonLine;
            if (line.type === "message_end" && line.message?.role === "assistant") answer = line.message;
          }
        });
        const { code, stderr } = await run.done;
        const text = (answer?.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
        if (!answer || answer.stopReason === "error" || !text) {
          const why = answer?.errorMessage || stderr.trim().split("\n")[0] || `exit ${code}`;
          if (SIGNED_OUT.test(why) || SIGNED_OUT.test(stderr)) throw new NotSignedIn(`Pi has no model it can use (${why}) — run \`pi\` and /login, or set a provider's API key`);
          throw new Error(`Pi could not answer: ${why}`);
        }
        const usage = answer.usage ?? {};
        // pi counts cached prompt tokens apart from `input`.
        return {
          text,
          inputTokens: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
          outputTokens: usage.output ?? 0,
          ...(usage.cacheRead != null ? { cacheReadTokens: usage.cacheRead } : {})
        };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
}
