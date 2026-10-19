import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import type { EngineMcpLink, McpLinkView } from "@tomradex/agent";
import type {} from "@tomradex/mcp";

/** OpenCode's global config folder: XDG_CONFIG_HOME/opencode, else `~/.config/opencode`. */
export const opencodeConfigDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "opencode");
/** OpenCode merges opencode.json with config.json and opencode.jsonc, so Tomrade's entry lives in the plain JSON one. */
export const opencodeUserFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(opencodeConfigDir(env), "opencode.json");
export const opencodeUserPlugin = (env: NodeJS.ProcessEnv = process.env): string => path.join(opencodeConfigDir(env), "plugins", "tomrade.js");

const PLUGIN_MARK = "Written by Tomrade";

/**
 * The `tomrade` server as OpenCode's config names it. Its header reads the
 * token a session Tomrade starts exports; anywhere else OpenCode sends it
 * empty, which Tomrade reads as no token. Both copies of a same-named server
 * connect, so this one carries the session's token too.
 */
export function opencodeMcpEntry(url: string): Record<string, unknown> {
  return { type: "remote", url, enabled: true, headers: { "X-Tomrade-Run": "{env:TOMRADE_MCP_TOKEN}" } };
}

/**
 * A plugin that reports an OpenCode session's lifecycle as Claude Code's hooks
 * name it, with the folder it runs in: to the session's own address when
 * Tomrade started it, otherwise tokenless and tagged as OpenCode. The global
 * and a repository's copy may both load; the first one does it all.
 */
export function opencodePlugin(eventUrl: string): string {
  return `// ${PLUGIN_MARK}: reports OpenCode sessions to Tomrade. Delete this file to stop.
const eventUrl = ${JSON.stringify(eventUrl)};
const names = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", glob: "Glob", list: "LS" };
const loaded = Symbol.for("tomrade.opencode");

export const TomradePlugin = async ({ directory }) => {
  if (globalThis[loaded]) return {};
  globalThis[loaded] = true;
  const token = process.env.TOMRADE_MCP_TOKEN;
  const url = token ? eventUrl.replace("/sessions/event", "/sessions/" + token + "/event") : eventUrl;
  const prompts = new Set();
  const pane = { ...(process.env.HERDR_PANE_ID ? { herdr_pane: process.env.HERDR_PANE_ID } : {}), ...(process.env.TERM_PROGRAM ? { terminal: process.env.TERM_PROGRAM } : {}) };
  const post = (payload) => { void fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-tomrade-agent": "opencode" },
    body: JSON.stringify({ cwd: directory, ...pane, ...payload }), signal: AbortSignal.timeout(2000) }).catch(() => {}); };
  return {
    event: async ({ event }) => {
      const p = event.properties ?? {};
      const session_id = p.sessionID ?? p.info?.id;
      if (event.type === "session.created") post({ hook_event_name: "SessionStart", session_id });
      else if (event.type === "message.updated" && p.info?.role === "user" && !prompts.has(p.info.id)) {
        prompts.add(p.info.id);
        post({ hook_event_name: "UserPromptSubmit", session_id });
      } else if (event.type === "session.idle") post({ hook_event_name: "Stop", session_id });
      else if (event.type === "session.error") post({ hook_event_name: "StopFailure", session_id, error_message: p.error?.data?.message ?? p.error?.name });
      else if (event.type === "session.deleted") post({ hook_event_name: "SessionEnd", session_id, reason: "exit" });
    },
    "tool.execute.before": async (input, output) => post({ hook_event_name: "PreToolUse", session_id: input.sessionID, tool_name: names[input.tool] ?? input.tool, tool_input: output?.args ?? {} }),
    "tool.execute.after": async (input, output) => post({ hook_event_name: "PostToolUse", session_id: input.sessionID, tool_name: names[input.tool] ?? input.tool, tool_input: input.args ?? {}, tool_output: String(output?.output ?? "").slice(0, 2000) })
  };
};
`;
}

/** The address of the `tomrade` server a config names; null when there is none; throws on a file that is not JSON. */
export function configuredMcpUrl(text: string): string | null {
  const parsed = JSON.parse(text) as { mcp?: Record<string, { url?: unknown }> } | null;
  const url = parsed?.mcp?.tomrade?.url;
  return typeof url === "string" ? url : null;
}

/** A config with Tomrade's server set, or taken out; every other key as it was. */
export function withMcpEntry(text: string, url: string | null): string {
  const config = (text.trim() ? JSON.parse(text) : { $schema: "https://opencode.ai/config.json" }) as Record<string, unknown>;
  const { tomrade: _, ...others } = (config.mcp as Record<string, unknown> | undefined) ?? {};
  const mcp = url ? { ...others, tomrade: opencodeMcpEntry(url) } : others;
  const { mcp: __, ...rest } = config;
  return JSON.stringify(Object.keys(mcp).length ? { ...rest, mcp } : rest, null, 2) + "\n";
}

/**
 * OpenCode's own sessions reach Tomrade through its global opencode.json and
 * the reporting plugin, both written here: OpenCode has `mcp add` but no
 * command that takes a server back out.
 */
export function opencodeMcpLink(ctx: Context): EngineMcpLink {
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  const view = (error?: string): McpLinkView => {
    const url = ctx.mcp.url;
    const file = opencodeUserFile();
    const manual = { connect: `opencode mcp add tomrade --url ${url ?? "<url>"}`, disconnect: `edit ${file} and remove mcp.tomrade` };
    let configuredUrl: string | null = null;
    try {
      configuredUrl = configuredMcpUrl(read(file) || "{}");
    } catch (cause) {
      return { state: "unavailable", url, configuredUrl, file, manual, error: error ?? `Cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    const state = !url ? "unavailable" : configuredUrl === url ? "connected" : configuredUrl ? "stale" : "missing";
    return { state, url, configuredUrl, file, manual, ...(error ? { error } : {}) };
  };
  const attempt = (change: () => void): McpLinkView => {
    try {
      change();
      return view();
    } catch (cause) {
      return view(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const ours = (file: string) => read(file).includes(PLUGIN_MARK);
  return {
    async status() {
      return view();
    },
    async connect() {
      const url = ctx.mcp.url;
      const eventUrl = ctx.mcp.eventUrl;
      if (!url || !eventUrl) return view("Tomrade's MCP server is not running");
      return attempt(() => {
        const file = opencodeUserFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, withMcpEntry(read(file), url));
        const plugin = opencodeUserPlugin();
        // A tomrade.js that is someone else's is left alone.
        if (!fs.existsSync(plugin) || ours(plugin)) {
          fs.mkdirSync(path.dirname(plugin), { recursive: true });
          fs.writeFileSync(plugin, opencodePlugin(eventUrl));
        }
      });
    },
    async disconnect() {
      return attempt(() => {
        const file = opencodeUserFile();
        if (fs.existsSync(file)) fs.writeFileSync(file, withMcpEntry(read(file), null));
        const plugin = opencodeUserPlugin();
        if (ours(plugin)) fs.rmSync(plugin);
      });
    }
  };
}
