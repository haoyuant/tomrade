import type { Context } from "cordis";
import type { RecordLine, RecordRead, ThreadMessage, ThreadSummary } from "@tomradex/agent";
import { clipDetail, clipLine, toolLine } from "@tomradex/engine-kit";
import type { PrState } from "./rules.js";
import type { CodeLinkStore, CodeLinkView, SessionCursor, SessionMark, SessionView } from "./store.js";
import { resumeCommand } from "./titles.js";

/** How many rows one page of the look-back list holds. */
export const REVIEW_PAGE = 30;
/** How many of the newest ended conversations a search for what was said reads. */
export const REVIEW_SAID_MAX = 40;
/** How much of one conversation a search keeps to look in. */
const SAID_MAX = 512 * 1024;
/** How long the line a search found may be, as the list quotes it. */
const SAID_LINE = 120;

/** What a search for words found: the conversations, and for each the line that says the words. */
export interface ReviewSaid {
  rows: ReviewRow[];
  said: Record<string, string>;
}
/** How many stretches of a record one look back reads, from its end: past that, the start is said to be cut. */
const READ_PAGES = 4;

/** A pull request as the look back names it; `state` merged with no number when the branch merged locally. */
export interface ReviewPr {
  number: number | null;
  state: PrState | null;
  url: string | null;
}

/** A ticket a session worked, with what its code came to. */
export interface ReviewTicket {
  itemId: string;
  key: string;
  title: string;
  pr: ReviewPr | null;
  commits: number;
}

/** One ended conversation in the look-back list: what came of it first, then who and when. */
export interface ReviewRow {
  id: string;
  /** A coding session (in a terminal, or run by Tomrade), or an assistant conversation put away. */
  kind: "session" | "thread";
  agent: string;
  /** What it goes by: its ticket's title, its own title, or what it was asked first. */
  title: string;
  /** The tickets it worked, the one it started on first. */
  tickets: ReviewTicket[];
  /** How many times it turned to the person; null where that was not counted (an assistant conversation). */
  asked: number | null;
  /** Commits on its tickets' branches, as the last scan counted them. */
  commits: number;
  /** The first ticket's pull request, where one is. */
  pr: ReviewPr | null;
  /** Its own last word on where it got to. */
  said: string | null;
  where: "pane" | "outside" | "panel";
  threadId: string | null;
  /** Its agent can take the conversation up again by its id, in a new terminal. */
  resumable: boolean;
  startedAt: number;
  endedAt: number;
}

/** Where a page stopped in each of the two sources the list reads; null in one once it ran dry. */
export interface ReviewCursor {
  session: SessionCursor | null;
  thread: SessionCursor | null;
}

export interface ReviewPage {
  rows: ReviewRow[];
  /** Where the next page starts; null when this was the last. */
  next: ReviewCursor | null;
}

/** One stretch of a conversation belonging to one ticket, or to none (before a claim, or a conversation without one). */
export interface ReviewSegment {
  itemId: string | null;
  key: string | null;
  title: string | null;
  from: number | null;
  to: number | null;
  lines: RecordLine[];
}

/** An ended conversation opened to look back on: its row, its conversation cut by ticket, and the ways on. */
export interface ReviewView {
  row: ReviewRow;
  segments: ReviewSegment[];
  /** The conversation's start is missing: only its end was read or saved. */
  cut: boolean;
  /** Nothing of its conversation could be read here. */
  unreadable: boolean;
  /** What its pane showed was recorded here: its raw output can be played back. */
  raw: boolean;
}

/** The tools an outside agent claims a ticket with: `claim_ticket`, however its MCP client prefixes the name. */
const CLAIM_LINE = /(?:^|[^a-z])claim_ticket\b[^·]*·\s*([A-Z][A-Z0-9]*-\d+)/i;

/**
 * A conversation cut where the session took a ticket on: each mark (a claim, a start on a ticket) begins that
 * ticket's stretch, and a claim the record itself shows begins it at that line. Lines before any mark belong to no
 * ticket; coming back to a ticket begins another stretch of it. Lines the record did not stamp stay where they are.
 */
export function cutByTicket(lines: RecordLine[], marks: SessionMark[], itemOfKey: (key: string) => string | null): { itemId: string | null; lines: RecordLine[] }[] {
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  const out: { itemId: string | null; lines: RecordLine[] }[] = [];
  let current: string | null = null;
  let next = 0;
  const push = (itemId: string | null, line: RecordLine) => {
    const last = out.at(-1);
    if (last && last.itemId === itemId) last.lines.push(line);
    else out.push({ itemId, lines: [line] });
  };
  for (const line of lines) {
    // A claim the agent made, as its record shows it: that line opens the ticket's stretch, and its mark is spent.
    const claimed = line.who === "tool" ? CLAIM_LINE.exec(line.text)?.[1] : undefined;
    const claimedId = claimed ? itemOfKey(claimed.toUpperCase()) : null;
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
  return out;
}

/** The link that speaks for a ticket in this session: on its branch when it has one, the delivery it worked, a pull request over none. */
export function ticketOutcome(session: Pick<SessionView, "branch" | "delivery" | "worked">, itemId: string, links: CodeLinkView[]): { pr: ReviewPr | null; commits: number } {
  const delivery = session.worked.find((w) => w.itemId === itemId)?.delivery ?? session.delivery;
  const own = links.filter((l) => l.itemId === itemId && (!session.branch || !l.branch || l.branch === session.branch));
  const ofDelivery = own.filter((l) => l.delivery === delivery);
  const pool = ofDelivery.length ? ofDelivery : own;
  const link = pool.find((l) => l.prNumber !== null) ?? pool.find((l) => l.mergedSha) ?? pool.at(-1);
  if (!link) return { pr: null, commits: 0 };
  const pr: ReviewPr | null = link.prNumber !== null || link.prUrl ? { number: link.prNumber, state: link.prState, url: link.prUrl } : link.mergedSha ? { number: null, state: "merged", url: null } : null;
  return { pr, commits: link.ahead };
}

/** A conversation's messages as record lines: what was said, and each step as a tool line with its input and output. */
export function threadLines(messages: ThreadMessage[]): RecordLine[] {
  const out: RecordLine[] = [];
  for (const m of messages) {
    const b = m.block;
    if (m.role === "user" && b.type === "text") {
      // The brief a Start writes is long and machine-made: the ticket's stretch says what it was about.
      if (/^(Implement|Continue|Bootstrap) [A-Z][A-Z0-9]*-\d+ — /.test(b.text)) continue;
      out.push({ who: "person", text: clipLine(b.text), at: m.at });
    } else if (m.role === "agent" && b.type === "text") out.push({ who: "agent", text: clipLine(b.text), at: m.at });
    else if (m.role === "agent" && b.type === "question") out.push({ who: "agent", text: clipLine(b.text), at: m.at });
    else if (m.role === "agent" && b.type === "error") out.push({ who: "agent", text: clipLine(b.text), at: m.at });
    else if (m.role === "agent" && b.type === "trace") {
      const args = (b.args && typeof b.args === "object" ? b.args : {}) as Record<string, unknown>;
      const input = typeof args.command === "string" ? `$ ${args.command}` : JSON.stringify(b.args ?? {}, null, 2);
      out.push({ who: "tool", text: toolLine(b.tool, args), detail: { input: clipDetail(input), ...(b.commandResult ? { output: clipDetail(b.commandResult.output) } : {}) }, at: m.at });
    }
  }
  return out;
}

/** The two sources' rows in one order, newest first, `limit` of them; and where each source stops for the next page. */
export function mergePage(sessions: ReviewRow[], threads: ReviewRow[], before: ReviewCursor | null, limit: number): ReviewPage {
  const rows = [...sessions, ...threads].sort((a, b) => b.endedAt - a.endedAt || (b.id < a.id ? -1 : 1)).slice(0, limit);
  const takenS = rows.filter((r) => r.kind === "session");
  const takenT = rows.filter((r) => r.kind === "thread");
  const moreS = sessions.length === limit || takenS.length < sessions.length;
  const moreT = threads.length === limit || takenT.length < threads.length;
  const stop = (taken: ReviewRow[], was: SessionCursor | null): SessionCursor | null => (taken.length ? { at: taken.at(-1)!.endedAt, id: taken.at(-1)!.id } : was);
  return { rows, next: moreS || moreT ? { session: moreS ? stop(takenS, before?.session ?? null) : null, thread: moreT ? stop(takenT, before?.thread ?? null) : null } : null };
}

export interface ReviewDeps {
  ctx: Context;
  store: CodeLinkStore;
  /** A session's conversation from its record: its end, or the stretch before an earlier read's start. */
  read: (projectId: string, sessionId: string, before?: number) => RecordRead | null;
  /** Whether the pane the session ran in was recorded while it ran. */
  recorded: (projectId: string, sessionId: string) => Promise<boolean>;
}

/**
 * The look back on ended conversations: coding sessions and put-away assistant conversations, a page at a time with
 * what came of each, and one opened whole, cut by the tickets it worked. Counts come from stored rows; a record is
 * read only for the conversation opened, or when what was said is searched.
 */
export class Review {
  /** What each conversation said, lowercased, by id and when it ended: an ended one does not change. */
  private readonly said = new Map<string, string>();
  private searches = 0;

  constructor(private readonly deps: ReviewDeps) {}

  /** One page of ended conversations, newest first; with `query`, the newest ones whose title, ticket or words match. */
  list(projectId: string, opts: { before?: ReviewCursor | null; limit?: number; query?: string } = {}): ReviewPage {
    const limit = Math.max(1, Math.min(opts.limit ?? REVIEW_PAGE, 100));
    const before = opts.before ?? null;
    const needle = opts.query?.trim() ?? "";
    const sessions = needle ? (before ? [] : this.deps.store.endedMatching(projectId, needle, this.itemsMatching(projectId, needle), limit)) : before && !before.session ? [] : this.deps.store.endedPage(projectId, before?.session ?? null, limit);
    const threads = needle ? (before ? [] : this.archivedMatching(projectId, needle, limit)) : before && !before.thread ? [] : this.threadsPage(projectId, before?.thread ?? null, limit);
    return mergePage(this.sessionRows(projectId, sessions), threads.map((th) => this.threadRow(projectId, th)), before, limit);
  }

  /**
   * The ended conversations whose words say `query`, newest first and the newest few only, read one at a time and
   * giving way between them; each with the line that says it. A newer search stops an older one where it is.
   */
  async saidIn(projectId: string, query: string, limit = REVIEW_SAID_MAX): Promise<ReviewSaid> {
    const turn = ++this.searches;
    const needle = query.trim().toLowerCase();
    const out: ReviewSaid = { rows: [], said: {} };
    if (!needle) return out;
    const hits: SessionView[] = [];
    for (const s of this.deps.store.endedPage(projectId, null, limit)) {
      if (this.searches !== turn) break;
      const key = `${s.id}:${s.endedAt ?? s.lastEventAt ?? s.startedAt}`;
      let text = this.said.get(key);
      if (text === undefined) {
        const read = this.readOf(projectId, s);
        text = (read?.lines ?? []).map((l) => l.text.replace(/\s+/g, " ")).join("\n").slice(0, SAID_MAX);
        this.said.set(key, text);
        if (this.said.size > limit * 2) this.said.delete(this.said.keys().next().value!);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      hits.push(s);
      const from = text.lastIndexOf("\n", at) + 1;
      const to = text.indexOf("\n", at);
      out.said[s.id] = text.slice(from, to < 0 ? undefined : to).slice(0, SAID_LINE);
    }
    out.rows = this.sessionRows(projectId, hits);
    return out;
  }

  /** One conversation opened whole: its row, its lines cut by ticket, and whether its pane's output was recorded. */
  async open(projectId: string, ref: { sessionId?: string; threadId?: string }): Promise<ReviewView | null> {
    const session = ref.sessionId ? this.deps.store.session(projectId, ref.sessionId) : null;
    if (ref.sessionId && !session) return null;
    const agent = this.deps.ctx.get("agent");
    if (session) {
      const row = this.sessionRows(projectId, [session])[0]!;
      const read = session.threadId && !session.externalId && agent ? { lines: threadLines(agent.store.messages(projectId, session.threadId)), cut: false } : await this.readWhole(projectId, session);
      const items = new Map(row.tickets.map((t) => [t.itemId, t]));
      const keys = new Map(row.tickets.map((t) => [t.key, t.itemId]));
      const segments = read ? cutByTicket(read.lines, session.marks, (key) => keys.get(key) ?? this.deps.ctx.items.getByKey(projectId, key)?.id ?? null).map((c) => this.segment(c.itemId, items.get(c.itemId ?? "") ?? null, c.lines)) : [];
      return { row, segments, cut: !!read?.cut, unreadable: !read, raw: session.herdrPane ? await this.deps.recorded(projectId, session.id) : false };
    }
    const thread = ref.threadId && agent ? agent.store.thread(projectId, ref.threadId) : null;
    if (!thread) return null;
    const row = this.threadRow(projectId, thread);
    const lines = threadLines(agent!.store.messages(projectId, thread.id));
    const ticket = row.tickets[0] ?? null;
    return { row, segments: lines.length ? [this.segment(ticket?.itemId ?? null, ticket, lines)] : [], cut: false, unreadable: false, raw: false };
  }

  private segment(itemId: string | null, ticket: ReviewTicket | null, lines: RecordLine[]): ReviewSegment {
    const times = lines.flatMap((l) => (l.at === undefined ? [] : [l.at]));
    return { itemId, key: ticket?.key ?? null, title: ticket?.title ?? null, from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) : null, lines };
  }

  /** The record from its end back toward its start, a stretch at a time, up to `READ_PAGES`; cut when more remains. */
  private async readWhole(projectId: string, session: SessionView): Promise<{ lines: RecordLine[]; cut: boolean } | null> {
    let read = this.readOf(projectId, session);
    if (!read) return null;
    const stretches = [read.lines];
    for (let pages = 1; read.cut && read.start !== undefined && pages < READ_PAGES; pages++) {
      const before = read.start;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const earlier = this.deps.read(projectId, session.id, before);
      if (!earlier || (earlier.start !== undefined && earlier.start >= before)) break;
      stretches.unshift(earlier.lines);
      read = earlier;
    }
    return { lines: stretches.flat(), cut: !!read.cut };
  }

  private readOf(projectId: string, session: SessionView): RecordRead | null {
    if (session.externalId) return this.deps.read(projectId, session.id);
    const agent = this.deps.ctx.get("agent");
    return session.threadId && agent ? { lines: threadLines(agent.store.messages(projectId, session.threadId)), cut: false } : null;
  }

  /** Rows for a page of sessions: their tickets' links read in one go. */
  private sessionRows(projectId: string, sessions: SessionView[]): ReviewRow[] {
    const itemIds = [...new Set(sessions.flatMap((s) => [...s.itemIds, ...s.worked.map((w) => w.itemId)]))];
    const links = this.deps.store.linksOfItems(projectId, itemIds);
    return sessions.map((s) => {
      const ordered = this.ticketOrder(s);
      const tickets = ordered.flatMap((itemId): ReviewTicket[] => {
        const item = this.deps.ctx.items.get(projectId, itemId);
        return item ? [{ itemId, key: item.key, title: item.title, ...ticketOutcome(s, itemId, links) }] : [];
      });
      return {
        id: s.id,
        kind: "session",
        agent: s.agent,
        title: tickets[0]?.title ?? s.title ?? "",
        tickets,
        asked: s.asked,
        commits: tickets.reduce((n, t) => n + t.commits, 0),
        pr: tickets.find((t) => t.pr)?.pr ?? null,
        said: s.summary,
        where: s.herdrPane ? "pane" : s.mode === "headless" ? "panel" : "outside",
        threadId: s.threadId,
        resumable: !!resumeCommand(s.agent, s.externalId),
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? s.lastEventAt ?? s.startedAt
      };
    });
  }

  /** The tickets a session worked, the one it started on first: by its marks, then the rest it holds or left. */
  private ticketOrder(s: SessionView): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...s.marks.map((m) => m.itemId), ...s.worked.map((w) => w.itemId), ...s.itemIds]) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  private threadRow(projectId: string, th: ThreadSummary): ReviewRow {
    const item = th.itemId ? this.deps.ctx.items.get(projectId, th.itemId) : null;
    const tickets: ReviewTicket[] = item ? [{ itemId: item.id, key: item.key, title: item.title, pr: null, commits: 0 }] : [];
    return { id: th.id, kind: "thread", agent: th.engine, title: th.title || item?.title || "", tickets, asked: null, commits: 0, pr: null, said: null, where: "panel", threadId: th.id, resumable: false, startedAt: th.createdAt, endedAt: th.updatedAt };
  }

  /** Put-away assistant conversations, a page at a time, leaving out those a session speaks for. */
  private threadsPage(projectId: string, before: SessionCursor | null, limit: number): ThreadSummary[] {
    const agent = this.deps.ctx.get("agent");
    if (!agent) return [];
    const page = agent.store.archivedThreadsPage(projectId, "assistant", before, limit);
    const spoken = this.deps.store.threadsWithSessions(projectId, page.map((th) => th.id));
    return page.filter((th) => !spoken.has(th.id));
  }

  private archivedMatching(projectId: string, needle: string, limit: number): ThreadSummary[] {
    const n = needle.toLowerCase();
    return this.threadsPage(projectId, null, limit * 4).filter((th) => th.title.toLowerCase().includes(n)).slice(0, limit);
  }

  /** The tickets whose key or title holds the search: a session that worked one of them matches by it. */
  private itemsMatching(projectId: string, needle: string): string[] {
    const n = needle.toLowerCase();
    const byKey = this.deps.ctx.items.getByKey(projectId, needle.toUpperCase());
    return byKey ? [byKey.id] : [];
  }
}
