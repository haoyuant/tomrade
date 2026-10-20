/** The Cursor hook events Tomrade listens to, as `.cursor/hooks.json` names them. */
export const CURSOR_HOOK_EVENTS = ["sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUse", "postToolUseFailure", "afterAgentResponse", "stop", "sessionEnd"] as const;

/** The POSIX script a connected repository carries; Cursor runs it from the project root. */
export const CURSOR_HOOK_SCRIPT = ".cursor/hooks/tomrade";
/** Its Windows twin: given a path without an extension, Cursor on Windows runs the `.ps1` beside it. */
export const CURSOR_HOOK_POWERSHELL = `${CURSOR_HOOK_SCRIPT}.ps1`;
/** The bare path, which runs on every system; so it needs the executable bit everywhere but Windows. */
export const CURSOR_HOOK_COMMAND = CURSOR_HOOK_SCRIPT;
/** What an older Tomrade committed: `sh` runs it, which Windows has only with Git Bash. */
export const LEGACY_CURSOR_HOOK_SCRIPT = ".cursor/hooks/tomrade.sh";
const LEGACY_CURSOR_HOOK_COMMAND = `sh ${LEGACY_CURSOR_HOOK_SCRIPT}`;
const FORMS = [
  { command: CURSOR_HOOK_COMMAND, scripts: [CURSOR_HOOK_SCRIPT, CURSOR_HOOK_POWERSHELL] },
  { command: LEGACY_CURSOR_HOOK_COMMAND, scripts: [LEGACY_CURSOR_HOOK_SCRIPT] }
];

/**
 * The reporting script: Cursor (2026.10) skips a hook whose command names
 * curl or wget, so the command lives in a script of its own.
 */
export function cursorHookScript(command: string): string {
  return `#!/bin/sh
# Written by Tomrade: reports Cursor sessions in this repository to Tomrade. Cursor runs it from .cursor/hooks.json.
${command}
`;
}

/** The same report for Cursor on Windows, which pipes the payload into the script. */
export function cursorHookPowerShell(script: string): string {
  return `# Written by Tomrade: reports Cursor sessions in this repository to Tomrade. Cursor on Windows runs it from .cursor/hooks.json.
${script}
`;
}

type HookEntry = { command?: unknown };
const ours = (entry: unknown) => FORMS.some(({ command }) => (entry as HookEntry)?.command === command);

/**
 * `.cursor/hooks.json` with Tomrade's script once on each event, after the
 * person's own hooks, in place of an older Tomrade's. Throws on a file that
 * is not a JSON object.
 */
export function withCursorHooks(text: string): string {
  const config = (text.trim() ? JSON.parse(text) : {}) as Record<string, unknown>;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("expected a JSON object");
  const hooks = { ...((config.hooks as Record<string, unknown> | undefined) ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    hooks[event] = entries.filter((entry) => !ours(entry));
  }
  for (const event of CURSOR_HOOK_EVENTS) hooks[event] = [...(Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []), { command: CURSOR_HOOK_COMMAND }];
  return JSON.stringify({ ...config, version: config.version ?? 1, hooks }, null, 2) + "\n";
}

/**
 * The scripts a hooks.json runs on every event Tomrade listens to — today's
 * pair, or the one an older Tomrade wrote — or none.
 */
export function cursorHookScripts(text: string | undefined): string[] {
  let config: { hooks?: Record<string, unknown> };
  try {
    config = JSON.parse(text || "{}") as typeof config;
  } catch {
    return [];
  }
  const form = FORMS.find(({ command }) => CURSOR_HOOK_EVENTS.every((event) => {
    const entries = config?.hooks?.[event];
    return Array.isArray(entries) && entries.some((entry) => (entry as HookEntry)?.command === command);
  }));
  return form?.scripts ?? [];
}

interface CursorPayload {
  hook_event_name?: string;
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  error_message?: string;
  text?: string;
  status?: string;
  reason?: string;
  tomrade_agent?: string;
  herdr_pane?: string;
  terminal?: string;
}

const EVENTS: Record<string, string> = {
  sessionStart: "SessionStart",
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  sessionEnd: "SessionEnd"
};
// Claude Code's names, which Tomrade's tool summaries know.
const TOOLS: Record<string, string> = { Shell: "Bash" };

/**
 * Turns Cursor's hook payloads (cursor-agent 2026.10) into the Claude Code
 * shape Tomrade's sessions read. Cursor's `stop` carries no text, so the
 * last `afterAgentResponse` of each conversation is kept for it.
 */
export function cursorHookReader(): (payload: unknown) => Record<string, unknown> | null {
  const said = new Map<string, string>();
  return (payload) => {
    const p = (payload ?? {}) as CursorPayload;
    const session_id = p.session_id ?? p.conversation_id;
    const cwd = p.cwd ?? p.workspace_roots?.[0];
    if (!session_id || !cwd || !p.hook_event_name) return null;
    const base = { session_id, cwd, tomrade_agent: "cursor", ...(p.herdr_pane ? { herdr_pane: p.herdr_pane } : {}), ...(p.terminal ? { terminal: p.terminal } : {}) };
    const tool = p.tool_name ? { tool_name: TOOLS[p.tool_name] ?? p.tool_name, tool_input: p.tool_input ?? {} } : {};
    switch (p.hook_event_name) {
      case "afterAgentResponse":
        if (p.text?.trim()) said.set(session_id, p.text);
        return null;
      case "stop": {
        const text = said.get(session_id);
        said.delete(session_id);
        if (p.status === "error") return { ...base, hook_event_name: "StopFailure", error_message: p.error_message ?? "the turn failed", ...(text ? { last_assistant_message: text } : {}) };
        return { ...base, hook_event_name: "Stop", ...(text ? { last_assistant_message: text } : {}) };
      }
      case "sessionEnd":
        said.delete(session_id);
        return { ...base, hook_event_name: "SessionEnd", reason: p.reason ?? "" };
      case "postToolUse":
        return { ...base, hook_event_name: "PostToolUse", ...tool, tool_output: p.tool_output };
      case "postToolUseFailure":
        return { ...base, hook_event_name: "PostToolUseFailure", ...tool, tool_error: p.error_message ?? "" };
      default: {
        const name = EVENTS[p.hook_event_name];
        return name ? { ...base, hook_event_name: name, ...tool } : null;
      }
    }
  };
}
