import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import type { EngineMcpLink } from "@tomradex/agent";
import { readJsonOr } from "@tomradex/contracts";
import { MCP_NAME, userMcpLink, type CliLocator } from "@tomradex/engine-kit";

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

/** The file's top-level object, {} when it is missing or holds something else; one that does not parse throws. */
function readJson(file: string): Record<string, unknown> {
  const parsed = readJsonOr<unknown>(file, {}, { missingOnly: true });
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
