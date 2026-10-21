import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import type { CommandCheck } from "@tomradex/agent";
import { GitFolder, type Git } from "@tomradex/git";
import type { CodeWords } from "./words.js";
import type { StartDefaultsStore } from "./defaults.js";
import type { CodeLinkStore, CodeLinkView } from "./store.js";
import { commandOk, exec } from "./terminal.js";
import { currentLinks, primaryOf, type ScanSummary } from "./scan/absorb.js";
import { bestEffort } from "@tomradex/contracts";

export interface OpenPrResult {
  pushed: boolean;
  /** The pull request's URL when one was created or found; otherwise a compare page to open one by hand, or null. */
  url: string | null;
  created: boolean;
  message: string;
}

export interface MergeLocalResult {
  merged: boolean;
  /** The default branch's head after the merge; null when nothing was merged. */
  sha: string | null;
  message: string;
}

/** The command an agent merges with when the repository lets it. */
export const MERGE_COMMAND = "gh pr merge";

/** The permission mode engines share for a run that asks nothing and is sandboxed nowhere. */
const FULL_ACCESS = "full-access";

/** Whether one local coding agent's own settings let it merge; `check` is null when Tomrade cannot read them. */
export interface MergeCheckView {
  engine: string;
  title: string;
  check: CommandCheck | null;
}

/** git's last word on a failure, which is the one that says why. */
const lastLine = (text: string | undefined) => (text ?? "").trim().split("\n").pop() ?? "";

/** A GitHub remote's compare page for a branch, or null for another host. */
export function compareUrl(remote: string, defaultBranch: string, branch: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branch)}?expand=1` : null;
}

export interface LandingDeps {
  ctx: Context;
  store: CodeLinkStore;
  git: Git;
  defaults: StartDefaultsStore;
  words: () => CodeWords;
  notify: (projectId: string) => void;
  reevaluate: (projectId: string, itemId: string, repoId: string) => void;
  scan: (projectId: string) => Promise<ScanSummary>;
  worktreeOf: (projectId: string, itemId: string) => string | null;
}

/** Getting a ticket's branch in: whether agents may merge, a local merge without a remote, and a pull request. */
export class Landing {
  private readonly ctx: Context;
  private readonly store: CodeLinkStore;
  private readonly git: Git;
  private readonly defaults: StartDefaultsStore;
  private readonly words: LandingDeps["words"];
  private readonly notify: LandingDeps["notify"];
  private readonly reevaluate: LandingDeps["reevaluate"];
  private readonly scan: LandingDeps["scan"];
  private readonly worktreeOf: LandingDeps["worktreeOf"];

  constructor(deps: LandingDeps) {
    this.ctx = deps.ctx;
    this.store = deps.store;
    this.git = deps.git;
    this.defaults = deps.defaults;
    this.words = deps.words;
    this.notify = deps.notify;
    this.reevaluate = deps.reevaluate;
    this.scan = deps.scan;
    this.worktreeOf = deps.worktreeOf;
  }

  private currentLinks(projectId: string, itemId: string): CodeLinkView[] {
    return currentLinks(this.store, projectId, itemId);
  }

  /**
   * Read, not run: each installed coding agent's own permission settings for
   * gh pr merge, under the mode a headless run here would use.
   */
  async mergeChecks(projectId: string, repoId: string): Promise<MergeCheckView[]> {
    const agent = this.ctx.get("agent");
    if (!agent) return [];
    const views: MergeCheckView[] = [];
    for (const engine of agent.codeEngines()) {
      if (!(await engine.available().catch(() => ({ ok: false }))).ok) continue;
      views.push({ engine: engine.id, title: engine.title, check: await this.mergeCheck(projectId, repoId, engine.id, false) });
    }
    return views;
  }

  async allowMerge(projectId: string, repoId: string, engineId: string): Promise<MergeCheckView> {
    const engine = this.ctx.get("agent")?.codeEngines().find((e) => e.id === engineId);
    if (!engine) throw new Error(`unknown engine ${engineId}`);
    if (!engine.local?.commands?.allow) throw new Error(`${engine.title}'s settings cannot be changed from Tomrade — allow gh pr merge there yourself`);
    return { engine: engine.id, title: engine.title, check: await this.mergeCheck(projectId, repoId, engineId, true) };
  }

  private async mergeCheck(projectId: string, repoId: string, engineId: string, allow: boolean): Promise<CommandCheck | null> {
    const repo = this.ctx.repos.get(projectId, repoId);
    if (!repo) throw new Error(`unknown repository ${repoId}`);
    const engine = this.ctx.get("agent")?.codeEngines().find((e) => e.id === engineId);
    if (!engine) return null;
    const remembered = this.defaults.read();
    const permissionMode = remembered?.engine === engineId && remembered.permissionMode ? remembered.permissionMode : engine.permissionModes?.default;
    // Tomrade itself hands full access to the run, so no setting of the agent's can stop the command.
    const commands = engine.local?.commands;
    if (!commands) return permissionMode === FULL_ACCESS ? { state: "allowed", why: "bypass", mode: FULL_ACCESS } : null;
    const placement = this.ctx.repos.checkout(repo.remote);
    const opts = { cwd: placement.checkout ?? null, worktree: !placement.runInCheckout, ...(permissionMode ? { permissionMode } : {}) };
    return allow && commands.allow ? commands.allow(MERGE_COMMAND, opts) : commands.check(MERGE_COMMAND, opts);
  }

  /**
   * In a repository with no remote, merge the ticket's branch into the default
   * branch here and record that merge as the link's evidence, whatever its
   * message says. Only where nothing can be lost: the default branch checked out
   * with a clean tree, or not checked out at all (a temporary worktree). A
   * conflict is aborted. `agent`: asked by an agent, which needs agent merging on.
   */
  async mergeLocal(projectId: string, itemId: string, opts: { agent?: boolean } = {}): Promise<MergeLocalResult> {
    const w = this.words();
    const no = (message: string): MergeLocalResult => ({ merged: false, sha: null, message });
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    const open = this.currentLinks(projectId, itemId).filter((l) => l.branch && !l.mergedSha);
    if (!open.length) return no(w("mergeNoBranch", { key: item.key }));
    if (open.length > 1) return no(w("mergeMany", { key: item.key }));
    const link = open[0]!;
    const repo = this.ctx.repos.get(projectId, link.repoId);
    if (!repo) return no(w("mergeNoBranch", { key: item.key }));
    const base = repo.defaultBranch;
    if (link.branch === base) return no(w("mergeNoBranch", { key: item.key }));
    const checkout = this.ctx.repos.checkout(repo.remote).checkout;
    if (!checkout || !fs.existsSync(checkout)) return no(w("mergeNoCheckout", { repo: repo.name }));
    if (await new GitFolder(this.git, checkout).remoteUrl()) return no(w("mergeHasRemote", { repo: repo.name }));
    if (opts.agent && !this.store.repoState(projectId, repo.id)?.agentMerge) return no(w("mergeAgentOff", { repo: repo.name }));

    const list = await this.git(["worktree", "list", "--porcelain"], { cwd: checkout, ok: true });
    const holder = list.stdout.split("\n\n").map((block) => ({ path: /^worktree (.+)$/m.exec(block)?.[1], branch: /^branch (.+)$/m.exec(block)?.[1] })).find((b) => b.branch === `refs/heads/${base}`)?.path;
    let cwd = holder;
    let temporary: string | null = null;
    if (cwd) {
      const dirty = await this.git(["status", "--porcelain", "--untracked-files=no"], { cwd, ok: true });
      if (dirty.code !== 0 || dirty.stdout.trim()) return no(w("mergeDirty", { base, where: cwd }));
    } else {
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-merge-"));
      cwd = path.join(temporary, "repo");
      const added = await this.git(["worktree", "add", "-q", cwd, base], { cwd: checkout, ok: true });
      if (added.code !== 0) {
        fs.rmSync(temporary, { recursive: true, force: true });
        return no(w("mergeFailed", { error: lastLine(added.stderr) }));
      }
    }
    try {
      const head = async () => (await this.git(["rev-parse", "HEAD"], { cwd: cwd! })).stdout.trim();
      let message: string;
      if ((await this.git(["merge-base", "--is-ancestor", link.branch, "HEAD"], { cwd, ok: true })).code === 0) {
        message = w("mergeAlready", { branch: link.branch, base });
      } else {
        // The subject leads with the key, so the commit also reads as this ticket's on any later scan.
        const merged = await this.git(["merge", "--no-ff", "-m", `${item.key}: ${item.title}`, "-m", `Merge branch '${link.branch}'`, link.branch], { cwd, ok: true });
        if (merged.code !== 0) {
          const conflicted = (await this.git(["diff", "--name-only", "--diff-filter=U"], { cwd, ok: true })).stdout.trim().split("\n").filter(Boolean);
          await this.git(["merge", "--abort"], { cwd, ok: true });
          return no(conflicted.length ? w("mergeConflict", { branch: link.branch, base, files: conflicted.join(", ") }) : w("mergeFailed", { error: lastLine(merged.stderr || merged.stdout) }));
        }
        message = "";
      }
      const sha = await head();
      this.store.patchLink(projectId, link.id, { mergedSha: sha, ahead: 0 });
      this.reevaluate(projectId, itemId, repo.id);
      this.notify(projectId);
      return { merged: true, sha, message: message || w("mergeDone", { branch: link.branch, base, sha: sha.slice(0, 7) }) };
    } finally {
      if (temporary) {
        await this.git(["worktree", "remove", "--force", cwd!], { cwd: checkout, ok: true });
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
  }

  /** Push the ticket's branch from its Tomrade worktree and open a pull request. Never from the user's own checkout, never the default branch. */
  async openPr(projectId: string, itemId: string): Promise<OpenPrResult> {
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    const links = this.currentLinks(projectId, itemId).filter((l) => l.branch);
    const link = primaryOf(links);
    if (!link) return { pushed: false, url: null, created: false, message: `${item.key} has no branch yet` };
    const repo = this.ctx.repos.get(projectId, link.repoId);
    if (!repo) return { pushed: false, url: null, created: false, message: "the repository row is gone" };
    const state = this.store.repoState(projectId, repo.id);
    if (state && !state.agentPush) return { pushed: false, url: compareUrl(repo.remote, repo.defaultBranch, link.branch), created: false, message: `pushing from Tomrade is off for ${repo.name} — push ${link.branch} yourself` };
    if (link.branch === repo.defaultBranch) return { pushed: false, url: null, created: false, message: "never the default branch" };
    const cwd = this.worktreeOf(projectId, itemId);
    if (!cwd) return { pushed: false, url: compareUrl(repo.remote, repo.defaultBranch, link.branch), created: false, message: `no Tomrade worktree for ${link.branch} on this machine — push it from where you work` };
    if (!(await new GitFolder(this.git, cwd).remoteUrl())) return { pushed: false, url: null, created: false, message: `${repo.name} has no remote — merge ${link.branch} into ${repo.defaultBranch} in your checkout instead` };

    const pushed = await this.git(["push", "-q", "-u", "origin", `HEAD:refs/heads/${link.branch}`], { cwd, ok: true });
    if (pushed.code !== 0) return { pushed: false, url: null, created: false, message: `git push failed — check your credentials for ${repo.remote}` };

    // An empty repository has no default branch to open a pull request against:
    // the bootstrap's branch becomes it. Creating a branch from nothing is not
    // rewriting one, and it is what the bootstrap ticket exists to do.
    const remoteDefault = await this.git(["ls-remote", "--exit-code", "--heads", "origin", repo.defaultBranch], { cwd, ok: true });
    if (remoteDefault.code === 2) {
      const created = await this.git(["push", "-q", "origin", `HEAD:refs/heads/${repo.defaultBranch}`], { cwd, ok: true });
      if (created.code === 0) {
        this.store.patchLink(projectId, link.id, { lastSeenAt: Date.now() });
        void bestEffort(this.scan(projectId), this.ctx.logger, `code scan of ${projectId} after the push`);
        return { pushed: true, url: null, created: false, message: `${repo.name} had no ${repo.defaultBranch} yet — ${link.branch} became it, so this ticket counts as merged` };
      }
    }

    let url: string | null = null;
    let created = false;
    if (await commandOk("gh")) {
      const env = await this.ctx.github.environment(this.git, cwd);
      try {
        const out = await exec("gh", ["pr", "create", "--head", link.branch, "--base", repo.defaultBranch, "--title", `${item.key}: ${item.title}`, "--body", `${item.body ?? ""}\n\nRefs ${item.key}`.trim()], cwd, env);
        url = out.trim().split("\n").pop() ?? null;
        created = !!url;
      } catch {
        // Already open, most likely: find it rather than fail.
        try {
          url = (await exec("gh", ["pr", "view", link.branch, "--json", "url", "-q", ".url"], cwd, env)).trim() || null;
        } catch {
          url = null;
        }
      }
    }
    if (url) {
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]) || null;
      this.store.patchLink(projectId, link.id, { prUrl: url, prNumber: number, prState: "open", lastSeenAt: Date.now() });
      this.reevaluate(projectId, itemId, repo.id);
      return { pushed: true, url, created, message: created ? `opened ${url}` : `pull request already open: ${url}` };
    }
    const compare = compareUrl(repo.remote, repo.defaultBranch, link.branch);
    this.notify(projectId);
    return { pushed: true, url: compare, created: false, message: compare ? "branch pushed — open the pull request from the compare page" : "branch pushed — open the pull request on your forge" };
  }
}
