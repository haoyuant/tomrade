import type { ThreadMessage } from "@tomradex/agent";

/** Codex cannot reopen a session whose record is not under the current CODEX_HOME (moved, cleared, or another home). */
export const lostSession = (error: unknown): boolean => /no rollout found/i.test(error instanceof Error ? error.message : String(error));

const RECAP_CHARS = 16_000;

/**
 * The conversation so far, for a fresh session standing in for one Codex lost.
 * The newest lines win when it is long; the message being answered now is left
 * out, since the turn's prompt carries it.
 */
export function conversationRecap(messages: ThreadMessage[]): string {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === "user") end--;
  const lines: string[] = [];
  let size = 0;
  for (let i = end - 1; i >= 0 && size < RECAP_CHARS; i--) {
    const { role, block } = messages[i];
    const text = block.type === "text" ? block.text : block.type === "question" ? block.text : null;
    if (role === "system" || !text?.trim()) continue;
    const line = `${role === "user" ? "User" : "You"}: ${text.trim()}`;
    lines.unshift(line);
    size += line.length;
  }
  if (!lines.length) return "";
  const body = lines.join("\n\n");
  return [
    "Your earlier Codex session for this conversation could not be reopened, so this is a new session. The conversation so far:",
    "<conversation>",
    body.length > RECAP_CHARS ? `…${body.slice(-RECAP_CHARS)}` : body,
    "</conversation>"
  ].join("\n");
}
