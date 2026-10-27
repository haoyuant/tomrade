import type { ReviewRow, ReviewSegment } from "@tomradex/code-link";
import { asStep } from "./convoFold";
import { workDone, type WorkDone } from "./steps";

/** A day as the list groups by it: the local date, `YYYY-MM-DD`. */
export function dayOf(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Rows by the day they ended, newest day first, each day's rows in the order given. */
export function groupByDay<T extends { endedAt: number }>(rows: T[]): { day: string; at: number; rows: T[] }[] {
  const out: { day: string; at: number; rows: T[] }[] = [];
  for (const row of rows) {
    const day = dayOf(row.endedAt);
    const last = out.at(-1);
    if (last && last.day === day) last.rows.push(row);
    else out.push({ day, at: row.endedAt, rows: [row] });
  }
  return out;
}

/** What a day is called: today, yesterday, else its date. */
export function dayLabel(day: string, now: number, words: { today: string; yesterday: string }, date: (at: number) => string): string {
  if (day === dayOf(now)) return words.today;
  if (day === dayOf(now - 24 * 60 * 60_000)) return words.yesterday;
  const [y, m, d] = day.split("-").map(Number);
  return date(new Date(y!, m! - 1, d!).getTime());
}

export type OutcomeWords = (key: "prMerged" | "prOpen" | "prClosed" | "prDraft" | "pr" | "mergedLocally" | "commit" | "commits" | "askedOnce" | "asked", vars?: Record<string, string | number>) => string;

/** A pull request in a few words, by its state. */
export function prLabel(pr: NonNullable<ReviewRow["pr"]>, say: OutcomeWords): string {
  if (pr.number === null) return say("mergedLocally");
  const key = pr.state === "merged" ? "prMerged" : pr.state === "open" ? "prOpen" : pr.state === "closed" ? "prClosed" : pr.state === "draft" ? "prDraft" : "pr";
  return say(key, { n: pr.number });
}

/** The outcome line's parts, in the design's order: the pull request, the commits, how often it asked. Empty when none apply. */
export function outcomeParts(row: Pick<ReviewRow, "pr" | "commits" | "asked">, say: OutcomeWords): string[] {
  return [
    row.pr ? prLabel(row.pr, say) : null,
    row.commits > 0 ? say(row.commits === 1 ? "commit" : "commits", { n: row.commits }) : null,
    row.asked ? say(row.asked === 1 ? "askedOnce" : "asked", { n: row.asked }) : null
  ].filter((part): part is string => !!part);
}

/** The outcome in one line: what its code came to, else what the session last said. */
export function outcomeLine(row: Pick<ReviewRow, "pr" | "commits" | "asked" | "said">, say: OutcomeWords): string | null {
  const parts = outcomeParts(row, say);
  return parts.length ? parts.join(" · ") : row.said;
}

/** The tickets a session did besides the one it goes by. */
export const alsoKeys = (row: Pick<ReviewRow, "tickets">): string[] => row.tickets.slice(1).map((t) => t.key);

export type SegmentKind = "chat" | "code";

/** What a stretch's steps came to, read as the record's tool lines. */
export const segmentWork = (lines: ReviewSegment["lines"]): WorkDone => workDone(lines.filter((l) => l.who === "tool").map(asStep));

/** A stretch that wrote a file or ran a command is writing code; one that only talked is chat. */
export const segmentKind = (work: WorkDone): SegmentKind => (work.files > 0 || work.commands > 0 ? "code" : "chat");

/** How long a stretch's one-line summary may be. */
const SUMMARY_MAX = 80;

/** What a stretch was about: the first thing the person said in it, else the first thing the agent said. */
export function segmentSummary(lines: ReviewSegment["lines"]): string {
  const said = lines.find((l) => l.who === "person") ?? lines.find((l) => l.who === "agent");
  const line = said?.text.replace(/\s+/g, " ").trim() ?? "";
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/** How many stretches each ticket has, by item id; `null` counts those before any ticket. */
export function stretchesOf(segments: Pick<ReviewSegment, "itemId">[]): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const s of segments) out.set(s.itemId, (out.get(s.itemId) ?? 0) + 1);
  return out;
}

/** Which stretches open at first: all of them from the list, only the ticket's when opened from its page. */
export function openAtFirst(segments: Pick<ReviewSegment, "itemId">[], itemId: string | null): Set<number> {
  const out = new Set<number>();
  segments.forEach((s, i) => {
    if (itemId === null || s.itemId === itemId) out.add(i);
  });
  return out;
}

/** The stretch the view lands on: the ticket's last one, when opened from its page; null to start at the top. */
export function landingSegment(segments: Pick<ReviewSegment, "itemId">[], itemId: string | null): number | null {
  if (itemId === null) return null;
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i]!.itemId === itemId) return i;
  return null;
}

/** Each conversation opened under another right after it, set in by one; the rest keep their order. A child whose parent is not among the rows stands on its own. */
export function nestRows<T extends { id: string; parentId?: string | null }>(rows: T[]): (T & { depth: 0 | 1 })[] {
  const ids = new Set(rows.map((r) => r.id));
  const nested = (r: T) => !!r.parentId && r.parentId !== r.id && ids.has(r.parentId);
  const out: (T & { depth: 0 | 1 })[] = [];
  for (const r of rows) {
    if (nested(r)) continue;
    out.push({ ...r, depth: 0 });
    for (const child of rows) if (child.parentId === r.id && nested(child)) out.push({ ...child, depth: 1 });
  }
  return out;
}
