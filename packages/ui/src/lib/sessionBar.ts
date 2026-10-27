import type { ThreadSummary } from "@tomradex/agent";
import type { SessionAsk, SessionOutcome, SessionView } from "@tomradex/code-link";
import type { AttentionEntry } from "~/lib/attention";
import { isApprovalAsk } from "./terminalSession";

export type BarStatus = "wait" | "run" | "idle" | "done";

/** One conversation in the session bar: an assistant thread, or a coding session in a terminal — never both for the same one. */
export interface BarRow {
  key: string;
  threadId: string | null;
  /** The code-link session: a terminal one is opened in the Terminal window, a headless one rides on its thread. */
  sessionId: string | null;
  title: string;
  /** The engine id; null for an assistant thread on the default conductor. */
  agent: string | null;
  status: BarStatus;
  /** In the panel, in a Terminal window pane, or in another terminal app (TERM_PROGRAM). */
  where: "panel" | "pane" | "outside";
  terminalApp: string | null;
  wait: Pick<AttentionEntry, "kind" | "text"> | null;
  /** What a waiting terminal session asks, worded where it shows; null otherwise. */
  ask: SessionAsk | null;
  /** What it is doing now, or what it last said. */
  activity: string | null;
  /** What came of an ended session: its pull request, commits, asks and last word, said by `outcomeLine`. */
  outcome: SessionOutcome | null;
  /** The Terminal window cell that shows it, by the window's number; null when no cell does. */
  cell: number | null;
  /** A terminal session waiting on a permission its card can answer: Allow with yes under the cursor, else Deny; null otherwise. */
  prompt: "allow" | "deny" | null;
  /** A live terminal session's pane: its last lines that say something; null otherwise. */
  tail: string[] | null;
  itemIds: string[];
  /** The key of the ticket it works, when it works one. */
  ticket: string | null;
  /** What opened a conversation, as the plugin that did names it; chips after the title. */
  origins: string[];
  /** A conversation stopped by a usage limit continues then, on its own. */
  parkedUntil: number | null;
  startedAt: number;
  /** When it last moved: the age a card shows. */
  at: number;
  /** The row of the conversation this one writes code in the background for; it sits right under that row. */
  parentKey: string | null;
  /** 0 for a row of its own, 1 under its parent. */
  depth: 0 | 1;
}

const RANK: Record<BarStatus, number> = { wait: 0, run: 1, idle: 2, done: 3 };

/** How long an assistant conversation sits untouched before it reads as done, with what it said last as its outcome. */
export const THREAD_DONE_AFTER_MS = 8 * 60 * 60_000;

/**
 * The bar's rows, waiting first. Within a group the order holds still while output streams:
 * waiting by how long it has waited, running by when it started, idle by when it was last used,
 * ended by when it ended. Idle conversations beyond `idleLimit` stay in the full list; the open thread or session never drops out.
 * A conversation writing code in the background for another sits right under it, wherever the more urgent of the two would be.
 */
export function sessionBarRows(input: {
  threads: ThreadSummary[];
  /** The session lists' rows; an ended one carries what came of it, a waiting one what its screen asks. */
  sessions: (SessionView & { outcome?: SessionOutcome | null; approval?: boolean; prompt?: "allow" | "deny" | null; tail?: string[] | null })[];
  /** Which Terminal window cell shows each session, by session id. */
  cells?: Record<string, number>;
  attention: AttentionEntry[];
  itemTitle: (itemId: string) => string | null;
  itemKey?: (itemId: string) => string | null;
  openThreadId: string | null;
  /** The terminal session the panel shows in place of a thread, if any. */
  openSessionId?: string | null;
  idleLimit?: number;
  /** Whether a ticket is done: a conversation on a done ticket is done too. */
  itemDone?: (itemId: string) => boolean;
  /** The clock quiet conversations are read against: one untouched past `THREAD_DONE_AFTER_MS` is done. Without it, none is. */
  now?: number;
}): BarRow[] {
  const waits = new Map(input.attention.map((e) => [e.key, e]));
  const threads = input.threads.filter((th) => !th.archived);
  const panelThreads = new Set(threads.map((th) => th.id));
  const sessionOfThread = new Map(input.sessions.filter((s) => s.threadId).map((s) => [s.threadId!, s]));
  const rows: BarRow[] = [];
  const keyOf = (ids: string[]) => (ids[0] && input.itemKey?.(ids[0])) || null;
  const cellOf = (sessionId: string | undefined) => (sessionId && input.cells?.[sessionId]) || null;

  for (const th of threads) {
    const session = sessionOfThread.get(th.id);
    const wait = waits.get(`thread:${th.id}`) ?? null;
    const live = session && session.state !== "ended" && session.state !== "lost";
    const busy: BarStatus = wait ? "wait" : th.running || (live && session.state === "running") ? "run" : "idle";
    // done once its ticket is, or once it sat untouched a good while: what it said last is what came of it
    const finished = busy === "idle" && !live && ((!!th.itemId && !!input.itemDone?.(th.itemId)) || (input.now !== undefined && input.now - th.updatedAt > THREAD_DONE_AFTER_MS));
    const status: BarStatus = finished ? "done" : busy;
    rows.push({
      key: `thread:${th.id}`, threadId: th.id, sessionId: session?.id ?? null,
      title: th.title || (th.itemId ? input.itemTitle(th.itemId) : null) || "",
      agent: th.engine, status, where: "panel", terminalApp: null,
      wait: wait && { kind: wait.kind, text: wait.text }, activity: live ? session.activity : finished ? null : (th.said ?? null),
      outcome: finished && th.said ? { pr: null, commits: 0, asked: null, said: th.said } : null, cell: live ? cellOf(session.id) : null, prompt: null, tail: null, ask: null,
      itemIds: th.itemId ? [th.itemId] : [], ticket: keyOf(th.itemId ? [th.itemId] : []), origins: th.origins ?? [], parkedUntil: th.parkedUntil ?? null, startedAt: th.createdAt, at: wait?.since ?? th.updatedAt,
      parentKey: th.parentId && panelThreads.has(th.parentId) ? `thread:${th.parentId}` : null, depth: 0
    });
  }

  for (const s of input.sessions) {
    if (s.threadId && panelThreads.has(s.threadId)) continue;
    const ended = s.state === "ended" || s.state === "lost";
    const wait = ended ? null : (waits.get(s.threadId ? `thread:${s.threadId}` : `session:${s.id}`) ?? null);
    const status: BarStatus = ended ? "done" : wait || s.state === "waiting" || s.state === "error" ? "wait" : s.state === "running" ? "run" : "idle";
    rows.push({
      key: `session:${s.id}`, threadId: null, sessionId: s.id,
      title: s.title || (s.itemIds[0] ? input.itemTitle(s.itemIds[0]) : null) || "",
      agent: s.agent, status, where: s.herdrPane ? "pane" : "outside", terminalApp: s.herdrPane ? null : s.terminal,
      wait: status === "wait" ? { kind: wait?.kind ?? (s.state === "error" ? "stuck" : "waiting"), text: wait?.text ?? s.activity ?? s.summary } : null,
      activity: ended ? null : s.activity, outcome: ended ? (s.outcome ?? { pr: null, commits: 0, asked: s.asked, said: s.summary }) : null, cell: ended ? null : cellOf(s.id),
      prompt: status === "wait" && s.approval && isApprovalAsk(s) ? (s.prompt ?? null) : null, tail: ended ? null : (s.tail ?? null), ask: status === "wait" && s.state === "waiting" ? (s.ask ?? null) : null,
      itemIds: s.itemIds, ticket: keyOf(s.itemIds), origins: [], parkedUntil: null, startedAt: s.startedAt, at: wait?.since ?? (ended ? s.endedAt : null) ?? s.lastEventAt ?? s.startedAt,
      parentKey: null, depth: 0
    });
  }

  const order = (a: BarRow, b: BarRow) =>
    RANK[a.status] - RANK[b.status] || (a.status === "wait" ? a.at - b.at : a.status === "run" ? b.startedAt - a.startedAt : b.at - a.at);
  rows.sort(order);
  const limit = input.idleLimit ?? 8;
  let idle = 0;
  const open = (r: BarRow) => (!!input.openThreadId && r.threadId === input.openThreadId) || (!!input.openSessionId && r.sessionId === input.openSessionId);
  const kept = rows.filter((r) => r.status !== "idle" || ++idle <= limit || open(r));
  // a parent an idle cap dropped comes back for the child that is still here, so the child is never orphaned
  const keptKeys = new Set(kept.map((r) => r.key));
  for (const r of kept) if (r.parentKey && !keptKeys.has(r.parentKey)) { keptKeys.add(r.parentKey); kept.push(rows.find((x) => x.key === r.parentKey)!); }
  kept.sort(order);
  return nest(kept);
}

/** Each child right under its parent, the pair placed where the first of them came in the order. */
function nest(rows: BarRow[]): BarRow[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: BarRow[] = [];
  const placed = new Set<string>();
  for (const r of rows) {
    if (placed.has(r.key)) continue;
    const top = (r.parentKey && byKey.get(r.parentKey)) || r;
    if (!placed.has(top.key)) { out.push(top); placed.add(top.key); }
    for (const child of rows) if (child.parentKey === top.key && !placed.has(child.key)) { out.push({ ...child, depth: 1 }); placed.add(child.key); }
  }
  return out;
}

/** ⌘K's sessions, each group in the bar's order: waiting on the person, in progress (running or idle), and ended. */
export function paletteSessionGroups(rows: BarRow[]): { waiting: BarRow[]; active: BarRow[]; history: BarRow[] } {
  return { waiting: rows.filter((r) => r.status === "wait"), active: rows.filter((r) => r.status === "run" || r.status === "idle"), history: rows.filter((r) => r.status === "done") };
}
