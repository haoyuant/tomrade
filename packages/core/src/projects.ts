import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { seedProjectBoards } from "./migrate.js";
import type { CreateProjectInput, Project } from "./types.js";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    keyPrefix: row.key_prefix,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** 'Tomrade Next' -> 'TOM'. Falls back to a generic prefix for nameless input. */
export function keyPrefixFor(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.slice(0, 3) || "ISS";
}

export class ProjectsRepository {
  constructor(private readonly db: Db) {}

  /** Seed the default project on first run (kept id 'default' for backward compat). */
  ensureDefault(): Project {
    const existing = this.db.prepare("SELECT * FROM projects WHERE id = 'default'").get() as ProjectRow | undefined;
    if (existing) return rowToProject(existing);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO projects (id, name, description, key_prefix, next_key_num, archived, created_at, updated_at) VALUES ('default', 'Default Project', NULL, 'TOM', 1, 0, ?, ?)"
        )
        .run(now, now);
      seedProjectBoards(this.db, "default", now);
    });
    tx();
    return { id: "default", name: "Default Project", description: null, keyPrefix: "TOM", archived: false, createdAt: now, updatedAt: now };
  }

  list(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY created_at ASC").all() as ProjectRow[]).map(rowToProject);
  }

  get(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  /** Creates the project, its first board and the two cross-board scopes. */
  create(input: CreateProjectInput): Project {
    const id = randomUUID();
    const now = Date.now();
    const keyPrefix = input.keyPrefix?.toUpperCase() || keyPrefixFor(input.name);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO projects (id, name, description, key_prefix, next_key_num, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)"
        )
        .run(id, input.name, input.description ?? null, keyPrefix, now, now);
      seedProjectBoards(this.db, id, now);
    });
    tx();
    return { id, name: input.name, description: input.description ?? null, keyPrefix, archived: false, createdAt: now, updatedAt: now };
  }

  update(id: string, patch: Partial<Pick<Project, "name" | "description" | "archived">>): Project | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, updatedAt: Date.now() };
    this.db
      .prepare("UPDATE projects SET name = ?, description = ?, archived = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.description, next.archived ? 1 : 0, next.updatedAt, id);
    return next;
  }

  /** Delete a project and everything scoped to it. */
  remove(id: string): void {
    const tx = this.db.transaction(() => {
      // History first. Every one of these scopes itself through a table a later
      // statement empties, so scrubbing afterwards silently matches nothing —
      // which is exactly what the board sweep used to do from below the boards
      // delete, and views were never swept at all.
      this.db.prepare("DELETE FROM oplog WHERE entity = 'item' AND entity_id IN (SELECT id FROM items WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM oplog WHERE entity = 'board' AND entity_id IN (SELECT id FROM boards WHERE project_id = ?)").run(id);
      this.db
        .prepare(
          "DELETE FROM oplog WHERE entity = 'view' AND entity_id IN (SELECT v.id FROM views v JOIN boards b ON b.id = v.board_id WHERE b.project_id = ?)"
        )
        .run(id);
      // A purged item left no row to scope through — its tombstone names the
      // project itself, and is the one oplog row that outlives its subject.
      this.db.prepare("DELETE FROM oplog WHERE op = 'purge' AND json_extract(before_json, '$.projectId') = ?").run(id);

      this.db.prepare("DELETE FROM item_labels WHERE item_id IN (SELECT id FROM items WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM item_relations WHERE from_item_id IN (SELECT id FROM items WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM view_item_rank WHERE view_id IN (SELECT v.id FROM views v JOIN boards b ON b.id = v.board_id WHERE b.project_id = ?)").run(id);
      this.db.prepare("DELETE FROM views WHERE board_id IN (SELECT id FROM boards WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM boards WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM labels WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM items WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
    tx();
  }
}
