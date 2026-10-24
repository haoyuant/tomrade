/** SDK 0.2.15: what a CLI agent's hook says happened, in one set of names whichever agent sent it. */
export type CliHookEvent = "session-start" | "prompt" | "pre-tool" | "post-tool" | "stop" | "session-end";

export const CLI_HOOK_EVENTS: readonly CliHookEvent[] = ["session-start", "prompt", "pre-tool", "post-tool", "stop", "session-end"];

/** The agents whose hooks reach Tomrade at all: in sessions it starts, or in repositories it connects. */
const REPORTING = ["claude-code", "workbuddy", "dsh", "pi", "codex", "cursor", "opencode", "hermes"] as const;

// Codex reads Claude Code's hook output (PreToolUse deny and context, SessionStart/UserPromptSubmit/PostToolUse
// context, Stop block); OpenCode's and Pi's extensions block a tool on a deny and read nothing else.
const ANSWERS: Record<CliHookEvent, readonly string[]> = {
  "session-start": ["claude-code", "workbuddy", "dsh", "codex"],
  prompt: ["claude-code", "workbuddy", "dsh", "codex"],
  "pre-tool": ["claude-code", "workbuddy", "dsh", "pi", "codex", "opencode"],
  "post-tool": ["claude-code", "workbuddy", "dsh", "pi", "codex"],
  stop: ["claude-code", "workbuddy", "dsh", "codex"],
  "session-end": []
};

/**
 * Which agents a CLI hook reaches. `answers`: the agent acts on the answer —
 * in a session Tomrade started, or in a connected repository whose hooks
 * leave Tomrade's reply on stdout. `sees`: the hook hears the event, and its
 * answer goes nowhere (Cursor's script swallows it, Hermes reports only).
 * Gemini CLI and Antigravity report no hooks at all.
 */
const reach = (event: CliHookEvent) => ({ answers: ANSWERS[event], sees: REPORTING.filter((agent) => !ANSWERS[event].includes(agent)) });

export const CLI_HOOK_COVERAGE: Readonly<Record<CliHookEvent, { answers: readonly string[]; sees: readonly string[] }>> = {
  "session-start": reach("session-start"),
  prompt: reach("prompt"),
  "pre-tool": reach("pre-tool"),
  "post-tool": reach("post-tool"),
  stop: reach("stop"),
  "session-end": reach("session-end")
};
