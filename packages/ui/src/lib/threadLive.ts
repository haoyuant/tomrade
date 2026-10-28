import type { ThreadDetail, ThreadMessage } from "@tomradex/agent";

/**
 * A pushed message, put where the thread's own order (seq) says. Events held
 * back while the window slept can land after a newer one; appending them
 * would show a backlog below the question that followed it.
 */
export function insertMessage(messages: readonly ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  // The usual push comes after everything there: a message already held has a seq no later than the last.
  const last = messages.at(-1);
  if (!last || last.seq < message.seq) return [...messages, message];
  if (messages.some((m) => m.id === message.id)) return messages as ThreadMessage[];
  let at = messages.length;
  while (at > 0 && messages[at - 1]!.seq > message.seq) at--;
  return [...messages.slice(0, at), message, ...messages.slice(at)];
}

/** Whether a pushed message skips past ones the cache never saw: the wire dropped something, so fetch the thread. */
export function missedBefore(messages: readonly ThreadMessage[], message: ThreadMessage): boolean {
  const last = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  return messages.length > 0 && message.seq > last + 1;
}

/** Runs `refetch` on a wake signal, once for a burst of them (resume, unlock, focus and visibility tend to arrive together). */
export function catchUp(refetch: () => void, gapMs = 2_000, now: () => number = Date.now): () => void {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < gapMs) return;
    last = t;
    refetch();
  };
}

/**
 * The seq a cached thread holds every message through, so asking again sends only what is newer — a long conversation
 * refetched on focus or mount is otherwise sent whole. null asks for it whole: nothing held, another thread, or a gap
 * (seq counts from 1 without one, so a complete list is as long as its last seq).
 */
export function heldThrough(held: ThreadDetail | undefined, threadId: string): number | null {
  const last = held?.messages.at(-1)?.seq;
  return held && held.thread.id === threadId && last !== undefined && held.messages.length === last ? last : null;
}

/** A thread asked for after `heldThrough`: everything fresh, the held messages kept as they are with the new ones after them. */
export function withHeld(held: ThreadDetail, fresh: ThreadDetail): ThreadDetail {
  return { ...fresh, messages: fresh.messages.length ? [...held.messages, ...fresh.messages] : held.messages };
}
