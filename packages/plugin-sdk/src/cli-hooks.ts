/** SDK 0.2.15: what a CLI agent's hook says happened, in one set of names whichever agent sent it. */
export type CliHookEvent = "session-start" | "prompt" | "pre-tool" | "post-tool" | "stop" | "session-end";

export const CLI_HOOK_EVENTS: readonly CliHookEvent[] = ["session-start", "prompt", "pre-tool", "post-tool", "stop", "session-end"];

/** The agents whose hooks reach Tomrade at all: in sessions it starts, or in repositories it connects. */
const REPORTING = ["claude-code", "workbuddy", "dsh", "pi", "codex", "cursor", "opencode", "hermes"] as const;

const ANSWERS: Record<CliHookEvent, readonly string[]> = {
  "session-start": ["claude-code", "workbuddy", "dsh"],
  prompt: ["claude-code", "workbuddy", "dsh"],
  "pre-tool": ["claude-code", "workbuddy", "dsh", "pi"],
  "post-tool": ["claude-code", "workbuddy", "dsh", "pi"],
  stop: ["claude-code", "workbuddy", "dsh"],
  "session-end": []
};

/**
 * Which agents a CLI hook reaches. `answers`: in a session Tomrade started, the
 * agent acts on the answer. `sees`: the hook hears the event — a connected
 * repository's, or one the agent cannot be answered on — and its answer goes
 * nowhere. Gemini CLI and Antigravity report no hooks at all.
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
