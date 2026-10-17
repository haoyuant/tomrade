import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { parse as parseYaml } from "yaml";
import type { EngineMcpLink, McpLinkView } from "@tomradex/agent";
import { chosenCommand, MCP_NAME, type CliLocator, type CliRunResult } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/mcp";

/** Hermes keeps everything under HERMES_HOME, else `~/.hermes`. */
export const hermesHome = (env: NodeJS.ProcessEnv = process.env): string => env.HERMES_HOME?.trim() || path.join(os.homedir(), ".hermes");
export const hermesConfigFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(hermesHome(env), "config.yaml");
export const hermesPluginDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(hermesHome(env), "plugins", MCP_NAME);

/**
 * Hermes expands `${VAR}` in a server's headers when it connects: a session
 * Tomrade starts exports its token, so the one user-level entry serves those
 * too. Hermes refuses a server whose variable is unset or empty, so the plugin
 * sets it to "none" (no token, to Tomrade) for every other session; plugins
 * load before MCP servers connect, and an exported token is left alone.
 */
export const TOKEN_HEADER = "${TOMRADE_MCP_TOKEN}";

const PLUGIN_MARK = "Written by Tomrade";

/**
 * A user plugin that reports a Hermes session's lifecycle as Claude Code's
 * hooks name it: to the session's own address when Tomrade started it (its
 * token is in the environment), otherwise tokenless, tagged as Hermes, with
 * the folder it runs in. Plugin hooks need no per-command consent, unlike
 * shell hooks. It also gives the token header its "none" outside Tomrade.
 */
export function hermesPlugin(eventUrl: string): { manifest: string; source: string } {
  const manifest = `name: ${MCP_NAME}
version: "1"
description: "${PLUGIN_MARK}: reports Hermes sessions to Tomrade."
provides_hooks:
  - on_session_start
  - pre_llm_call
  - pre_tool_call
  - post_tool_call
  - on_session_end
  - on_session_finalize
`;
  const source = `"""${PLUGIN_MARK}: reports this Hermes session to Tomrade. \`hermes plugins disable ${MCP_NAME}\` turns it off."""

import json
import os
import threading
import urllib.request

os.environ.setdefault("TOMRADE_MCP_TOKEN", "none")

EVENT_URL = ${JSON.stringify(eventUrl)}
NAMES = {"terminal": "Bash", "read_file": "Read", "write_file": "Write", "patch": "Edit", "search_files": "Grep"}


def _post(event, **fields):
    token = os.environ.get("TOMRADE_MCP_TOKEN", "")
    url = EVENT_URL.replace("/sessions/event", "/sessions/" + token + "/event") if token not in ("", "none") else EVENT_URL
    body = json.dumps({"hook_event_name": event, "cwd": os.getcwd(), **fields}, default=str).encode()
    request = urllib.request.Request(url, data=body, method="POST", headers={"content-type": "application/json", "x-tomrade-agent": "hermes"})

    def send():
        try:
            urllib.request.urlopen(request, timeout=2).read()
        except Exception:
            pass

    threading.Thread(target=send, daemon=True).start()


def _tool(name):
    return NAMES.get(name, name)


def register(ctx):
    ctx.register_hook("on_session_start", lambda session_id=None, **_: _post("SessionStart", session_id=session_id))
    ctx.register_hook("pre_llm_call", lambda session_id=None, **_: _post("UserPromptSubmit", session_id=session_id))
    ctx.register_hook("pre_tool_call", lambda tool_name="", args=None, session_id=None, **_: _post("PreToolUse", session_id=session_id, tool_name=_tool(tool_name), tool_input=args or {}))

    def post_tool(tool_name="", args=None, result=None, session_id=None, status=None, error_message=None, **_):
        failed = bool(error_message) or status in ("error", "failed")
        _post("PostToolUseFailure" if failed else "PostToolUse", session_id=session_id, tool_name=_tool(tool_name), tool_input=args or {},
              **({"tool_error": error_message or str(result)} if failed else {"tool_output": str(result)[:2000]}))

    def turn_end(session_id=None, failed=False, turn_exit_reason=None, **_):
        if failed:
            _post("StopFailure", session_id=session_id, error_message=turn_exit_reason)
        else:
            _post("Stop", session_id=session_id)

    ctx.register_hook("post_tool_call", post_tool)
    ctx.register_hook("on_session_end", turn_end)
    ctx.register_hook("on_session_finalize", lambda session_id=None, **_: _post("SessionEnd", session_id=session_id, reason="exit"))
`;
  return { manifest, source };
}

const failure = (result: CliRunResult): string | null =>
  result.error?.message ?? (result.code === 0 ? null : (result.stderr.trim() || result.stdout.trim() || `exited with ${result.code}`).slice(-400));

const quote = (args: string[]) => ["hermes", ...args].map((arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg}'`)).join(" ");

/**
 * Hermes' own sessions reach Tomrade through a `tomrade` server in its
 * config.yaml, changed with `hermes config set|unset` (Hermes owns that
 * file's format), and the reporting plugin, turned on with `hermes plugins`.
 */
export function hermesMcpLink(ctx: Context, cli: CliLocator): EngineMcpLink {
  const adds = (url: string) => [
    ["config", "set", `mcp_servers.${MCP_NAME}.url`, url],
    ["config", "set", `mcp_servers.${MCP_NAME}.headers.X-Tomrade-Run`, TOKEN_HEADER],
    // Compound tools call a worker model and can outlast a short default.
    ["config", "set", `mcp_servers.${MCP_NAME}.timeout`, "600"]
  ];
  const removes = [["config", "unset", `mcp_servers.${MCP_NAME}`]];
  const view = (error?: string): McpLinkView => {
    const url = ctx.mcp.url;
    const file = hermesConfigFile();
    const manual = { connect: adds(url ?? "<url>").map(quote).join(" && "), disconnect: removes.map(quote).join(" && ") };
    let configuredUrl: string | null = null;
    try {
      if (fs.existsSync(file)) {
        const servers = (parseYaml(fs.readFileSync(file, "utf8")) as { mcp_servers?: Record<string, { url?: unknown }> } | null)?.mcp_servers;
        const configured = servers?.[MCP_NAME]?.url;
        configuredUrl = typeof configured === "string" ? configured : null;
      }
    } catch (cause) {
      return { state: "unavailable", url, configuredUrl, file, manual, error: error ?? `Cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    const state = !url ? "unavailable" : configuredUrl === url ? "connected" : configuredUrl ? "stale" : "missing";
    return { state, url, configuredUrl, file, manual, ...(error ? { error } : {}) };
  };
  const run = async (steps: string[][]): Promise<string | null> => {
    for (const args of steps) {
      try {
        const why = failure(await cli.run(chosenCommand(ctx, "hermes"), args, 30_000));
        if (why) return why;
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    }
    return null;
  };
  const ours = () => {
    try { return fs.readFileSync(path.join(hermesPluginDir(), "__init__.py"), "utf8").includes(PLUGIN_MARK); } catch { return false; }
  };
  return {
    async status() {
      return view();
    },
    async connect() {
      const url = ctx.mcp.url;
      const eventUrl = ctx.mcp.eventUrl;
      if (!url || !eventUrl) return view("Tomrade's MCP server is not running");
      const dir = hermesPluginDir();
      // A folder of the same name that is someone else's plugin is left alone; only the server is added.
      if (ours() || !fs.existsSync(dir)) {
        try {
          const plugin = hermesPlugin(eventUrl);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "plugin.yaml"), plugin.manifest);
          fs.writeFileSync(path.join(dir, "__init__.py"), plugin.source);
        } catch (cause) {
          return view(cause instanceof Error ? cause.message : String(cause));
        }
      }
      return view((await run([...adds(url), ...(ours() ? [["plugins", "enable", MCP_NAME]] : [])])) ?? undefined);
    },
    async disconnect() {
      if (!view().configuredUrl) return view();
      const error = await run(removes);
      if (!error && ours()) {
        await run([["plugins", "disable", MCP_NAME]]);
        fs.rmSync(hermesPluginDir(), { recursive: true, force: true });
      }
      return view(error ?? undefined);
    }
  };
}
