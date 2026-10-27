/** A line of a conversation as the cut reads it: who said it, what, and when the record wrote it. */
export interface CutLine {
  who: string;
  text: string;
  at?: number;
}

/** A moment the session took a ticket on: a claim, a start. */
export interface CutMark {
  itemId: string;
  at: number;
}

/** Where a cut stopped: the ticket the lines belong to now, and the marks spent so far. Lines after it go on from here. */
export interface CutState {
  current: string | null;
  next: number;
}

export interface Cut<L> {
  itemId: string | null;
  lines: L[];
}

/** The tools an outside agent claims a ticket with: `claim_ticket`, however its MCP client prefixes the name. */
export const CLAIM_LINE = /(?:^|[^a-z])claim_ticket\b[^·]*·\s*([A-Z][A-Z0-9]*-\d+)/i;

/** The ticket key a line claims, when it is a claim the record shows. */
export const claimedKey = (line: CutLine): string | null => (line.who === "tool" ? (CLAIM_LINE.exec(line.text)?.[1]?.toUpperCase() ?? null) : null);

/**
 * Lines cut where the session took a ticket on, going on from `from`: each mark (a claim, a start on a ticket)
 * begins that ticket's stretch, and a claim the record itself shows begins it at that line. Lines before any mark
 * belong to no ticket; coming back to a ticket begins another stretch of it. Lines the record did not stamp stay
 * where they are. A later page cut from the state this one ends in reads as if the two were cut at once.
 */
export function cutFrom<L extends CutLine>(lines: L[], marks: CutMark[], itemOfKey: (key: string) => string | null, from: CutState = { current: null, next: 0 }): { cuts: Cut<L>[]; state: CutState } {
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  const cuts: Cut<L>[] = [];
  let { current, next } = from;
  const push = (itemId: string | null, line: L) => {
    const last = cuts.at(-1);
    if (last && last.itemId === itemId) last.lines.push(line);
    else cuts.push({ itemId, lines: [line] });
  };
  for (const line of lines) {
    // A claim the agent made, as its record shows it: that line opens the ticket's stretch, and its mark is spent.
    const claimed = claimedKey(line);
    const claimedId = claimed ? itemOfKey(claimed) : null;
    if (claimedId) {
      current = claimedId;
      if (sorted[next]?.itemId === claimedId) next++;
      push(current, line);
      continue;
    }
    if (line.at !== undefined) {
      while (next < sorted.length && sorted[next]!.at <= line.at) current = sorted[next++]!.itemId;
    }
    push(current, line);
  }
  return { cuts, state: { current, next } };
}

/** Two runs of stretches one after the other, the stretch they meet in joined when it is the same ticket's. */
export function joinCuts<L>(a: Cut<L>[], b: Cut<L>[]): Cut<L>[] {
  if (!a.length) return b;
  if (!b.length) return a;
  const last = a.at(-1)!;
  const first = b[0]!;
  return last.itemId === first.itemId ? [...a.slice(0, -1), { itemId: last.itemId, lines: [...last.lines, ...first.lines] }, ...b.slice(1)] : [...a, ...b];
}
