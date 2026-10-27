import type { SessionView } from "./store.js";

/** The most of a session's first words a guess reads: its first sentence or two. */
export const GUESS_SAID_MAX = 240;

/** A ticket a session's first words sound like, offered while the session holds none. */
export interface TicketGuess {
  itemId: string;
  key: string;
  title: string;
}

/** A session a guess is for: a terminal conversation of the person's own, on no ticket, not told to go without one, still live. */
export const guessable = (s: SessionView): boolean => s.threadId === null && !s.itemIds.length && !s.withoutTicket && s.endedAt === null && s.state !== "ended" && s.state !== "lost";

/** The first sentence or two of what the person said, on one line; empty for nothing to go by, or a slash command. */
export function firstWords(prompt: string | undefined): string {
  const flat = (prompt ?? "").replace(/\s+/g, " ").trim();
  if (!flat || flat.startsWith("/")) return "";
  const two = (flat.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [flat]).slice(0, 2).join("").trim();
  return two.length > GUESS_SAID_MAX ? two.slice(0, GUESS_SAID_MAX) : two;
}

/** What find_similar answers, as far as a guess reads it. */
interface Similar {
  verdict?: string;
  matches?: { id?: string; key?: string; title?: string; kind?: string }[];
}

/** The ids find_similar matched, best first; none when it found nothing like these words. */
export function similarIds(answer: unknown): string[] {
  const similar = answer as Similar | null;
  if (!similar || similar.verdict === "none") return [];
  return (similar.matches ?? []).flatMap((m) => (m.id && (m.kind ?? "ticket") === "ticket" ? [m.id] : []));
}
