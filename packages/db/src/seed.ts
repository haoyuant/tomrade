import { randomUUID } from "node:crypto";
import type { Queryable } from "./sqlite.js";

/** The one view every board is guaranteed to have. */
export const ALL_WORK_VIEW = {
  name: "All work",
  icon: "i-board",
  groupBy: "status",
  columns: ["backlog", "todo", "doing", "verifying", "done", "cancelled"]
} as const;

export function insertDefaultView(db: Queryable, boardId: string, now: number, rank = 0): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO views (id, board_id, name, icon, group_by, columns_json, filter_json, wip_json, rank, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', ?, ?, ?)`
  ).run(id, boardId, ALL_WORK_VIEW.name, ALL_WORK_VIEW.icon, ALL_WORK_VIEW.groupBy, JSON.stringify(ALL_WORK_VIEW.columns), rank, now, now);
  return id;
}

/** The two cross-board scopes seeded alongside every project's first board. */
const SCOPES = [
  {
    name: "Recently updated",
    icon: "i-clock",
    sort: "recent",
    subtitle: "all boards",
    note: "Every issue in the project, newest write first",
    views: [
      ALL_WORK_VIEW,
      { name: "Agent writes", icon: "i-pen", groupBy: "status", columns: ["todo", "doing", "verifying", "done"], filter: { provenance: ["ai"] } }
    ]
  },
  {
    name: "Epics",
    icon: "i-stack",
    sort: null,
    subtitle: "all boards",
    note: "Every issue in the project, one column per epic",
    views: [{ name: "All epics", icon: "i-stack", groupBy: "epic", columns: [] }]
  }
] as const;

/** Seeds the Main board and both scopes; returns the board's id. */
export function seedProjectBoards(db: Queryable, projectId: string, now: number): string {
  const boardId = randomUUID();
  db.prepare(
    `INSERT INTO boards (id, project_id, name, icon, subtitle, across, sort, note, rank, created_at, updated_at)
     VALUES (?, ?, 'Main', 'i-board', NULL, 0, NULL, NULL, 0, ?, ?)`
  ).run(boardId, projectId, now, now);
  insertDefaultView(db, boardId, now);

  SCOPES.forEach((scope, i) => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO boards (id, project_id, name, icon, subtitle, across, sort, note, rank, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(id, projectId, scope.name, scope.icon, scope.subtitle, scope.sort, scope.note, 100 + i, now, now);
    scope.views.forEach((v, vi) => {
      db.prepare(
        `INSERT INTO views (id, board_id, name, icon, group_by, columns_json, filter_json, wip_json, rank, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`
      ).run(randomUUID(), id, v.name, v.icon, v.groupBy, JSON.stringify(v.columns), JSON.stringify("filter" in v ? v.filter : {}), vi, now, now);
    });
  });
  return boardId;
}
