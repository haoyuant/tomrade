import type { ChangeHunk, ChangeLine } from "@tomradex/code-link";

export type CommentSide = "old" | "new";

/** A comment on a line or a range of lines of a diff, as the view is given it. */
export interface DiffComment {
  id: string;
  path: string;
  side: CommentSide;
  /** One-based, on `side`, as they were when the comment was made. */
  line: number;
  endLine: number;
  /** The commented lines as they were, newline-joined: what pins the comment when the diff shifts. */
  quote: string;
  body: string;
  state: "open" | "resolved";
  /** It has been handed to the agent. */
  sent: boolean;
  createdAt: number;
  /** A reviewing agent found it: who, and how much it matters. */
  finding?: { reviewer: string; severity: "info" | "warning" | "error" };
}

/** What a new comment is made of. */
export type DiffCommentDraft = Pick<DiffComment, "path" | "side" | "line" | "endLine" | "quote" | "body">;

/** What pins a comment: its side, where its lines were, and what they said. */
export type Anchor = Pick<DiffComment, "side" | "line" | "endLine" | "quote">;

/** Where an anchor sits now: its hunk, the indexes of its first and last line there, and their numbers on its side. */
export interface Place {
  hunk: number;
  first: number;
  last: number;
  line: number;
  endLine: number;
}

/** A deleted line is on the old side; anything else is commented on as the code reads now. */
export const sideOf = (line: ChangeLine): CommentSide => (line.kind === "del" ? "old" : "new");

/**
 * Where an anchor's lines are in a file's hunks: at their recorded line when the text there still is the quote, else
 * the nearest place on that side where the quoted lines stand in order. Null when they are nowhere: the comment is outdated.
 */
export function placeAnchor(anchor: Anchor, hunks: readonly ChangeHunk[]): Place | null {
  const want = anchor.quote.split("\n");
  let best: Place | null = null;
  let gap = Infinity;
  hunks.forEach((hunk, h) => {
    const side = hunk.lines.flatMap((line, index) => (line[anchor.side] === null ? [] : [{ index, no: line[anchor.side]!, text: line.text }]));
    for (let s = 0; s + want.length <= side.length; s++) {
      const away = Math.abs(side[s].no - anchor.line);
      if (away >= gap || !want.every((text, k) => side[s + k].text === text)) continue;
      const end = side[s + want.length - 1];
      best = { hunk: h, first: side[s].index, last: end.index, line: side[s].no, endLine: end.no };
      gap = away;
    }
  });
  return best;
}

/** The anchor of the lines on one side of a hunk between two of its lines (by index, in either order); null when an end is not on that side. */
export function rangeAnchor(hunk: ChangeHunk, side: CommentSide, a: number, b: number): Anchor | null {
  const [from, to] = a <= b ? [a, b] : [b, a];
  if (hunk.lines[from]?.[side] == null || hunk.lines[to]?.[side] == null) return null;
  const lines = hunk.lines.slice(from, to + 1).filter((line) => line[side] !== null);
  return { side, line: lines[0][side]!, endLine: lines[lines.length - 1][side]!, quote: lines.map((line) => line.text).join("\n") };
}

/**
 * The anchor a press on a line makes: that line alone, or, given the range being written on the same file, that range
 * stretched to the line when both are on one side of one hunk (the lines between two hunks are not in the diff).
 */
export function pickAnchor(hunks: readonly ChangeHunk[], h: number, index: number, held: Anchor | null): Anchor | null {
  const hunk = hunks[h];
  const line = hunk?.lines[index];
  if (!line) return null;
  const side = sideOf(line);
  const at = held?.side === side ? placeAnchor(held, hunks) : null;
  return at?.hunk === h ? rangeAnchor(hunk, side, Math.min(at.first, index), Math.max(at.last, index)) : rangeAnchor(hunk, side, index, index);
}
