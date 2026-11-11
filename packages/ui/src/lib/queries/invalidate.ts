import type { QueryClient } from "@tanstack/react-query";
import { keys } from "./keys";

/** Everything a board write can invalidate, in one call. */
export function invalidateWorkspace(qc: QueryClient, projectId: string): void {
  void qc.invalidateQueries({ queryKey: keys.items(projectId) });
  void qc.invalidateQueries({ queryKey: keys.labels(projectId) });
  void qc.invalidateQueries({ queryKey: keys.oplog(projectId) });
  void qc.invalidateQueries({ queryKey: keys.timeline(projectId) });
  void qc.invalidateQueries({ queryKey: keys.syncAttention(projectId) });
  void qc.invalidateQueries({ queryKey: keys.historyAll(projectId) });
  invalidateContributions(qc, projectId);
}

/**
 * What plugins show about one project's tickets. The palette's commands, the graph
 * list and the assistant's accessories do not read tickets; a plugin or the
 * language changing them comes as its own broadcast.
 */
export function invalidateContributions(qc: QueryClient, projectId: string): void {
  for (const key of [keys.badges(projectId), keys.sidebarModules(projectId), keys.sectionsAll(projectId), keys.graphEdgesAll(projectId), keys.statusItems(projectId), keys.statusItems()]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

/**
 * Everything keyed by one project. `invalidateWorkspace` deliberately leaves
 * boards, views and ranks alone — a board write cannot change them — but an
 * import from a destination replaces every row, so this one spares nothing.
 */
export function invalidateProject(qc: QueryClient, projectId: string): void {
  invalidateWorkspace(qc, projectId);
  for (const key of [keys.boards(projectId), keys.views(projectId), keys.fields(projectId), keys.projects, keys.storageStatus(projectId), keys.storageInfo(projectId)]) {
    void qc.invalidateQueries({ queryKey: key });
  }
  void qc.invalidateQueries({ queryKey: keys.ranksAll });
}

/**
 * What a burst of writes to a project can have changed, by what they wrote: a ticket reaches the board and what
 * reads tickets; a view (its settings or a card's rank, as a drag writes it) only the views and ranks. A board
 * written (rare: a workstream added, renamed, removed), or anything else, asks for everything.
 */
export function invalidateWrites(qc: QueryClient, projectId: string, entities: readonly string[]): void {
  if (entities.some((e) => e !== "item" && e !== "view")) return invalidateProject(qc, projectId);
  if (entities.includes("item")) invalidateWorkspace(qc, projectId);
  if (entities.includes("view")) {
    void qc.invalidateQueries({ queryKey: keys.views(projectId) });
    void qc.invalidateQueries({ queryKey: keys.ranksAll });
  }
}

/** File queries that read one path: they are asked again only when a change names that path, or a folder above it. */
const PATH_READS = new Set(["read", "history"]);

/**
 * A change to a project's files. `paths` names what changed when the writer knows; without it (a sync, an outside
 * edit) everything about the project's files is asked again. With it, the tree, status and the rest are, but an
 * open file's content and history only for a path that changed. A version's content never changes.
 */
export function invalidateFiles(qc: QueryClient, projectId: string, paths?: readonly string[]): void {
  void qc.invalidateQueries({ queryKey: keys.timeline(projectId) });
  if (!paths) {
    void qc.invalidateQueries({ queryKey: keys.files.all(projectId) });
    return;
  }
  const touched = (p: string) => paths.some((changed) => p === changed || p.startsWith(`${changed}/`));
  void qc.invalidateQueries({
    queryKey: keys.files.all(projectId),
    predicate: (q) => {
      const kind = q.queryKey[2];
      if (kind === "version") return false;
      return typeof kind === "string" && PATH_READS.has(kind) ? touched(String(q.queryKey[3])) : true;
    }
  });
}

/**
 * A session's hook, read by what lists sessions and a ticket's page; a session's state, ask or block changing
 * also by the board's badges and the other contributions. Tickets and threads are not asked again.
 */
export function invalidateSessions(qc: QueryClient, projectId: string, moved: boolean): void {
  // An open diff too: a session's hook is the nearest thing to hearing its working tree change.
  for (const key of [keys.codeLink.sessionsAll(projectId), keys.codeLink.recentSessions(projectId), keys.codeLink.timelineAll(projectId), keys.codeLink.handoffAll(projectId), keys.codeLink.reviewAll(projectId), keys.codeLink.changesAll(projectId), keys.sectionsAll(projectId)]) {
    void qc.invalidateQueries({ queryKey: key });
  }
  if (moved) invalidateContributions(qc, projectId);
}

/** How long hooks settle before what reads sessions is asked again, and the least time between two standing changes' asks. */
export const SESSIONS_SETTLE_MS = 100;
/** Hooks that change no session's standing (only what it is doing) are heard at most once this often. */
export const SESSIONS_GAP_MS = 1000;

/**
 * `invalidateSessions` once per burst of hooks: several agents send a few a second each, and every ask re-reads
 * the session bars' list. A change in a session's standing (`moved`: waiting, ended, claimed, state) goes at once,
 * or within SESSIONS_SETTLE_MS of the last ask; activity waits for the burst to settle and comes at most once a
 * SESSIONS_GAP_MS. A standing change asks for everything activity does, so it takes a pending one along.
 */
export function sessionsRefresher(qc: QueryClient, { settleMs = SESSIONS_SETTLE_MS, gapMs = SESSIONS_GAP_MS } = {}): (projectId: string, moved: boolean) => void {
  const projects = new Map<string, { timer: ReturnType<typeof setTimeout> | null; due: number; moved: boolean; last: number }>();
  const run = (projectId: string) => {
    const soon = projects.get(projectId)!;
    if (soon.timer) clearTimeout(soon.timer);
    const moved = soon.moved;
    Object.assign(soon, { timer: null, moved: false, last: Date.now() });
    invalidateSessions(qc, projectId, moved);
  };
  return (projectId, moved) => {
    const soon = projects.get(projectId) ?? { timer: null, due: 0, moved: false, last: -Infinity };
    projects.set(projectId, soon);
    const now = Date.now();
    soon.moved ||= moved;
    const wait = moved ? Math.max(0, soon.last + settleMs - now) : Math.max(settleMs, soon.last + gapMs - now);
    if (wait === 0) return run(projectId);
    if (soon.timer) {
      if (soon.due <= now + wait) return;
      clearTimeout(soon.timer);
    }
    soon.due = now + wait;
    soon.timer = setTimeout(() => run(projectId), wait);
  };
}
