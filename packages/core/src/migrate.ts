import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { SCHEMA_VERSION } from "./schema.js";

interface ColumnRow {
  name: string;
}

function columns(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[]).map((c) => c.name));
}

function addColumn(db: Db, table: string, name: string, ddl: string): void {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

/** The one view every board is guaranteed to have (TOM-19). */
export const ALL_WORK_VIEW = {
  name: "All work",
  icon: "i-board",
  groupBy: "status",
  columns: ["backlog", "todo", "doing", "verifying", "done", "cancelled"]
} as const;

export function insertDefaultView(db: Db, boardId: string, now: number, rank = 0): string {
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
    views: [ALL_WORK_VIEW, { name: "Agent writes", icon: "i-pen", groupBy: "status", columns: ["todo", "doing", "verifying", "done"], filter: { provenance: ["ai"] } }]
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

export function seedProjectBoards(db: Db, projectId: string, now: number): string {
  const boardId = randomUUID();
  db.prepare(
    `INSERT INTO boards (id, project_id, name, icon, subtitle, across, sort, note, rank, created_at, updated_at)
     VALUES (?, ?, 'All work', 'i-board', NULL, 0, NULL, NULL, 0, ?, ?)`
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
      ).run(
        randomUUID(),
        id,
        v.name,
        v.icon,
        v.groupBy,
        JSON.stringify(v.columns),
        JSON.stringify("filter" in v ? v.filter : {}),
        vi,
        now,
        now
      );
    });
  });
  return boardId;
}

/**
 * Bring a database written by an older build up to SCHEMA_VERSION. Additive
 * only: existing rows are preserved and backfilled, never dropped.
 */
export function migrate(db: Db): void {
  const from = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (from >= SCHEMA_VERSION) return;

  const now = Date.now();
  const tx = db.transaction(() => {
    addColumn(db, "projects", "key_prefix", "TEXT NOT NULL DEFAULT 'TOM'");
    addColumn(db, "projects", "next_key_num", "INTEGER NOT NULL DEFAULT 1");
    addColumn(db, "projects", "archived", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "items", "board_id", "TEXT NOT NULL DEFAULT ''");
    addColumn(db, "items", "key_num", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "items", "priority", "INTEGER NOT NULL DEFAULT 2");

    // Every project needs its board set before items can point at one. Orphan
    // project_ids are included: leaving them unkeyed would break the unique key
    // index that is created straight after this runs.
    const projects = db
      .prepare("SELECT id FROM projects UNION SELECT DISTINCT project_id AS id FROM items WHERE project_id NOT IN (SELECT id FROM projects)")
      .all() as { id: string }[];
    for (const p of projects) {
      // an item can only carry a project_id that has no project row after a
      // partial migration or a manual edit; give it somewhere to live
      db.prepare("INSERT OR IGNORE INTO projects (id, name, description, key_prefix, next_key_num, archived, created_at, updated_at) VALUES (?, ?, NULL, 'TOM', 1, 0, ?, ?)")
        .run(p.id, `Recovered ${p.id}`, now, now);
      const hasBoard = db.prepare("SELECT 1 FROM boards WHERE project_id = ? LIMIT 1").get(p.id);
      const boardId = hasBoard
        ? (db.prepare("SELECT id FROM boards WHERE project_id = ? AND across = 0 ORDER BY rank LIMIT 1").get(p.id) as { id: string }).id
        : seedProjectBoards(db, p.id, now);
      db.prepare("UPDATE items SET board_id = ? WHERE project_id = ? AND (board_id IS NULL OR board_id = '')").run(boardId, p.id);

      // Keys are assigned oldest-first so they read as a creation sequence.
      const unkeyed = db
        .prepare("SELECT id FROM items WHERE project_id = ? AND key_num = 0 ORDER BY updated_at ASC")
        .all(p.id) as { id: string }[];
      let next = ((db.prepare("SELECT MAX(key_num) AS m FROM items WHERE project_id = ?").get(p.id) as { m: number | null }).m ?? 0) + 1;
      for (const row of unkeyed) {
        db.prepare("UPDATE items SET key_num = ? WHERE id = ?").run(next, row.id);
        next += 1;
      }
      // never rewind: a key that was handed out and then deleted must not come back
      db.prepare("UPDATE projects SET next_key_num = MAX(next_key_num, ?) WHERE id = ?").run(next, p.id);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  tx();
}
