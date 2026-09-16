import type { Db, Migration } from "@tomrade/db";
import type { Author } from "@tomrade/domain";

/** The remote a project shares its files through. Per project, non-secret, travels in the project's folder. */
export interface RemoteRow {
  projectId: string;
  backend: string;
  config: Record<string, unknown>;
  updatedAt: number;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS plugin_files_remotes (
      project_id TEXT PRIMARY KEY,
      backend    TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )`
  },
  {
    // What this machine did to the files through Tomrade, as the versions
    // before and after each step: the undo stack. Machine-local, never exported.
    version: 2,
    up: `CREATE TABLE IF NOT EXISTS plugin_files_ops (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      at         INTEGER NOT NULL,
      by         TEXT NOT NULL,
      run_id     TEXT,
      kind       TEXT NOT NULL,
      path       TEXT NOT NULL,
      target     TEXT,
      paths_json TEXT NOT NULL,
      base       TEXT NOT NULL,
      head       TEXT NOT NULL,
      undone_at  INTEGER
    )`
  }
];

export const TABLES = {
  plugin_files_remotes: { project: "project_id", export: { order: "project_id" } },
  plugin_files_ops: { project: "project_id", export: false }
} as const;

export type FileOpKind = "write" | "mkdir" | "move" | "copy" | "remove" | "import";

/** One operation on a project's files, undoable while its paths stay as it left them. */
export interface FileOpRow {
  seq: number;
  projectId: string;
  at: number;
  by: Author;
  runId: string | null;
  kind: FileOpKind;
  /** The path the op is about; for a move or copy, where it started. */
  path: string;
  /** Where a move or copy landed. */
  target: string | null;
  /** Every path the op touched — what undo puts back. */
  paths: string[];
  /** The version before the op, and the one it left. */
  base: string;
  head: string;
  undoneAt: number | null;
}

interface RawOp {
  seq: number;
  project_id: string;
  at: number;
  by: string;
  run_id: string | null;
  kind: string;
  path: string;
  target: string | null;
  paths_json: string;
  base: string;
  head: string;
  undone_at: number | null;
}

const opOf = (r: RawOp): FileOpRow => ({
  seq: r.seq,
  projectId: r.project_id,
  at: r.at,
  by: r.by as Author,
  runId: r.run_id,
  kind: r.kind as FileOpKind,
  path: r.path,
  target: r.target,
  paths: JSON.parse(r.paths_json) as string[],
  base: r.base,
  head: r.head,
  undoneAt: r.undone_at
});

export class OpsStore {
  constructor(private readonly pool: Db) {}

  record(op: Omit<FileOpRow, "seq" | "undoneAt">): FileOpRow {
    const info = this.pool
      .for(op.projectId)
      .prepare("INSERT INTO plugin_files_ops (project_id, at, by, run_id, kind, path, target, paths_json, base, head, undone_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(op.projectId, op.at, op.by, op.runId, op.kind, op.path, op.target, JSON.stringify(op.paths), op.base, op.head);
    return { ...op, seq: Number(info.lastInsertRowid), undoneAt: null };
  }

  get(projectId: string, seq: number): FileOpRow | null {
    const row = this.pool.for(projectId).prepare("SELECT * FROM plugin_files_ops WHERE project_id = ? AND seq = ?").get(projectId, seq) as RawOp | undefined;
    return row ? opOf(row) : null;
  }

  /** Newest first, undone ones included. */
  list(projectId: string, limit: number): FileOpRow[] {
    return (this.pool.for(projectId).prepare("SELECT * FROM plugin_files_ops WHERE project_id = ? ORDER BY at DESC, seq DESC LIMIT ?").all(projectId, limit) as RawOp[]).map(opOf);
  }

  markUndone(projectId: string, seq: number, at: number | null): void {
    this.pool.for(projectId).prepare("UPDATE plugin_files_ops SET undone_at = ? WHERE project_id = ? AND seq = ?").run(at, projectId, seq);
  }

  /** The redo stack is void: a write landed somewhere. */
  forget(projectId: string): void {
    this.pool.for(projectId).prepare("DELETE FROM plugin_files_ops WHERE project_id = ? AND undone_at IS NOT NULL").run(projectId);
  }
}

export class RemoteStore {
  constructor(private readonly pool: Db) {}

  get(projectId: string): RemoteRow | null {
    const row = this.pool.for(projectId).prepare("SELECT project_id, backend, config_json, updated_at FROM plugin_files_remotes WHERE project_id = ?").get(projectId) as
      | { project_id: string; backend: string; config_json: string; updated_at: number }
      | undefined;
    if (!row) return null;
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.config_json) as Record<string, unknown>;
    } catch {
      // a torn merge of the exported row; the backend's defaults fill in
    }
    return { projectId: row.project_id, backend: row.backend, config, updatedAt: row.updated_at };
  }

  set(projectId: string, backend: string, config: Record<string, unknown>): RemoteRow {
    const updatedAt = Date.now();
    this.pool
      .for(projectId)
      .prepare(
        `INSERT INTO plugin_files_remotes (project_id, backend, config_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET backend = excluded.backend, config_json = excluded.config_json, updated_at = excluded.updated_at`
      )
      .run(projectId, backend, JSON.stringify(config), updatedAt);
    return { projectId, backend, config, updatedAt };
  }

  clear(projectId: string): void {
    this.pool.for(projectId).prepare("DELETE FROM plugin_files_remotes WHERE project_id = ?").run(projectId);
  }
}
