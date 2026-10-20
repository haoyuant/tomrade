import type { SessionRow, TerminalRow } from "@tomradex/code-sessions";

/** A live session this window cannot show: it runs in another terminal app here, on another computer, or in the assistant panel. */
export const away = (s: SessionRow): boolean => s.endedAt === null && s.where !== "herdr";

/**
 * One row of what this window shows: a session in a herdr pane of its own, or a terminal opened here — with the
 * ticket session its agent claimed, once it has.
 */
export type HereRow = { kind: "session"; id: string; session: SessionRow } | { kind: "terminal"; id: string; terminal: TerminalRow; session: SessionRow | null };

/** The herdr pane a row's terminal is; null while it has none. */
export const paneOf = (r: HereRow): string | null => (r.kind === "terminal" ? r.terminal.pane : r.session.pane);

/**
 * The sidebar: one list of what this window shows, and the live sessions it cannot. A session with no ticket is never a
 * row of its own when a terminal here holds its pane: that terminal is the row. Rows on one pane — an agent working
 * several tickets side by side — sit together, where the first of them would. Ended sessions are the archive's.
 */
export function sidebarRows(sessions: SessionRow[], terminals: TerminalRow[]): { here: HereRow[]; away: SessionRow[] } {
  const live = sessions.filter((s) => s.endedAt === null);
  const byId = new Map(live.map((s) => [s.id, s]));
  const terminalPanes = new Set(terminals.flatMap((t) => (t.pane ? [t.pane] : [])));
  const claimed = new Set(terminals.flatMap((t) => (t.sessionId ? [t.sessionId] : [])));
  const rows: HereRow[] = [
    ...terminals.map((t): HereRow => ({ kind: "terminal", id: t.id, terminal: t, session: t.sessionId ? (byId.get(t.sessionId) ?? null) : null })),
    ...live.filter((s) => !away(s) && !claimed.has(s.id) && !(s.pane && !s.itemId && terminalPanes.has(s.pane))).map((s): HereRow => ({ kind: "session", id: s.id, session: s }))
  ];
  // Needs-you first, then the ones working a ticket, then plain terminals; newest first within each.
  const rank = (r: HereRow) => {
    const s = r.session;
    if (s?.needsYou) return 0;
    return s?.itemId ? 1 : 2;
  };
  const started = (r: HereRow) => (r.kind === "terminal" ? r.terminal.startedAt : r.session.startedAt);
  const sorted = rows.sort((a, b) => rank(a) - rank(b) || started(b) - started(a));
  const here: HereRow[] = [];
  for (const r of sorted) {
    if (here.includes(r)) continue;
    const pane = paneOf(r);
    here.push(...(pane ? sorted.filter((o) => paneOf(o) === pane) : [r]));
  }
  return { here, away: live.filter(away) };
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
