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
import { parseBranch } from "./keys.js";
import type { CodeLinkStore, SessionView } from "./store.js";

const WorktreeSettings = z.object({
  enabled: z.boolean().default(true).meta({ title: "Remove a finished ticket's worktree" }).describe("Once a ticket is Done or Cancelled, the worktree Tomrade made for it is removed from this computer — only when nothing would be lost: no uncommitted or untracked files, no session still in it. Starting the ticket again brings the worktree back."),
  outside: z.boolean().default(false).meta({ title: "Also remove ones made outside the Hub" }).describe("Worktrees made somewhere else — by an agent in your own terminal, or by you — are removed the same way once every ticket they were worked for is Done or Cancelled, and only when nothing would be lost. One on no ticket is never touched."),
  keepDays: z.number().int().min(0).max(365).default(1).meta({ title: "Keep for (days)" }).describe("How long a finished ticket's worktree stays before it is removed. 0 removes it soon after the ticket finishes."),
  dropBranch: z.boolean().default(true).meta({ title: "Delete its local branch too" }).describe("When a worktree is removed — by this cleanup, or by you — its local branch is deleted with it, only when every commit on it is kept elsewhere: merged into the default branch, squash-merged into it, or on the remote. Otherwise the branch stays."),
  dropRemoteBranch: z.boolean().default(true).meta({ title: "Delete its branch on the remote too" }).describe("The branch of the same name on the remote is deleted as well — only when the remote's default branch already has everything on it (merged, or squash-merged), and only where pushing from Tomrade is on for the repository. A branch that was pushed but never merged stays on the remote.")
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
        enabled: { title: "移除已结束工单的 worktree", description: "工单完成或取消后，Tomrade 为它建的 worktree 会从这台电脑上移除——只在不丢东西时：没有未提交改动和未跟踪文件，也没有会话还在里面。重新开始这张工单就能把 worktree 带回来。" },
        outside: { title: "也移除在 Hub 之外建的 worktree", description: "在别处建的 worktree（终端里的智能体建的，或你自己建的）也一样处理：它对应的工单都已完成或取消、移除不会丢东西时就移除。不属于任何工单的永远不动。" },
        keepDays: { title: "保留天数", description: "已结束工单的 worktree 保留多久再移除。0 表示工单结束后很快移除。" },
        dropBranch: { title: "同时删除本地分支", description: "移除 worktree 时（自动清理，或你手动移除），它的本地分支会一起删除——只在分支上的每个提交都在别处还有时：已合并进默认分支、已 squash 合并进去，或远端有这条分支。否则分支保留。" },
        dropRemoteBranch: { title: "同时删除远端分支", description: "远端的同名分支也会一起删除——只在远端的默认分支已经包含它的全部内容时（已合并，或已 squash 合并），并且这个仓库允许 Tomrade 推送。只推送过、没有合并的分支会留在远端。" }
      }
    }
  }
};

/**
 * Why a worktree stays: its ticket or conversation is not finished, a session or run is still in it, it has
 * uncommitted or untracked files, it sits on commits no branch holds, or — made outside the Hub — it is on no ticket,
 * and so the person's own to keep or remove.
 */
export type WorktreeHold = "open" | "busy" | "dirty" | "loose" | "unticketed";

/** A worktree of one of the project's checkouts, as it stands on this machine: one Tomrade made for a conversation, or one made elsewhere. */
export interface WorktreeView {
  repoId: string;
  dir: string;
  /** The conversation it was made for; the folder is named for it. Empty for one made outside the Hub. */
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
  /**
   * Git no longer knows the folder: its checkout was moved or deleted, or its record pruned. Nothing can tell what
   * removing it loses, so cleanup leaves it and only a person removes it, one at a time.
   */
  stray: boolean;
  /**
   * Made outside the Hub's folder, by an agent in the person's own terminal or by the person: its tickets are those
   * of the sessions that worked in it and the one its branch names. Cleanup never removes it; a person may, once its
   * tickets are finished and nothing holds it.
   */
  outside: boolean;
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
  /** What became of its local branch: deleted with it, or kept because commits on it are nowhere else; null when it had none, or the worktree stayed. */
  branch: "deleted" | "kept" | null;
  /** The same for the branch of that name on the remote; null when the remote has none, or could not be asked. */
  remoteBranch: "deleted" | "kept" | null;
}

/** Asks a checkout's remote what it has now, once for a whole removal; false when it could not be asked. */
type Freshen = (checkout: string) => Promise<boolean>;

export interface WorktreesDeps {
  ctx: Context;
  store: CodeLinkStore;
  git: Git;
  /** Whether a pane still runs; null when nothing can tell. */
  paneAlive: (pane: string) => Promise<boolean | null>;
  /** Where the pane's foreground processes run; empty when the backend cannot tell. */
  paneDirs: (pane: string) => Promise<string[]>;
  /** Machine-local: each thread's worktree. A removed one is forgotten. */
  worktrees: Map<string, string>;
  notify: (projectId: string) => void;
  /** The project's ticket key prefix, by which a branch names its ticket. */
  prefixOf: (projectId: string) => string;
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

/** `checkout`: where git is asked about it; null for a stray, which no checkout has. */
type Tree = WorktreeView & { checkout: string | null };

/**
 * The worktrees of the project's checkouts, and their end. One Tomrade made under the Hub for a ticket goes once the
 * ticket is done or cancelled and nothing would be lost with it; everything else stays until a person removes it, and
 * a worktree anyone still works in is never touched. One made outside the Hub — by an agent in the person's terminal,
 * or by the person — is listed and counted with the rest, and removed on a person's word, or by the same rule once
 * the `outside` setting says so and it was worked for a ticket. The person's own
 * checkout is never one of them.
 */
export class Worktrees {
  private readonly ctx: Context;
  private readonly store: CodeLinkStore;
  private readonly git: Git;
  private readonly sizes = new Map<string, { bytes: number | null; at: number }>();
  private sizing: Promise<unknown> = Promise.resolve();
  /** Per project, the worktrees its last listing named: the folders a size may be asked of. */
  private readonly listed = new Map<string, Set<string>>();
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

  /**
   * Remove these on a person's word. One that something holds stays, with the reason: what holds it, or git's own
   * words. `strays`: the person was told git cannot check them; without it a stray stays.
   */
  async remove(projectId: string, dirs: string[], strays = false): Promise<WorktreeRemoval[]> {
    const trees = await this.trees(projectId);
    const fresh = this.freshen();
    const out: WorktreeRemoval[] = [];
    for (const dir of dirs) {
      const tree = trees.find((each) => each.dir === dir);
      out.push(tree ? await this.take(projectId, tree, fresh, strays) : { dir, removed: false, reason: "not a worktree Tomrade made for this project", branch: null, remoteBranch: null });
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
    // Under the Hub by where it is; anywhere else only as the listing named it.
    const ours = roots.some((root) => path.dirname(path.resolve(dir)) === path.resolve(root)) || !!this.listed.get(projectId)?.has(dir);
    if (!ours || !fs.existsSync(dir)) return Promise.resolve(null);
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
        const fresh = this.freshen();
        for (const tree of due) if ((await this.take(projectId, tree, fresh)).removed) gone++;
        if (gone) this.host.notify(projectId);
        removed += gone;
      } catch (error) {
        this.ctx.logger.warn(`removing finished worktrees of ${projectId} failed: ${errorMessage(error)}`);
      }
    }
    return removed;
  }

  private freshen(): Freshen {
    const asked = new Map<string, Promise<boolean>>();
    return (checkout) => {
      let answer = asked.get(checkout);
      if (!answer) {
        answer = this.git(["fetch", "-q", "--prune", "origin"], { cwd: checkout, ok: true }).then((fetched) => fetched.code === 0, () => false);
        asked.set(checkout, answer);
      }
      return answer;
    };
  }

  private async take(projectId: string, tree: Tree, fresh: Freshen, strays = false): Promise<WorktreeRemoval> {
    const stays = (reason: string): WorktreeRemoval => ({ dir: tree.dir, removed: false, reason, branch: null, remoteBranch: null });
    if (tree.hold) return stays(tree.hold);
    if (!tree.checkout && !strays) return stays("git no longer knows this folder: it is removed only on its own row");
    const refused = tree.checkout ? await this.ctx.repos.removeWorktree(tree.checkout, tree.dir, tree.outside) : this.ctx.repos.removeStrayWorktree(tree.dir);
    if (refused) {
      this.ctx.logger.info(`worktree ${tree.dir} stays: ${refused}`);
      return stays(refused);
    }
    this.sizes.delete(tree.dir);
    if (this.host.worktrees.get(tree.threadId) === tree.dir) this.host.worktrees.delete(tree.threadId);
    const branches = await this.dropBranches(projectId, tree, fresh);
    this.ctx.logger.info(`removed worktree ${tree.dir}${tree.tickets.length ? ` (${tree.tickets.map((ticket) => ticket.key).join(", ")})` : ""}; ${!tree.checkout ? "git no longer knew it" : !tree.branch ? "it was on no branch" : `its branch ${tree.branch} ${branches.branch === "deleted" ? "went with it" : "stays"}`}`);
    return { dir: tree.dir, removed: true, reason: null, ...branches };
  }

  /**
   * What goes with a removed worktree: its local branch, and the branch of the same name on the remote, each only when
   * nothing on it would be lost and its setting says so. Never the default branch.
   */
  private async dropBranches(projectId: string, tree: Tree, fresh: Freshen): Promise<Pick<WorktreeRemoval, "branch" | "remoteBranch">> {
    const repo = this.ctx.repos.get(projectId, tree.repoId);
    const { checkout, branch } = tree;
    if (!checkout || !branch || !repo) return { branch: null, remoteBranch: null };
    const settings = this.settings();
    const base = repo.defaultBranch;
    if (branch === base || (!settings.dropBranch && !settings.dropRemoteBranch)) return { branch: "kept", remoteBranch: null };
    const run = (args: string[]) => this.git(args, { cwd: checkout, ok: true });
    const tipOf = async (ref: string) => {
      const found = await run(["rev-parse", "--verify", "--quiet", ref]);
      return found.code === 0 ? found.stdout.trim() : null;
    };
    const local = `refs/heads/${branch}`;
    const remote = `refs/remotes/origin/${branch}`;
    const remoteBase = `refs/remotes/origin/${base}`;
    // What the remote has is only known once it has just been asked: a branch deleted there since would still look kept.
    const asked = await fresh(checkout);
    const localTip = await tipOf(local);
    const remoteTip = asked ? await tipOf(remote) : null;

    let dropped: "deleted" | "kept" = "kept";
    if (settings.dropBranch && localTip) {
      const merged = await this.landedIn(checkout, local, [remoteBase, `refs/heads/${base}`]);
      const pushed = !merged && !!remoteTip && (await run(["merge-base", "--is-ancestor", local, remote])).code === 0;
      // -D, since git's own -d knows nothing of a squash: the checks above are the ones that decide. It still refuses a branch another worktree has checked out.
      if ((merged || pushed) && (await run(["branch", "-D", branch])).code === 0) {
        dropped = "deleted";
        this.ctx.logger.info(`deleted branch ${branch} (was ${localTip}): ${merged ? `${base} has all of it` : "the remote has it"}`);
      }
    }

    let remoteDropped: "deleted" | "kept" | null = null;
    if (remoteTip) {
      remoteDropped = "kept";
      // Once this one is gone nothing else has its commits, so only what the remote's own default branch already took; and only where Tomrade may push at all.
      const may = settings.dropRemoteBranch && this.store.repoState(projectId, tree.repoId)?.agentPush !== false;
      if (may && (await this.landedIn(checkout, remote, [remoteBase]))) {
        // Deleted only if it is still the commit that was judged.
        const pushed = await run(["push", "-q", `--force-with-lease=refs/heads/${branch}:${remoteTip}`, "origin", `:refs/heads/${branch}`]);
        if (pushed.code === 0) {
          remoteDropped = "deleted";
          this.ctx.logger.info(`deleted branch ${branch} on the remote (was ${remoteTip}): ${base} there has all of it`);
        }
      }
    }
    return { branch: dropped, remoteBranch: remoteDropped };
  }

  /**
   * Whether everything on a branch has landed in one of these: it contains the branch (merged), or already has the
   * branch's whole change as one commit (squash-merged) — which git judges from the patch itself, so a change that had
   * to be altered to land does not count.
   */
  private async landedIn(checkout: string, ref: string, bases: string[]): Promise<boolean> {
    const run = (args: string[]) => this.git(args, { cwd: checkout, ok: true });
    const there: string[] = [];
    for (const base of bases) if ((await run(["rev-parse", "--verify", "--quiet", base])).code === 0) there.push(base);
    for (const base of there) if ((await run(["merge-base", "--is-ancestor", ref, base])).code === 0) return true;
    for (const base of there) {
      const fork = (await run(["merge-base", base, ref])).stdout.trim();
      if (!fork) continue;
      // The branch as the one commit a squash would have made of it, compared by patch with what the base took since they parted.
      const squashed = (await run(["-c", "user.name=Tomrade", "-c", "user.email=tomrade@localhost", "commit-tree", `${ref}^{tree}`, "-p", fork, "-m", "squash"])).stdout.trim();
      if (!squashed) continue;
      const cherry = await run(["cherry", base, squashed]);
      if (cherry.code === 0 && cherry.stdout.trim().startsWith("-")) return true;
    }
    return false;
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
      if (!root) continue;
      const placed = this.ctx.repos.checkout(repo.remote);
      const checkout = placed.problem ? null : placed.checkout;
      const known: { dir: string; branch: string | null; outside: boolean; checkout: string | null }[] = checkout ? (await this.registered(checkout, root)).map((found) => ({ ...found, checkout })) : [];
      // Beside them, the folders git no longer knows: no checkout lists those.
      const strays = this.ctx.repos.strayWorktrees(repo).filter((dir) => !known.some((found) => found.dir === dir));
      for (const found of [...known, ...strays.map((dir) => ({ dir, branch: null, outside: false, checkout: null }))]) {
        // Two repositories can share a name, and so a folder: a worktree is listed once, by the checkout it belongs to.
        if (out.some((tree) => tree.dir === found.dir)) continue;
        if (found.outside) {
          // No conversation of Tomrade's made it: whose it is, is read from who worked in it and what its branch says.
          const here = real(found.dir);
          const inside = sessions.filter((session) => within(here, session.worktree) || within(here, session.cwd));
          const tickets = this.ticketsAt(projectId, inside, found.branch);
          const finishedAt = Math.max(0, ...tickets.map((ticket) => ticket.updatedAt));
          // On no ticket here, and on one of another open project that shares the checkout: that project lists it.
          if (!tickets.length && openIds.some((id) => id !== projectId && this.ticketsAt(id, this.store.sessions(id).filter((session) => within(here, session.worktree) || within(here, session.cwd)), found.branch).length)) continue;
          out.push({
            repoId: repo.id,
            dir: found.dir,
            threadId: "",
            branch: found.branch,
            owner: tickets.length ? "ticket" : "none",
            tickets: tickets.map(({ updatedAt: _updatedAt, ...ticket }) => ticket),
            hold: tickets.some((ticket) => !FINISHED.has(ticket.status)) ? "open" : inside.some(live) ? "busy" : tickets.length ? null : "unticketed",
            removeAt: tickets.length && settings.enabled && settings.outside ? finishedAt + settings.keepDays * DAY_MS : null,
            stray: false,
            outside: true,
            checkout: found.checkout
          });
          panes.set(found.dir, [...new Set(inside.flatMap((session) => (session.herdrPane ? [session.herdrPane] : [])))]);
          continue;
        }
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
          removeAt: owner === "ticket" && found.checkout && settings.enabled ? finishedAt + settings.keepDays * DAY_MS : null,
          stray: !found.checkout,
          outside: false,
          checkout: found.checkout
        });
        panes.set(found.dir, [...new Set(inside.flatMap((session) => (session.herdrPane ? [session.herdrPane] : [])))]);
      }
    }
    // What is left is asked of the terminal and of git, a few worktrees at a time: a machine with dozens left over is the one that looks.
    const unheld = out.filter((tree) => !tree.hold);
    const look = async (tree: Tree): Promise<void> => {
      const here = real(tree.dir);
      for (const pane of panes.get(tree.dir) ?? []) {
        if ((await this.host.paneAlive(pane).catch(() => null)) !== true) continue;
        // A pane its sessions left holds it only while something there still runs in it: one agent goes on from ticket to ticket in the same pane.
        const dirs = await this.host.paneDirs(pane).catch(() => []);
        if (!dirs.length || dirs.some((dir) => within(here, dir))) {
          tree.hold = "busy";
          return;
        }
      }
      if (tree.checkout) tree.hold = await this.loses(tree.dir, tree.branch);
    };
    await Promise.all(Array.from({ length: Math.min(LOOKS_AT_ONCE, unheld.length) }, async () => {
      for (let tree = unheld.pop(); tree; tree = unheld.pop()) await look(tree);
    }));
    for (const tree of out) if (tree.hold) tree.removeAt = null;
    this.listed.set(projectId, new Set(out.map((tree) => tree.dir)));
    return out;
  }

  /** The project's tickets a worktree outside the Hub was worked for: those of the sessions in it, and the one its branch names. */
  private ticketsAt(projectId: string, inside: SessionView[], branch: string | null): { id: string; key: string; title: string; status: ItemStatus; updatedAt: number }[] {
    const prefix = this.host.prefixOf(projectId);
    const named = branch ? parseBranch(branch, prefix) : null;
    const items = [...inside.flatMap((session) => session.itemIds.map((id) => this.ctx.items.get(projectId, id))), named === null ? null : this.ctx.items.getByKey(projectId, `${prefix}-${named}`)];
    const seen = new Set<string>();
    return items.flatMap((item) => (item && !seen.has(item.id) && seen.add(item.id) ? [{ id: item.id, key: item.key, title: item.title, status: item.status, updatedAt: item.updatedAt }] : []));
  }

  /**
   * The checkout's worktrees as git lists them: those right in the Hub's folder for it, and those made anywhere else.
   * The checkout itself is not one, nor the folder a merge Tomrade is making stands in for a moment.
   */
  private async registered(checkout: string, root: string): Promise<{ dir: string; branch: string | null; outside: boolean }[]> {
    const list = await this.git(["worktree", "list", "--porcelain"], { cwd: checkout, ok: true });
    if (list.code !== 0) return [];
    const under = real(root);
    const main = real(checkout);
    // git names the repository's own folder first.
    return list.stdout.split(/\r?\n\r?\n+/).slice(1).flatMap((block) => {
      const dir = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
      if (!dir || !fs.existsSync(dir)) return [];
      const at = real(dir);
      if (at === main || path.basename(path.dirname(at)).startsWith("tomrade-merge-")) return [];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? null;
      // Under the Hub it is named as the Hub names it, which is how Start and the sessions know it; git gives the path with links resolved.
      return [path.dirname(at) === under ? { dir: path.join(root, path.basename(dir)), branch, outside: false } : { dir, branch, outside: true }];
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
