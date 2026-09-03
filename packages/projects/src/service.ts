import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import { seedProjectBoards, type Db } from "@tomrade/db";
import { keyPrefixFor, type CreateProjectInput, type Project, type ProjectPatch } from "@tomrade/domain";
import type {} from "@tomrade/ipc";

declare module "cordis" {
  interface Context {
    projects: Projects;
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    "projects.list": () => Project[];
    "projects.create": (input: CreateProjectInput) => Project;
    "projects.update": (id: string, patch: ProjectPatch) => Project | null;
    "projects.remove": (id: string) => void;
  }
}

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

/**
 * Projects are the container, not the work: they are managed by humans through
 * the UI, sit outside the oplog, and are the one entity undo does not reach.
 */
export class Projects extends Service {
  static provide = "projects";
  static inject = ["db"];

  constructor(ctx: Context) {
    super(ctx, "projects");
  }

  [Service.init]() {
    this.ensureDefault();
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("projects.list", () => ctx.projects.list());
      ctx.ipc.handle("projects.create", (input) => ctx.projects.create(input));
      ctx.ipc.handle("projects.update", (id, patch) => ctx.projects.update(id, patch));
      ctx.ipc.handle("projects.remove", (id) => ctx.projects.remove(id));
    });
  }

  private get db(): Db {
    return this.ctx.db;
  }

  /**
   * A first-run seed, not a repair. The id stays 'default' so a database written
   * before projects existed still resolves, but this only ever writes into an
   * empty table: a project a human deleted must not reappear on the next boot.
   */
  ensureDefault(): Project | null {
    const existing = this.db.prepare("SELECT * FROM projects WHERE id = 'default'").get() as ProjectRow | undefined;
    if (existing) return rowToProject(existing);
    if ((this.db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n > 0) return null;
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO projects (id, name, description, key_prefix, next_key_num, archived, created_at, updated_at) VALUES ('default', 'Default Project', NULL, 'TOM', 1, 0, ?, ?)")
        .run(now, now);
      seedProjectBoards(this.db, "default", now);
    });
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
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO projects (id, name, description, key_prefix, next_key_num, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)")
        .run(id, input.name, input.description ?? null, keyPrefix, now, now);
      seedProjectBoards(this.db, id, now);
    });
    return { id, name: input.name, description: input.description ?? null, keyPrefix, archived: false, createdAt: now, updatedAt: now };
  }

  update(id: string, patch: ProjectPatch): Project | null {
    const existing = this.get(id);
    if (!existing) return null;
    // An absent key means "leave it" — a bare spread would let an explicit
    // `description: undefined` through and bind it as a value.
    const next: Project = {
      ...existing,
      name: patch.name ?? existing.name,
      description: patch.description === undefined ? existing.description : patch.description,
      archived: patch.archived ?? existing.archived,
      updatedAt: Date.now()
    };
    this.db
      .prepare("UPDATE projects SET name = ?, description = ?, archived = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.description, next.archived ? 1 : 0, next.updatedAt, id);
    return next;
  }

  /** Delete a project and everything scoped to it, history first. */
  remove(id: string): void {
    this.db.transaction(() => {
      // Each of these sweeps scopes itself through a table a later statement
      // empties, so the history has to go before the rows it is found through.
      this.db.prepare("DELETE FROM oplog WHERE entity = 'item' AND entity_id IN (SELECT id FROM items WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM oplog WHERE entity = 'board' AND entity_id IN (SELECT id FROM boards WHERE project_id = ?)").run(id);
      this.db
        .prepare("DELETE FROM oplog WHERE entity = 'view' AND entity_id IN (SELECT v.id FROM views v JOIN boards b ON b.id = v.board_id WHERE b.project_id = ?)")
        .run(id);
      // A purge tombstone is the one oplog row that outlives its subject; it names the project itself.
      this.db.prepare("DELETE FROM oplog WHERE op = 'purge' AND json_extract(before_json, '$.projectId') = ?").run(id);

      this.db.prepare("DELETE FROM item_labels WHERE item_id IN (SELECT id FROM items WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM item_values WHERE field_id IN (SELECT id FROM fields WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM field_options WHERE field_id IN (SELECT id FROM fields WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM fields WHERE project_id = ?").run(id);
      // Both directions: nothing stops an agent relating across projects, and an
      // incoming edge lives on the other project's row.
      this.db
        .prepare(
          "DELETE FROM item_relations WHERE from_item_id IN (SELECT id FROM items WHERE project_id = ?) OR to_item_id IN (SELECT id FROM items WHERE project_id = ?)"
        )
        .run(id, id);
      this.db.prepare("DELETE FROM view_item_rank WHERE view_id IN (SELECT v.id FROM views v JOIN boards b ON b.id = v.board_id WHERE b.project_id = ?)").run(id);
      this.db.prepare("DELETE FROM views WHERE board_id IN (SELECT id FROM boards WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM boards WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM labels WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM items WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
  }
}
