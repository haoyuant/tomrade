import type { Sqlite } from "./sqlite.js";
import { CORE_SCHEMA_VERSION } from "./schema.js";
import { insertViewRow, seedProject } from "./seed.js";

function columns(db: Sqlite, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

function addColumn(db: Sqlite, table: string, name: string, ddl: string): void {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

interface LegacyViewRow {
  id: string;
  board_id: string;
  kind: string | null;
  group_by: string | null;
  columns_json: string | null;
  filter_json: string | null;
  wip_json: string | null;
  rank: number;
}

interface LegacyBoardRow {
  id: string;
  project_id: string;
  name: string;
  icon: string;
  across: number;
  sort: string | null;
}

const parse = <T>(json: string | null, fallback: T): T => {
  try {
    return json ? (JSON.parse(json) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** The old per-view facet filter, as clauses over the fields it named. */
function clausesOf(filter: Record<string, unknown[] | undefined>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (filter.labels?.length) out.push({ field: "labels", op: "in", values: filter.labels });
  if (filter.epics?.length) out.push({ field: "epic", op: "in", values: filter.epics.map((e) => (e === "none" ? null : e)) });
  if (filter.priorities?.length) out.push({ field: "priority", op: "in", values: filter.priorities.map(String) });
  if (filter.provenance?.length) out.push({ field: "provenance", op: "in", values: filter.provenance });
  return out;
}

/**
 * Boards stop being containers of views and become options of the Workstream
 * field; views move up to the project. Each workstream's Status view becomes a
 * project view named after the board and filtered to it (its row is reused so
 * manual ordering survives); the two cross-board scopes become a Table sorted
 * by recency and a board grouped by epic; every project gains a Dependencies
 * graph. Only unconverted rows (project_id = '') are touched, so this is safe
 * to run again.
 */
function liftViewsToProjects(db: Sqlite, now: number): void {
  const legacy = columns(db, "views").has("kind");
  const projects = db.prepare("SELECT id FROM projects").all() as { id: string }[];
  for (const p of projects) {
    const boards = db.prepare("SELECT id, project_id, name, icon, across, sort FROM boards WHERE project_id = ? ORDER BY across ASC, rank ASC, created_at ASC").all(p.id) as LegacyBoardRow[];
    if (!boards.length) continue;
    const alreadyLifted = (db.prepare("SELECT COUNT(*) AS n FROM views WHERE project_id = ?").get(p.id) as { n: number }).n > 0;
    if (alreadyLifted) continue;
    let rank = 0;
    for (const b of boards) {
      const rows = legacy
        ? (db.prepare("SELECT id, board_id, kind, group_by, columns_json, filter_json, wip_json, rank FROM views WHERE board_id = ? AND project_id = '' ORDER BY rank ASC").all(b.id) as LegacyViewRow[])
        : [];
      const status = rows.find((r) => (r.kind ?? r.group_by) === "status") ?? rows[0];
      const filter = parse<Record<string, unknown[] | undefined>>(status?.filter_json ?? null, {});
      const seed =
        b.across === 1
          ? b.sort === "recent"
            ? { name: b.name, icon: b.icon, layout: "table" as const, query: { filter: clausesOf(filter), sortBy: [{ field: "updated", dir: "desc" }] } }
            : { name: b.name, icon: b.icon, layout: "board" as const, query: { filter: clausesOf(filter), columnBy: "epic" } }
          : {
              name: b.name,
              icon: b.icon,
              layout: "board" as const,
              query: {
                filter: [{ field: "board", op: "in", values: [b.id] }, ...clausesOf(filter)],
                columnBy: "status",
                columns: parse<string[]>(status?.columns_json ?? null, []),
                wip: parse<Record<string, number>>(status?.wip_json ?? null, {})
              }
            };
      if (status) {
        db.prepare("UPDATE views SET project_id = ?, board_id = '', name = ?, icon = ?, layout = ?, query_json = ?, rank = ?, updated_at = ? WHERE id = ?").run(
          p.id,
          seed.name,
          seed.icon,
          seed.layout,
          JSON.stringify(seed.query),
          rank,
          now,
          status.id
        );
      } else {
        insertViewRow(db, p.id, seed, rank, now);
      }
      rank += 1;
      for (const r of rows) {
        if (r.id === status?.id) continue;
        db.prepare("DELETE FROM view_item_rank WHERE view_id = ?").run(r.id);
        db.prepare("DELETE FROM views WHERE id = ?").run(r.id);
      }
      // A scope owned nothing; its view carries on, the row does not.
      if (b.across === 1) db.prepare("DELETE FROM boards WHERE id = ?").run(b.id);
    }
    insertViewRow(db, p.id, { name: "Dependencies", icon: "i-graph", layout: "graph", query: { graph: "deps" } }, rank, now);
  }
}

/**
 * Bring a database written by an older build up to CORE_SCHEMA_VERSION.
 * Additive only: rows are preserved and backfilled, never dropped — the one
 * exception is the views table, whose rows are reconciled into the current
 * model rather than kept in a shape nothing reads.
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
    addColumn(db, "views", "project_id", "TEXT NOT NULL DEFAULT ''");
    addColumn(db, "views", "layout", "TEXT NOT NULL DEFAULT 'board'");
    addColumn(db, "views", "query_json", "TEXT NOT NULL DEFAULT '{}'");
    // A pre-#21 database carries group_by but no kind; the lift reads either.
    if (columns(db, "views").has("group_by")) addColumn(db, "views", "kind", "TEXT");

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
        : seedProject(db, p.id, now);
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

    liftViewsToProjects(db, now);
    db.pragma(`user_version = ${CORE_SCHEMA_VERSION}`);
  })();
}
