import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type { ThreadSummary } from "@tomradex/agent";
import { errorMessage } from "@tomradex/contracts";
import type { ItemStatus } from "@tomradex/domain";
import type { Git } from "@tomradex/git";
import type { SettingsSection } from "@tomradex/settings";
import type { CodeLinkStore, SessionView } from "./store.js";

const WorktreeSettings = z.object({
  enabled: z.boolean().default(true).meta({ title: "Remove a finished ticket's worktree" }).describe("Once a ticket is Done or Cancelled, the worktree Tomrade made for it is removed from this computer — only when nothing would be lost: no uncommitted or untracked files, no session still in it. Its branch stays, and starting the ticket again brings the worktree back."),
  keepDays: z.number().int().min(0).max(365).default(1).meta({ title: "Keep for (days)" }).describe("How long a finished ticket's worktree stays before it is removed. 0 removes it soon after the ticket finishes.")
});
type WorktreeSettings = z.infer<typeof WorktreeSettings>;

export const WORKTREE_SECTION: SettingsSection<WorktreeSettings> = {
  id: "worktrees",
  title: "Worktrees",
  description: "Every ticket started from Tomrade is worked in a worktree of its own under the Hub, with its own installed dependencies, and they fill the disk when left. What they take on this computer, and when a finished ticket's is removed.",
  schema: WorktreeSettings,
  defaults: WorktreeSettings.parse({}),
  scope: "machine",
  order: 31,
  words: {
    zh: {
      title: "Worktree",
      description: "从 Tomrade 开始的每张工单都在 Hub 下自己的 worktree 里做，各带一份依赖安装，放着不管会占满磁盘。这里是它们在这台电脑上占了多少，以及已结束工单的 worktree 何时移除。",
      fields: {
        enabled: { title: "移除已结束工单的 worktree", description: "工单完成或取消后，Tomrade 为它建的 worktree 会从这台电脑上移除——只在不丢东西时：没有未提交改动和未跟踪文件，也没有会话还在里面。分支会保留，重新开始这张工单就能把 worktree 带回来。" },
        keepDays: { title: "保留天数", description: "已结束工单的 worktree 保留多久再移除。0 表示工单结束后很快移除。" }
      }
    }
  }
};

/**
 * Why a worktree stays: its ticket or conversation is not finished, a session or run is still in it, it has
 * uncommitted or untracked files, or it sits on commits no branch holds.
 */
export type WorktreeHold = "open" | "busy" | "dirty" | "loose";

/** A worktree Tomrade made for a conversation, as it stands on this machine. */
export interface WorktreeView {
  repoId: string;
  dir: string;
  /** The conversation it was made for; the folder is named for it. */
  threadId: string;
  /** The branch checked out in it; null when it is detached. */
  branch: string | null;
  /** A ticket's, a conversation's on no ticket, or nobody's: its conversation is gone from every open project. */
  owner: "ticket" | "conversation" | "none";
  /** The tickets worked in it that the project still has. */
  tickets: { id: string; key: string; title: string; status: ItemStatus }[];
  /** Null when removing it loses nothing. */
  hold: WorktreeHold | null;
  /** When cleanup removes it by itself; null when it will not: something holds it, cleanup is off, or it is not a ticket's. */
  removeAt: number | null;
}

/** One repository's worktrees, in one open project. */
export interface WorktreeGroup {
  projectId: string;
  project: string;
  repoId: string;
  repo: string;
  trees: WorktreeView[];
}

/** Every worktree Tomrade made on this machine, across the open projects, and the disk they are on. */
export interface WorktreeOverview {
  /** The Hub's folder of worktrees; null with no Hub folder chosen. */
  root: string | null;
  /** That folder's disk, in bytes: what is free to this user, and its size; null when it cannot be read. */
  disk: { free: number; total: number } | null;
  /** Repositories that have a worktree here; one with none is left out. */
  groups: WorktreeGroup[];
}

export interface WorktreeRemoval {
  dir: string;
  removed: boolean;
  /** Why it stayed, in git's words when git refused. */
  reason: string | null;
}

export interface WorktreesDeps {
  ctx: Context;
  store: CodeLinkStore;
  git: Git;
  /** Whether a pane still runs; null when nothing can tell. */
  paneAlive: (pane: string) => Promise<boolean | null>;
  /** Machine-local: each thread's worktree. A removed one is forgotten. */
  worktrees: Map<string, string>;
  notify: (projectId: string) => void;
}

const DAY_MS = 24 * 60 * 60_000;
/** A size is read again after this long; reading one walks every file of an install. */
const SIZE_FRESH_MS = 10 * 60_000;
/** A ticket that has just finished is looked at this much later: its sessions end first. */
const SOON_MS = 30_000;

/** How many worktrees git is asked about at once. */
const LOOKS_AT_ONCE = 4;

const FINISHED = new Set<ItemStatus>(["done", "cancelled"]);

const real = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

const within = (dir: string, inner: string | null): boolean => {
  if (!inner) return false;
  const rel = path.relative(dir, real(inner));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

type Tree = WorktreeView & { checkout: string };

/**
 * The worktrees Tomrade made under the Hub, and their end. A ticket's worktree goes once the ticket is done or
 * cancelled and nothing would be lost with it; everything else stays until a person removes it, and a worktree
 * anyone still works in is never touched. Only folders in the Hub's worktrees are looked at: the person's own
 * checkout, and a folder an outside session named, are not Tomrade's to remove.
 */
export class Worktrees {
  private readonly ctx: Context;
  private readonly store: CodeLinkStore;
  private readonly git: Git;
  private readonly sizes = new Map<string, { bytes: number | null; at: number }>();
  private sizing: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private sweeping: Promise<number> | null = null;

  constructor(private readonly host: WorktreesDeps) {
    this.ctx = host.ctx;
    this.store = host.store;
    this.git = host.git;
  }

  settings(): WorktreeSettings {
    return WorktreeSettings.parse(this.ctx.settings.value(WORKTREE_SECTION.id) ?? {});
  }

  /** Every worktree of the project's repositories that Tomrade made on this machine, with what holds each. */
  async list(projectId: string): Promise<WorktreeView[]> {
    return (await this.trees(projectId)).map(({ checkout: _checkout, ...view }) => view);
  }

  /** Every open project's worktrees by repository, each worktree once, with the disk the Hub keeps them on. */
  async overview(): Promise<WorktreeOverview> {
    const root = this.ctx.repos.worktreesDir();
    const names = new Map(this.ctx.hub.catalog.projects().map((project) => [project.id, project.name]));
    const seen = new Set<string>();
    const groups: WorktreeGroup[] = [];
    for (const projectId of this.ctx.db.openIds()) {
      const repos = new Map(this.ctx.repos.list(projectId).map((repo) => [repo.id, repo.name]));
      // A checkout two projects share lists a worktree nobody owns under both: it counts once.
      const trees = (await this.list(projectId)).filter((tree) => !seen.has(tree.dir) && !!seen.add(tree.dir));
      for (const repoId of new Set(trees.map((tree) => tree.repoId))) {
        groups.push({ projectId, project: names.get(projectId) ?? "", repoId, repo: repos.get(repoId) ?? "", trees: trees.filter((tree) => tree.repoId === repoId) });
      }
    }
    return { root, disk: root ? await diskOf(root) : null, groups };
  }

  /** Remove these on a person's word. One that something holds stays, with the reason: what holds it, or git's own words. */
  async remove(projectId: string, dirs: string[]): Promise<WorktreeRemoval[]> {
    const trees = await this.trees(projectId);
    const out: WorktreeRemoval[] = [];
    for (const dir of dirs) {
      const tree = trees.find((each) => each.dir === dir);
      out.push(tree ? await this.take(tree) : { dir, removed: false, reason: "not a worktree Tomrade made for this project" });
    }
    if (out.some((removal) => removal.removed)) this.host.notify(projectId);
    return out;
  }

  /** One pass over the open projects: finished tickets' worktrees whose keeping time is over go. How many went. */
  sweep(): Promise<number> {
    this.sweeping ??= this.pass().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  /** A pass a little later, however many ask for it meanwhile. */
  soon(delayMs = SOON_MS): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sweep();
    }, delayMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** How much disk a worktree takes, in bytes; null when it cannot be read or is not one of the project's. */
  size(projectId: string, dir: string): Promise<number | null> {
    const roots = this.ctx.repos.list(projectId).map((repo) => this.ctx.repos.worktreesDir(repo)).filter((root): root is string => !!root);
    if (!roots.some((root) => path.dirname(path.resolve(dir)) === path.resolve(root)) || !fs.existsSync(dir)) return Promise.resolve(null);
    const known = this.sizes.get(dir);
    if (known && Date.now() - known.at < SIZE_FRESH_MS) return Promise.resolve(known.bytes);
    // One at a time: several installs read at once only slow each other down.
    const read = this.sizing.then(async () => {
      const again = this.sizes.get(dir);
      if (again && Date.now() - again.at < SIZE_FRESH_MS) return again.bytes;
      const bytes = await diskUsage(dir);
      this.sizes.set(dir, { bytes, at: Date.now() });
      return bytes;
    });
    this.sizing = read.catch(() => null);
    return read;
  }

  private async pass(): Promise<number> {
    if (!this.settings().enabled) return 0;
    let removed = 0;
    for (const projectId of this.ctx.db.openIds()) {
      try {
        const now = Date.now();
        const due = (await this.trees(projectId)).filter((tree) => tree.removeAt !== null && tree.removeAt <= now);
        let gone = 0;
        for (const tree of due) if ((await this.take(tree)).removed) gone++;
        if (gone) this.host.notify(projectId);
        removed += gone;
      } catch (error) {
        this.ctx.logger.warn(`removing finished worktrees of ${projectId} failed: ${errorMessage(error)}`);
      }
    }
    return removed;
  }

  private async take(tree: Tree): Promise<WorktreeRemoval> {
    if (tree.hold) return { dir: tree.dir, removed: false, reason: tree.hold };
    const refused = await this.ctx.repos.removeWorktree(tree.checkout, tree.dir);
    if (refused) {
      this.ctx.logger.info(`worktree ${tree.dir} stays: ${refused}`);
      return { dir: tree.dir, removed: false, reason: refused };
    }
    this.sizes.delete(tree.dir);
    if (this.host.worktrees.get(tree.threadId) === tree.dir) this.host.worktrees.delete(tree.threadId);
    this.ctx.logger.info(`removed worktree ${tree.dir}${tree.tickets.length ? ` (${tree.tickets.map((ticket) => ticket.key).join(", ")})` : ""}; its branch ${tree.branch ?? "(detached)"} stays`);
    return { dir: tree.dir, removed: true, reason: null };
  }

  private async trees(projectId: string): Promise<Tree[]> {
    const agent = this.ctx.get("agent");
    const settings = this.settings();
    const openIds = this.ctx.db.openIds();
    const threads = agent?.store.threads(projectId, null) ?? [];
    const roots = new Map<string, string>();
    const rootOf = (thread: ThreadSummary): string => {
      const known = roots.get(thread.id);
      if (known) return known;
      let root = thread;
      const seen = new Set<string>([thread.id]);
      while (root.parentId && !seen.has(root.parentId)) {
        seen.add(root.parentId);
        const parent = agent?.store.thread(projectId, root.parentId);
        if (!parent) break;
        root = parent;
      }
      roots.set(thread.id, root.id);
      return root.id;
    };
    const running = new Set((agent?.activeRuns() ?? []).filter(({ thread }) => thread.projectId === projectId).map(({ thread }) => rootOf(thread)));
    const sessions = this.store.sessions(projectId);
    const sessionRoot = (session: SessionView): string | null => {
      const thread = session.threadId ? agent?.store.thread(projectId, session.threadId) : null;
      return thread ? rootOf(thread) : session.threadId;
    };
    const live = (session: SessionView) => session.state !== "ended" && session.state !== "lost";

    const out: Tree[] = [];
    const panes = new Map<string, string[]>();
    for (const repo of this.ctx.repos.list(projectId)) {
      const root = this.ctx.repos.worktreesDir(repo);
      const placed = this.ctx.repos.checkout(repo.remote);
      if (!root || !placed.checkout || placed.problem) continue;
      for (const found of await this.registered(placed.checkout, root)) {
        // Two repositories can share a name, and so a folder: a worktree is listed once, by the checkout it belongs to.
        if (out.some((tree) => tree.dir === found.dir)) continue;
        const threadId = path.basename(found.dir);
        const thread = agent?.store.thread(projectId, threadId) ?? null;
        // Another open project's conversation: that project lists it.
        if (!thread && openIds.some((id) => id !== projectId && agent?.store.thread(id, threadId))) continue;
        const members = thread ? [thread, ...threads.filter((other) => other.id !== thread.id && rootOf(other) === thread.id)] : [];
        const itemIds = [...new Set(members.flatMap((member) => (member.itemId ? [member.itemId] : [])))];
        const tickets = itemIds.flatMap((id) => {
          const item = this.ctx.items.get(projectId, id);
          return item ? [{ id: item.id, key: item.key, title: item.title, status: item.status, updatedAt: item.updatedAt }] : [];
        });
        const owner: WorktreeView["owner"] = !thread ? "none" : thread.itemId ? "ticket" : "conversation";
        const unfinished = tickets.some((ticket) => !FINISHED.has(ticket.status)) || (owner === "conversation" && !thread!.archived);
        const here = real(found.dir);
        const inside = sessions.filter((session) => sessionRoot(session) === threadId || within(here, session.worktree) || within(here, session.cwd));
        const hold: WorktreeHold | null = unfinished ? "open" : running.has(threadId) || inside.some(live) ? "busy" : null;
        // Kept from when its tickets were last touched: the nearest thing to when the last of them finished.
        const finishedAt = Math.max(0, ...tickets.map((ticket) => ticket.updatedAt));
        out.push({
          repoId: repo.id,
          dir: found.dir,
          threadId,
          branch: found.branch,
          owner,
          tickets: tickets.map(({ updatedAt: _updatedAt, ...ticket }) => ticket),
          hold,
          removeAt: owner === "ticket" && settings.enabled ? finishedAt + settings.keepDays * DAY_MS : null,
          checkout: placed.checkout
        });
        panes.set(found.dir, [...new Set(inside.flatMap((session) => (session.herdrPane ? [session.herdrPane] : [])))]);
      }
    }
    // What is left is asked of the terminal and of git, a few worktrees at a time: a machine with dozens left over is the one that looks.
    const unheld = out.filter((tree) => !tree.hold);
    const look = async (tree: Tree): Promise<void> => {
      for (const pane of panes.get(tree.dir) ?? []) {
        if ((await this.host.paneAlive(pane).catch(() => null)) === true) {
          tree.hold = "busy";
          return;
        }
      }
      tree.hold = await this.loses(tree.dir, tree.branch);
    };
    await Promise.all(Array.from({ length: Math.min(LOOKS_AT_ONCE, unheld.length) }, async () => {
      for (let tree = unheld.pop(); tree; tree = unheld.pop()) await look(tree);
    }));
    for (const tree of out) if (tree.hold) tree.removeAt = null;
    return out;
  }

  /** The checkout's worktrees that sit right in the Hub's folder for it, as git lists them. */
  private async registered(checkout: string, root: string): Promise<{ dir: string; branch: string | null }[]> {
    const list = await this.git(["worktree", "list", "--porcelain"], { cwd: checkout, ok: true });
    if (list.code !== 0) return [];
    const under = real(root);
    return list.stdout.split(/\r?\n\r?\n+/).flatMap((block) => {
      const dir = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
      if (!dir || !fs.existsSync(dir) || path.dirname(real(dir)) !== under) return [];
      // Named as the Hub names it, which is how Start and the sessions know it; git gives the path with links resolved.
      return [{ dir: path.join(root, path.basename(dir)), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? null }];
    });
  }

  /** What removing the worktree would lose: files git does not have, or commits no branch holds. A branch stays in the checkout, so its commits do. */
  private async loses(dir: string, branch: string | null): Promise<WorktreeHold | null> {
    // Read without taking the index lock: a session may start in it while this looks.
    const status = await this.git(["--no-optional-locks", "status", "--porcelain"], { cwd: dir, ok: true });
    if (status.code !== 0 || status.stdout.trim()) return "dirty";
    if (branch) return null;
    const head = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: dir, ok: true });
    if (head.code !== 0) return null;
    const held = await this.git(["for-each-ref", "--count=1", "--contains", "HEAD", "refs/heads", "refs/remotes"], { cwd: dir, ok: true });
    return held.code === 0 && held.stdout.trim() ? null : "loose";
  }
}

/** The disk a folder is on — or, while the folder is not there yet, the nearest one above it that is. */
async function diskOf(dir: string): Promise<{ free: number; total: number } | null> {
  for (let at = dir; ; at = path.dirname(at)) {
    try {
      const disk = await fs.promises.statfs(at);
      return { free: disk.bavail * disk.bsize, total: disk.blocks * disk.bsize };
    } catch {
      if (path.dirname(at) === at) return null;
    }
  }
}

/** `du` where there is one: it reads an install's files far faster than Node can ask about each. */
async function diskUsage(dir: string): Promise<number | null> {
  if (process.platform !== "win32") {
    const kilobytes = await new Promise<number | null>((resolve) => {
      // An unreadable file makes du exit non-zero with the total still printed.
      execFile("du", ["-sk", dir], { timeout: 5 * 60_000 }, (_error, stdout) => {
        const n = Number.parseInt(String(stdout).trim().split(/\s+/)[0] ?? "", 10);
        resolve(Number.isFinite(n) ? n : null);
      });
    });
    if (kilobytes !== null) return kilobytes * 1024;
  }
  return walkSize(dir);
}

async function walkSize(dir: string): Promise<number | null> {
  let total = 0;
  const pending = [dir];
  while (pending.length) {
    const folder = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      if (folder === dir) return null;
      continue;
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else total += await fs.promises.lstat(file).then((stat) => stat.size, () => 0);
    }
  }
  return total;
}
