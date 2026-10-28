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
 * A session's hook, read by what lists sessions and a ticket's page; a session's state, ask or block changing
 * also by the board's badges and the other contributions. Tickets and threads are not asked again.
 */
export function invalidateSessions(qc: QueryClient, projectId: string, moved: boolean): void {
  for (const key of [keys.codeLink.sessionsAll(projectId), keys.codeLink.recentSessions(projectId), keys.codeLink.timelineAll(projectId), keys.codeLink.handoffAll(projectId), keys.codeLink.reviewAll(projectId), keys.sectionsAll(projectId)]) {
    void qc.invalidateQueries({ queryKey: key });
  }
  if (moved) invalidateContributions(qc, projectId);
}
