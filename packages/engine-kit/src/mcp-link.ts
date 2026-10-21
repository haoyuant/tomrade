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
