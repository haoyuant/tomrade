import type { ThreadMessage } from "./types.js";

const RECAP_CHARS = 16_000;

/**
 * The conversation so far, for an engine that keeps its own session and is
 * starting a new one on a thread that already has history: its old session is
 * gone, or the thread came from another engine. The newest lines win when it is
 * long. Everything after the last answer is left out: the message being answered
 * now (the turn carries it), and notes or unanswered tries of it before.
 */
export function conversationRecap(messages: ThreadMessage[]): string {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role !== "agent") end--;
  const lines: string[] = [];
  let size = 0;
  for (let i = end - 1; i >= 0 && size < RECAP_CHARS; i--) {
    const { role, block } = messages[i];
    const text = block.type === "text" || block.type === "question" ? block.text : null;
    if (role === "system" || !text?.trim()) continue;
    const line = `${role === "user" ? "User" : "Assistant"}: ${text.trim()}`;
    lines.unshift(line);
    size += line.length;
  }
  if (!lines.length) return "";
  const body = lines.join("\n\n");
  return [
    "This conversation began before your current session, so you do not remember it. What was said so far:",
    "<conversation>",
    body.length > RECAP_CHARS ? `…${body.slice(-RECAP_CHARS)}` : body,
    "</conversation>"
  ].join("\n");
}

/** The recap and the turn's own prompt, in that order; the prompt alone when there is nothing to recap. */
export const withRecap = (recap: string | undefined, prompt: string): string => (recap ? `${recap}\n\n${prompt}` : prompt);
