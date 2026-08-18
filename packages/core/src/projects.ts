import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { CreateProjectInput, Project } from "./types.js";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class ProjectsRepository {
  constructor(private readonly db: Db) {}

  /** Seed the default project on first run (kept id 'default' for backward compat). */
  ensureDefault(): Project {
    const existing = this.db.prepare("SELECT * FROM projects WHERE id = 'default'").get() as ProjectRow | undefined;
    if (existing) return rowToProject(existing);
    const now = Date.now();
    this.db.prepare("INSERT INTO projects (id, name, description, created_at, updated_at) VALUES ('default', 'Default Project', NULL, ?, ?)").run(now, now);
    return { id: "default", name: "Default Project", description: null, createdAt: now, updatedAt: now };
  }

  list(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY created_at ASC").all() as ProjectRow[]).map(rowToProject);
  }

  get(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  create(input: CreateProjectInput): Project {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare("INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, input.name, input.description ?? null, now, now);
    return { id, name: input.name, description: input.description ?? null, createdAt: now, updatedAt: now };
  }

  rename(id: string, name: string): Project | null {
    const existing = this.get(id);
    if (!existing) return null;
    const now = Date.now();
    this.db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
    return { ...existing, name, updatedAt: now };
  }

  /** Delete a project and every item in it (cascade; recorded nowhere — items are project-scoped). */
  remove(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM items WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
    tx();
  }
}
