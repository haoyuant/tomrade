import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Where a project's shareable copy is published, in provider terms. Non-secret; portable. */
export const RemoteRef = z.object({
  provider: z.string(),
  config: z.record(z.string(), z.unknown()).default({})
});
export type RemoteRef = z.infer<typeof RemoteRef>;

/**
 * One project as this machine knows it. Identity (id, name, prefix) is a cache
 * of the project's own row; everything else is machine-local placement and is
 * never synced — a lost catalog costs the placements, not the data.
 */
export const CatalogProject = z.object({
  id: z.string(),
  name: z.string().default(""),
  keyPrefix: z.string().default("TOM"),
  /** The folder holding `.tomrade/`. Null while the project lives only in the cache (pre-P1 data, or mid-migration). */
  dir: z.string().nullable().default(null),
  /** Who drives git in that folder: Tomrade (a repository made for the project), the user (their code checkout), nobody. */
  git: z.enum(["dedicated", "shared", "none"]).default("none"),
  /** Only meaningful for a dedicated repository: where Tomrade pushes. */
  remote: RemoteRef.nullable().default(null),
  /** Plugin namespaces whose tables travel in this project's folder. */
  exports: z.array(z.string()).default([]),
  /** In a shared checkout: commit the `.tomrade` subtree after publishing. Never push. */
  autoCommit: z.boolean().default(false),
  lastPublishedDigest: z.string().nullable().default(null),
  lastSyncAt: z.number().nullable().default(null),
  /** The last oplog seq already appended to the folder's log; the write-through catches up from here. */
  lastLoggedSeq: z.number().int().default(0),
  archived: z.boolean().default(false),
  /** Tables (`<namespace>/<table>`) a restore could not read: never exported from here until a snapshot carrying them arrives. */
  withheld: z.array(z.string()).default([]),
  /** The first run's Default Project, untouched so far: kept out of the account's catalog until someone uses it. */
  seed: z.boolean().default(false),
  createdAt: z.number().default(0),
  /** Cached facts for the home grid, refreshed on close and on write. */
  facts: z.object({ items: z.number(), boards: z.number(), updatedAt: z.number() }).optional()
});
export type CatalogProject = z.infer<typeof CatalogProject>;

export const CatalogRepo = z.object({
  /** The local checkout Tomrade fetches from and adds worktrees to. Null until the user names one. */
  checkout: z.string().nullable().default(null),
  /** The workstream runs directly in the checkout instead of a worktree. The user's decision and risk. */
  runInCheckout: z.boolean().default(false)
});
export type CatalogRepo = z.infer<typeof CatalogRepo>;

const CatalogFile = z.object({
  v: z.literal(1).default(1),
  projects: z.array(CatalogProject).default([]),
  /** Keyed by the normalized remote URL, so two projects sharing a repository share one checkout. */
  repos: z.record(z.string(), CatalogRepo).default({})
});

/**
 * `catalog.json`: the machine-local list of projects and repository checkouts.
 * Atomic writes; a file we cannot parse is treated as empty rather than guessed at.
 */
export class Catalog {
  private data: z.infer<typeof CatalogFile> = { v: 1, projects: [], repos: {} };

  constructor(private readonly file: string | null) {
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const parsed = CatalogFile.safeParse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      if (parsed.success) this.data = parsed.data;
    } catch {
      // first run
    }
  }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body = JSON.stringify({ ...this.data, projects: [...this.data.projects].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) }, null, 2) + "\n";
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, this.file);
  }

  projects(): CatalogProject[] {
    return [...this.data.projects].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  project(id: string): CatalogProject | null {
    return this.data.projects.find((p) => p.id === id) ?? null;
  }

  /** Insert or replace by id; partial input is completed with the schema's defaults. */
  upsertProject(input: Partial<CatalogProject> & { id: string }): CatalogProject {
    const existing = this.project(input.id);
    const next = CatalogProject.parse({ ...existing, ...input });
    this.data.projects = [...this.data.projects.filter((p) => p.id !== input.id), next];
    this.save();
    return next;
  }

  patchProject(id: string, patch: Partial<Omit<CatalogProject, "id">>): CatalogProject | null {
    const existing = this.project(id);
    if (!existing) return null;
    return this.upsertProject({ ...existing, ...patch, id });
  }

  removeProject(id: string): void {
    const before = this.data.projects.length;
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    if (this.data.projects.length !== before) this.save();
  }

  repos(): Record<string, CatalogRepo> {
    return { ...this.data.repos };
  }

  repo(remote: string): CatalogRepo | null {
    return this.data.repos[remote] ?? null;
  }

  setRepo(remote: string, patch: Partial<CatalogRepo>): CatalogRepo {
    const next = CatalogRepo.parse({ ...this.data.repos[remote], ...patch });
    this.data.repos = { ...this.data.repos, [remote]: next };
    this.save();
    return next;
  }

  removeRepo(remote: string): void {
    if (!(remote in this.data.repos)) return;
    const { [remote]: _gone, ...rest } = this.data.repos;
    this.data.repos = rest;
    this.save();
  }
}
