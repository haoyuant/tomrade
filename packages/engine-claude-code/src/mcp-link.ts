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
  file(): string;
  /** The address its `tomrade` entry names; null when there is none; throws when the file cannot be read. */
  configuredUrl(): string | null;
  add(url: string): string[];
  remove(): string[];
  cli: CliLocator;
  engineId: string;
}

const failure = (result: CliRunResult): string | null =>
  result.error?.message ?? (result.code === 0 ? null : (result.stderr.trim() || result.stdout.trim() || `exited with ${result.code}`).slice(-400));

/** Status reads the agent's file; changes go through its own CLI, which owns that file's format. */
export function userMcpLink(ctx: Context, config: UserMcpConfig): EngineMcpLink {
  const name = config.cli.name;
  const quote = (args: string[]) => [name, ...args].map((arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : `"${arg}"`)).join(" ");
  const view = (error?: string): McpLinkView => {
    const url = ctx.mcp.url;
    const manual = { connect: quote(config.add(url ?? "<url>")), disconnect: quote(config.remove()) };
    let configuredUrl: string | null = null;
    try {
      configuredUrl = config.configuredUrl();
    } catch (cause) {
      return { state: "unavailable", url, configuredUrl, file: config.file(), manual, error: error ?? `Cannot read ${config.file()}: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    // A stale entry has to go before the new one is added.
    if (configuredUrl) manual.connect = `${manual.disconnect}; ${manual.connect}`;
    const state = !url ? "unavailable" : configuredUrl === url ? "connected" : configuredUrl ? "stale" : "missing";
    return { state, url, configuredUrl, file: config.file(), manual, ...(error ? { error } : {}) };
  };
  const run = async (args: string[]): Promise<string | null> => {
    try {
      return failure(await config.cli.run(chosenCommand(ctx, config.engineId), args, 30_000));
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  };
  return {
    async status() {
      return view();
    },
    async connect() {
      const url = ctx.mcp.url;
      if (!url) return view("Tomrade's MCP server is not running");
      const before = view();
      if (before.state === "connected") return before;
      if (before.configuredUrl) {
        const error = await run(config.remove());
        if (error) return view(error);
      }
      return view((await run(config.add(url))) ?? undefined);
    },
    async disconnect() {
      if (!view().configuredUrl) return view();
      return view((await run(config.remove())) ?? undefined);
    }
  };
}

/** Claude Code keeps user-scope servers in `.claude.json`, beside CLAUDE_CONFIG_DIR's settings or in the home folder. */
export function claudeUserFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
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
  return { ...userMcpLink(ctx, {
    engineId: "claude-code",
    cli,
    file: () => claudeUserFile(),
    configuredUrl: () => urlOf((readJson(claudeUserFile()).mcpServers as Record<string, unknown> | undefined)?.[MCP_NAME]),
    add: (url) => ["mcp", "add", "--scope", "user", "--transport", "http", MCP_NAME, url],
    remove: () => ["mcp", "remove", "--scope", "user", MCP_NAME]
  }), projectApproval: (dir) => claudeProjectServerApproval(dir) };
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
