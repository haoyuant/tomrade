import type { SessionRow, TerminalRow, ThreadRow } from "@tomradex/code-sessions";
import { isApprovalAsk } from "../lib/terminalSession";

/** A live session this window cannot show: it runs in another terminal app here, on another computer, or in the assistant panel. */
export const away = (s: SessionRow): boolean => s.endedAt === null && s.where !== "herdr";

export const live = (s: SessionRow): boolean => s.state !== "ended" && s.state !== "lost";

/** Where a row stands in the session bar: waiting on the person, running, idle, or ended. */
export type BarStatus = "wait" | "run" | "idle" | "done";

/**
 * One row of the session bar: a session in a herdr pane of its own, a terminal opened here — with the ticket session
 * its agent claimed, once it has — or an assistant conversation, with the headless session Tomrade runs for it.
 */
export type HereRow = { kind: "session"; id: string; session: SessionRow } | { kind: "terminal"; id: string; terminal: TerminalRow; session: SessionRow | null } | { kind: "thread"; id: string; thread: ThreadRow; session: SessionRow | null; /** 1 when it sits under the conversation it writes code in the background for. */ depth?: 1 };

/** The herdr pane a row's terminal is; null while it has none, and for a conversation, which has no pane here. */
export const paneOf = (r: HereRow): string | null => (r.kind === "terminal" ? r.terminal.pane : r.kind === "session" ? r.session.pane : null);

/** A session's status as the bar reads it: ended, on the person (a permission, a question, its merge, an error), running, or idle. */
export const sessionStatus = (s: SessionRow): BarStatus => (!live(s) ? "done" : s.needsYou || s.state === "waiting" || s.state === "error" ? "wait" : s.state === "running" ? "run" : "idle");

export function statusOf(r: HereRow): BarStatus {
  if (r.kind === "thread") {
    const s = r.session && live(r.session) ? r.session : null;
    return r.thread.wait || s?.needsYou ? "wait" : r.thread.running || s?.state === "running" ? "run" : "idle";
  }
  // A plain terminal goes by how herdr reads the agent in it.
  if (r.kind === "terminal" && !r.session) {
    const agent = r.terminal.agentStatus;
    return agent === "blocked" ? "wait" : agent === "working" ? "run" : "idle";
  }
  return sessionStatus(r.session!);
}

/** The session waits on a permission its card can answer: its agent declared the keys, and its screen shows that prompt. */
export const canAnswer = (s: SessionRow): boolean => s.approval && s.prompt !== null && live(s) && isApprovalAsk(s);

/** How long a row says it is new: the assistant panel's session bar's rule. */
export const NEW_MS = 60_000;

/** Just started and not over: the bar says so for its first minute. */
export const isNewRow = (r: HereRow, now = Date.now()): boolean => statusOf(r) !== "done" && now - rowStartedAt(r) < NEW_MS;

const RANK: Record<BarStatus, number> = { wait: 0, run: 1, idle: 2, done: 3 };
export const rowStartedAt = (r: HereRow): number => (r.kind === "terminal" ? r.terminal.startedAt : r.kind === "session" ? r.session.startedAt : r.thread.createdAt);
/** When the row last moved: its hooks' last word, else its start; a conversation's last update. */
const movedAt = (r: HereRow): number => (r.kind === "thread" ? (r.session?.lastEventAt ?? r.thread.updatedAt) : r.kind === "terminal" && !r.session ? r.terminal.startedAt : (r.session!.lastEventAt ?? r.session!.startedAt));
export const waitedSince = (r: HereRow): number => (r.kind === "thread" ? (r.thread.wait?.since ?? movedAt(r)) : movedAt(r));

/**
 * The bar's order, the assistant panel's: waiting first, by how long each has waited; then running, by start; idle by
 * when last used; ended last, by when. It holds still while output streams.
 */
export function order(a: HereRow, b: HereRow): number {
  const sa = statusOf(a);
  const sb = statusOf(b);
  if (sa !== sb) return RANK[sa] - RANK[sb];
  if (sa === "wait") return waitedSince(a) - waitedSince(b);
  if (sa === "run") return rowStartedAt(b) - rowStartedAt(a);
  if (sa === "done") return (b.session?.endedAt ?? 0) - (a.session?.endedAt ?? 0);
  return movedAt(b) - movedAt(a);
}

/**
 * The session bar: one list of what this window shows and the assistant's conversations, and the live sessions it
 * cannot show. A session with no ticket is never a row of its own when a terminal here holds its pane: that terminal is
 * the row. A session without a pane here whose conversation is the assistant's rides on that conversation's row. Rows
 * on one pane — an agent working several tickets side by side — sit together, where the first of them would. A conversation
 * writing code in the background for another sits right under it, the same way. An ended session a cell shows to read
 * closes the list, with what came of it; the rest are History's.
 */
export function sidebarRows(sessions: SessionRow[], terminals: TerminalRow[], threads: ThreadRow[] = []): { here: HereRow[]; away: SessionRow[] } {
  const live = sessions.filter((s) => s.endedAt === null);
  const byId = new Map(live.map((s) => [s.id, s]));
  const terminalPanes = new Set(terminals.flatMap((t) => (t.pane ? [t.pane] : [])));
  const claimed = new Set(terminals.flatMap((t) => (t.sessionId ? [t.sessionId] : [])));
  const listed = new Set(threads.map((t) => t.id));
  const onThread = (s: SessionRow) => !s.pane && !!s.threadId && listed.has(s.threadId);
  const byThread = new Map(live.filter(onThread).map((s) => [s.threadId!, s]));
  const rows: HereRow[] = [
    ...terminals.map((t): HereRow => ({ kind: "terminal", id: t.id, terminal: t, session: t.sessionId ? (byId.get(t.sessionId) ?? null) : null })),
    ...live.filter((s) => !away(s) && !claimed.has(s.id) && !(s.pane && !s.itemId && terminalPanes.has(s.pane))).map((s): HereRow => ({ kind: "session", id: s.id, session: s })),
    ...threads.map((t): HereRow => ({ kind: "thread", id: t.id, thread: t, session: byThread.get(t.id) ?? null }))
  ];
  const sorted = rows.sort(order);
  const here: HereRow[] = [];
  const parentOf = (r: HereRow) => (r.kind === "thread" && r.thread.parentId ? sorted.find((o) => o.kind === "thread" && o.id === r.thread.parentId) : undefined);
  const children = (r: HereRow) => sorted.filter((o): o is Extract<HereRow, { kind: "thread" }> => o.kind === "thread" && o.thread.parentId === r.id).map((o) => ({ ...o, depth: 1 as const }));
  for (const r of sorted) {
    if (here.some((o) => o.id === r.id)) continue;
    const top = parentOf(r) ?? r;
    const pane = paneOf(top);
    if (pane) { here.push(...sorted.filter((o) => paneOf(o) === pane)); continue; }
    if (!here.some((o) => o.id === top.id)) here.push(top);
    here.push(...children(top).filter((c) => !here.some((o) => o.id === c.id)));
  }
  const done = sessions.filter((s) => s.endedAt !== null && s.continuedIn === null).map((s): HereRow => ({ kind: "session", id: s.id, session: s }));
  return { here: [...here, ...done.sort(order)], away: live.filter((s) => away(s) && !onThread(s)) };
}

/** The list cut where the pane changes: rows on one pane make one bundle, every other row one of its own. */
export function bundles(rows: HereRow[]): HereRow[][] {
  const out: HereRow[][] = [];
  for (const r of rows) {
    const last = out.at(-1);
    const pane = paneOf(r);
    if (last && pane && paneOf(last[0]!) === pane) last.push(r);
    else out.push([r]);
  }
  return out;
}

/** What a session goes by in the list: its ticket, else its branch, else its agent. */
export const sessionName = (s: SessionRow): string => s.key ?? (s.branch || s.agentName || s.agent);
