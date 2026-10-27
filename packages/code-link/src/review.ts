import type { Context } from "cordis";
import type { ItemStatus } from "@tomradex/domain";
import { PANEL_SURFACES, type RecordLine, type RecordRead, type ThreadMessage, type ThreadSummary } from "@tomradex/agent";
import { clipDetail, clipLine, toolLine } from "@tomradex/engine-kit";
import type { PrState } from "./rules.js";
import type { CodeLinkStore, CodeLinkView, SessionCursor, SessionMark, SessionView } from "./store.js";
import { cutFrom } from "./segments.js";
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
  /** Where the ticket stands now. */
  status: ItemStatus;
  pr: ReviewPr | null;
  commits: number;
}

/** Where the look-back list's rows come from; each row's `kind` names its source. */
export type ReviewSource = "session" | "thread" | "idle";
const SOURCES: ReviewSource[] = ["session", "thread", "idle"];

/** One conversation in the look-back list: what came of it first, then who and when. */
export interface ReviewRow {
  id: string;
  /**
   * A coding session (in a terminal, or run by Tomrade), an assistant conversation put away, or one still open and
   * idle — the session bar shows only the newest few of those, the list finds the rest.
   */
  kind: ReviewSource;
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
  /** The conversation this one wrote code in the background for; the list sets it in under that one. */
  parentId?: string | null;
  /** Its agent can take the conversation up again by its id, in a new terminal. */
  resumable: boolean;
  /** Ended on no ticket, with its agent's session id and the folder it ran in: it can go on in the background, as itself. */
  continuable?: boolean;
  startedAt: number;
  endedAt: number;
}

/** What came of an ended session, as every list says it: its pull request, its commits, how often it asked, its last word. */
export type SessionOutcome = Pick<ReviewRow, "pr" | "commits" | "asked" | "said">;

/** Where a page stopped in each source the list reads; null in one once it ran dry. */
export type ReviewCursor = Record<ReviewSource, SessionCursor | null>;

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



/** A conversation cut where the session took a ticket on; see `cutFrom`. */
export function cutByTicket(lines: RecordLine[], marks: SessionMark[], itemOfKey: (key: string) => string | null): { itemId: string | null; lines: RecordLine[] }[] {
  return cutFrom(lines, marks, itemOfKey).cuts;
}

/** The tools that change a file, across the agents' records. */
const FILE_TOOL = /^(?:write|edit|multi_?edit|apply_?patch|write_?file|edit_?file|create_?file|str_?replace\w*|notebook_?edit)$/i;
const isTrace = (m: ThreadMessage | undefined): boolean => m?.role === "agent" && m.block.type === "trace";

/**
 * An assistant conversation cut as a session is: where it claimed a ticket (the note a claim leaves), and where it
 * first turned to writing code (the run of steps that first changed a file), so its chat and its code read apart.
 * Before a claim it belongs to `itemId` — the ticket it was opened on — unless it claimed one later, then to none.
 */
export function cutThread(messages: ThreadMessage[], itemOfKey: (key: string) => string | null, itemId: string | null): { itemId: string | null; messages: ThreadMessage[] }[] {
  const claims = messages.some((m) => m.block.type === "note" && !!m.block.claimed);
  let code = messages.findIndex((m) => isTrace(m) && FILE_TOOL.test((m.block as Extract<ThreadMessage["block"], { type: "trace" }>).tool));
  while (code > 0 && isTrace(messages[code - 1])) code--;
  const out: { itemId: string | null; messages: ThreadMessage[] }[] = [];
  let current = claims ? null : itemId;
  messages.forEach((m, i) => {
    const claimed = m.block.type === "note" ? m.block.claimed : undefined;
    const last = out.at(-1);
    if (claimed) {
      const was = current;
      current = itemOfKey(claimed) ?? current;
      // claimed for the code it had just started writing: that stretch is the ticket's
      if (last && last.itemId === null && was === null && code >= 0 && last.messages[0] === messages[code]) {
        last.itemId = current;
        last.messages.push(m);
        return;
      }
    }
    if (!last || claimed || i === code) out.push({ itemId: current, messages: [m] });
    else last.messages.push(m);
  });
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

/** The sources' rows in one order, newest first, `limit` of them; and where each source stops for the next page. */
export function mergePage(sources: Record<ReviewSource, ReviewRow[]>, before: ReviewCursor | null, limit: number): ReviewPage {
  const rows = SOURCES.flatMap((source) => sources[source]).sort((a, b) => b.endedAt - a.endedAt || (b.id < a.id ? -1 : 1)).slice(0, limit);
  const next = { session: null, thread: null, idle: null } as ReviewCursor;
  let more = false;
  for (const source of SOURCES) {
    const taken = rows.filter((r) => r.kind === source);
    const goesOn = sources[source].length === limit || taken.length < sources[source].length;
    if (!goesOn) continue;
    more = true;
    next[source] = taken.length ? { at: taken.at(-1)!.endedAt, id: taken.at(-1)!.id } : (before?.[source] ?? null);
  }
  return { rows, next: more ? next : null };
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
 * The look back on conversations: ended coding sessions, put-away assistant conversations and the idle ones the
 * session bar no longer shows, a page at a time with what came of each, and one opened whole, cut by the tickets it
 * worked. Counts come from stored rows; a record is read only for the conversation opened, or when what was said is
 * searched.
 */
export class Review {
  /** What each conversation said, lowercased, by id and when it ended: an ended one does not change. */
  private readonly said = new Map<string, string>();
  private searches = 0;

  constructor(private readonly deps: ReviewDeps) {}

  /** One page of conversations, newest first; with `query`, the newest ones whose title, ticket or words match. */
  list(projectId: string, opts: { before?: ReviewCursor | null; limit?: number; query?: string } = {}): ReviewPage {
    const limit = Math.max(1, Math.min(opts.limit ?? REVIEW_PAGE, 100));
    const before = opts.before ?? null;
    const needle = opts.query?.trim() ?? "";
    // a search is one page: the newest matches of each source
    const page = <T>(source: ReviewSource, matching: () => T[], paged: (from: SessionCursor | null) => T[]): T[] =>
      needle ? (before ? [] : matching()) : before && !before[source] ? [] : paged(before?.[source] ?? null);
    const sessions = page("session", () => this.deps.store.endedMatching(projectId, needle, this.itemsMatching(projectId, needle), limit), (from) => this.deps.store.endedPage(projectId, from, limit));
    const threads = page("thread", () => this.threadsMatching(projectId, true, needle, limit), (from) => this.threadsPage(projectId, true, from, limit));
    const idle = page("idle", () => this.threadsMatching(projectId, false, needle, limit), (from) => this.threadsPage(projectId, false, from, limit));
    const rows = (list: ThreadSummary[]) => list.map((th) => this.threadRow(projectId, th));
    return mergePage({ session: this.sessionRows(projectId, sessions), thread: rows(threads), idle: rows(idle) }, before, limit);
  }

  /** What came of each of these sessions, by id, the way the list says it: their tickets' links read in one go. */
  outcomes(projectId: string, sessions: SessionView[]): Map<string, SessionOutcome> {
    return new Map(this.sessionRows(projectId, sessions).map((r) => [r.id, { pr: r.pr, commits: r.commits, asked: r.asked, said: r.said }]));
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
    const ticketOf = (itemId: string | null): ReviewTicket | null => {
      if (!itemId) return null;
      const known = row.tickets.find((t) => t.itemId === itemId);
      const item = known ? null : this.deps.ctx.items.get(projectId, itemId);
      return known ?? (item ? { itemId, key: item.key, title: item.title, status: item.status, pr: null, commits: 0 } : null);
    };
    const cuts = cutThread(agent!.store.messages(projectId, thread.id), (key) => this.deps.ctx.items.getByKey(projectId, key)?.id ?? null, thread.itemId);
    const segments = cuts.flatMap((c) => {
      const lines = threadLines(c.messages);
      return lines.length ? [this.segment(c.itemId, ticketOf(c.itemId), lines)] : [];
    });
    return { row, segments, cut: false, unreadable: false, raw: false };
  }

  /** The tickets a session worked, with what their code came to — for a running session cut by ticket. Reads no record. */
  tickets(projectId: string, sessionId: string): ReviewTicket[] {
    const session = this.deps.store.session(projectId, sessionId);
    return session ? this.sessionRows(projectId, [session])[0]!.tickets : [];
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
        return item ? [{ itemId, key: item.key, title: item.title, status: item.status, ...ticketOutcome(s, itemId, links) }] : [];
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
        continuable: !tickets.length && !!s.externalId && !!s.cwd && (s.state === "ended" || s.state === "lost"),
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
    const tickets: ReviewTicket[] = item ? [{ itemId: item.id, key: item.key, title: item.title, status: item.status, pr: null, commits: 0 }] : [];
    return { id: th.id, kind: th.archived ? "thread" : "idle", agent: th.engine, title: th.title || item?.title || "", tickets, asked: null, commits: 0, pr: null, said: th.said ?? null, where: "panel", threadId: th.id, parentId: th.parentId, resumable: false, startedAt: th.createdAt, endedAt: th.updatedAt };
  }

  /** Put-away (or open and idle) assistant conversations, a page at a time, leaving out those a session speaks for and those running. */
  private threadsPage(projectId: string, archived: boolean, before: SessionCursor | null, limit: number): ThreadSummary[] {
    const agent = this.deps.ctx.get("agent");
    if (!agent) return [];
    const out: ThreadSummary[] = [];
    let from = before;
    // read past what the filter leaves out: a page short of `limit` would read as the source's end while the store has more
    for (;;) {
      const page = agent.store.threadsPage(projectId, PANEL_SURFACES, archived, from, limit);
      out.push(...this.ownThreads(projectId, page));
      const last = page.at(-1);
      if (out.length >= limit || page.length < limit || !last) break;
      from = { at: last.updatedAt, id: last.id };
    }
    return out.slice(0, limit);
  }

  private threadsMatching(projectId: string, archived: boolean, needle: string, limit: number): ThreadSummary[] {
    const agent = this.deps.ctx.get("agent");
    return agent ? this.ownThreads(projectId, agent.store.threadsMatching(projectId, PANEL_SURFACES, archived, needle, limit)) : [];
  }

  /** A conversation a session ran in is the session's row; one with a run going is the bar's, not the list's. */
  private ownThreads(projectId: string, threads: ThreadSummary[]): ThreadSummary[] {
    const spoken = this.deps.store.threadsWithSessions(projectId, threads.map((th) => th.id));
    const running = new Set(this.deps.ctx.get("agent")?.activeRuns().map((a) => a.thread.id));
    return threads.filter((th) => !spoken.has(th.id) && !running.has(th.id));
  }

  /** The tickets whose key or title holds the search: a session that worked one of them matches by it. */
  private itemsMatching(projectId: string, needle: string): string[] {
    const n = needle.toLowerCase();
    const byKey = this.deps.ctx.items.getByKey(projectId, needle.toUpperCase());
    return byKey ? [byKey.id] : [];
  }
}
