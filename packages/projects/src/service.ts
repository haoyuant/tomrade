import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import { seedProject, type Db, type ProjectDb } from "@tomradex/db";
import type { Hub } from "@tomradex/hub";
import { keyPrefixFor, type CreateProjectInput, type Project, type ProjectPatch } from "@tomradex/domain";
import type {} from "@tomradex/ipc";
import { defineTool } from "@tomradex/tools";
import { splitLegacy } from "./legacy.js";
import type { ProjectsReader } from "@tomradex/contracts";

declare module "cordis" {
  interface Context {
    projects: Projects;
  }
  interface Events {
    "projects/created"(project: Project): void;
    "projects/removed"(projectId: string): void;
    /** A project's rows changed underneath the app (import, rebuild); caches for it are stale. */
    "projects/changed"(projectId: string): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "projects.list": () => Project[];
    "projects.get": (id: string) => Project | null;
    /** `dir`: the folder the project's `.tomrade/` goes in; default `<Hub>/projects/<slug>`. */
    "projects.create": (input: CreateProjectInput, opts?: { dir?: string }) => Project;
    "projects.update": (id: string, patch: ProjectPatch) => Project | null;
    /** Forgets the project on this machine and drops its cache; `deleteFolder` also removes the folder. */
    "projects.remove": (id: string, opts?: { deleteFolder?: boolean }) => void;
  }
  interface Broadcasts {
    "projects.changed": () => void;
  }
}

export const ProjectsConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** The pre-P0 single database. Split into per-project caches on first boot, then moved to `backupsDir`. */
    legacyPath: z.string().optional(),
    backupsDir: z.string().optional(),
    /** What an empty catalog gets on boot: an empty Default Project, or nothing — another plugin seeds the first project. */
    firstRun: z.enum(["default", "none"]).optional()
  })
);
export type ProjectsConfig = z.infer<typeof ProjectsConfig>;

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

/**
 * Projects are the container, not the work: managed by humans through the UI,
 * outside the oplog, the one entity undo does not reach. The catalog says which
 * exist on this machine; each project's own file holds its row.
 */
export class Projects extends Service implements ProjectsReader {
  static provide = "projects";
  static inject = ["db", "hub"];
  static Config = ProjectsConfig;

  private readonly home: Context;

  constructor(
    ctx: Context,
    public readonly config: ProjectsConfig
  ) {
    super(ctx, "projects");
    this.home = ctx;
  }

  [Service.init]() {
    this.adoptLegacy();
    for (const entry of this.hub.catalog.projects()) this.db.open(entry.id);
    if (!this.hub.catalog.projects().length && this.config.firstRun !== "none") this.ensureDefault();

    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("projects.list", () => ctx.projects.list());
      ctx.ipc.handle("projects.get", (id) => ctx.projects.get(id));
      ctx.ipc.handle("projects.create", (input, opts) => ctx.projects.create(input, opts));
      ctx.ipc.handle("projects.update", (id, patch) => ctx.projects.update(id, patch));
      ctx.ipc.handle("projects.remove", (id, opts) => ctx.projects.remove(id, opts));
    });
    this.home.inject(["tools"], (ctx) => {
      ctx.tools.register(
        defineTool({
          name: "list_projects",
          title: "List projects",
          description: "The projects on this machine, with the id every other tool takes as projectId. In a conversation, `current` marks the one it works in; the others are for reference only.",
          input: z.object({}),
          execute: (_args, inv) => ctx.projects.list().map((p) => ({ id: p.id, name: p.name, keyPrefix: p.keyPrefix, archived: p.archived, ...(inv.projectId ? { current: p.id === inv.projectId } : {}) }))
        })
      );
    });
  }

  private get db(): Db {
    return this.ctx.db;
  }

  private get hub(): Hub {
    return this.ctx.hub;
  }

  /** The pre-P0 file, if this machine still has one and nothing else has been catalogued: split it, once. */
  private adoptLegacy(): void {
    const legacyPath = this.config.legacyPath;
    if (!legacyPath || !fs.existsSync(legacyPath) || this.hub.catalog.projects().length) return;
    const result = splitLegacy({
      legacyPath,
      db: this.db,
      deviceId: this.hub.deviceId,
      backupsDir: this.config.backupsDir ?? path.join(path.dirname(legacyPath), "backups"),
      registrations: this.db.registrations("project")
    });
    for (const p of result.projects) {
      const row = this.rowOf(p.id);
      this.hub.catalog.upsertProject({ id: p.id, name: p.name, keyPrefix: row?.key_prefix ?? "TOM", archived: p.archived, createdAt: p.createdAt });
    }
    this.home.logger.info(`split ${result.projects.length} project(s) out of ${legacyPath}; the old file is at ${result.movedTo}`);
  }

  /** A first-run seed, not a repair: only ever runs against an empty catalog. */
  ensureDefault(): Project | null {
    if (this.hub.catalog.projects().length) return null;
    const project = this.create({ name: "Default Project", keyPrefix: "TOM" });
    this.hub.catalog.patchProject(project.id, { seed: true });
    return project;
  }

  private rowOf(id: string): ProjectRow | undefined {
    if (!this.db.has(id)) return undefined;
    return this.db.for(id).prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  }

  private toProject(id: string): Project | null {
    const entry = this.hub.catalog.project(id);
    if (!entry) return null;
    const row = this.rowOf(id);
    return {
      id,
      name: row?.name ?? entry.name,
      description: row?.description ?? null,
      keyPrefix: row?.key_prefix ?? entry.keyPrefix,
      archived: entry.archived,
      ...(entry.sample ? { sample: true } : {}),
      createdAt: row?.created_at ?? entry.createdAt,
      updatedAt: row?.updated_at ?? entry.createdAt
    };
  }

  list(): Project[] {
    return this.hub.catalog.projects().flatMap((entry) => {
      const project = this.toProject(entry.id);
      return project ? [project] : [];
    });
  }

  get(id: string): Project | null {
    return this.toProject(id);
  }

  /**
   * Creates the project's cache, its row, its Main workstream and the default
   * views. The folder is the storage layer's to write, on `projects/created`;
   * a chosen `dir` is recorded here so it writes there. `seed` fills the
   * project before anyone hears of it, so what it writes is how the project
   * began rather than its history: the folder's first snapshot holds it, and
   * its log rows are dropped.
   */
  create(input: CreateProjectInput, opts: { dir?: string; seed?: (project: Project) => void } = {}): Project {
    const id = randomUUID();
    const now = Date.now();
    const keyPrefix = input.keyPrefix?.toUpperCase() || keyPrefixFor(input.name);
    const db = this.db.open(id);
    db.transaction(() => {
      db.prepare("INSERT INTO projects (id, name, description, key_prefix, next_key_num, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)").run(
        id,
        input.name,
        input.description ?? null,
        keyPrefix,
        now,
        now
      );
      seedProject(db, id, now, input.locale);
    });
    const dir = opts.dir ? path.resolve(opts.dir) : null;
    if (dir) fs.mkdirSync(dir, { recursive: true });
    this.hub.catalog.upsertProject({ id, name: input.name, keyPrefix, createdAt: now, dir });
    const project: Project = { id, name: input.name, description: input.description ?? null, keyPrefix, archived: false, createdAt: now, updatedAt: now };
    if (opts.seed) {
      try {
        opts.seed(project);
      } catch (error) {
        this.db.remove(id);
        this.hub.catalog.removeProject(id);
        throw error;
      }
      db.prepare("DELETE FROM oplog").run();
    }
    this.home.emit("projects/created", project);
    this.notify();
    return project;
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
    if (this.db.has(id)) {
      this.db.for(id).prepare("UPDATE projects SET name = ?, description = ?, archived = ?, updated_at = ? WHERE id = ?").run(next.name, next.description, next.archived ? 1 : 0, next.updatedAt, id);
    }
    this.hub.catalog.patchProject(id, { name: next.name, archived: next.archived, seed: false });
    this.notify();
    return next;
  }

  /** Forget the project on this machine and delete its cache. Its folder, where the truth is, stays unless asked. */
  remove(id: string, opts: { deleteFolder?: boolean } = {}): void {
    const dir = this.hub.catalog.project(id)?.dir;
    this.home.emit("projects/removed", id);
    this.db.remove(id);
    if (opts.deleteFolder && dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    this.hub.catalog.removeProject(id);
    this.notify();
  }

  /** The open handle for a project, for callers that already hold an id. */
  dbFor(id: string): ProjectDb {
    return this.db.for(id);
  }

  private notify(): void {
    this.home.get("ipc")?.send("projects.changed");
  }
}
