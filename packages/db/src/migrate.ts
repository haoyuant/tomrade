import { randomUUID } from "node:crypto";
import type { Sqlite } from "./sqlite.js";
import { CORE_SCHEMA_VERSION } from "./schema.js";
import { seedProjectBoards, VIEW_KINDS, type ViewKindSeed } from "./seed.js";

function columns(db: Sqlite, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

function addColumn(db: Sqlite, table: string, name: string, ddl: string): void {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

const VIEW_KIND_META: Record<ViewKindSeed, { name: string; icon: string; groupBy: string }> = {
  status: { name: "Status", icon: "s-doing", groupBy: "status" },
  priority: { name: "Priority", icon: "i-bars", groupBy: "priority" },
  epic: { name: "Epic", icon: "i-stack", groupBy: "epic" },
  dependencies: { name: "Dependencies", icon: "i-graph", groupBy: "status" }
};

/**
 * Collapses every board down to exactly one view per built-in kind. A view
 * whose (backfilled) kind already matches one is kept — the oldest by rank
 * wins a duplicate — everything else on the board is dropped; a kind with no
 * match gets a fresh, empty-columns row. Additive in spirit (nothing outside
 * `views` is touched) but this table's rows are deliberately reconciled, not
 * just backfilled: the old free-form "saved views" model is being retired.
 */
function reconcileBuiltinViews(db: Sqlite, now: number): void {
  const boards = db.prepare("SELECT id FROM boards").all() as { id: string }[];
  for (const board of boards) {
    const rows = db.prepare("SELECT id, kind FROM views WHERE board_id = ? ORDER BY rank ASC, created_at ASC").all(board.id) as {
      id: string;
      kind: string | null;
    }[];
    const byKind = new Map<ViewKindSeed, string>();
    const extra: string[] = [];
    for (const row of rows) {
      const kind = row.kind && (VIEW_KINDS as readonly string[]).includes(row.kind) ? (row.kind as ViewKindSeed) : null;
      if (kind && !byKind.has(kind)) byKind.set(kind, row.id);
      else extra.push(row.id);
    }
    VIEW_KINDS.forEach((kind, rank) => {
      const meta = VIEW_KIND_META[kind];
      const existingId = byKind.get(kind);
      if (existingId) {
        db.prepare("UPDATE views SET kind = ?, group_by = ?, rank = ? WHERE id = ?").run(kind, meta.groupBy, rank, existingId);
      } else {
        db.prepare(
          `INSERT INTO views (id, board_id, name, icon, group_by, kind, columns_json, filter_json, wip_json, rank, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', '{}', ?, ?, ?)`
        ).run(randomUUID(), board.id, meta.name, meta.icon, meta.groupBy, kind, rank, now, now);
      }
    });
    for (const id of extra) {
      db.prepare("DELETE FROM view_item_rank WHERE view_id = ?").run(id);
      db.prepare("DELETE FROM views WHERE id = ?").run(id);
    }
  }
}

/**
 * Bring a database written by an older build up to CORE_SCHEMA_VERSION.
 * Additive only: rows are preserved and backfilled, never dropped.
 */
export function migrateCore(db: Sqlite): void {
  const from = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (from >= CORE_SCHEMA_VERSION) return;

  const now = Date.now();
  db.transaction(() => {
    addColumn(db, "projects", "key_prefix", "TEXT NOT NULL DEFAULT 'TOM'");
    addColumn(db, "projects", "next_key_num", "INTEGER NOT NULL DEFAULT 1");
    addColumn(db, "projects", "archived", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "items", "board_id", "TEXT NOT NULL DEFAULT ''");
    addColumn(db, "items", "key_num", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "items", "priority", "INTEGER NOT NULL DEFAULT 2");
    addColumn(db, "oplog", "run_id", "TEXT");
    addColumn(db, "views", "kind", "TEXT");
    db.exec("UPDATE views SET kind = group_by WHERE kind IS NULL");
    reconcileBuiltinViews(db, now);

    // Orphan project_ids are included: left unkeyed they would break the unique
    // key index created straight after this runs.
    const projects = db
      .prepare("SELECT id FROM projects UNION SELECT DISTINCT project_id AS id FROM items WHERE project_id NOT IN (SELECT id FROM projects)")
      .all() as { id: string }[];
    for (const p of projects) {
      db.prepare("INSERT OR IGNORE INTO projects (id, name, description, key_prefix, next_key_num, archived, created_at, updated_at) VALUES (?, ?, NULL, 'TOM', 1, 0, ?, ?)")
        .run(p.id, `Recovered ${p.id}`, now, now);
      const hasBoard = db.prepare("SELECT 1 FROM boards WHERE project_id = ? LIMIT 1").get(p.id);
      const boardId = hasBoard
        ? (db.prepare("SELECT id FROM boards WHERE project_id = ? AND across = 0 ORDER BY rank LIMIT 1").get(p.id) as { id: string }).id
        : seedProjectBoards(db, p.id, now);
      db.prepare("UPDATE items SET board_id = ? WHERE project_id = ? AND (board_id IS NULL OR board_id = '')").run(boardId, p.id);

      // Keys are assigned oldest-first so they read as a creation sequence.
      const unkeyed = db.prepare("SELECT id FROM items WHERE project_id = ? AND key_num = 0 ORDER BY updated_at ASC").all(p.id) as { id: string }[];
      let next = ((db.prepare("SELECT MAX(key_num) AS m FROM items WHERE project_id = ?").get(p.id) as { m: number | null }).m ?? 0) + 1;
      for (const row of unkeyed) {
        db.prepare("UPDATE items SET key_num = ? WHERE id = ?").run(next, row.id);
        next += 1;
      }
      // Never rewind: a key that was handed out and then deleted must not come back.
      db.prepare("UPDATE projects SET next_key_num = MAX(next_key_num, ?) WHERE id = ?").run(next, p.id);
    }
    db.pragma(`user_version = ${CORE_SCHEMA_VERSION}`);
  })();
}
