import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { CORE_TABLES_SQL, migrateCore, projectPredicate, type Db, type PluginRegistration, type ProjectDb } from "@tomradex/db";

/** Core tables and the clause that selects one project's rows in a database holding several. */
const CORE_SCOPES: [table: string, where: string][] = [
  ["boards", "project_id = @projectId"],
  ["repos", "project_id = @projectId"],
  ["views", "project_id = @projectId"],
  ["items", "project_id = @projectId"],
  ["labels", "project_id = @projectId"],
  ["fields", "project_id = @projectId"],
  ["field_options", "field_id IN (SELECT id FROM legacy.fields WHERE project_id = @projectId)"],
  ["item_values", "field_id IN (SELECT id FROM legacy.fields WHERE project_id = @projectId)"],
  ["item_labels", "item_id IN (SELECT id FROM legacy.items WHERE project_id = @projectId)"],
  ["item_relations", "from_item_id IN (SELECT id FROM legacy.items WHERE project_id = @projectId) AND to_item_id IN (SELECT id FROM legacy.items WHERE project_id = @projectId)"],
  ["view_item_rank", "view_id IN (SELECT id FROM legacy.views WHERE project_id = @projectId)"],
  [
    "oplog",
    // Live rows, plus the snapshot predicate for rows whose subject is soft-deleted or purged.
    `(entity = 'item' AND entity_id IN (SELECT id FROM legacy.items WHERE project_id = @projectId))
     OR (entity = 'board' AND entity_id IN (SELECT id FROM legacy.boards WHERE project_id = @projectId))
     OR (entity = 'view' AND entity_id IN (SELECT id FROM legacy.views WHERE project_id = @projectId))
     OR json_extract(COALESCE(before_json, after_json), '$.projectId') = @projectId
     OR json_extract(COALESCE(before_json, after_json), '$.boardId') IN (SELECT id FROM legacy.boards WHERE project_id = @projectId)`
  ]
];

interface LegacyProject {
  id: string;
  name: string;
  archived: number;
  created_at: number;
}

export interface SplitResult {
  projects: { id: string; name: string; archived: boolean; createdAt: number }[];
  movedTo: string;
}

const columnsOf = (db: ProjectDb, table: string, schema = "main"): string[] =>
  (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

const tableExists = (db: ProjectDb, table: string, schema: string): boolean =>
  !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table);

/**
 * The one-time split of a pre-P0 `tomrade.db`, which held every project, into
 * one cache per project. Each project's rows are copied through ATTACH with the
 * same predicates an export uses; the oplog keeps its seq and is stamped with
 * this machine's id. The old file is moved, never deleted, and only after every
 * project copied cleanly.
 */
export function splitLegacy(opts: { legacyPath: string; db: Db; deviceId: string; backupsDir: string; registrations: PluginRegistration[] }): SplitResult {
  const { legacyPath } = opts;
  // Bring the old file to the current core schema first (it is ours), and fold
  // the WAL into the main file so the attach reads every committed row.
  const legacy = new Database(legacyPath);
  // A pre-boards file lacks tables the migration alters; creating them first is what Db.init always did.
  legacy.exec(CORE_TABLES_SQL);
  migrateCore(legacy);
  legacy.pragma("wal_checkpoint(TRUNCATE)");
  const rows = legacy.prepare("SELECT id, name, archived, created_at FROM projects ORDER BY created_at ASC").all() as LegacyProject[];
  legacy.close();

  const projects: SplitResult["projects"] = [];
  for (const row of rows) {
    const db = opts.db.open(row.id);
    db.prepare("ATTACH DATABASE ? AS legacy").run(legacyPath);
    try {
      db.transaction(() => {
        const projectCols = columnsOf(db, "projects").filter((c) => columnsOf(db, "projects", "legacy").includes(c));
        db.prepare(`INSERT OR REPLACE INTO projects (${projectCols.join(", ")}) SELECT ${projectCols.join(", ")} FROM legacy.projects WHERE id = @projectId`).run({ projectId: row.id });
        for (const [table, where] of CORE_SCOPES) {
          if (!tableExists(db, table, "legacy")) continue;
          const cols = columnsOf(db, table).filter((c) => columnsOf(db, table, "legacy").includes(c));
          db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) SELECT ${cols.join(", ")} FROM legacy.${table} WHERE ${where}`).run({ projectId: row.id });
        }
        for (const reg of opts.registrations) {
          if (reg.scope !== "project") continue;
          for (const table of Object.keys(reg.tables)) {
            if (!tableExists(db, table, "legacy") || !tableExists(db, table, "main")) continue;
            const cols = columnsOf(db, table).filter((c) => columnsOf(db, table, "legacy").includes(c));
            const where = projectPredicate(reg.tables, table).replace(/\bFROM\s+(plugin_\w+)/g, "FROM legacy.$1");
            db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) SELECT ${cols.join(", ")} FROM legacy.${table} WHERE ${where}`).run({ projectId: row.id });
          }
        }
        // Everything in the old file was written here.
        db.prepare("UPDATE oplog SET device = @device, device_seq = seq WHERE device = ''").run({ device: opts.deviceId });
        // Never rewind the counter: a key handed out and deleted must not come back.
        db.prepare("UPDATE projects SET next_key_num = MAX(next_key_num, COALESCE((SELECT MAX(key_num) FROM items), 0) + 1) WHERE id = @projectId").run({ projectId: row.id });
      });
    } finally {
      db.prepare("DETACH DATABASE legacy").run();
    }
    projects.push({ id: row.id, name: row.name, archived: row.archived === 1, createdAt: row.created_at });
  }

  // History whose subject no predicate can place (a snapshot from before rows
  // named their project) has exactly one possible home when there is one project.
  if (rows.length === 1) {
    const db = opts.db.for(rows[0].id);
    db.prepare("ATTACH DATABASE ? AS legacy").run(legacyPath);
    try {
      const cols = columnsOf(db, "oplog").filter((c) => columnsOf(db, "oplog", "legacy").includes(c));
      db.transaction(() => {
        db.prepare(`INSERT OR IGNORE INTO oplog (${cols.join(", ")}) SELECT ${cols.join(", ")} FROM legacy.oplog WHERE seq NOT IN (SELECT seq FROM main.oplog)`).run();
        db.prepare("UPDATE oplog SET device = @device, device_seq = seq WHERE device = ''").run({ device: opts.deviceId });
      });
    } finally {
      db.prepare("DETACH DATABASE legacy").run();
    }
  }

  fs.mkdirSync(opts.backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const target = path.join(opts.backupsDir, `tomrade.db.pre-split.${stamp}`);
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(legacyPath + suffix)) fs.renameSync(legacyPath + suffix, target + suffix);
  }
  return { projects, movedTo: target };
}
