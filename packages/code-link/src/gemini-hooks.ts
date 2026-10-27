import { hookCommand } from "./connect.js";

/** The engine id Gemini CLI's sessions carry. */
export const GEMINI_AGENT = "gemini";

/** The Gemini CLI hook events a session Tomrade started reports, as its settings name them (Gemini CLI 0.65). */
const GEMINI_HOOK_EVENTS = ["SessionStart", "BeforeAgent", "BeforeTool", "Notification", "AfterTool", "AfterAgent", "SessionEnd"] as const;

/**
 * The `hooks` of a session's Gemini settings: the person's own, then Tomrade's
 * on each event it reads. Each posts Gemini's payload to the session's address
 * and prints nothing, whatever Tomrade answers and whether it answers at all,
 * so Gemini never acts on it and waits at most a moment for it.
 */
export function geminiHooks(eventUrl: string, own?: unknown): Record<string, unknown> {
  const hooks: Record<string, unknown> = own && typeof own === "object" && !Array.isArray(own) ? { ...(own as Record<string, unknown>) } : {};
  // Named, so Gemini's "Executing Hook" line says whose it is rather than the whole command.
  const ours = { type: "command", name: "tomrade", command: hookCommand(eventUrl), timeout: 5000 };
  for (const event of GEMINI_HOOK_EVENTS) hooks[event] = [...(Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []), { hooks: [ours] }];
  return hooks;
}

/** What Gemini CLI's hooks post (`createBaseInput` and each event's own fields). */
interface GeminiPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  prompt_response?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { llmContent?: unknown; returnDisplay?: unknown; error?: { message?: string } | null };
  notification_type?: string;
  message?: string;
  reason?: string;
}

// Claude Code's names for Gemini CLI's own tools, which Tomrade's tool summaries and checks know.
const TOOLS: Record<string, string> = {
  run_shell_command: "Bash",
  read_file: "Read",
  write_file: "Write",
  replace: "Edit",
  glob: "Glob",
  grep_search: "Grep",
  list_directory: "LS",
  web_fetch: "WebFetch",
  google_web_search: "WebSearch"
};

/**
 * Gemini CLI's hook payload in the Claude Code shape Tomrade's sessions read;
 * null for an event it does not read. Its session id, record and folder carry
 * over by the same names.
 */
export function geminiHookPayload(payload: unknown): Record<string, unknown> | null {
  const p = (payload ?? {}) as GeminiPayload;
  const tool = p.tool_name ? { tool_name: TOOLS[p.tool_name] ?? p.tool_name, tool_input: p.tool_input ?? {} } : {};
  switch (p.hook_event_name) {
    case "SessionStart":
    case "SessionEnd":
      return { ...p };
    case "BeforeAgent":
      return { ...p, hook_event_name: "UserPromptSubmit" };
    case "AfterAgent":
      return { ...p, hook_event_name: "Stop", ...(typeof p.prompt_response === "string" ? { last_assistant_message: p.prompt_response } : {}) };
    case "BeforeTool":
      return { ...p, hook_event_name: "PreToolUse", ...tool };
    case "AfterTool": {
      const response = p.tool_response ?? {};
      if (response.error) return { ...p, hook_event_name: "PostToolUseFailure", ...tool, tool_error: response.error.message ?? "" };
      const output = typeof response.llmContent === "string" ? response.llmContent : typeof response.returnDisplay === "string" ? response.returnDisplay : response;
      return { ...p, hook_event_name: "PostToolUse", ...tool, tool_output: output };
    }
    case "Notification":
      // Gemini notifies only as it asks to run a tool.
      return p.notification_type === "ToolPermission" ? { ...p, notification_type: "permission_prompt" } : null;
    default:
      return null;
  }
}
