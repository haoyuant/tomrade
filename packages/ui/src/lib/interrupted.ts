import type { ThreadMessage } from "@tomradex/agent";

/**
 * The interruption notes that offer to continue, each with the conversation it continues: for this
 * conversation and for each conversation writing code in the background under it, only its newest
 * note, and only while that conversation is still interrupted. Earlier notes, and notes written
 * before notes were marked, stay as they are.
 */
export function interruptedNotes(messages: readonly ThreadMessage[], threadId: string, interrupted: (threadId: string) => boolean): Map<string, string> {
  const newest = new Map<string, string>();
  for (const m of messages) {
    if (m.block.type !== "note" || !m.block.interrupted) continue;
    newest.set(m.block.threadFor ?? threadId, m.id);
  }
  const out = new Map<string, string>();
  for (const [target, messageId] of newest) if (interrupted(target)) out.set(messageId, target);
  return out;
}
