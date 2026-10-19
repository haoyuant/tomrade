import type { CliHookAnswer, CliHookCall, CliHookEvent } from "@tomradex/agent";

/** The agents' hook names, read as one set: a failed tool is still `post-tool`, with its error. */
const EVENTS: Record<string, CliHookEvent> = {
  SessionStart: "session-start",
  UserPromptSubmit: "prompt",
  PreToolUse: "pre-tool",
  PostToolUse: "post-tool",
  PostToolUseFailure: "post-tool",
  Stop: "stop",
  SessionEnd: "session-end"
};

export const cliHookEvent = (name: unknown): CliHookEvent | null => (typeof name === "string" ? (EVENTS[name] ?? null) : null);

/**
 * What DeepSeek Harness's own Claude Code hook bridge posts for a session, with
 * Tomrade's answer read back; its reporter still tells the session's story, so
 * these reach plugins from the bridge alone.
 */
export const BRIDGED_BY_DSH: ReadonlySet<CliHookEvent> = new Set(["session-start", "prompt", "pre-tool", "post-tool", "stop"]);

/** Which of Tomrade's posts a hook came from: dsh's bridge (answers only) or its reporter (the session's story). */
export type HookSource = "dsh-hooks" | "dsh-report";

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : value === undefined || value === null ? undefined : JSON.stringify(value));

/** A hook's payload as plugins read it, whichever agent sent it. */
export function cliHookCall(event: CliHookEvent, raw: Record<string, unknown>, where: Pick<CliHookCall, "agent" | "answerable" | "projectId" | "sessionId" | "ticket">): CliHookCall {
  const toolName = typeof raw.tool_name === "string" ? raw.tool_name : null;
  const output = text(raw.tool_output ?? raw.tool_response);
  const error = text(raw.tool_error ?? (raw.hook_event_name === "PostToolUseFailure" ? raw.error : undefined));
  return {
    event,
    ...where,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    ...(toolName && (event === "pre-tool" || event === "post-tool")
      ? { tool: { name: toolName, input: raw.tool_input ?? {}, ...(event === "post-tool" && output !== undefined ? { output } : {}), ...(error !== undefined ? { error } : {}) } }
      : {}),
    ...(event === "stop" && typeof raw.last_assistant_message === "string" ? { text: raw.last_assistant_message } : {}),
    raw
  };
}

/**
 * An answer in Claude Code's hook output, which Claude Code, WorkBuddy, Pi's
 * session extension and DeepSeek Harness's bridge all read. The event-scoped
 * fields name their event, or Claude Code and dsh pass them over; context also
 * stays at the top, where Pi's extension reads it.
 */
export function hookReply(hookEventName: string, answer: CliHookAnswer): Record<string, unknown> {
  const event = cliHookEvent(hookEventName);
  if (answer.deny && event === "pre-tool") return { hookSpecificOutput: { hookEventName, permissionDecision: "deny", permissionDecisionReason: answer.deny } };
  if (answer.continue && event === "stop") return { decision: "block", reason: answer.continue };
  if (answer.context && (event === "session-start" || event === "prompt" || event === "post-tool")) {
    return { additionalContext: answer.context, hookSpecificOutput: { hookEventName, additionalContext: answer.context } };
  }
  return {};
}

/** Tomrade's own answer first — a refusal it makes is never a plugin's to lift — and a plugin's context beside its own. */
export function mergeAnswers(own: CliHookAnswer, plugin: CliHookAnswer | undefined): CliHookAnswer {
  if (!plugin) return own;
  if (own.deny || own.continue) return own;
  const context = [own.context, plugin.context].filter((c): c is string => !!c?.trim()).join("\n\n");
  return { ...(plugin.deny ? { deny: plugin.deny } : {}), ...(plugin.continue ? { continue: plugin.continue } : {}), ...(context ? { context } : {}) };
}
