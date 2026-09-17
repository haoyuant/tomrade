import type { ProjectDb } from "./project-db.js";
import type { Sqlite } from "./sqlite.js";

export interface Migration {
  version: number;
  up: string | ((db: Sqlite) => void);
}

/** How a plugin table relates to a project: one column, or a chain through another table. */
export type ProjectScope = string | { via: string; table: string };

export interface PluginTableSpec {
  /** Required for project-scope tables: how rows are found for one project. */
  project?: ProjectScope;
  /**
   * Where the durable copy goes. An exported table lands in the project's
   * `.tomrade/plugins/<ns>/<table>.jsonl` (or the Hub's `plugins/`); `false`
   * means machine-local working state, gone when the cache is rebuilt.
   * `always` is for rows that are part of the project's identity rather than
   * data about it — a binding every machine needs before it can do anything —
   * so they travel whether or not the user ticked the namespace, even inside
   * a code checkout, and the namespace is not offered as a choice.
   */
  export: { order: string; appendOnly?: boolean; always?: boolean } | false;
}

export type PluginScope = "project" | "hub";

export interface MigrateOptions {
  /** Which database the steps run on. Default: every project's. */
  scope?: PluginScope;
  tables: Record<string, PluginTableSpec>;
}

export interface PluginRegistration {
  namespace: string;
  scope: PluginScope;
  steps: Migration[];
  tables: Record<string, PluginTableSpec>;
}

const TABLE_STATEMENT = /\b(CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`]?(\w+)/gi;

const MIGRATIONS_TABLE = "CREATE TABLE IF NOT EXISTS plugin_migrations (namespace TEXT PRIMARY KEY, version INTEGER NOT NULL)";

/**
 * The declaration is the contract: without it the system cannot scope a
 * plugin's rows to a project, delete them with it, or carry them in the
 * project's folder — so an undeclared namespace is refused, loudly.
 */
export function validateRegistration(namespace: string, steps: Migration[], options: MigrateOptions | undefined): PluginRegistration {
  const prefix = `plugin_${namespace}_`;
  const created = new Set<string>();
  for (const step of steps) {
    if (typeof step.up !== "string") continue;
    for (const match of step.up.matchAll(TABLE_STATEMENT)) {
      const [, verb, table] = match;
      if (!table.startsWith(prefix)) throw new Error(`migration ${namespace}@${step.version} touches "${table}"; plugin tables must be named ${prefix}*`);
      if (verb.toUpperCase() === "CREATE") created.add(table);
    }
  }
  if (!options?.tables) {
    const hint = [...created].map((t) => `${t}: { project: "project_id", export: { order: "id" } }`).join(", ");
    throw new Error(`ctx.db.migrate("${namespace}") needs a tables declaration so its rows can be scoped, exported and deleted with a project — e.g. { tables: { ${hint || `${prefix}example: { project: "project_id", export: false }`} } }`);
  }
  const scope = options.scope ?? "project";
  for (const [table, spec] of Object.entries(options.tables)) {
    if (!table.startsWith(prefix)) throw new Error(`ctx.db.migrate("${namespace}") declares "${table}"; plugin tables must be named ${prefix}*`);
    if (scope === "project" && spec.project === undefined) throw new Error(`ctx.db.migrate("${namespace}") declares "${table}" without a project scope; say which column (or via which table) holds the project`);
    if (scope === "hub" && spec.project !== undefined) throw new Error(`ctx.db.migrate("${namespace}") declares "${table}" with a project scope in the hub; hub tables belong to no project`);
    if (spec.export && !spec.export.order?.trim()) throw new Error(`ctx.db.migrate("${namespace}") exports "${table}" without an order; the artifact must be deterministic`);
  }
  for (const table of created) {
    if (!(table in options.tables)) throw new Error(`ctx.db.migrate("${namespace}") creates "${table}" but does not declare it in tables`);
  }
  return { namespace, scope, steps: [...steps].sort((a, b) => a.version - b.version), tables: options.tables };
}

export function ensureMigrationsTable(db: ProjectDb): void {
  db.exec(MIGRATIONS_TABLE);
}

/** Run a namespace's pending steps on one file; each file keeps its own counter. */
export function applyRegistration(db: ProjectDb, reg: PluginRegistration): number {
  ensureMigrationsTable(db);
  const current = (db.prepare("SELECT version FROM plugin_migrations WHERE namespace = ?").get(reg.namespace) as { version: number } | undefined)?.version ?? 0;
  let version = current;
  for (const m of reg.steps) {
    if (m.version <= version) continue;
    db.transaction(() => {
      if (typeof m.up === "string") db.exec(m.up);
      else m.up(db.handle);
      db.prepare("INSERT INTO plugin_migrations (namespace, version) VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET version = excluded.version").run(reg.namespace, m.version);
    });
    version = m.version;
  }
  return version;
}

/**
 * The WHERE clause that selects one project's rows of a declared table, for a
 * database that may hold several projects (the legacy split) — in a project's
 * own file every row already belongs to it.
 */
export function projectPredicate(tables: Record<string, PluginTableSpec>, table: string, depth = 0): string {
  const spec = tables[table];
  if (!spec?.project) throw new Error(`table ${table} has no project scope`);
  if (depth > 8) throw new Error(`table ${table}: project scope chain is too deep`);
  if (typeof spec.project === "string") return `${spec.project} = @projectId`;
  const inner = projectPredicate(tables, spec.project.table, depth + 1);
  const key = primaryKeyColumn(spec.project.table);
  return `${spec.project.via} IN (SELECT ${key} FROM ${spec.project.table} WHERE ${inner})`;
}

/** Plugin tables reached through a chain are keyed by `id` unless they say otherwise. */
const primaryKeyColumn = (_table: string): string => "id";
