import { primaryOf } from "./scan/absorb.js";
import type { PrState } from "./rules.js";
import type { CodeLinkView, SessionView } from "./store.js";

/** Where a conversation was at one point: the assistant panel, a pane of Tomrade's terminal, or a terminal app. */
export type TimelinePlace = "panel" | "cell" | "terminal";

export interface TimelineStop {
  sessionId: string;
  where: TimelinePlace;
  /** The terminal app it ran in, when that was one. */
  terminal: string | null;
  at: number;
}

/** One conversation on the ticket. Taking it up again — a resume, a move between the panel and a cell — is not a new one. */
export interface TimelineEntry {
  /** Its first session. */
  id: string;
  agent: string;
  startedAt: number;
  /** When its last session ended; null while one lives. */
  endedAt: number | null;
  live: boolean;
  /** The session it is in now, or ended in. */
  latest: string;
  /** Where it went, in order. */
  stops: TimelineStop[];
  /** What came of it, in its own last word. */
  outcome: string | null;
  /** Commits on its branch, as the last scan counted them. */
  commits: number;
  /** How often it was taken up again: its stops past the first. */
  continued: number;
  /** How often it turned to the person. */
  asked: number;
  folder: string | null;
  branch: string;
}

export interface TicketTimeline {
  /** By when each began. */
  entries: TimelineEntry[];
  /** What the ticket delivered: its pull request, its commits, from how many conversations, how many files changed (null when unknown). */
  delivered: { pr: { number: number | null; state: PrState | null; url: string | null } | null; commits: number; sessions: number; files: number | null };
  /** Two live conversations in one folder, whose changes would overwrite each other: the later one is the one to move or stop. */
  clash: { folder: string; branch: string; earlier: string; later: string; laterSession: string } | null;
}

const ended = (s: SessionView) => s.state === "ended" || s.state === "lost";
const placeOf = (s: SessionView): TimelinePlace => (s.mode === "headless" ? "panel" : s.herdrPane ? "cell" : "terminal");

/**
 * The ticket's conversations from its sessions: the sessions of one thread (the panel and the cells it moved to) or of
 * one agent conversation (a resume carries its id) make one entry, each with where it went and what came of it.
 */
export function ticketTimeline(sessions: SessionView[], links: CodeLinkView[], files: number | null = null): TicketTimeline {
  const byStart = [...new Map(sessions.map((s) => [s.id, s])).values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const groups: SessionView[][] = [];
  const byThread = new Map<string, SessionView[]>();
  const byExternal = new Map<string, SessionView[]>();
  for (const s of byStart) {
    const external = s.externalId ? `${s.agent}:${s.externalId}` : null;
    const group = (s.threadId ? byThread.get(s.threadId) : undefined) ?? (external ? byExternal.get(external) : undefined);
    const into = group ?? [];
    if (!group) groups.push(into);
    into.push(s);
    if (s.threadId) byThread.set(s.threadId, into);
    if (external) byExternal.set(external, into);
  }
  const aheadOf = new Map(links.filter((l) => l.branch).map((l) => [l.branch, l.ahead]));
  const entries = groups.map((group): TimelineEntry => {
    const last = group.at(-1)!;
    const live = group.some((s) => !ended(s));
    const now = [...group].reverse().find((s) => !ended(s)) ?? last;
    const branches = [...new Set(group.map((s) => s.branch).filter(Boolean))];
    return {
      id: group[0]!.id,
      agent: last.agent,
      startedAt: group[0]!.startedAt,
      endedAt: live ? null : Math.max(...group.map((s) => s.endedAt ?? s.lastEventAt ?? s.startedAt)),
      live,
      latest: now.id,
      stops: group.map((s) => ({ sessionId: s.id, where: placeOf(s), terminal: s.herdrPane ? null : s.terminal, at: s.startedAt })),
      outcome: (live ? (now.activity ?? now.summary) : last.summary) ?? [...group].reverse().find((s) => s.summary)?.summary ?? null,
      commits: branches.reduce((n, b) => n + (aheadOf.get(b) ?? 0), 0),
      continued: group.length - 1,
      asked: group.reduce((n, s) => n + s.asked, 0),
      folder: now.worktree ?? now.cwd,
      branch: now.branch
    };
  });
  const primary = primaryOf(links);
  const going = entries.filter((e) => e.live && e.folder);
  let clash: TicketTimeline["clash"] = null;
  for (let i = 0; i < going.length && !clash; i++) {
    const later = going.slice(i + 1).find((e) => e.folder === going[i]!.folder);
    if (later) clash = { folder: later.folder!, branch: later.branch, earlier: going[i]!.id, later: later.id, laterSession: later.latest };
  }
  return {
    entries,
    delivered: {
      pr: primary && (primary.prNumber !== null || primary.prUrl) ? { number: primary.prNumber, state: primary.prState, url: primary.prUrl } : null,
      commits: links.reduce((n, l) => n + l.ahead, 0),
      sessions: entries.length,
      files
    },
    clash
  };
}
