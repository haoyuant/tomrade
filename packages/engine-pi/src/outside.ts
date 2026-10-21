import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import type { EngineMcpLink, McpLinkView } from "@tomradex/agent";
import type { ConnectFileWriter } from "@tomradex/code-link";
import { errorMessage } from "@tomradex/contracts";
import type {} from "@tomradex/mcp";

/** pi's config folder: PI_CODING_AGENT_DIR, else `~/.pi/agent`. */
export const piAgentDir = (env: NodeJS.ProcessEnv = process.env): string => env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");

/** Where the user-level extension lives: pi loads every file in `<agent dir>/extensions` by itself. */
export const piUserExtension = (env: NodeJS.ProcessEnv = process.env): string => path.join(piAgentDir(env), "extensions", "tomrade.ts");

/**
 * The extension that connects a pi session Tomrade did not start: it
 * registers Tomrade's MCP server and posts the session's lifecycle as Claude
 * Code's hooks name it, tagged as pi, with the folder it runs in. A server in
 * mcp.json would win over the bridge a Tomrade session registers, so this is
 * an extension that steps aside when the session brings its own token. The
 * user-level and a repository's copy may both load; the first one does it all.
 */
export function outsideExtension(mcpUrl: string, eventUrl: string): string {
  const server = { url: mcpUrl, exposure: "direct", timeout: 600, description: "Tomrade: this project's backlog, tickets, files and workflows" };
  return `// Written by Tomrade: connects pi sessions you start yourself. Delete this file to disconnect.
const server = ${JSON.stringify(server)};
const eventUrl = ${JSON.stringify(eventUrl)};
const names = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "LS" };
const textOf = (content) => (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\\n");
const loaded = Symbol.for("tomrade.pi.outside");
const pane = { ...(process.env.HERDR_PANE_ID ? { herdr_pane: process.env.HERDR_PANE_ID } : {}), ...(process.env.TERM_PROGRAM || process.env.WT_SESSION ? { terminal: process.env.TERM_PROGRAM || "WindowsTerminal" } : {}) };

export default function (pi) {
  // A session Tomrade started registers its own server, with its token.
  if (process.env.TOMRADE_MCP_TOKEN || globalThis[loaded]) return;
  globalThis[loaded] = true;
  try { pi.registerMcpServer("tomrade", server); } catch {}
  let sessionId;
  let cwd;
  const post = (payload) => { void fetch(eventUrl, { method: "POST", headers: { "content-type": "application/json", "x-tomrade-agent": "pi" },
    body: JSON.stringify({ session_id: sessionId, cwd, ...pane, ...payload }), signal: AbortSignal.timeout(2000) }).catch(() => {}); };
  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    cwd = ctx.cwd;
    post({ hook_event_name: "SessionStart" });
  });
  pi.on("agent_start", () => post({ hook_event_name: "UserPromptSubmit" }));
  pi.on("tool_call", (event) => post({ hook_event_name: "PreToolUse", tool_name: names[event.toolName] ?? event.toolName, tool_input: event.input }));
  pi.on("tool_result", (event) => {
    const text = textOf(event.content);
    post({ hook_event_name: event.isError ? "PostToolUseFailure" : "PostToolUse", tool_name: names[event.toolName] ?? event.toolName,
      tool_input: event.input, ...(event.isError ? { tool_error: text } : { tool_output: text }) });
  });
  pi.on("agent_end", (event) => {
    const last = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (last?.stopReason === "error") post({ hook_event_name: "StopFailure", error_message: last.errorMessage });
    else if (last) post({ hook_event_name: "Stop", last_assistant_message: textOf(last.content) });
  });
  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit") post({ hook_event_name: "SessionEnd", reason: "exit" });
  });
}
`;
}

/** The MCP address an extension this function wrote names; null for any other file. */
export function outsideExtensionUrl(source: string): string | null {
  const line = /^const server = (\{.*\});$/m.exec(source)?.[1];
  if (!line) return null;
  try {
    const url = (JSON.parse(line) as { url?: unknown }).url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

/** A repository's `.pi/extensions/tomrade.ts` for code-link's Connect, which takes it through its connector registry. */
export const piConnector: ConnectFileWriter = { write: outsideExtension, url: outsideExtensionUrl };

/**
 * Pi's own sessions reach Tomrade through the user-level extension above,
 * written and removed here directly: pi has no command that installs a file.
 */
export function piMcpLink(ctx: Context): EngineMcpLink {
  /** What connecting writes, also kept where Tomrade can always write, for doing it by hand. */
  const source = (): string | null => (ctx.mcp.url && ctx.mcp.eventUrl ? outsideExtension(ctx.mcp.url, ctx.mcp.eventUrl) : null);
  const copy = (text: string): string => {
    const file = path.join(os.tmpdir(), `tomrade-pi-extension-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.ts`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
    return file;
  };
  const view = (error?: string): McpLinkView => {
    const url = ctx.mcp.url;
    const file = piUserExtension();
    const text = source();
    let spare = "<file>";
    try { if (text) spare = copy(text); } catch { /* the manual line names a placeholder */ }
    const manual = { connect: `mkdir -p "${path.dirname(file)}" && cp "${spare}" "${file}"`, disconnect: `rm "${file}"` };
    let configuredUrl: string | null = null;
    try {
      configuredUrl = fs.existsSync(file) ? outsideExtensionUrl(fs.readFileSync(file, "utf8")) : null;
    } catch (cause) {
      return { state: "unavailable", url, configuredUrl, file, manual, error: error ?? `Cannot read ${file}: ${errorMessage(cause)}` };
    }
    const state = !url ? "unavailable" : configuredUrl === url ? "connected" : configuredUrl ? "stale" : "missing";
    return { state, url, configuredUrl, file, manual, ...(error ? { error } : {}) };
  };
  const attempt = (change: () => void): McpLinkView => {
    try {
      change();
      return view();
    } catch (cause) {
      return view(errorMessage(cause));
    }
  };
  return {
    async status() {
      return view();
    },
    async connect() {
      const text = source();
      if (!text) return view("Tomrade's MCP server is not running");
      return attempt(() => {
        const file = piUserExtension();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      });
    },
    async disconnect() {
      const file = piUserExtension();
      // Only a file Tomrade wrote is removed.
      return attempt(() => {
        if (fs.existsSync(file) && outsideExtensionUrl(fs.readFileSync(file, "utf8")) !== null) fs.rmSync(file);
      });
    }
  };
}
