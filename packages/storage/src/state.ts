import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CORE_SCHEMA_VERSION, seedDefaultViews, type PluginRegistration, type Queryable } from "@tomradex/db";
import { NewerSchemaError } from "./types.js";
import { writeFileAtomic } from "@tomradex/contracts";

/** The slice of a connection the artifact needs; a project's `ProjectDb` satisfies it. */
export interface StateDb extends Queryable {
  transaction<T>(fn: () => T): T;
}

export const ARTIFACT_DIR = ".tomrade";
export const MANIFEST = "project.json";
const STATE_DIR = "state";
const PLUGINS_DIR = "plugins";
export const LOG_DIR = "log";
export const DOCS_DIR = "docs";
const GITIGNORE = ".gitignore";
const GITATTRIBUTES = ".gitattributes";
const README = "README.md";
const MCP = "mcp.json";

/** What the shared row carries. Counters and per-machine flags stay out: they cannot be merged line by line. */
const PROJECT_COLUMNS = ["id", "name", "description", "key_prefix", "created_at"] as const;

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
  { name: "deliveries", columns: ["id", "project_id", "item_id", "sequence", "state", "started_at", "completed_at", "updated_at", "bases_json"], scope: "project_id = @projectId", order: "item_id, sequence" },
  {
    name: "boards",
    columns: ["id", "project_id", "name", "icon", "across", "sort", "note", "rank", "repo_id", "repo_path", "created_at", "updated_at"],
    scope: "project_id = @projectId",
    order: "id"
  },
  { name: "repos", columns: ["id", "project_id", "remote", "name", "default_branch", "created_at", "updated_at"], scope: "project_id = @projectId", order: "id" },
  {
    name: "views",
    // board_id is legacy and always ''; it stays in the row so an older database, where it is NOT NULL, can take the import.
    columns: ["id", "project_id", "board_id", "name", "icon", "layout", "query_json", "rank", "created_at", "updated_at"],
    scope: "project_id = @projectId",
    order: "id"
  },
  {
    name: "items",
    columns: ["id", "project_id", "board_id", "key_num", "title", "body", "kind", "work_type", "playbook_id", "evidence_json", "status", "priority", "parent_id", "rank", "updated_at", "updated_by", "version", "human_locked"],
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
    // Both ends inside the project: an edge across projects has no home in one project's artifact.
    scope: `from_item_id IN (${ITEMS_OF}) AND to_item_id IN (${ITEMS_OF})`,
    order: "from_item_id, to_item_id, kind"
  },
  { name: "view_item_rank", columns: ["view_id", "item_id", "rank"], scope: `view_id IN (${VIEWS_OF})`, order: "view_id, item_id" }
];

/** Snapshot pointer: what the state files hold and which ops of each machine they already include. */
export interface SnapshotInfo {
  digest: string;
  at: number;
  checkpoint: Record<string, number>;
}

export interface ProjectManifest {
  v: 1 | 2;
  /** The core schema the artifact was written against; a newer one is refused on read. */
  schemaVersion: number;
  project: Record<string, unknown>;
  /** Set when Tomrade made this folder's repository for the project alone — then any machine may drive it. */
  repo?: "dedicated";
  /** Plugin namespaces whose tables travel here. Shared, so every machine writes the same set. */
  exports?: string[];
  logWindowDays?: number;
  snapshot?: SnapshotInfo;
}

export interface ProjectState {
  manifest: ProjectManifest;
  /** Table name → rows, in the order `TABLES` declares. */
  tables: Record<string, Record<string, unknown>[]>;
  /** Exported plugin tables: namespace → table → rows. */
  plugins: Record<string, Record<string, Record<string, unknown>[]>>;
}

export const DEFAULT_LOG_WINDOW_DAYS = 30;

export const projectIdOf = (state: ProjectState): string => String(state.manifest.project.id);

/** Rows in declared column order, so `JSON.stringify` is canonical. */
function pick(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[c] ?? (c === "work_type" ? "coding" : c === "evidence_json" ? '{"resources":[],"submissions":[],"reviews":[]}' : null);
  return out;
}

/** The columns of a plugin table, from the file itself; the declaration names only the order. */
export function columnsOf(db: Queryable, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

export function primaryKeyOf(db: Queryable, table: string): string[] {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[]).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  return cols.length ? cols.map((c) => c.name) : ["id"];
}

export interface ExportOptions {
  /** Plugin registrations whose tables may travel; filtered by `exports`, except tables declared `always`. */
  registrations?: PluginRegistration[];
  exports?: string[];
  repo?: "dedicated";
  logWindowDays?: number;
  /** Every machine's furthest op present in this file, so a reader knows which log lines the snapshot already holds. */
  checkpoint?: Record<string, number>;
  at?: number;
  /** `<namespace>/<table>` this machine has never seen: left out, so an empty copy here never stands in for the real one elsewhere. */
  withhold?: string[];
  /** Tables of plugins not registered here, as the folder last had them: written back unchanged rather than dropped. */
  carry?: ProjectState["plugins"];
}

export function exportState(db: StateDb, projectId: string, opts: ExportOptions = {}): ProjectState {
  const project = db.prepare(`SELECT ${PROJECT_COLUMNS.join(", ")} FROM projects WHERE id = @projectId`).get({ projectId }) as Record<string, unknown> | undefined;
  if (!project) throw new Error(`Project ${projectId} not found`);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const spec of TABLES) {
    const rows = db.prepare(`SELECT ${spec.columns.join(", ")} FROM ${spec.name} WHERE ${spec.scope} ORDER BY ${spec.order}`).all({ projectId }) as Record<string, unknown>[];
    tables[spec.name] = rows.map((r) => pick(r, spec.columns));
  }
  const exports = [...(opts.exports ?? [])].sort();
  const plugins: ProjectState["plugins"] = {};
  for (const reg of opts.registrations ?? []) {
    if (reg.scope !== "project") continue;
    const chosen = exports.includes(reg.namespace);
    for (const [table, spec] of Object.entries(reg.tables).sort(([a], [b]) => a.localeCompare(b))) {
      if (!spec.export || !(chosen || spec.export.always)) continue;
      if (opts.withhold?.includes(`${reg.namespace}/${table}`)) continue;
      let columns: string[];
      try {
        columns = columnsOf(db, table);
      } catch {
        continue; // the plugin's migration failed on this file; nothing to export
      }
      if (!columns.length) continue;
      const rows = db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${spec.export.order}`).all() as Record<string, unknown>[];
      (plugins[reg.namespace] ??= {})[table] = rows.map((r) => pick(r, columns));
    }
  }
  for (const [namespace, byTable] of Object.entries(opts.carry ?? {})) {
    if (!plugins[namespace] && Object.keys(byTable).length) plugins[namespace] = byTable;
  }
  const manifest: ProjectManifest = {
    v: 2,
    schemaVersion: CORE_SCHEMA_VERSION,
    project: pick(project, PROJECT_COLUMNS),
    ...(opts.repo ? { repo: opts.repo } : {}),
    exports,
    logWindowDays: opts.logWindowDays ?? DEFAULT_LOG_WINDOW_DAYS
  };
  const state: ProjectState = { manifest, tables, plugins };
  state.manifest.snapshot = { digest: digestState(state), at: opts.at ?? Date.now(), checkpoint: opts.checkpoint ?? {} };
  return state;
}

const jsonl = (rows: Record<string, unknown>[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

/** The state files alone — what the digest covers and what the snapshot pointer describes. */
export function stateFiles(state: ProjectState): Map<string, string> {
  const files = new Map<string, string>();
  for (const spec of TABLES) {
    files.set(path.join(ARTIFACT_DIR, STATE_DIR, `${spec.name}.jsonl`), jsonl((state.tables[spec.name] ?? []).map((r) => pick(r, spec.columns))));
  }
  for (const [ns, tables] of Object.entries(state.plugins ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [table, rows] of Object.entries(tables).sort(([a], [b]) => a.localeCompare(b))) {
      files.set(path.join(ARTIFACT_DIR, PLUGINS_DIR, ns, `${table}.jsonl`), jsonl(rows));
    }
  }
  return files;
}

/**
 * The whole artifact as file contents, keyed by path relative to the project
 * folder. Deterministic: identical data produces identical bytes.
 */
export function serializeState(state: ProjectState, opts: { mcpUrl?: string | null } = {}): Map<string, string> {
  const files = stateFiles(state);
  files.set(path.join(ARTIFACT_DIR, MANIFEST), JSON.stringify(state.manifest, null, 2) + "\n");
  for (const [rel, body] of supportFiles(opts)) files.set(rel, body);
  return files;
}

/** The files beside the state that describe the folder rather than the project. */
function supportFiles(opts: { mcpUrl?: string | null }): Map<string, string> {
  const files = new Map<string, string>();
  // Anchored: an unanchored `files/` also kept `plugins/files/` out of git.
  files.set(
    path.join(ARTIFACT_DIR, GITIGNORE),
    ["# The cache never belongs in a folder — only this text does; the files keep a repository of their own.", "*.db", "*.db-wal", "*.db-shm", "*.db-journal", "*.tmp", "/files/", "/files-archive/", ""].join("\n")
  );
  files.set(
    path.join(ARTIFACT_DIR, GITATTRIBUTES),
    [
      "# One row per line, sorted by id: git may keep both sides of a clash and Tomrade settles duplicate ids by its log.",
      "state/*.jsonl merge=union",
      "log/*.jsonl merge=union",
      "plugins/**/*.jsonl merge=union",
      "# LF on every machine: the manifest's digest covers these bytes, and core.autocrlf=true would check them out as CRLF.",
      "*.jsonl text eol=lf",
      "*.json text eol=lf",
      "*.md text eol=lf",
      ""
    ].join("\n")
  );
  files.set(
    path.join(ARTIFACT_DIR, README),
    [
      "# Tomrade project",
      "",
      "This folder is a Tomrade backlog: `state/` is the current snapshot, `log/` is each machine's change log,",
      "`plugins/` holds plugin data that travels with the project, and `docs/` is yours.",
      "",
      "Edit the backlog through Tomrade or its MCP server, not by hand — direct edits are imported as external",
      "changes and lose their author. Open the folder in Tomrade with \"Open folder…\".",
      ""
    ].join("\n")
  );
  if (opts.mcpUrl) {
    files.set(path.join(ARTIFACT_DIR, MCP), JSON.stringify({ mcpServers: { tomrade: { type: "http", url: opts.mcpUrl } } }, null, 2) + "\n");
  }
  return files;
}

/** Bring the support files up to date without touching the snapshot. Returns true when any changed. */
export function refreshSupportFiles(dir: string, opts: { mcpUrl?: string | null } = {}): boolean {
  let changed = false;
  for (const [rel, body] of supportFiles(opts)) changed = writeIfChanged(path.join(dir, rel), body) || changed;
  return changed;
}

/** A digest of the state files' own bytes, so "nothing changed" is exact rather than inferred. */
export function digestState(state: ProjectState): string {
  return digestFiles(stateFiles(state));
}

export function digestFiles(files: Map<string, string>): string {
  const hash = createHash("sha256");
  for (const [name, body] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name.split(path.sep).join("/"));
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
  writeFileAtomic(file, body);
  return true;
}

const listFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
};

/**
 * Write the snapshot: every file through a temporary name and a rename, the
 * manifest last, so a reader never sees a manifest describing files that are
 * not there yet. Returns true when anything on disk actually changed.
 */
export function writeArtifact(dir: string, state: ProjectState, opts: { mcpUrl?: string | null } = {}): boolean {
  const files = serializeState(state, opts);
  const manifestRel = path.join(ARTIFACT_DIR, MANIFEST);
  let changed = false;
  for (const [rel, body] of files) {
    if (rel === manifestRel) continue;
    changed = writeIfChanged(path.join(dir, rel), body) || changed;
  }
  // A table dropped from the spec, or a namespace no longer exported, must not linger and be read back later.
  for (const sub of [STATE_DIR, PLUGINS_DIR]) {
    const base = path.join(dir, ARTIFACT_DIR, sub);
    for (const file of listFiles(base)) {
      const rel = path.relative(dir, file);
      if (!files.has(rel) && !rel.endsWith(".tmp")) {
        fs.rmSync(file, { force: true });
        changed = true;
        // A namespace no longer exported leaves no empty folder behind.
        for (let parent = path.dirname(file); parent !== base && fs.existsSync(parent) && !fs.readdirSync(parent).length; parent = path.dirname(parent)) fs.rmdirSync(parent);
      }
    }
  }
  changed = writeIfChanged(path.join(dir, manifestRel), files.get(manifestRel)!) || changed;
  return changed;
}

const lf = (text: string): string => text.replace(/\r\n/g, "\n");

/**
 * Put back LF where a checkout turned the artifact or a log into CRLF; the
 * snapshot is rewritten only when its data changes, so this is what brings an
 * unchanged folder back. Returns true when any file changed.
 */
export function restoreLf(dir: string): boolean {
  const base = path.join(dir, ARTIFACT_DIR);
  const files = [path.join(base, MANIFEST), ...[STATE_DIR, PLUGINS_DIR, LOG_DIR].flatMap((sub) => listFiles(path.join(base, sub)).filter((f) => f.endsWith(".jsonl")))];
  let changed = false;
  for (const file of files) {
    let body: string;
    try {
      body = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!body.includes("\r\n")) continue;
    writeFileAtomic(file, lf(body), { mkdir: false });
    changed = true;
  }
  return changed;
}

export const hasArtifact = (dir: string): boolean => fs.existsSync(path.join(dir, ARTIFACT_DIR, MANIFEST));

export class TornArtifactError extends Error {
  constructor(public readonly dir: string) {
    super(`${dir} is still being written or synced; its files do not match its manifest yet`);
    this.name = "TornArtifactError";
  }
}

export class ConflictMarkersError extends Error {
  constructor(public readonly file: string) {
    super(`${file} holds unresolved git conflict markers; resolve them before Tomrade can read the folder`);
    this.name = "ConflictMarkersError";
  }
}

const MARKERS = /^(<{7}|={7}|>{7})( |$)/m;

/** Relative paths under `.tomrade/` → contents; what both a folder and a git commit reduce to. */
export type ArtifactFiles = Map<string, string>;

/**
 * Parse an artifact from its files. A v2 manifest carries a digest of its
 * state files; a mismatch means a sync is mid-flight and the caller retries
 * rather than importing half a snapshot. CRLF reads as LF: the digest was
 * taken over LF, and a checkout with core.autocrlf=true changes only that.
 */
export function parseArtifact(raw: ArtifactFiles, where: string, opts: { verify?: boolean } = {}): ProjectState | null {
  const files: ArtifactFiles = new Map([...raw].map(([rel, body]) => [rel, lf(body)]));
  const manifestRel = path.join(ARTIFACT_DIR, MANIFEST);
  const manifestText = files.get(manifestRel);
  if (manifestText === undefined) return null;
  if (MARKERS.test(manifestText)) throw new ConflictMarkersError(path.join(where, manifestRel));
  const manifest = JSON.parse(manifestText) as ProjectManifest;
  if (typeof manifest?.project?.id !== "string") throw new Error(`${path.join(where, manifestRel)} is not a Tomrade project manifest`);
  if (manifest.schemaVersion > CORE_SCHEMA_VERSION) throw new NewerSchemaError(manifest.schemaVersion, CORE_SCHEMA_VERSION);

  const parseRows = (body: string, columns?: readonly string[]): Record<string, unknown>[] =>
    body
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        if (MARKERS.test(l)) throw new ConflictMarkersError(where);
        let row: Record<string, unknown>;
        try {
          row = JSON.parse(l) as Record<string, unknown>;
        } catch {
          // A line cut short: the file is still arriving, like a digest that does not match yet.
          throw new TornArtifactError(where);
        }
        return columns ? pick(row, columns) : row;
      });

  const tables: Record<string, Record<string, unknown>[]> = {};
  const covered = new Map<string, string>();
  for (const spec of TABLES) {
    const rel = path.join(ARTIFACT_DIR, STATE_DIR, `${spec.name}.jsonl`);
    const body = files.get(rel);
    // A core table newer than the writer has no file, and the writer's digest never named one.
    if (body !== undefined) covered.set(rel, body);
    tables[spec.name] = parseRows(body ?? "", spec.columns);
  }
  const plugins: ProjectState["plugins"] = {};
  const pluginsPrefix = path.join(ARTIFACT_DIR, PLUGINS_DIR) + path.sep;
  for (const rel of [...files.keys()].sort()) {
    if (!rel.startsWith(pluginsPrefix) || !rel.endsWith(".jsonl")) continue;
    const ns = path.basename(path.dirname(rel));
    const table = path.basename(rel, ".jsonl");
    const body = files.get(rel)!;
    covered.set(rel, body);
    (plugins[ns] ??= {})[table] = parseRows(body);
  }
  // The legacy manifest wrote the digest over the whole serialisation; only v2 can be checked.
  if (opts.verify !== false && manifest.v === 2 && manifest.snapshot && digestFiles(covered) !== manifest.snapshot.digest) throw new TornArtifactError(where);
  return { manifest, tables, plugins };
}

/** The artifact's files as a folder holds them. */
export function artifactFilesOf(dir: string): ArtifactFiles {
  const files: ArtifactFiles = new Map();
  const manifest = path.join(dir, ARTIFACT_DIR, MANIFEST);
  if (fs.existsSync(manifest)) files.set(path.join(ARTIFACT_DIR, MANIFEST), fs.readFileSync(manifest, "utf8"));
  for (const sub of [STATE_DIR, PLUGINS_DIR]) {
    for (const file of listFiles(path.join(dir, ARTIFACT_DIR, sub))) {
      if (file.endsWith(".jsonl")) files.set(path.relative(dir, file), fs.readFileSync(file, "utf8"));
    }
  }
  return files;
}

export function readArtifact(dir: string, opts: { verify?: boolean } = {}): ProjectState | null {
  return parseArtifact(artifactFilesOf(dir), dir, opts);
}

/** The one table the old unanchored `files/` rule kept out of every repository. */
const NEVER_COMMITTED = { table: "files/plugin_files_remotes", rel: path.join(ARTIFACT_DIR, PLUGINS_DIR, "files", "plugin_files_remotes.jsonl") };

/**
 * Read a project cloned from a remote. A commit cannot be caught mid-write, so
 * a digest that does not match means files never reached git: backups made
 * before the `.gitignore` was anchored lack `plugins/files/`. When the digest
 * says that table was empty, `fill` is the file to put back beside the clone;
 * otherwise its rows are unknown here and it is `withheld` — never exported
 * from this machine until a snapshot that carries it arrives. Neither writes
 * anything to the remote.
 */
export function readClone(dir: string): { state: ProjectState; fill: Map<string, string>; withheld: string[] } | null {
  const files = artifactFilesOf(dir);
  const attempt = (candidate: ArtifactFiles): ProjectState | null | undefined => {
    try {
      return parseArtifact(candidate, dir);
    } catch (error) {
      if (error instanceof TornArtifactError) return undefined;
      throw error;
    }
  };
  const exact = attempt(files);
  if (exact !== undefined) return exact ? { state: exact, fill: new Map(), withheld: [] } : null;
  // Most often the missing file was an empty table, and the digest says so.
  if (!files.has(NEVER_COMMITTED.rel)) {
    const filled = attempt(new Map([...files, [NEVER_COMMITTED.rel, ""]]));
    if (filled) return { state: filled, fill: new Map([[NEVER_COMMITTED.rel, ""]]), withheld: [] };
  }
  const state = parseArtifact(files, dir, { verify: false });
  return state ? { state, fill: new Map(), withheld: files.has(NEVER_COMMITTED.rel) ? [] : [NEVER_COMMITTED.table] } : null;
}

/**
 * Replace the project's rows with the artifact's. Not a user write: an import
 * materialises a project that already exists elsewhere, so it never goes
 * through `write()` and lands no oplog rows. Plugin tables named in the
 * artifact are replaced too; those the artifact lacks are left alone.
 */
/**
 * `additive`: namespaces whose rows join this machine's instead of replacing
 * them — ones that did not travel here until now, so what is only here is not
 * a deletion.
 */
export function importState(db: StateDb, state: ProjectState, opts: { registrations?: PluginRegistration[]; additive?: string[] } = {}): void {
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
    db.prepare("DELETE FROM deliveries WHERE project_id = @projectId").run({ projectId });
    db.prepare("DELETE FROM labels WHERE project_id = @projectId").run({ projectId });
    db.prepare("DELETE FROM boards WHERE project_id = @projectId").run({ projectId });
    db.prepare("DELETE FROM repos WHERE project_id = @projectId").run({ projectId });

    const project = pick(state.manifest.project, PROJECT_COLUMNS);
    const existing = db.prepare("SELECT next_key_num, archived FROM projects WHERE id = @projectId").get({ projectId }) as { next_key_num: number; archived: number } | undefined;
    db.prepare(
      `INSERT INTO projects (id, name, description, key_prefix, next_key_num, archived, created_at, updated_at)
       VALUES (@id, @name, @description, @key_prefix, 1, @archived, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, key_prefix = excluded.key_prefix, created_at = excluded.created_at, updated_at = excluded.updated_at`
    ).run({ ...project, archived: existing?.archived ?? 0, updated_at: Date.now() });

    for (const spec of TABLES) {
      let rows = state.tables[spec.name] ?? [];
      if (spec.name === "deliveries" && !rows.length) {
        rows = state.plugins?.code_link?.plugin_code_link_deliveries ?? [];
        rows = rows.map(row => ({ ...row, bases_json: row.bases_json ?? "{}" }));
      }
      // An artifact from before views belonged to the project has rows nothing can place; the project gets the defaults instead.
      if (spec.name === "views") rows = rows.filter((r) => typeof r.layout === "string" && r.project_id === projectId);
      if (!rows.length) continue;
      const stmt = db.prepare(`INSERT INTO ${spec.name} (${spec.columns.join(", ")}) VALUES (${spec.columns.map((c) => `@${c}`).join(", ")})`);
      for (const row of rows) stmt.run(pick(row, spec.columns));
    }
    if (!db.prepare("SELECT 1 FROM views WHERE project_id = @projectId LIMIT 1").get({ projectId })) seedDefaultViews(db, projectId, Date.now());

    // The counter is derived, never merged: past every key anyone has minted, and never below where it was.
    db.prepare("UPDATE projects SET next_key_num = MAX(next_key_num, COALESCE((SELECT MAX(key_num) FROM items WHERE project_id = @projectId), 0) + 1) WHERE id = @projectId").run({ projectId });

    writePlugins(db, state.plugins ?? {}, opts.registrations ?? [], opts.additive ?? []);
  });
}

/** Replace the tables of the plugins registered here with the given rows; the rest are not this machine's to read. */
export function importPlugins(db: StateDb, plugins: ProjectState["plugins"], registrations: PluginRegistration[]): void {
  db.transaction(() => writePlugins(db, plugins, registrations));
}

function writePlugins(db: StateDb, plugins: ProjectState["plugins"], registrations: PluginRegistration[], additive: string[] = []): void {
  const declared = new Map(registrations.filter((r) => r.scope === "project").map((r) => [r.namespace, r]));
  for (const [ns, tables] of Object.entries(plugins ?? {})) {
    const reg = declared.get(ns);
    if (!reg) continue; // a plugin this machine lacks: its files ride along untouched
    for (const [table, rows] of Object.entries(tables)) {
      // A table can become machine-local in a newer plugin version. An old
      // artifact may still name it; its stale copy must never replace this
      // machine's live state.
      if (!reg.tables[table]?.export) continue;
      let columns: string[];
      try {
        columns = columnsOf(db, table);
      } catch {
        continue;
      }
      if (!additive.includes(ns)) db.prepare(`DELETE FROM ${table}`).run();
      if (!rows.length) continue;
      const cols = columns.filter((c) => rows.some((r) => c in r));
      const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`);
      for (const row of rows) stmt.run(pick(row, cols));
    }
  }
}
