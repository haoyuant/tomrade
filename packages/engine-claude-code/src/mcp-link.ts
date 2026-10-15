import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import type { EngineMcpLink, McpLinkView } from "@tomradex/agent";
import type {} from "@tomradex/mcp";
import { chosenCommand } from "./availability.js";
import type { CliLocator, CliRunResult } from "./locate.js";

export const MCP_NAME = "tomrade";

/** What a person (or a test) needs to know about one agent's user-level MCP configuration. */
export interface UserMcpConfig {
  /** The file the agent keeps it in. */
  file(profile?: string): string;
  /** The address its `tomrade` entry names; null when there is none; throws when the file cannot be read. */
  configuredUrl(profile?: string): string | null;
  add(url: string): string[];
  remove(): string[];
  cli: CliLocator;
  engineId: string;
  /** An agent with several configuration folders: each one, the agent's own first. */
  profiles?(): string[];
  /** The environment that points the CLI at `profile`, and the same as a shell prefix (empty for the agent's own). */
  profileEnv?(profile: string): { env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv; prefix: string };
}

const failure = (result: CliRunResult): string | null =>
  result.error?.message ?? (result.code === 0 ? null : (result.stderr.trim() || result.stdout.trim() || `exited with ${result.code}`).slice(-400));

/** Status reads the agent's file; changes go through its own CLI, which owns that file's format. */
export function userMcpLink(ctx: Context, config: UserMcpConfig): EngineMcpLink {
  const name = config.cli.name;
  const quote = (args: string[]) => [name, ...args].map((arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : `"${arg}"`)).join(" ");
  const profiles = () => config.profiles?.() ?? [];
  const one = (profile: string | undefined, error?: string): McpLinkView => {
    const url = ctx.mcp.url;
    const prefix = profile ? (config.profileEnv?.(profile).prefix ?? "") : "";
    const manual = { connect: prefix + quote(config.add(url ?? "<url>")), disconnect: prefix + quote(config.remove()) };
    const file = config.file(profile);
    const where = profile ? { profile } : {};
    let configuredUrl: string | null = null;
    try {
      configuredUrl = config.configuredUrl(profile);
    } catch (cause) {
      return { state: "unavailable", url, configuredUrl, file, manual, ...where, error: error ?? `Cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    // A stale entry has to go before the new one is added.
    if (configuredUrl) manual.connect = `${manual.disconnect}; ${manual.connect}`;
    const state = !url ? "unavailable" : configuredUrl === url ? "connected" : configuredUrl ? "stale" : "missing";
    return { state, url, configuredUrl, file, manual, ...where, ...(error ? { error } : {}) };
  };
  /** The agent's own profile, with every profile listed when there are several; `error` goes on the one it is about. */
  const view = (error?: string, about?: string): McpLinkView => {
    const all = profiles();
    const own = all[0];
    if (all.length < 2) return one(own, error);
    const listed = all.map((profile) => one(profile, profile === (about ?? own) ? error : undefined));
    return { ...listed[0]!, profiles: listed };
  };
  const run = async (args: string[], profile: string | undefined): Promise<string | null> => {
    try {
      const env = profile && config.profileEnv ? config.profileEnv(profile).env : undefined;
      return failure(await config.cli.run(chosenCommand(ctx, config.engineId), args, 30_000, env));
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  };
  const pick = (profile?: string) => (profile && profiles().includes(profile) ? profile : profiles()[0]);
  return {
    async status() {
      return view();
    },
    async connect(profile) {
      const target = pick(profile);
      const url = ctx.mcp.url;
      if (!url) return view("Tomrade's MCP server is not running", target);
      const before = one(target);
      if (before.state === "connected") return view();
      if (before.configuredUrl) {
        const error = await run(config.remove(), target);
        if (error) return view(error, target);
      }
      return view((await run(config.add(url), target)) ?? undefined, target);
    },
    async disconnect(profile) {
      const target = pick(profile);
      if (!one(target).configuredUrl) return view();
      return view((await run(config.remove(), target)) ?? undefined, target);
    }
  };
}

const defaultConfigDir = (home = os.homedir()) => path.join(home, ".claude");

/** Claude Code keeps user-scope servers in `.claude.json`, beside CLAUDE_CONFIG_DIR's settings or in the home folder. */
export function claudeUserFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/** The environment Claude Code needs to run under one config folder: none for the default `~/.claude`. */
export function claudeProfileEnv(dir: string, home = os.homedir()): NodeJS.ProcessEnv {
  return path.resolve(dir) === defaultConfigDir(home) ? {} : { CLAUDE_CONFIG_DIR: path.resolve(dir) };
}

/** The config folder a session ran under, from its transcript: `<dir>/projects/<folder>/<session>.jsonl`. */
export function claudeConfigDirOf(transcript: string): string | null {
  const parts = path.resolve(transcript).split(path.sep);
  return parts.length > 3 && parts.at(-3) === "projects" && parts.at(-1)!.endsWith(".jsonl") ? parts.slice(0, -3).join(path.sep) || path.sep : null;
}

/**
 * Every Claude Code config folder in use here, the one this process would use
 * first. Several accounts are often one alias each (`CLAUDE_CONFIG_DIR=~/.claude-work claude`),
 * which an app opened from the Dock never sees: such folders are found beside
 * the default one, and from the transcripts sessions report through their hooks.
 */
export function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), seen: Iterable<string> = []): string[] {
  const own = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : defaultConfigDir(home);
  let beside: string[] = [];
  try {
    beside = fs.readdirSync(home).filter((name) => /^\.claude[-_.]./.test(name)).map((name) => path.join(home, name)).filter((dir) => fs.existsSync(path.join(dir, ".claude.json")));
  } catch {
    // An unreadable home folder hides only these.
  }
  const usedDefault = fs.existsSync(path.join(home, ".claude.json")) ? [defaultConfigDir(home)] : [];
  return [...new Set([own, ...usedDefault, ...[...seen].map((dir) => path.resolve(dir)), ...beside])];
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const urlOf = (server: unknown): string | null => {
  const url = (server as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? url : null;
};

export function claudeMcpLink(ctx: Context, cli: CliLocator): EngineMcpLink {
  // Folders seen only through a session's hooks; the alias that set them is invisible from here.
  const seen = new Set<string>();
  const profiles = () => claudeConfigDirs(process.env, os.homedir(), seen);
  const envOf = (profile?: string) => (profile ? claudeProfileEnv(profile) : process.env);
  const own = () => profiles()[0]!;
  const prefixOf = (profile: string) => {
    if (profile === own()) return "";
    const dir = claudeProfileEnv(profile).CLAUDE_CONFIG_DIR;
    const home = os.homedir();
    const shown = dir && dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
    return dir ? `CLAUDE_CONFIG_DIR=${/\s/.test(shown!) ? `"${shown}"` : shown} ` : "env -u CLAUDE_CONFIG_DIR ";
  };
  return {
    ...userMcpLink(ctx, {
      engineId: "claude-code",
      cli,
      profiles,
      profileEnv: (profile) => ({
        env: (base) => {
          const { CLAUDE_CONFIG_DIR: _, ...rest } = base;
          return { ...rest, ...claudeProfileEnv(profile) };
        },
        prefix: prefixOf(profile)
      }),
      file: (profile) => claudeUserFile(envOf(profile)),
      configuredUrl: (profile) => urlOf((readJson(claudeUserFile(envOf(profile))).mcpServers as Record<string, unknown> | undefined)?.[MCP_NAME]),
      add: (url) => ["mcp", "add", "--scope", "user", "--transport", "http", MCP_NAME, url],
      remove: () => ["mcp", "remove", "--scope", "user", MCP_NAME]
    }),
    projectApproval: (dir) => claudeProjectServerApproval(dir),
    projectApprovals: (dir) =>
      profiles().map((profile) => ({ profile, state: claudeProjectServerApproval(dir, MCP_NAME, claudeProfileEnv(profile)), command: `${prefixOf(profile)}claude` })),
    sawTranscript: (file) => {
      const dir = claudeConfigDirOf(file);
      if (dir) seen.add(dir);
    }
  };
}

/**
 * Whether Claude Code will load a repository's `.mcp.json` server: it asks
 * once per folder, and remembers the answer in `.claude.json` or in a
 * settings file. `pending` until the person answers.
 */
export function claudeProjectServerApproval(dir: string, name = MCP_NAME, env: NodeJS.ProcessEnv = process.env): "approved" | "rejected" | "pending" {
  const settingsDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const settings = [path.join(settingsDir, "settings.json"), path.join(dir, ".claude", "settings.json"), path.join(dir, ".claude", "settings.local.json")].map((file) => {
    try { return readJson(file); } catch { return {}; }
  });
  let project: Record<string, unknown> = {};
  try {
    const projects = readJson(claudeUserFile(env)).projects as Record<string, Record<string, unknown>> | undefined;
    project = projects?.[path.resolve(dir)] ?? {};
  } catch {
    // An unreadable file answers nothing: the person is asked as before.
  }
  const listed = (source: Record<string, unknown>, key: string) => Array.isArray(source[key]) && (source[key] as unknown[]).includes(name);
  if ([project, ...settings].some((source) => listed(source, "disabledMcpjsonServers"))) return "rejected";
  if ([project, ...settings].some((source) => listed(source, "enabledMcpjsonServers") || source.enableAllProjectMcpServers === true)) return "approved";
  return "pending";
}
