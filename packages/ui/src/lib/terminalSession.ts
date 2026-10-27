import type { RecordLine, RecordRead } from "@tomradex/agent";
import type { SessionView } from "@tomradex/code-link";

/** The least time between two reads of one session's pane, or of its record: the panel never asks faster. */
export const READ_EVERY_MS = 1000;

/** How many rows the strip reads to find its two lines, and how many the drawer shows. */
export const STRIP_ROWS = 12;
export const DRAWER_ROWS = 60;

/** A line of a pane's screen that is furniture, not output: a rule, an empty input box, a shortcut hint. */
const FURNITURE = /^[>❯$%#│|?]+$|^\? for shortcuts|^esc to interrupt|^\d+ tokens?\b|^ctrl\+/i;

/** The last `n` lines of a pane's screen that say something, box drawing stripped. */
export function tailLines(screen: string | null | undefined, n: number): string[] {
  if (!screen) return [];
  const lines = screen
    .split("\n")
    .map((line) => line.replace(/[─-╿]/g, " ").replace(/\s+$/, ""))
    .filter((line) => line.trim() && !FURNITURE.test(line.trim()));
  return lines.slice(-n);
}

/** The session waits on the person's say-so for a tool: what Allow and Deny answer. Not a turn that ended, nor a question. */
export const isApprovalAsk = (session: Pick<SessionView, "state" | "activity">): boolean => session.state === "waiting" && /^needs your approval/i.test(session.activity ?? "");

export const isLive = (session: Pick<SessionView, "state">): boolean => session.state !== "ended" && session.state !== "lost";

/** Whether the panel may read the pane now: only while it shows the session, the session has a pane and runs, and the window is visible. */
export const mayReadPane = (input: { shown: boolean; visible: boolean; pane: boolean; live: boolean }): boolean => input.shown && input.visible && input.pane && input.live;

/** How long to wait before the next read, so two are at least `minMs` apart: zero when the last one is old enough. */
export const delayUntil = (lastAt: number | null, now: number, minMs = READ_EVERY_MS): number => (lastAt === null ? 0 : Math.max(0, lastAt + minMs - now));

export type ConvoLineView = RecordLine & { key: number };

/**
 * A conversation as the panel holds it: the record's last page, re-read as the session moves, and the pages read
 * before it. Keys stay put across re-reads, so a tool call the person opened stays open.
 */
export interface ConvoState {
  earlier: ConvoLineView[];
  tail: ConvoLineView[];
  /** Where the tail page begins, as the last read said. */
  tailStart: number | null;
  /** Where the earliest page read begins, to ask for what came before; null when nothing more is there. */
  before: number | null;
  /** The record could not be read at all. */
  unreadable: boolean;
}

const keyed = (lines: RecordLine[], from: number): ConvoLineView[] => lines.map((l, i) => ({ ...l, key: from + i }));

export function convoFromTail(read: RecordRead | null): ConvoState {
  if (!read) return { earlier: [], tail: [], tailStart: null, before: null, unreadable: true };
  return { earlier: [], tail: keyed(read.lines, 0), tailStart: read.start ?? 0, before: read.cut ? (read.start ?? null) : null, unreadable: false };
}

/** An earlier stretch, in on top — only the one asked for (`before` the earliest page), so a late answer does not double lines. */
export function convoWithEarlier(state: ConvoState, before: number, read: RecordRead | null): ConvoState {
  if (state.before !== before || !read) return state;
  const first = state.earlier[0]?.key ?? state.tail[0]?.key ?? 0;
  return { ...state, earlier: [...keyed(read.lines, first - read.lines.length), ...state.earlier], before: read.cut ? (read.start ?? null) : null };
}

/**
 * The last page read again. It starts where it did while the record stays within one page of its end, and then the
 * tail is replaced line for line; once the record has grown past that, the pages read before no longer join it, so
 * the view starts over from the new tail.
 */
export function convoRefreshed(state: ConvoState, read: RecordRead | null): ConvoState {
  if (!read) return state;
  if (state.unreadable || (read.start ?? 0) !== state.tailStart) return convoFromTail(read);
  return { ...state, tail: keyed(read.lines, 0) };
}

export const convoLines = (state: ConvoState): ConvoLineView[] => (state.earlier.length ? [...state.earlier, ...state.tail] : state.tail);
