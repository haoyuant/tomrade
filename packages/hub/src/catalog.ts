import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { errorMessage } from "@tomradex/contracts";

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
  /** Who can read that remote, as its provider said at `visibilityAt`; null until asked. */
  visibility: z.enum(["public", "private", "unknown"]).nullable().default(null),
  visibilityAt: z.number().nullable().default(null),
  /** Plugin namespaces whose tables travel in this project's folder. */
  exports: z.array(z.string()).default([]),
  /** In a shared checkout: commit the `.tomrade` subtree after publishing. Never push. */
  autoCommit: z.boolean().default(false),
  lastPublishedDigest: z.string().nullable().default(null),
  lastSyncAt: z.number().nullable().default(null),
  /** The last oplog seq already appended to the folder's log; the write-through catches up from here. */
  lastLoggedSeq: z.number().int().default(0),
  /** This device's own oplog rows up to this device_seq have reached where the project is shared; null until first known. */
  syncedDeviceSeq: z.number().int().nullable().default(null),
  archived: z.boolean().default(false),
  /** Tables (`<namespace>/<table>`) a restore could not read: never exported from here until a snapshot carrying them arrives. */
  withheld: z.array(z.string()).default([]),
  /** Plugin namespaces whose tables in the folder the cache has not taken in: their plugin was not loaded when the folder was read. */
  unimported: z.array(z.string()).default([]),
  /** The first run's project, untouched so far: kept out of the account's catalog until someone uses it. */
  seed: z.boolean().default(false),
  /** The sample project: this machine's tour, never in the account's catalog however much it is used. */
  sample: z.boolean().default(false),
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

/** A catalog file that did not read whole: why, and the copy it was kept as. */
export interface CatalogDamage {
  /** Entries that could not be read, of how many; null when the file is not JSON at all. */
  dropped: { count: number; of: number } | null;
  /** The parser's own words, for whoever repairs the file. */
  detail: string;
  keptAs: string;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

/**
 * `catalog.json`: the machine-local list of projects and repository checkouts.
 * Atomic writes. A file that does not read whole is kept beside itself and
 * what reads of it is used, but nothing is written over it until the person
 * says so: written over, every project's sync state — or the entries a newer
 * build wrote — would be gone with it.
 */
export class Catalog {
  private data: z.infer<typeof CatalogFile> = { v: 1, projects: [], repos: {} };
  private damage: CatalogDamage | null = null;

  constructor(private readonly file: string | null) {
    this.load();
  }

  /** Why the file did not read whole and where its copy is; saves are refused until `confirmOverwrite`. */
  get corrupt(): CatalogDamage | null {
    return this.damage;
  }

  /** The person's say-so: what was salvaged is written over the file that failed to read. Its copy stays. */
  confirmOverwrite(): void {
    if (!this.damage) return;
    this.damage = null;
    this.save();
  }

  private load(): void {
    if (!this.file) return;
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return; // first run
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      this.keep(text, null, errorMessage(error));
      return;
    }
    const parsed = CatalogFile.safeParse(raw);
    if (parsed.success) {
      this.data = parsed.data;
      return;
    }
    // Entry by entry: one a newer build wrote costs that entry, not every other project's state.
    const file = (raw && typeof raw === "object" ? raw : {}) as { projects?: unknown; repos?: unknown };
    const projects = Array.isArray(file.projects) ? file.projects : [];
    const repos = file.repos && typeof file.repos === "object" && !Array.isArray(file.repos) ? Object.entries(file.repos as Record<string, unknown>) : [];
    const keptProjects = projects.flatMap((p) => {
      const r = CatalogProject.safeParse(p);
      return r.success ? [r.data] : [];
    });
    const keptRepos = repos.flatMap(([remote, r]) => {
      const parsedRepo = CatalogRepo.safeParse(r);
      return parsedRepo.success ? [[remote, parsedRepo.data] as const] : [];
    });
    this.data = { v: 1, projects: keptProjects, repos: Object.fromEntries(keptRepos) };
    const of = projects.length + repos.length;
    const issue = parsed.error.issues[0];
    this.keep(text, { count: of - keptProjects.length - keptRepos.length, of }, issue ? `${issue.path.join(".") || "file"}: ${issue.message}` : "schema mismatch");
  }

  /** The file as it is, beside itself; a launch that finds the same bytes already kept adds no copy. */
  private keep(text: string, dropped: CatalogDamage["dropped"], detail: string): void {
    const file = this.file!;
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.corrupt-`;
    const same = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).find((n) => fs.readFileSync(path.join(dir, n), "utf8") === text);
    const keptAs = path.join(dir, same ?? `${prefix}${stamp()}`);
    if (!same) fs.copyFileSync(file, keptAs);
    this.damage = { dropped, detail, keptAs };
  }

  private save(): void {
    if (!this.file || this.damage) return;
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
