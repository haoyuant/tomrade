import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { chosenCommand, cliLentModel, NotSignedIn, runJsonl, type CliLocator } from "@tomradex/engine-claude-code";
import { transcriptOf, type LentModel } from "@tomradex/llm";

/** Gemini CLI's exit code for a sign-in it cannot finish without a person. */
const AUTH_EXIT = 41;

// Only workspace settings outrank the person's own (a system settings file must be root's), so a lent call runs in a folder of its own.
const WORKSPACE_SETTINGS = { tools: { core: [] }, skills: { enabled: false }, hooksConfig: { enabled: false }, context: { includeDirectoryTree: false }, experimental: { enableAgents: false } };
// Never a browser sign-in from a background call; folder trust and a sandbox would refuse or slow a call that runs no tool.
const BARE_ENV = { NO_BROWSER: "true", GEMINI_CLI_TRUST_WORKSPACE: "true", GEMINI_SANDBOX: "false" };

interface StreamLine {
  type?: string;
  session_id?: string;
  role?: string;
  content?: string;
  status?: string;
  message?: string;
  error?: { message?: string };
  stats?: { input_tokens?: number; cached?: number; output_tokens?: number };
}

/** Where Gemini CLI keeps its settings and sessions; GEMINI_CLI_HOME stands in for the home folder. */
export const geminiDir = (env: NodeJS.ProcessEnv = process.env) => path.join(env.GEMINI_CLI_HOME || os.homedir(), ".gemini");

/** The model the person set for Gemini CLI itself. Without one a lent call asks Flash, not Auto's classifier and then Pro. */
export function ownModel(dir = geminiDir(), env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GEMINI_MODEL?.trim()) return env.GEMINI_MODEL.trim();
  try {
    const name = (JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as { model?: { name?: unknown } }).model?.name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The lent calls' folder, with the settings that keep them bare. */
function workspace(): string {
  const dir = path.join(os.tmpdir(), "tomrade-gemini-lent");
  const file = path.join(dir, ".gemini", "settings.json");
  const settings = JSON.stringify(WORKSPACE_SETTINGS, null, 2);
  let current = "";
  try { current = fs.readFileSync(file, "utf8"); } catch {}
  if (current !== settings) {
    // two calls at once: neither may read the other's half-written file
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = `${file}.${process.pid}.${Date.now()}`;
    fs.writeFileSync(next, settings);
    fs.renameSync(next, file);
  }
  return fs.realpathSync(dir);
}

/** Gemini CLI saves every headless session for resuming; a lent call's holds the person's prompt and is nothing to resume. */
export function forgetSession(dir: string, cwd: string, sessionId: string): void {
  try {
    const projects = (JSON.parse(fs.readFileSync(path.join(dir, "projects.json"), "utf8")) as { projects?: Record<string, string> }).projects ?? {};
    const name = projects[cwd];
    if (!name) return;
    const chats = path.join(dir, "tmp", name, "chats");
    for (const file of fs.readdirSync(chats)) if (file.startsWith("session-") && file.includes(sessionId.slice(0, 8))) fs.rmSync(path.join(chats, file), { force: true });
  } catch {
    // a layout this version does not use: the session stays, as it would have
  }
}

const lastLine = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").at(-1)?.trim() ?? "";

/**
 * The signed-in Gemini CLI answering one prompt: its coding-agent prompt
 * swapped for the call's (GEMINI_SYSTEM_MD), no tools, MCP servers,
 * extensions, skills or hooks.
 */
export function geminiLentModel(ctx: Context, opts: { cli: CliLocator; found(): Promise<boolean> }): LentModel {
  return cliLentModel({
    id: "gemini",
    title: "Gemini CLI",
    rank: 40,
    found: opts.found,
    async ask(request, signal) {
      const chosen = (ctx.get("agent")?.settingsOf().engines.gemini as { model?: unknown } | undefined)?.model;
      const model = typeof chosen === "string" && chosen.trim() ? chosen.trim() : ownModel() ? undefined : "flash";
      // a server name that matches none: the person's MCP servers stay off
      const args = ["-p", "", "-o", "stream-json", "-e", "none", "--allowed-mcp-server-names", "tomrade-lent-none", ...(model ? ["-m", model] : [])];
      const cwd = workspace();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-gemini-system-"));
      const system = path.join(tmp, "system.md");
      fs.writeFileSync(system, request.system);
      let text = "";
      let session: string | undefined;
      let failure: string | undefined;
      let said: string | undefined;
      const usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } = { inputTokens: 0, outputTokens: 0 };
      try {
        const run = runJsonl(await opts.cli.launch(chosenCommand(ctx, "gemini")), args, {
          cwd,
          env: { ...process.env, ...BARE_ENV, GEMINI_SYSTEM_MD: system },
          stdin: transcriptOf(request.messages),
          signal: signal ?? new AbortController().signal,
          onLine: (raw) => {
            const line = raw as StreamLine;
            if (line.type === "init") session = line.session_id;
            else if (line.type === "message" && line.role === "assistant") text += line.content ?? "";
            else if (line.type === "error") said ??= line.message;
            else if (line.type === "result") {
              if (line.status === "error") failure = line.error?.message ?? "the turn failed";
              usage.inputTokens = line.stats?.input_tokens ?? 0;
              usage.outputTokens = line.stats?.output_tokens ?? 0;
              // part of input_tokens, as Gemini counts its prompt
              if (line.stats?.cached !== undefined) usage.cacheReadTokens = line.stats.cached;
            }
          }
        });
        const { code, stderr } = await run.done;
        if (session) forgetSession(geminiDir(), cwd, session);
        if (code === AUTH_EXIT) throw new NotSignedIn(`Gemini CLI is not signed in (${failure ?? lastLine(stderr)}) — run \`gemini\` and sign in with a Google account`);
        if (failure || code !== 0 || (!text && said)) throw new Error(`Gemini CLI could not answer: ${failure ?? said ?? (lastLine(stderr) || `exit ${code}`)}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      return { text, ...usage };
    }
  });
}
