import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { chosenCommand, cliLentModel, NotSignedIn, spawnCli, stopCli, type CliLaunch, type CliLocator } from "@tomradex/engine-claude-code";
import { transcriptOf, type LentModel } from "@tomradex/llm";

// Before the reply: Hermes has no first-run provider yet, or no key for it.
const SIGNED_OUT = /hermes (setup|model)|no (inference )?provider|no api key|api key (is )?(missing|not set)/i;
// Hermes takes a one-shot prompt only as an argument; past this a command line may not hold it.
const MAX_PROMPT = 100_000;

interface UsageFile {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  failed?: boolean | null;
  auxiliary?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number };
}

/** One run to its end, stopped when the caller gives up; stdout is the reply alone. */
function answer(launch: CliLaunch, args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnCli(launch, args, { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const stop = () => stopCli(child);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => { stderr += error.message; });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      resolve({ code: signal?.aborted ? null : code, stdout, stderr: signal?.aborted ? "stopped" : stderr });
    });
  });
}

/**
 * The signed-in Hermes answering one prompt (`hermes -z`): no tools beyond its
 * small todo list (a toolset that also names no MCP server, so none is
 * started), no AGENTS.md, memory or skills. It has no system-prompt flag, so
 * the instructions lead the prompt. Its titling calls count toward the spend.
 */
export function hermesLentModel(ctx: Context, opts: { cli: CliLocator; found(): Promise<boolean>; options(): { model?: string } }): LentModel {
  return cliLentModel({
    id: "hermes",
    title: "Hermes",
    // After Pi: Hermes starts a Python runtime for every call.
    rank: 60,
    found: opts.found,
    async ask(request, signal) {
      const prompt = `${request.system}\n\n---\n\n${transcriptOf(request.messages)}`;
      if (prompt.length > MAX_PROMPT) throw new Error(`Hermes could not answer: the request is ${prompt.length} characters, more than a one-shot command line holds`);
      const { model } = opts.options();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hermes-lent-"));
      const usageFile = path.join(tmp, "usage.json");
      try {
        const args = ["-z", prompt, "-t", "todo", "--ignore-rules", "--usage-file", usageFile, ...(model ? ["-m", model] : [])];
        const run = await answer(await opts.cli.launch(chosenCommand(ctx, "hermes")), args, tmp, signal);
        let usage: UsageFile = {};
        try { usage = JSON.parse(fs.readFileSync(usageFile, "utf8")) as UsageFile; } catch { /* an early failure writes none */ }
        const text = run.stdout.trim();
        if (run.code !== 0 || usage.failed || !text) {
          const why = (text || run.stderr.trim() || `exit ${run.code}`).split("\n").filter(Boolean).slice(0, 2).join(" ");
          if (SIGNED_OUT.test(why)) throw new NotSignedIn(`Hermes has no model it can use (${why}) — run \`hermes setup\` to choose a provider and add its key`);
          throw new Error(`Hermes could not answer: ${why}`);
        }
        const aux = usage.auxiliary ?? {};
        const read = (usage.cache_read_tokens ?? 0) + (aux.cache_read_tokens ?? 0);
        // Hermes counts cached prompt tokens apart from input_tokens.
        return {
          text,
          inputTokens: (usage.input_tokens ?? 0) + (aux.input_tokens ?? 0) + read + (usage.cache_write_tokens ?? 0) + (aux.cache_write_tokens ?? 0),
          outputTokens: (usage.output_tokens ?? 0) + (aux.output_tokens ?? 0),
          ...(usage.cache_read_tokens != null ? { cacheReadTokens: read } : {})
        };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
}
