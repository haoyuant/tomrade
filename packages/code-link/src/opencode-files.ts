/** What a connected repository carries for OpenCode; engine-opencode keeps its own copy for the user-level files, so code link needs no engine. */

const PLUGIN_MARK = "Written by Tomrade";

/**
 * The `tomrade` server as OpenCode's config names it. Its header reads the
 * token a session Tomrade starts exports; anywhere else OpenCode sends it
 * empty, which Tomrade reads as no token. Both copies of a same-named server
 * connect, so this one carries the session's token too.
 */
function opencodeMcpEntry(url: string): Record<string, unknown> {
  // The pane header names where the session runs, from the variable Tomrade's terminal sets; empty elsewhere.
  return { type: "remote", url, enabled: true, headers: { "X-Tomrade-Run": "{env:TOMRADE_MCP_TOKEN}", "X-Tomrade-Herdr-Pane": "{env:HERDR_PANE_ID}" } };
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
const textOf = (parts) => Array.isArray(parts) ? parts.filter((part) => part?.type === "text").map((part) => part.text).join("\\n") : typeof parts === "string" ? parts : "";
const promptOf = (p) => textOf(p?.parts) || textOf(p?.info?.parts) || textOf(p?.info?.content) || (typeof p?.info?.text === "string" ? p.info.text : "");

export const TomradePlugin = async ({ directory }) => {
  if (globalThis[loaded]) return {};
  globalThis[loaded] = true;
  const token = process.env.TOMRADE_MCP_TOKEN;
  const url = token ? eventUrl.replace("/sessions/event", "/sessions/" + token + "/event") : eventUrl;
  const prompts = new Set();
  const pane = { ...(process.env.HERDR_PANE_ID ? { herdr_pane: process.env.HERDR_PANE_ID } : {}), ...(process.env.TERM_PROGRAM || process.env.WT_SESSION ? { terminal: process.env.TERM_PROGRAM || "WindowsTerminal" } : {}) };
  const ask = (payload) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-tomrade-agent": "opencode" },
    body: JSON.stringify({ cwd: directory, ...pane, ...payload }), signal: AbortSignal.timeout(2000) }).then((response) => response.json()).catch(() => ({}));
  const post = (payload) => { void ask(payload); };
  return {
    event: async ({ event }) => {
      const p = event.properties ?? {};
      const session_id = p.sessionID ?? p.info?.id;
      if (event.type === "session.created") post({ hook_event_name: "SessionStart", session_id, ...(p.info?.title ? { title: p.info.title } : {}) });
      else if (event.type === "session.updated" && p.info?.title) post({ hook_event_name: "TitleUpdate", session_id, title: p.info.title });
      else if (event.type === "message.updated" && p.info?.role === "user" && !prompts.has(p.info.id)) {
        prompts.add(p.info.id);
        const prompt = promptOf(p);
        post({ hook_event_name: "UserPromptSubmit", session_id, ...(prompt ? { prompt } : {}) });
      } else if (event.type === "session.idle") post({ hook_event_name: "Stop", session_id });
      else if (event.type === "session.error") post({ hook_event_name: "StopFailure", session_id, error_message: p.error?.data?.message ?? p.error?.name });
      else if (event.type === "session.deleted") post({ hook_event_name: "SessionEnd", session_id, reason: "exit" });
    },
    // Tomrade may refuse a tool (a code change before the session claimed a ticket): the reason reaches the agent as the tool's error.
    "tool.execute.before": async (input, output) => {
      const reply = await ask({ hook_event_name: "PreToolUse", session_id: input.sessionID, tool_name: names[input.tool] ?? input.tool, tool_input: output?.args ?? {} });
      const decision = reply?.hookSpecificOutput;
      if (decision?.permissionDecision === "deny") throw new Error(decision.permissionDecisionReason || "Tomrade refused this tool call");
    },
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
