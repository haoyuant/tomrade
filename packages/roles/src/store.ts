import type { ProjectDb } from "@tomradex/db";
import type { Ceiling } from "./permission.js";

export const MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS plugin_roles_roles (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  title        TEXT NOT NULL,
  stage        TEXT NOT NULL,
  engines_json TEXT NOT NULL DEFAULT '[]',
  permission   TEXT,
  instructions TEXT NOT NULL DEFAULT '',
  needs_json   TEXT NOT NULL DEFAULT '{}',
  updated_at   INTEGER NOT NULL
);
`
  }
];

/** A project's roles are how its tickets are worked on every machine that has it, so they go wherever the project does. */
export const TABLES = {
  plugin_roles_roles: { project: "project_id", export: { order: "id", always: true } }
} as const;

/** `implement`: it works a ticket. `review`: it reads a ticket's changes and changes nothing. */
export type RoleStage = "implement" | "review";

/** What a role asks of the machine it runs on. Nothing asked: any machine. */
export interface RoleNeeds {
  /** `darwin`, `win32` or `linux`. */
  platform?: string;
  /** One machine, by its name. */
  device?: string;
}

/** A role as it is stored: one a person made, or what they changed of a built-in one. */
export interface StoredRole {
  id: string;
  title: string;
  stage: RoleStage;
  /** Engine ids, the preferred one first. None: whichever this machine would start with. */
  engines: string[];
  /** The most its sessions may do without asking. Null: the engine's own default, or what the person picks at Start. */
  permission: Ceiling | null;
  /** What more its agent is told, after the ticket. */
  instructions: string;
  needs: RoleNeeds;
  updatedAt: number;
}

interface Row {
  id: string;
  title: string;
  stage: string;
  engines_json: string;
  permission: string | null;
  instructions: string;
  needs_json: string;
  updated_at: number;
}

const parsed = <T>(json: string, otherwise: T): T => {
  try {
    return JSON.parse(json) as T;
  } catch {
    return otherwise;
  }
};

const toRole = (r: Row): StoredRole => ({
  id: r.id,
  title: r.title,
  stage: r.stage === "review" ? "review" : "implement",
  engines: parsed<string[]>(r.engines_json, []).filter((e) => typeof e === "string"),
  permission: r.permission as Ceiling | null,
  instructions: r.instructions,
  needs: parsed<RoleNeeds>(r.needs_json, {}),
  updatedAt: r.updated_at
});

export class RoleStore {
  constructor(private readonly db: (projectId: string) => ProjectDb) {}

  all(projectId: string): StoredRole[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_roles_roles ORDER BY title COLLATE NOCASE ASC, id ASC").all() as Row[]).map(toRole);
  }

  get(projectId: string, id: string): StoredRole | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_roles_roles WHERE id = ?").get(id) as Row | undefined;
    return row ? toRole(row) : null;
  }

  put(projectId: string, role: StoredRole): void {
    this.db(projectId)
      .prepare("INSERT OR REPLACE INTO plugin_roles_roles (id, project_id, title, stage, engines_json, permission, instructions, needs_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(role.id, projectId, role.title, role.stage, JSON.stringify(role.engines), role.permission, role.instructions, JSON.stringify(role.needs), role.updatedAt);
  }

  remove(projectId: string, id: string): boolean {
    return this.db(projectId).prepare("DELETE FROM plugin_roles_roles WHERE id = ?").run(id).changes > 0;
  }
}
