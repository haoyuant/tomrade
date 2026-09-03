import { randomUUID } from "node:crypto";
import type { Queryable } from "./sqlite.js";

/** The stored shape of a view's query; the domain's `ViewQuery` without the type dependency. */
export interface ViewSeed {
  name: string;
  icon: string;
  layout: "board" | "table" | "graph";
  query: Record<string, unknown>;
}

/** The views every new project opens with. The first is what the project route lands on. */
export const DEFAULT_VIEWS: readonly ViewSeed[] = [
  { name: "Board", icon: "i-board", layout: "board", query: { columnBy: "status" } },
  { name: "Table", icon: "i-bars", layout: "table", query: { sortBy: [{ field: "updated", dir: "desc" }] } },
  { name: "Epics", icon: "i-stack", layout: "board", query: { columnBy: "epic" } },
  { name: "Dependencies", icon: "i-graph", layout: "graph", query: { graph: "deps" } }
];

/** Raw insert, for seeds and migrations; `ctx.views.create` is the logged path. */
export function insertViewRow(db: Queryable, projectId: string, seed: ViewSeed, rank: number, now: number, id = randomUUID()): string {
  db.prepare(
    `INSERT INTO views (id, project_id, board_id, name, icon, layout, query_json, rank, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, seed.name, seed.icon, seed.layout, JSON.stringify(seed.query), rank, now, now);
  return id;
}

export function seedDefaultViews(db: Queryable, projectId: string, now: number): string {
  let first = "";
  DEFAULT_VIEWS.forEach((seed, rank) => {
    const id = insertViewRow(db, projectId, seed, rank, now);
    if (rank === 0) first = id;
  });
  return first;
}

/** Seeds the Main workstream and the default views; returns the board's id. */
export function seedProject(db: Queryable, projectId: string, now: number): string {
  const boardId = randomUUID();
  db.prepare(
    `INSERT INTO boards (id, project_id, name, icon, subtitle, across, sort, note, rank, created_at, updated_at)
     VALUES (?, ?, 'Main', 'i-board', NULL, 0, NULL, NULL, 0, ?, ?)`
  ).run(boardId, projectId, now, now);
  seedDefaultViews(db, projectId, now);
  return boardId;
}
