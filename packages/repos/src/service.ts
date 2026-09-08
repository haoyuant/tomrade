import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { Db, ProjectDb } from "@tomrade/db";
import type { Hub } from "@tomrade/hub";
import type {} from "@tomrade/boards";
import { InUseError, NotFoundError, type CreateRepoInput, type Repo, type RepoPatch } from "@tomrade/domain";
import type {} from "@tomrade/ipc";
import { GitFolder, cleanRemote, cloneInto, gitRunner, slugOf, type Git } from "@tomrade/storage";
import { defineTool, requireProjectId } from "@tomrade/tools";

declare module "cordis" {
  interface Context {
    repos: Repos;
  }
}

/** Where a workstream's code is on this machine, and whether it is ready for an agent. */
export interface CheckoutView {
  remote: string;
  checkout: string | null;
  runInCheckout: boolean;
}

export interface WorkdirView {
  repo: Repo;
  /** The folder the agent runs in: a worktree of the checkout by default, the checkout itself when asked. */
  cwd: string;
  worktree: string | null;
  checkout: string;
  branch: string;
}

declare module "@tomrade/ipc" {
  interface Channels {
    "repos.list": (projectId: string) => Repo[];
    "repos.create": (input: CreateRepoInput) => Repo;
    "repos.update": (projectId: string, id: string, patch: RepoPatch) => Repo;
    "repos.remove": (projectId: string, id: string) => void;
    /** Every remote this machine has placed, by remote URL. */
    "repos.checkouts": () => CheckoutView[];
    /** Name the local checkout of a remote; refused when the folder's origin is a different repository. */
    "repos.setCheckout": (remote: string, dir: string) => CheckoutView;
    "repos.clearCheckout": (remote: string) => void;
    "repos.setRunInCheckout": (remote: string, on: boolean) => CheckoutView;
    /** Clone the remote into the Hub's repos/ folder and record it as the checkout. */
    "repos.clone": (remote: string, branch: string) => CheckoutView;
  }
  interface Broadcasts {
    "repos.changed": () => void;
  }
}

export const ReposConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    gitBinary: z.string().default("git")
  })
);
export type ReposConfig = z.infer<typeof ReposConfig>;

interface RepoRow {
  id: string;
  project_id: string;
  remote: string;
  name: string;
  default_branch: string;
  created_at: number;
  updated_at: number;
}

const rowToRepo = (r: RepoRow): Repo => ({ id: r.id, projectId: r.project_id, remote: r.remote, name: r.name, defaultBranch: r.default_branch, createdAt: r.created_at, updatedAt: r.updated_at });

/** Two spellings of one repository read the same: no credential, no trailing `.git`, no trailing slash. */
export const normalizeRemote = (remote: string): string => cleanRemote(remote.trim()).replace(/\/+$/, "").replace(/\.git$/, "");

const nameOf = (remote: string): string => normalizeRemote(remote).split(/[/:]/).filter(Boolean).pop() ?? "repo";

/** The workstream has a repository but this machine has not said where its checkout is. */
export class CheckoutUnsetError extends Error {
  constructor(public readonly remote: string) {
    super(`No local checkout for ${remote} on this machine — point Tomrade at yours, or let it clone one`);
    this.name = "CheckoutUnsetError";
  }
}

/**
 * The code repositories a project's workstreams stand for. Their identity (the
 * remote URL) is a project row and travels with it; where each is checked out
 * is this machine's alone, in the catalog. Tomrade never pushes any of them:
 * it fetches, and adds worktrees for agents to run in.
 */
export class Repos extends Service {
  static provide = "repos";
  static inject = ["db", "hub", "storage"];
  static Config = ReposConfig;

  private readonly home: Context;
  private readonly runGit: Git;

  constructor(
    ctx: Context,
    public readonly config: ReposConfig
  ) {
    super(ctx, "repos");
    this.home = ctx;
    this.runGit = gitRunner(config.gitBinary);
  }

  [Service.init]() {
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("repos.list", (projectId) => ctx.repos.list(projectId));
      ctx.ipc.handle("repos.create", (input) => ctx.repos.create(input));
      ctx.ipc.handle("repos.update", (projectId, id, patch) => ctx.repos.update(projectId, id, patch));
      ctx.ipc.handle("repos.remove", (projectId, id) => ctx.repos.remove(projectId, id));
      ctx.ipc.handle("repos.checkouts", () => ctx.repos.checkouts());
      ctx.ipc.handle("repos.setCheckout", (remote, dir) => ctx.repos.setCheckout(remote, dir));
      ctx.ipc.handle("repos.clearCheckout", (remote) => ctx.repos.clearCheckout(remote));
      ctx.ipc.handle("repos.setRunInCheckout", (remote, on) => ctx.repos.setRunInCheckout(remote, on));
      ctx.ipc.handle("repos.clone", (remote, branch) => ctx.repos.clone(remote, branch));
    });
    this.home.inject(["tools"], (ctx) => {
      ctx.tools.register(
        defineTool({
          name: "list_repos",
          title: "List repositories",
          description: "The code repositories a project's workstreams stand for. `update_workstream` takes a repoId to link one.",
          input: z.object({ projectId: z.string().optional() }),
          execute: ({ projectId }, inv) => ctx.repos.list(requireProjectId("list_repos", projectId, inv))
        })
      );
    });
  }

  private db(projectId: string): ProjectDb {
    return (this.ctx.db as Db).for(projectId);
  }

  private get hub(): Hub {
    return this.ctx.hub;
  }

  private notify(): void {
    this.home.get("ipc")?.send("repos.changed");
  }

  // ── the shared rows ──────────────────────────────────────────────────────────

  list(projectId: string): Repo[] {
    return (this.db(projectId).prepare("SELECT * FROM repos WHERE project_id = ? ORDER BY name ASC, created_at ASC").all(projectId) as RepoRow[]).map(rowToRepo);
  }

  get(projectId: string, id: string): Repo | null {
    const row = this.db(projectId).prepare("SELECT * FROM repos WHERE id = ? AND project_id = ?").get(id, projectId) as RepoRow | undefined;
    return row ? rowToRepo(row) : null;
  }

  /** A remote already known to the project is returned, not duplicated. */
  create(input: CreateRepoInput): Repo {
    const remote = normalizeRemote(input.remote);
    if (!remote) throw new Error("A repository needs a remote URL");
    const existing = this.db(input.projectId).prepare("SELECT * FROM repos WHERE project_id = ? AND remote = ?").get(input.projectId, remote) as RepoRow | undefined;
    if (existing) return rowToRepo(existing);
    const now = Date.now();
    const repo: Repo = { id: randomUUID(), projectId: input.projectId, remote, name: input.name?.trim() || nameOf(remote), defaultBranch: input.defaultBranch?.trim() || "main", createdAt: now, updatedAt: now };
    this.db(input.projectId)
      .prepare("INSERT INTO repos (id, project_id, remote, name, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(repo.id, repo.projectId, repo.remote, repo.name, repo.defaultBranch, now, now);
    this.notify();
    return repo;
  }

  update(projectId: string, id: string, patch: RepoPatch): Repo {
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    const next: Repo = {
      ...existing,
      name: patch.name?.trim() || existing.name,
      defaultBranch: patch.defaultBranch?.trim() || existing.defaultBranch,
      remote: patch.remote ? normalizeRemote(patch.remote) : existing.remote,
      updatedAt: Date.now()
    };
    this.db(projectId).prepare("UPDATE repos SET remote = ?, name = ?, default_branch = ?, updated_at = ? WHERE id = ?").run(next.remote, next.name, next.defaultBranch, next.updatedAt, id);
    this.notify();
    return next;
  }

  /** Refused while a workstream still stands for it. */
  remove(projectId: string, id: string): void {
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    const using = (this.db(projectId).prepare("SELECT COUNT(*) AS n FROM boards WHERE repo_id = ?").get(id) as { n: number }).n;
    if (using > 0) throw new InUseError(id, `${existing.name} is still the repository of ${using} workstream${using === 1 ? "" : "s"}`);
    this.db(projectId).prepare("DELETE FROM repos WHERE id = ?").run(id);
    this.notify();
  }

  // ── this machine's checkouts ─────────────────────────────────────────────────

  checkouts(): CheckoutView[] {
    return Object.entries(this.hub.catalog.repos())
      .map(([remote, r]) => ({ remote, checkout: r.checkout, runInCheckout: r.runInCheckout }))
      .sort((a, b) => a.remote.localeCompare(b.remote));
  }

  checkout(remote: string): CheckoutView {
    const key = normalizeRemote(remote);
    const r = this.hub.catalog.repo(key);
    return { remote: key, checkout: r?.checkout ?? null, runInCheckout: r?.runInCheckout ?? false };
  }

  /** The folder must be a checkout of that very repository: its origin is compared, not trusted. */
  async setCheckout(remote: string, rawDir: string): Promise<CheckoutView> {
    const key = normalizeRemote(remote);
    const dir = path.resolve(rawDir);
    if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
    const g = new GitFolder(this.runGit, dir);
    const top = await g.toplevel();
    if (!top) throw new Error(`${dir} is not a git repository`);
    const origin = await g.remoteUrl();
    if (origin && normalizeRemote(origin) !== key) throw new Error(`${dir} is a checkout of ${normalizeRemote(origin)}, not of ${key}`);
    this.hub.catalog.setRepo(key, { checkout: dir });
    this.notify();
    return this.checkout(key);
  }

  clearCheckout(remote: string): void {
    this.hub.catalog.removeRepo(normalizeRemote(remote));
    this.notify();
  }

  setRunInCheckout(remote: string, on: boolean): CheckoutView {
    const key = normalizeRemote(remote);
    this.hub.catalog.setRepo(key, { runInCheckout: on });
    this.notify();
    return this.checkout(key);
  }

  /** For whoever has no checkout: clone into the Hub's `repos/`, where the user can see it. Still their repository — never pushed. */
  async clone(remote: string, branch = "main"): Promise<CheckoutView> {
    const key = normalizeRemote(remote);
    const hubDir = this.hub.dir;
    if (!hubDir) throw new Error("Choose the Hub folder first");
    const base = path.join(hubDir, "repos", slugOf(nameOf(key)));
    let dir = base;
    for (let n = 2; fs.existsSync(dir); n++) dir = `${base}-${n}`;
    await cloneInto(this.runGit, remote.trim(), branch, dir);
    this.hub.catalog.setRepo(key, { checkout: dir });
    this.notify();
    return this.checkout(key);
  }

  // ── where an agent runs ──────────────────────────────────────────────────────

  /**
   * The folder a thread on a workstream runs in. A worktree of the checkout,
   * detached at the remote's default branch, under the Hub where the user can
   * open it; or the checkout itself when the user chose that for the workstream.
   */
  async workdirFor(projectId: string, boardId: string, threadId: string): Promise<WorkdirView | null> {
    const board = this.db(projectId).prepare("SELECT repo_id, repo_path FROM boards WHERE id = ?").get(boardId) as { repo_id: string | null; repo_path: string } | undefined;
    if (!board?.repo_id) return null;
    const repo = this.get(projectId, board.repo_id);
    if (!repo) return null;
    const placement = this.checkout(repo.remote);
    if (!placement.checkout || !fs.existsSync(placement.checkout)) throw new CheckoutUnsetError(repo.remote);
    const sub = board.repo_path.replace(/^\/+/, "");
    if (placement.runInCheckout) {
      return { repo, cwd: path.join(placement.checkout, sub), worktree: null, checkout: placement.checkout, branch: repo.defaultBranch };
    }
    const hubDir = this.hub.dir;
    if (!hubDir) throw new Error("Choose the Hub folder first");
    const worktree = path.join(hubDir, "worktrees", slugOf(repo.name), threadId);
    if (!fs.existsSync(worktree)) {
      const g = new GitFolder(this.runGit, placement.checkout);
      await g.fetch(repo.defaultBranch);
      fs.mkdirSync(path.dirname(worktree), { recursive: true });
      const start = (await this.runGit(["rev-parse", "--verify", `origin/${repo.defaultBranch}`], { cwd: placement.checkout, ok: true })).code === 0 ? `origin/${repo.defaultBranch}` : "HEAD";
      await this.runGit(["worktree", "add", "--detach", worktree, start], { cwd: placement.checkout });
    }
    return { repo, cwd: path.join(worktree, sub), worktree, checkout: placement.checkout, branch: repo.defaultBranch };
  }

  /** Remove a thread's worktree. The branch, if the agent made one, stays in the checkout. */
  async removeWorktree(view: WorkdirView): Promise<void> {
    if (!view.worktree) return;
    await this.runGit(["worktree", "remove", "--force", view.worktree], { cwd: view.checkout, ok: true });
    fs.rmSync(view.worktree, { recursive: true, force: true });
  }
}
