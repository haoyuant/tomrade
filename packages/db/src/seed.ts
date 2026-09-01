import { randomUUID } from "node:crypto";
import type { Queryable } from "./sqlite.js";

/** The app's four built-in views. Fixed — never created, renamed or removed by a user. */
export const VIEW_KINDS = ["status", "priority", "epic", "dependencies"] as const;
export type ViewKindSeed = (typeof VIEW_KINDS)[number];

/** `name`/`icon`/`group_by` are legacy columns the app no longer reads; kept populated for schema stability. */
const VIEW_KIND_META: Record<ViewKindSeed, { name: string; icon: string; groupBy: string }> = {
  status: { name: "Status", icon: "s-doing", groupBy: "status" },
  priority: { name: "Priority", icon: "i-bars", groupBy: "priority" },
  epic: { name: "Epic", icon: "i-stack", groupBy: "epic" },
  dependencies: { name: "Dependencies", icon: "i-graph", groupBy: "status" }
};

/** Inserts a board's four built-in views; returns the Status view's id. */
export function insertBuiltinViews(db: Queryable, boardId: string, now: number): string {
  let statusId = "";
  VIEW_KINDS.forEach((kind, rank) => {
    const id = randomUUID();
    if (kind === "status") statusId = id;
    const meta = VIEW_KIND_META[kind];
    db.prepare(
      `INSERT INTO views (id, board_id, name, icon, group_by, kind, columns_json, filter_json, wip_json, rank, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', '{}', ?, ?, ?)`
    ).run(id, boardId, meta.name, meta.icon, meta.groupBy, kind, rank, now, now);
  });
  return statusId;
}

/** The two cross-board scopes seeded alongside every project's first board. */
const SCOPES = [
  { name: "Recently updated", icon: "i-clock", sort: "recent", subtitle: "all boards", note: "Every issue in the project, newest write first" },
  { name: "Epics", icon: "i-stack", sort: null, subtitle: "all boards", note: "Every issue in the project, one column per epic" }
] as const;

/** Seeds the Main board and both scopes; returns the board's id. */
export function seedProjectBoards(db: Queryable, projectId: string, now: number): string {
  const boardId = randomUUID();
  db.prepare(
    `INSERT INTO boards (id, project_id, name, icon, subtitle, across, sort, note, rank, created_at, updated_at)
     VALUES (?, ?, 'Main', 'i-board', NULL, 0, NULL, NULL, 0, ?, ?)`
  ).run(boardId, projectId, now, now);
  insertBuiltinViews(db, boardId, now);

  SCOPES.forEach((scope, i) => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO boards (id, project_id, name, icon, subtitle, across, sort, note, rank, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(id, projectId, scope.name, scope.icon, scope.subtitle, scope.sort, scope.note, 100 + i, now, now);
    insertBuiltinViews(db, id, now);
  });
  return boardId;
}
