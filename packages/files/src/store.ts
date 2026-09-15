import type { Db, Migration } from "@tomrade/db";

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
  }
];

export const TABLES = {
  plugin_files_remotes: { project: "project_id", export: { order: "project_id" } }
} as const;

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
