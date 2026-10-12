import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import { createAcpEngine, PERMISSION_CHOICES, type AcpAgent, type RequestUsage } from "@tomradex/engine-acp";
import { localCli, type BundledCli, type CliHost } from "@tomradex/engine-claude-code";

export const WorkBuddyOptions = z.object({
  command: z.string().default("codebuddy"),
  /** A model id as CodeBuddy lists it (`default-model`, `hy3`, …); empty keeps the one it last used. */
  model: z.string().optional(),
  /** Its thought level: minimal, low, medium, high, xhigh or max. */
  effort: z.string().optional()
});
export type WorkBuddyOptions = z.infer<typeof WorkBuddyOptions>;

const firstFile = (candidates: string[]): string => candidates.find((file) => fs.existsSync(file)) ?? candidates[0]!;

/**
 * The CodeBuddy Code CLI the WorkBuddy desktop app ships, and the app's own
 * Electron binary that runs it — the way WorkBuddy starts it itself, so a
 * machine with the app but no Node can still use it.
 */
export function workbuddyApps(host: Pick<CliHost, "platform" | "env" | "home">): BundledCli[] {
  if (host.platform === "darwin") {
    const p = path.posix;
    return ["/Applications", p.join(host.home, "Applications")].flatMap((root) =>
      ["WorkBuddy AI", "WorkBuddy"].map((app) => {
        const contents = p.join(root, `${app}.app`, "Contents");
        let binaries: string[] = [];
        try { binaries = fs.readdirSync(p.join(contents, "MacOS")); } catch {}
        return { file: p.join(contents, "Resources/app.asar.unpacked/cli/bin/codebuddy"), runtime: p.join(contents, "MacOS", binaries[0] ?? "Electron") };
      })
    );
  }
  if (host.platform === "win32") {
    const w = path.win32;
    const env = (key: string) => Object.entries(host.env).find(([name]) => name.toUpperCase() === key)?.[1];
    const roots = [w.join(env("LOCALAPPDATA") ?? w.join(host.home, "AppData", "Local"), "Programs"), env("PROGRAMFILES")].filter((dir): dir is string => !!dir);
    return roots.flatMap((root) =>
      ["WorkBuddy AI", "WorkBuddyAI", "workbuddy-ai", "WorkBuddy"].map((folder) => ({
        file: w.join(root, folder, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
        runtime: firstFile(["WorkBuddyAI.exe", "WorkBuddy AI.exe", "WorkBuddy.exe"].map((exe) => w.join(root, folder, exe)))
      }))
    );
  }
  return [];
}

/** CodeBuddy reports each model request's tokens, OpenAI-style, inside a usage update's `_meta`. */
export function codebuddyUsage(update: Record<string, any>): RequestUsage | null {
  const usage = update._meta?.usage;
  if (!usage || typeof usage.prompt_tokens !== "number") return null;
  const cached = [usage.prompt_cache_hit_tokens, usage.prompt_tokens_details?.cached_tokens, usage.cache_read_input_tokens].filter((n): n is number => typeof n === "number");
  const written = [usage.prompt_cache_write_tokens, usage.cache_creation_input_tokens].filter((n): n is number => typeof n === "number");
  return {
    input: usage.prompt_tokens,
    output: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    ...(cached.length ? { cacheRead: Math.max(...cached) } : {}),
    ...(written.length ? { cacheWrite: Math.max(...written) } : {})
  };
}

/**
 * CodeBuddy ends every failed turn with stopReason "refusal" and puts the
 * reason in `_meta["codebuddy.ai/errorMessage"]` — a JSON-RPC error whose
 * `data.details` holds the upstream words ("Internal error" alone says nothing).
 * Its status code and category stay in the details.
 */
export function codebuddyFailure(response: Record<string, any>): string | undefined {
  const raw = response._meta?.["codebuddy.ai/errorMessage"] ?? response.errorMessage ?? response._meta?.errorMessage;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return raw.trim(); }
  if (!parsed || typeof parsed !== "object") return raw.trim();
  const details = typeof parsed.data?.details === "string" && parsed.data.details.trim() ? parsed.data.details.trim() : undefined;
  const message = typeof parsed.message === "string" && parsed.message.trim() && parsed.message !== "Internal error" ? parsed.message.trim() : undefined;
  return message && details && !message.includes(details) ? `${message} — ${details}` : (message ?? details);
}

/** `codebuddy --help` lists the models it takes: "Currently supported: (a, b, c)". */
export function helpModels(help: string): string[] {
  const list = /Currently supported:\s*\(([^)]*)\)/.exec(help.replace(/\s+/g, " "))?.[1];
  return list ? list.split(",").map((model) => model.trim()).filter(Boolean) : [];
}

/** Newest first, at most a few: the files in `dir` that `keep` lets through. */
export function newestLogs(dir: string, keep: (name: string) => boolean, limit = 2): string[] {
  try {
    return fs.readdirSync(dir).filter(keep).map((name) => path.join(dir, name))
      .map((file) => ({ file, at: fs.statSync(file).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, limit).map((f) => f.file);
  } catch {
    return [];
  }
}

export const workbuddy: AcpAgent<WorkBuddyOptions> = {
  id: "workbuddy",
  title: "WorkBuddy",
  cli: localCli("codebuddy", { bundled: workbuddyApps }),
  install: "install WorkBuddy (workbuddy.ai), or its CLI with npm install -g @tencent-ai/codebuddy-code",
  // The WorkBuddy app's own copy of the CLI is found without any install; inside codebuddy, /login signs in.
  setup: { install: ["npm install -g @tencent-ai/codebuddy-code"], signIn: "codebuddy", signInRuns: true, docs: "https://www.workbuddy.ai/docs/cli/overview" },
  options: WorkBuddyOptions,
  permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask, PERMISSION_CHOICES["read-only"]] },
  args: () => ["--acp"],
  // Every few prompts CodeBuddy titles the session with the session's own model, thinking included, and
  // answers the prompt only once the title is back — 45 s after a 3 s reply on hy4-preview. Tomrade shows no such title.
  env: () => ({ CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1" }),
  // Interactive `codebuddy` takes Claude Code's flags and hooks, so a ticket can start in a terminal too.
  terminal: true,
  // "default" asks before the first use of every tool, so Tomrade decides what a read-only or ask turn lets through.
  mode: (policy) => (policy === "full-access" ? "bypassPermissions" : "default"),
  usage: codebuddyUsage,
  failure: codebuddyFailure,
  signIn: "run `codebuddy` and /login with your WorkBuddy account",
  diagnostics: {
    // Each CLI process logs to <date>/<cwd hash>__<id>.log; the WorkBuddy app's own sessions are the desktop__ ones.
    logs: () => {
      const dir = path.join(os.homedir(), ".codebuddy", "logs", new Date().toISOString().slice(0, 10));
      return newestLogs(dir, (name) => name.endsWith(".log") && !name.startsWith("desktop__"));
    },
    facts: (catalog) => ({
      // Tencent's internal edition offers models named *-ioa and signs in against its own endpoint.
      edition: catalog.models.some((m) => /-ioa$/.test(m.value)) ? "ioa" : catalog.models.length ? "public" : "unknown",
      internetEnvironment: process.env.CODEBUDDY_INTERNET_ENVIRONMENT ?? "unset"
    })
  },
  probe: {
    args: ["--help"],
    says: (output, catalog) => {
      const models = helpModels(output);
      if (models.length && !catalog.models.length) catalog.models = models.map((value) => ({ value }));
      return null;
    },
    reason: ""
  }
};

export function createWorkBuddyEngine(ctx: Context) {
  return createAcpEngine(ctx, workbuddy);
}

export default {
  name: "engine-workbuddy",
  inject: ["agent", "mcp", "tools"],
  apply(ctx: Context) { ctx.agent.engine(createWorkBuddyEngine(ctx)); }
};
