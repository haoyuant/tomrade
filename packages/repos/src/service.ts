import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { Db, ProjectDb } from "@tomradex/db";
import type { Hub } from "@tomradex/hub";
import type {} from "@tomradex/boards";
import { InUseError, NotFoundError, repoSubfolder, type CreateRepoInput, type Repo, type RepoPatch } from "@tomradex/domain";
import type {} from "@tomradex/ipc";
import { GitError, GitFolder, cloneInto, gitRunner, type Git } from "@tomradex/git";
import { slugOf } from "@tomradex/storage";
import { defineTool, requireProjectId } from "@tomradex/tools";
import { isLocalRemote, normalizeRemote, sameRepository } from "./remotes.js";
import { contract, type ReposReader } from "@tomradex/contracts";

declare module "cordis" {
  interface Context {
    repos: Repos;
  }
  interface Events {
    /** A checkout was placed successfully; consumers may inspect it immediately. */
    "repos/checkout-set"(remote: string): void;
  }
}

/** Where a workstream's code is on this machine, and whether it is ready for an agent. */
export interface CheckoutView {
  remote: string;
  checkout: string | null;
  runInCheckout: boolean;
  /** The folder this machine names cannot be worked in: gone from disk, or no longer a git checkout. */
  problem?: CheckoutProblem;
}

export type CheckoutProblem = "missing" | "not-git";

/** Every folder Tomrade places is a repository's top, so its own `.git` is what makes it usable. */
function checkoutProblem(dir: string): CheckoutProblem | null {
  try {
    if (!fs.statSync(dir).isDirectory()) return "missing";
  } catch {
    return "missing";
  }
  return fs.existsSync(path.join(dir, ".git")) ? null : "not-git";
}

const withProblem = (view: CheckoutView): CheckoutView => {
  const problem = view.checkout ? checkoutProblem(view.checkout) : null;
  return problem ? { ...view, problem } : view;
};

/** Result of inspecting the folder the user explicitly chose. */
export type CheckoutSelection =
  | { state: "ready"; view: CheckoutView }
  | { state: "clone"; remote: string; parent: string; dir: string; /** Set when the chosen folder is a checkout of another repository. */ origin?: string };

/** What no project wants committed, kept out of an imported folder that has no .gitignore of its own. */
const IMPORT_EXCLUDES = ["node_modules/", ".venv/", "venv/", "__pycache__/", ".DS_Store", ".env"];

/** A folder the user chose as one of the project's repositories. */
export interface FolderRepo {
  repo: Repo;
  view: CheckoutView;
  /** The folder has no origin: it is the repository, and its branches stay on this machine. */
  local: boolean;
  /** The project already had this repository; the folder became its checkout. */
  existing: boolean;
  /** The folder was not a repository: Tomrade ran git init in it. */
  initialised: boolean;
  /** Files committed because the repository had no commit yet; 0 when it already had one. */
  committed: number;
}

export interface WorkdirView {
  repo: Repo;
  /** The folder the agent runs in: a worktree of the checkout by default, the checkout itself when asked. */
  cwd: string;
  worktree: string | null;
  checkout: string;
  branch: string;
}

/** A thread's worktree that is not on this machine, asked about without leave to make it. */
export type MissingWorkdir = Omit<WorkdirView, "cwd"> & { cwd: null };

declare module "@tomradex/ipc" {
  interface Channels {
    "repos.list": (projectId: string) => Repo[];
    "repos.create": (input: CreateRepoInput) => Repo;
    /** Add the repository in a folder the user chose: its origin when it has one, the folder itself when it has none. */
    "repos.addFromFolder": (projectId: string, dir: string) => FolderRepo;
    "repos.update": (projectId: string, id: string, patch: RepoPatch) => Repo;
    "repos.remove": (projectId: string, id: string) => void;
    /** Every remote this machine has placed, by remote URL. */
    "repos.checkouts": () => CheckoutView[];
    /** Inspect the folder the user chose. If it is not this checkout, offer a named child folder for cloning. */
    "repos.selectCheckout": (remote: string, dir: string) => CheckoutSelection;
    "repos.clearCheckout": (remote: string) => void;
    "repos.setRunInCheckout": (remote: string, on: boolean) => CheckoutView;
    /** Clone as a named child of the folder the user chose, after explicit confirmation. */
    "repos.cloneInto": (remote: string, branch: string, parent: string) => CheckoutView;
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

const nameOf = (remote: string): string => normalizeRemote(remote).split(/[/:]/).filter(Boolean).pop() ?? "repo";

/** Keep ordinary remote basenames intact, but never allow a remote to escape the selected parent. */
const checkoutFolderNameOf = (remote: string): string => {
  const name = nameOf(remote);
  return name !== "." && name !== ".." && /^[a-zA-Z0-9._-]+$/.test(name) ? name : slugOf(name);
};

/** The workstream has a repository but this machine has not said where its checkout is. */
export class CheckoutUnsetError extends Error {
  constructor(public readonly remote: string) {
    super(`No local checkout for ${remote} on this machine — point Tomrade at yours, or let it clone one`);
    this.name = "CheckoutUnsetError";
  }
}

/** Worktrees live under the Hub folder, and none is chosen on this machine. */
export class HubUnsetError extends Error {
  constructor() {
    super("No Hub folder is chosen on this machine — choose one under Settings › Hub; worktrees are made in it");
    this.name = "HubUnsetError";
  }
}

/** git keeps a branch in one worktree at a time, and another worktree already has this one. */
/** The workstream's folder is a place on this machine outside the checkout: only a folder in the repository can be run in. */
export class RepoPathOutsideError extends Error {
  constructor(
    public readonly repoPath: string,
    public readonly checkout: string
  ) {
    super(`The workstream's folder ${repoPath} is not inside the checkout ${checkout} — in the workstream's settings, make it a folder in the repository (for example apps/web), or empty for the root`);
    this.name = "RepoPathOutsideError";
  }
}

export class BranchInUseError extends Error {
  constructor(
    public readonly branch: string,
    public readonly at: string
  ) {
    super(`${branch} is already checked out in ${at} — finish or remove that worktree, then start again`);
    this.name = "BranchInUseError";
  }
}

/**
 * The code repositories a project's workstreams stand for. Their identity (the
 * remote URL) is a project row and travels with it; where each is checked out
 * is this machine's alone, in the catalog. Tomrade never pushes any of them:
 * it fetches, and adds worktrees for agents to run in.
 */
export class Repos extends Service implements ReposReader {
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
      ctx.ipc.handle("repos.addFromFolder", (projectId, dir) => ctx.repos.addFromFolder(projectId, dir));
      ctx.ipc.handle("repos.update", (projectId, id, patch) => ctx.repos.update(projectId, id, patch));
      ctx.ipc.handle("repos.remove", (projectId, id) => ctx.repos.remove(projectId, id));
      ctx.ipc.handle("repos.checkouts", () => ctx.repos.checkouts());
      ctx.ipc.handle("repos.selectCheckout", (remote, dir) => ctx.repos.selectCheckout(remote, dir));
      ctx.ipc.handle("repos.clearCheckout", (remote) => ctx.repos.clearCheckout(remote));
      ctx.ipc.handle("repos.setRunInCheckout", (remote, on) => ctx.repos.setRunInCheckout(remote, on));
      ctx.ipc.handle("repos.cloneInto", (remote, branch, dir) => ctx.repos.cloneInto(remote, branch, dir));
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
    contract(this.home, "analytics")?.activate("code.link", "project_repo_linked");
    return repo;
  }

  /**
   * A folder chosen as a repository. Its origin, when it has one, is the
   * identity, and a row already naming it under any spelling is reused. With
   * no origin the folder itself is the repository, local to this machine until
   * it gains one (see adoptOrigins). A folder that is not a repository yet
   * becomes one here, and a repository with nothing committed gets its first
   * commit: worktrees, scans and merges all need a default branch to stand on.
   */
  async addFromFolder(projectId: string, rawDir: string): Promise<FolderRepo> {
    const dir = path.resolve(rawDir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not an existing folder`);
    const g = new GitFolder(this.runGit, dir);
    let top = await g.toplevel();
    const initialised = !top;
    if (!top) {
      await g.init("main");
      top = fs.realpathSync(dir);
    }
    if (top !== fs.realpathSync(dir)) throw new Error(`${dir} is inside the repository at ${top} — choose that folder, then point the workstream at the subfolder`);
    const committed = await this.commitUnborn(g);
    const origin = await g.remoteUrl();
    let known: Repo | undefined;
    for (const row of this.list(projectId)) {
      if (origin ? await sameRepository(origin, row.remote) : normalizeRemote(row.remote) === normalizeRemote(dir)) {
        known = row;
        break;
      }
    }
    const repo = known ?? this.create({ projectId, remote: origin ?? dir, name: origin ? undefined : path.basename(dir), defaultBranch: await this.trunkOf(dir, !!origin) });
    const key = normalizeRemote(repo.remote);
    this.hub.catalog.setRepo(key, { checkout: dir });
    this.notify();
    this.home.emit("repos/checkout-set", key);
    return { repo, view: this.checkout(key), local: !origin, existing: !!known, initialised, committed };
  }

  /**
   * A repository with no commit has no branch to scan, branch from or merge
   * into. What its working tree holds becomes the first commit, as the user's
   * .gitignore says; a folder without one still keeps dependency and cache
   * folders out, through .git/info/exclude so no file of theirs is written.
   */
  private async commitUnborn(g: GitFolder): Promise<number> {
    const run = (args: string[]) => this.runGit(args, { cwd: g.dir, ok: true });
    if ((await run(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0) return 0;
    if (!fs.existsSync(path.join(g.dir, ".gitignore"))) {
      const info = path.join(g.dir, ".git", "info");
      fs.mkdirSync(info, { recursive: true });
      fs.appendFileSync(path.join(info, "exclude"), `\n# Added by Tomrade: the folder had no .gitignore when it was imported\n${IMPORT_EXCLUDES.join("\n")}\n`);
    }
    await run(["add", "-A"]);
    const staged = (await run(["diff", "--cached", "--name-only"])).stdout.split("\n").filter((line) => line.trim()).length;
    if (!staged) return 0;
    await g.ensureIdentity();
    await this.runGit(["commit", "-q", "-m", `Import ${path.basename(g.dir)} into Tomrade`], { cwd: g.dir });
    return staged;
  }

  /** Where a folder's branches start: origin's HEAD, else main or master, else whatever is checked out. */
  private async trunkOf(dir: string, hasOrigin: boolean): Promise<string> {
    const run = (args: string[]) => this.runGit(args, { cwd: dir, ok: true });
    if (hasOrigin) {
      const head = await run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
      if (head.code === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, "");
    }
    for (const name of ["main", "master"]) {
      for (const ref of hasOrigin ? [`refs/remotes/origin/${name}`, `refs/heads/${name}`] : [`refs/heads/${name}`]) {
        if ((await run(["rev-parse", "--verify", "--quiet", ref])).code === 0) return name;
      }
    }
    const current = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return (current.code === 0 && current.stdout.trim()) || "main";
  }

  /**
   * A local repository whose folder has since gained an origin takes that
   * origin as its identity, so the project, and every machine it travels to,
   * sees the remote. The row keeps its id: workstreams and links stay put.
   */
  async adoptOrigins(projectId: string): Promise<Repo[]> {
    const rows = this.list(projectId);
    const adopted: Repo[] = [];
    for (const repo of rows) {
      if (!isLocalRemote(repo.remote)) continue;
      const placement = this.checkout(repo.remote);
      if (!placement.checkout || !fs.existsSync(placement.checkout)) continue;
      const origin = await new GitFolder(this.runGit, placement.checkout).remoteUrl();
      if (!origin || (await sameRepository(origin, repo.remote))) continue;
      // Another row already stands for that origin: two rows for one repository would split its workstreams.
      let taken = false;
      for (const other of rows) {
        if (other.id !== repo.id && (await sameRepository(origin, other.remote))) {
          taken = true;
          break;
        }
      }
      if (taken) continue;
      const next = this.update(projectId, repo.id, { remote: origin });
      // The old key stays: another project naming the same folder adopts on its own pass.
      this.hub.catalog.setRepo(normalizeRemote(next.remote), { checkout: placement.checkout, runInCheckout: placement.runInCheckout });
      adopted.push(next);
    }
    return adopted;
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
      .map(([remote, r]) => withProblem({ remote, checkout: r.checkout, runInCheckout: r.runInCheckout }))
      .sort((a, b) => a.remote.localeCompare(b.remote));
  }

  checkout(remote: string): CheckoutView {
    const key = normalizeRemote(remote);
    const r = this.hub.catalog.repo(key);
    return withProblem({ remote: key, checkout: r?.checkout ?? null, runInCheckout: r?.runInCheckout ?? false });
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
    if (origin && !(await sameRepository(origin, key))) throw new Error(`${dir} is a checkout of ${normalizeRemote(origin)}, not of ${key}`);
    this.hub.catalog.setRepo(key, { checkout: dir });
    this.notify();
    this.home.emit("repos/checkout-set", key);
    return this.checkout(key);
  }

  /** Choosing a folder never mutates it. A folder without this checkout gets an explicit clone offer. */
  async selectCheckout(remote: string, rawDir: string): Promise<CheckoutSelection> {
    const key = normalizeRemote(remote);
    const parent = path.resolve(rawDir);
    if (!fs.existsSync(parent)) throw new Error(`${parent} does not exist`);
    if (!fs.statSync(parent).isDirectory()) throw new Error(`${parent} is not a folder`);

    let other: string | undefined;
    if (fs.existsSync(path.join(parent, ".git"))) {
      const origin = await new GitFolder(this.runGit, parent).remoteUrl();
      if (!origin || (await sameRepository(origin, key))) return { state: "ready", view: await this.setCheckout(key, parent) };
      other = normalizeRemote(origin);
    }

    // A local repository can be cloned only where its folder is; elsewhere its copy is chosen, not made.
    if (isLocalRemote(key) && !fs.existsSync(key) && !fs.existsSync(`${key}.git`)) {
      throw new Error(other ? `${parent} is a checkout of ${other}, not of ${key}` : `${parent} is not a git repository, and ${key} has no remote to clone from — choose its folder on this machine`);
    }
    const dir = path.join(parent, checkoutFolderNameOf(key));
    if (fs.existsSync(dir)) {
      if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} already exists and is not a folder — nothing was cloned`);
      if (fs.existsSync(path.join(dir, ".git"))) return { state: "ready", view: await this.setCheckout(key, dir) };
      if (fs.readdirSync(dir).length !== 0) throw new Error(`${dir} already exists and is not empty — nothing was cloned`);
    }
    return other ? { state: "clone", remote: key, parent, dir, origin: other } : { state: "clone", remote: key, parent, dir };
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

  /** Clone into a repository-named child of the folder the user selected and then confirmed. */
  async cloneInto(remote: string, branch: string, rawParent: string): Promise<CheckoutView> {
    const key = normalizeRemote(remote);
    const parent = path.resolve(rawParent);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error(`${parent} is not an existing folder`);
    const dir = path.join(parent, checkoutFolderNameOf(key));
    if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length !== 0)) {
      throw new Error(`${dir} already exists and is not empty — nothing was cloned`);
    }
    await cloneInto(this.runGit, remote.trim(), branch, dir);
    this.hub.catalog.setRepo(key, { checkout: dir });
    this.notify();
    this.home.emit("repos/checkout-set", key);
    return this.checkout(key);
  }

  // ── where an agent runs ──────────────────────────────────────────────────────

  /**
   * The folder a thread on a workstream runs in. A worktree of the checkout,
   * detached at the remote's default branch, under the Hub where the user can
   * open it; or the checkout itself when the user chose that for the workstream.
   */
  async workdirFor(projectId: string, boardId: string, threadId: string, opts?: { branch?: string | null; create?: true }): Promise<WorkdirView | null>;
  async workdirFor(projectId: string, boardId: string, threadId: string, opts: { branch?: string | null; create: boolean }): Promise<WorkdirView | MissingWorkdir | null>;
  async workdirFor(projectId: string, boardId: string, threadId: string, opts: { branch?: string | null; create?: boolean } = {}): Promise<WorkdirView | MissingWorkdir | null> {
    const board = this.db(projectId).prepare("SELECT repo_id, repo_path FROM boards WHERE id = ?").get(boardId) as { repo_id: string | null; repo_path: string } | undefined;
    if (!board?.repo_id) return null;
    const repo = this.get(projectId, board.repo_id);
    if (!repo) return null;
    const placement = this.checkout(repo.remote);
    if (!placement.checkout || placement.problem) throw new CheckoutUnsetError(repo.remote);
    // Stored with forward slashes, relative to the repository; an absolute path from before that rule still resolves here.
    const sub = repoSubfolder(board.repo_path, placement.checkout);
    if (sub === null) throw new RepoPathOutsideError(board.repo_path, placement.checkout);
    if (placement.runInCheckout) {
      const cwd = path.join(placement.checkout, sub);
      // The user's own checkout is never written, not even an empty folder.
      if (!fs.existsSync(cwd)) throw new Error(`The workstream's folder ${sub} does not exist in ${placement.checkout} — create it there, or change the folder in the workstream's settings, before an agent runs in it`);
      return { repo, cwd, worktree: null, checkout: placement.checkout, branch: repo.defaultBranch };
    }
    const hubDir = this.hub.dir;
    if (!hubDir) throw new HubUnsetError();
    const worktree = path.join(hubDir, "worktrees", slugOf(repo.name), threadId);
    // Looking never writes: a worktree that is not there is reported, not made.
    if (opts.create === false && !fs.existsSync(worktree)) return { repo, cwd: null, worktree: null, checkout: placement.checkout, branch: opts.branch ?? repo.defaultBranch };
    if (!fs.existsSync(worktree)) {
      const g = new GitFolder(this.runGit, placement.checkout);
      await g.fetch(repo.defaultBranch);
      fs.mkdirSync(path.dirname(worktree), { recursive: true });
      const checkout = placement.checkout;
      const verify = async (ref: string) => (await this.runGit(["rev-parse", "--verify", "--quiet", ref], { cwd: checkout, ok: true })).code === 0;
      // Where a new branch starts: the remote's default branch, else the local
      // one (a repository with no remote), else whatever the checkout has, else
      // nothing — an empty repository has no commit to start from, so the branch
      // is born unborn (`--orphan`) and its first commit is the repository's first.
      const start = (await verify(`refs/remotes/origin/${repo.defaultBranch}`))
        ? `origin/${repo.defaultBranch}`
        : (await verify(`refs/heads/${repo.defaultBranch}`))
          ? repo.defaultBranch
          : (await verify("HEAD"))
            ? "HEAD"
            : null;
      const branch = opts.branch ?? null;
      if (branch) {
        // A ticket's branch: continued where it already exists (an earlier
        // session here, or a push from elsewhere), started from the default
        // branch otherwise. Detached is for a thread with no ticket.
        if (await verify(`refs/heads/${branch}`)) {
          await this.runGit(["worktree", "add", worktree, branch], { cwd: checkout }).catch((err: unknown) => {
            const at = err instanceof GitError ? /is already (?:used by worktree|checked out) at '([^']+)'/.exec(err.stderr)?.[1] : undefined;
            throw at ? new BranchInUseError(branch, at) : err;
          });
        } else if (await verify(`refs/remotes/origin/${branch}`)) await this.runGit(["worktree", "add", "--track", "-b", branch, worktree, `origin/${branch}`], { cwd: checkout });
        else if (start) await this.runGit(["worktree", "add", "-b", branch, worktree, start], { cwd: checkout });
        else await this.runGit(["worktree", "add", "--orphan", "-b", branch, worktree], { cwd: checkout });
      } else if (start) {
        await this.runGit(["worktree", "add", "--detach", worktree, start], { cwd: checkout });
      } else {
        await this.runGit(["worktree", "add", "--orphan", "-b", `tomrade/${threadId.slice(0, 8)}`, worktree], { cwd: checkout });
      }
    }
    // A workstream's folder may not exist yet — an empty repository, or one being
    // bootstrapped into a monorepo layout. In Tomrade's own worktree it can be made.
    const cwd = path.join(worktree, sub);
    if (opts.create !== false) fs.mkdirSync(cwd, { recursive: true });
    return { repo, cwd, worktree, checkout: placement.checkout, branch: opts.branch ?? repo.defaultBranch };
  }

  /** Remove a thread's worktree. The branch, if the agent made one, stays in the checkout. */
  async removeWorktree(view: WorkdirView): Promise<void> {
    if (!view.worktree) return;
    await this.runGit(["worktree", "remove", "--force", view.worktree], { cwd: view.checkout, ok: true });
    fs.rmSync(view.worktree, { recursive: true, force: true });
  }
}
