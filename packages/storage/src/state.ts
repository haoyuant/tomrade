import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CORE_SCHEMA_VERSION, seedDefaultViews, type Queryable } from "@tomrade/db";
import { NewerSchemaError } from "./types.js";

/** The slice of a connection the artifact needs; a project's own `ProjectDb` satisfies it. */
export interface StateDb extends Queryable {
  transaction<T>(fn: () => T): T;
}

export const ARTIFACT_DIR = ".tomrade";
const MANIFEST = "project.json";
const STATE_DIR = "state";
const GITIGNORE = ".gitignore";
const MCP = "mcp.json";

const PROJECT_COLUMNS = ["id", "name", "description", "key_prefix", "next_key_num", "archived", "created_at", "updated_at"] as const;

interface TableSpec {
  /** File name under `state/`, and the SQL table. */
  name: string;
  columns: readonly string[];
  /** WHERE clause over `@projectId`. */
  scope: string;
  /** Deterministic ordering — the artifact must be byte-identical for identical data. */
  order: string;
}

const ITEMS_OF = "SELECT id FROM items WHERE project_id = @projectId";
const FIELDS_OF = "SELECT id FROM fields WHERE project_id = @projectId";
const VIEWS_OF = "SELECT id FROM views WHERE project_id = @projectId";

/**
 * One list drives export, import, file names and ordering, so the artifact
 * cannot drift from the schema in only one of those places.
 */
export const TABLES: readonly TableSpec[] = [
  {
    name: "boards",
    columns: ["id", "project_id", "name", "icon", "subtitle", "across", "sort", "note", "rank", "created_at", "updated_at"],
    scope: "project_id = @projectId",
    order: "id"
  },
  {
    name: "views",
    // board_id is legacy and always ''; it stays in the row so an older database, where it is NOT NULL, can take the import.
    columns: ["id", "project_id", "board_id", "name", "icon", "layout", "query_json", "rank", "created_at", "updated_at"],
    scope: "project_id = @projectId",
    order: "id"
  },
  {
    name: "items",
    columns: ["id", "project_id", "board_id", "key_num", "title", "body", "kind", "status", "priority", "parent_id", "rank", "updated_at", "updated_by", "version", "human_locked"],
    scope: "project_id = @projectId",
    order: "id"
  },
  { name: "labels", columns: ["id", "project_id", "name"], scope: "project_id = @projectId", order: "id" },
  { name: "fields", columns: ["id", "project_id", "name", "type", "rank", "created_at", "updated_at"], scope: "project_id = @projectId", order: "id" },
  { name: "field_options", columns: ["id", "field_id", "name", "description", "rank"], scope: `field_id IN (${FIELDS_OF})`, order: "id" },
  { name: "item_values", columns: ["item_id", "field_id", "num", "text"], scope: `field_id IN (${FIELDS_OF})`, order: "item_id, field_id" },
  { name: "item_labels", columns: ["item_id", "label_id"], scope: `item_id IN (${ITEMS_OF})`, order: "item_id, label_id" },
  {
    name: "item_relations",
    columns: ["from_item_id", "to_item_id", "kind"],
    // Both ends inside the project: an edge across projects has no home in one
    // project's artifact, and cannot exist at all once a project is one file.
    scope: `from_item_id IN (${ITEMS_OF}) AND to_item_id IN (${ITEMS_OF})`,
    order: "from_item_id, to_item_id, kind"
  },
  { name: "view_item_rank", columns: ["view_id", "item_id", "rank"], scope: `view_id IN (${VIEWS_OF})`, order: "view_id, item_id" }
];

export interface ProjectManifest {
  v: 1;
  /** The core schema the artifact was written against; a newer one is refused on read. */
  schemaVersion: number;
  project: Record<string, unknown>;
}

export interface ProjectState {
  manifest: ProjectManifest;
  /** Table name → rows, in the order `TABLES` declares. */
  tables: Record<string, Record<string, unknown>[]>;
}

export const projectIdOf = (state: ProjectState): string => String(state.manifest.project.id);

/** Rows in declared column order, so `JSON.stringify` is canonical. */
function pick(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[c] ?? null;
  return out;
}

export function exportState(db: StateDb, projectId: string): ProjectState {
  const project = db.prepare(`SELECT ${PROJECT_COLUMNS.join(", ")} FROM projects WHERE id = @projectId`).get({ projectId }) as Record<string, unknown> | undefined;
  if (!project) throw new Error(`Project ${projectId} not found`);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const spec of TABLES) {
    const rows = db.prepare(`SELECT ${spec.columns.join(", ")} FROM ${spec.name} WHERE ${spec.scope} ORDER BY ${spec.order}`).all({ projectId }) as Record<string, unknown>[];
    tables[spec.name] = rows.map((r) => pick(r, spec.columns));
  }
  return { manifest: { v: 1, schemaVersion: CORE_SCHEMA_VERSION, project: pick(project, PROJECT_COLUMNS) }, tables };
}

/**
 * The artifact as file contents, keyed by path relative to the destination.
 * Deterministic: identical data produces identical bytes, so an unchanged
 * project makes no commit.
 */
export function serializeState(state: ProjectState, opts: { mcpUrl?: string | null } = {}): Map<string, string> {
  const files = new Map<string, string>();
  files.set(path.join(ARTIFACT_DIR, MANIFEST), JSON.stringify(state.manifest, null, 2) + "\n");
  for (const spec of TABLES) {
    const rows = state.tables[spec.name] ?? [];
    files.set(path.join(ARTIFACT_DIR, STATE_DIR, `${spec.name}.jsonl`), rows.map((r) => JSON.stringify(pick(r, spec.columns))).join("\n") + (rows.length ? "\n" : ""));
  }
  files.set(
    path.join(ARTIFACT_DIR, GITIGNORE),
    ["# The live database never belongs in a destination — only this text does.", "*.db", "*.db-wal", "*.db-shm", "*.db-journal", "*.tmp", ""].join("\n")
  );
  if (opts.mcpUrl) {
    files.set(path.join(ARTIFACT_DIR, MCP), JSON.stringify({ mcpServers: { tomrade: { type: "http", url: opts.mcpUrl } } }, null, 2) + "\n");
  }
  return files;
}

/** A digest of the artifact's own bytes, so "nothing changed" is exact rather than inferred. */
export function digestState(state: ProjectState): string {
  const hash = createHash("sha256");
  for (const [name, body] of [...serializeState(state)].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update("\0");
    hash.update(body);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function writeIfChanged(file: string, body: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === body) return false;
  } catch {
    // absent
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
  return true;
}

/** Returns true when anything on disk actually changed. */
export function writeArtifact(dir: string, state: ProjectState, opts: { mcpUrl?: string | null } = {}): boolean {
  const files = serializeState(state, opts);
  let changed = false;
  for (const [rel, body] of files) changed = writeIfChanged(path.join(dir, rel), body) || changed;
  // A table dropped from the spec must not linger and be read back later.
  const stateDir = path.join(dir, ARTIFACT_DIR, STATE_DIR);
  for (const entry of fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []) {
    if (!files.has(path.join(ARTIFACT_DIR, STATE_DIR, entry))) {
      fs.rmSync(path.join(stateDir, entry), { force: true });
      changed = true;
    }
  }
  return changed;
}

export const hasArtifact = (dir: string): boolean => fs.existsSync(path.join(dir, ARTIFACT_DIR, MANIFEST));

export function readArtifact(dir: string): ProjectState | null {
  const manifestPath = path.join(dir, ARTIFACT_DIR, MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ProjectManifest;
  if (typeof manifest?.project?.id !== "string") throw new Error(`${manifestPath} is not a Tomrade project manifest`);
  if (manifest.schemaVersion > CORE_SCHEMA_VERSION) throw new NewerSchemaError(manifest.schemaVersion, CORE_SCHEMA_VERSION);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const spec of TABLES) {
    const file = path.join(dir, ARTIFACT_DIR, STATE_DIR, `${spec.name}.jsonl`);
    const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    tables[spec.name] = body
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => pick(JSON.parse(l) as Record<string, unknown>, spec.columns));
  }
  return { manifest, tables };
}

/**
 * Replace the project's rows with the artifact's. Not a user write: an import
 * materialises a project that already exists elsewhere, so it never goes through
 * `write()` and lands no oplog rows — the same bootstrap path `seedProjectBoards`
 * takes inside `projects.create`.
 */
export function importState(db: StateDb, state: ProjectState): void {
  const projectId = projectIdOf(state);
  db.transaction(() => {
    // Each sweep scopes through a table a later one empties, so dependents go first.
    db.prepare(`DELETE FROM view_item_rank WHERE view_id IN (${VIEWS_OF})`).run({ projectId });
    db.prepare(`DELETE FROM item_labels WHERE item_id IN (${ITEMS_OF})`).run({ projectId });
    db.prepare(`DELETE FROM item_values WHERE field_id IN (${FIELDS_OF})`).run({ projectId });
    db.prepare(`DELETE FROM field_options WHERE field_id IN (${FIELDS_OF})`).run({ projectId });
    db.prepare("DELETE FROM fields WHERE project_id = @projectId").run({ projectId });
    db.prepare(`DELETE FROM item_relations WHERE from_item_id IN (${ITEMS_OF}) OR to_item_id IN (${ITEMS_OF})`).run({ projectId });
    db.prepare("DELETE FROM views WHERE project_id = @projectId").run({ projectId });
    db.prepare("DELETE FROM items WHERE project_id = @projectId").run({ projectId });
    db.prepare("DELETE FROM labels WHERE project_id = @projectId").run({ projectId });
    db.prepare("DELETE FROM boards WHERE project_id = @projectId").run({ projectId });

    const cols = PROJECT_COLUMNS.join(", ");
    const binds = PROJECT_COLUMNS.map((c) => `@${c}`).join(", ");
    const updates = PROJECT_COLUMNS.filter((c) => c !== "id")
      .map((c) => `${c} = excluded.${c}`)
      .join(", ");
    db.prepare(`INSERT INTO projects (${cols}) VALUES (${binds}) ON CONFLICT(id) DO UPDATE SET ${updates}`).run(state.manifest.project);

    for (const spec of TABLES) {
      let rows = state.tables[spec.name] ?? [];
      // An artifact from before views belonged to the project has rows nothing can place; the project gets the defaults instead.
      if (spec.name === "views") rows = rows.filter((r) => typeof r.layout === "string" && r.project_id === projectId);
      if (!rows.length) continue;
      const stmt = db.prepare(`INSERT INTO ${spec.name} (${spec.columns.join(", ")}) VALUES (${spec.columns.map((c) => `@${c}`).join(", ")})`);
      for (const row of rows) stmt.run(pick(row, spec.columns));
    }
    if (!(db.prepare("SELECT 1 FROM views WHERE project_id = @projectId LIMIT 1").get({ projectId }))) seedDefaultViews(db, projectId, Date.now());
  });
}
