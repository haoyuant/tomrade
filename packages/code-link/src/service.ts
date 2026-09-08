import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomrade/agent";
import type { ThreadSummary } from "@tomrade/agent";
import type {} from "@tomrade/boards";
import type {} from "@tomrade/contributions";
import type { Badge, SectionRow } from "@tomrade/contributions";
import type {} from "@tomrade/db";
import type {} from "@tomrade/hub";
import type {} from "@tomrade/ipc";
import type {} from "@tomrade/items";
import type {} from "@tomrade/mcp";
import type {} from "@tomrade/repos";
import type {} from "@tomrade/settings";
import type { Author, Item, Repo } from "@tomrade/domain";
import { gitRunner, type Git } from "@tomrade/storage";
import { PLAYBOOKS } from "./playbooks.js";
import { decide, type Decision, type Evidence } from "./rules.js";
import { scanRepo, type ScanResult } from "./scanner.js";
import { Sessions } from "./sessions.js";
import { Starter, type StartMode, type StartResult } from "./start.js";
import { CodeLinkStore, MIGRATIONS, TABLES, type CodeLinkView, type ProposalView, type RepoStatePatch, type RepoStateView, type SessionView } from "./store.js";
import { TerminalSettings, commandOk, exec, launchTerminal } from "./terminal.js";
import { registerTools } from "./tools.js";

/** Who the scanner writes as. Evidence from git is not a person's decision, and it is not a model's either. */
export const AUTHOR: Author = "ai:code-link";

declare module "cordis" {
  interface Context {
    codeLink: CodeLink;
  }
}

/** A branch that names a ticket the project does not have, or a ticket in another project. */
export interface UnlinkedBranch {
  repoId: string;
  repoName: string;
  branch: string;
  keyNum: number | null;
  sha: string;
  committedAt: number;
}

export interface ScanSummary {
  repos: number;
  scanned: number;
  offline: number;
  links: number;
  /** Tickets whose status the evidence moved. */
  changed: number;
  /** Proposals and flags raised. */
  proposals: number;
  skipped: { repoId: string; reason: string }[];
}

export interface OpenPrResult {
  pushed: boolean;
  /** The pull request's URL when one was created or found; otherwise a compare page to open one by hand, or null. */
  url: string | null;
  created: boolean;
  message: string;
}

export type RepoPolicyPatch = Pick<RepoStatePatch, "branchTemplate" | "autoDone" | "agentPush" | "readiness">;

declare module "@tomrade/ipc" {
  interface Channels {
    "codeLink.links": (projectId: string, itemId?: string) => CodeLinkView[];
    "codeLink.rescan": (projectId: string) => ScanSummary;
    "codeLink.proposals": (projectId: string, itemId?: string) => ProposalView[];
    "codeLink.resolve": (projectId: string, proposalId: string, accept: boolean) => ProposalView;
    "codeLink.unlinked": (projectId: string) => UnlinkedBranch[];
    "codeLink.linkBranch": (projectId: string, itemId: string, repoId: string, branch: string) => CodeLinkView;
    "codeLink.repos": (projectId: string) => RepoStateView[];
    "codeLink.setRepoPolicy": (projectId: string, repoId: string, patch: RepoPolicyPatch) => RepoStateView;
    /** Start or continue work on a ticket with a local coding agent, headless or in a terminal. */
    "codeLink.start": (projectId: string, itemId: string, opts: { mode: StartMode; engine?: string }) => StartResult;
    "codeLink.sessions": (projectId: string, itemId?: string) => SessionView[];
    /** Push the ticket's branch from its worktree and open a pull request (gh), or hand back the compare page. */
    "codeLink.openPr": (projectId: string, itemId: string) => OpenPrResult;
    /** Where this machine's worktree for the ticket is, if it has one. */
    "codeLink.worktree": (projectId: string, itemId: string) => string | null;
  }
  interface Broadcasts {
    "codeLink.changed": (projectId: string) => void;
  }
}

export const CodeLinkConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    gitBinary: z.string().default("git"),
    /** Rescan cadence for open projects; 0 turns the timer off (tests, or a machine that only rescans by hand). */
    scanMs: z.number().int().min(0).default(120_000),
    /** Fetch from the remote before reading. Off, only what this machine already has is read. */
    fetch: z.boolean().default(true)
  })
);
export type CodeLinkConfig = z.infer<typeof CodeLinkConfig>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Relative time for a status line or a section row. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The link the ticket is judged and shown by: an open pull request first, else the branch that moved last. */
export function primaryOf(links: CodeLinkView[]): CodeLinkView | null {
  if (!links.length) return null;
  return [...links].sort((a, b) => {
    const open = Number(b.prState === "open") - Number(a.prState === "open");
    if (open) return open;
    const pr = Number(b.prNumber !== null) - Number(a.prNumber !== null);
    if (pr) return pr;
    const branch = Number(!!b.branch) - Number(!!a.branch);
    if (branch) return branch;
    return (b.headAt ?? 0) - (a.headAt ?? 0);
  })[0]!;
}

const signature = (kind: string, to: string | null, reason: string): string => `${kind}|${to ?? ""}|${reason}`;

/** A GitHub remote's compare page for a branch, or null for another host. */
export function compareUrl(remote: string, defaultBranch: string, branch: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branch)}?expand=1` : null;
}

const SETTINGS_SECTION = {
  id: "codeLink",
  title: "Code link",
  description: "Which terminal opens a ticket, and how Claude Code or Codex is invoked in it. {prompt}, {mcpConfig}, {mcpUrl}, {settings}, {resume} and {cwd} are filled in.",
  schema: TerminalSettings,
  defaults: TerminalSettings.parse({}),
  order: 30
};

/**
 * Ticket ↔ code. Git is the truth about progress: a read-only scan of each
 * repository the project's workstreams stand for finds the branches and
 * default-branch commits that name a ticket, records them as links, and moves
 * the ticket forward — or, where the ticket says more than the code, raises a
 * proposal for a person. Start hands a ticket to a local coding agent in a
 * worktree of its own; sessions follow that agent whether Tomrade drives it or
 * the user does in a terminal. Nothing here rewrites a branch or touches the
 * user's checkout.
 */
export class CodeLink extends Service {
  static provide = "codeLink";
  static inject = ["db", "items", "boards", "repos", "hub", "settings"];
  static Config = CodeLinkConfig;

  store!: CodeLinkStore;
  sessions!: Sessions;

  private readonly home: Context;
  private readonly git: Git;
  private starter!: Starter;
  private readonly unlinkedByProject = new Map<string, UnlinkedBranch[]>();
  private readonly scannedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<ScanSummary>>();
  /** Machine-local: each thread's worktree, for the section and the terminal. */
  private readonly worktrees = new Map<string, string>();

  constructor(
    ctx: Context,
    public readonly config: CodeLinkConfig
  ) {
    super(ctx, "codeLink");
    this.home = ctx;
    this.git = gitRunner(config.gitBinary);
  }

  [Service.init]() {
    this.ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    this.store = new CodeLinkStore(this.ctx.db);
    this.sessions = new Sessions(this.ctx, this.store, (projectId) => this.notify(projectId));
    this.starter = new Starter({
      ctx: this.ctx,
      store: this.store,
      sessions: this.sessions,
      scan: (projectId) => this.scan(projectId),
      notify: (projectId) => this.notify(projectId),
      sessionDir: (id) => this.sessionDir(id),
      worktrees: this.worktrees
    });
    this.ctx.settings.register(SETTINGS_SECTION);
    // A headless session cannot have survived a restart; say so, and let the ticket offer Continue.
    for (const projectId of this.ctx.db.openIds()) this.sessions.reconcile(projectId);
    this.ctx.on("db/opened", (projectId) => this.sessions.reconcile(projectId));

    this.home.inject(["tools"], (ctx) =>
      registerTools(ctx, {
        store: this.store,
        reevaluate: (projectId, itemId, repoId) => this.reevaluate(projectId, itemId, repoId),
        noteProgress: (projectId, sessionId, text) => this.sessions.touch(projectId, sessionId, { summary: text, state: "running" }),
        notify: (projectId) => this.notify(projectId)
      })
    );
    this.home.inject(["agent"], (ctx) => {
      for (const playbook of PLAYBOOKS) ctx.agent.playbook(playbook);
      ctx.on("agent/run-started", (_run, thread) => {
        const session = this.sessionOf(thread);
        if (session) this.sessions.touch(thread.projectId, session.id, { state: "running" });
      });
      ctx.on("agent/run-ended", (run, thread) => {
        const session = this.sessionOf(thread);
        if (!session) return;
        const externalId = ctx.agent.store.external(thread.projectId, thread.id)[run.engine];
        this.sessions.touch(thread.projectId, session.id, {
          state: run.stop === "asked" ? "waiting" : "idle",
          ...(externalId ? { externalId } : {}),
          ...(run.error ? { summary: `stopped: ${run.error.slice(0, 200)}` } : {})
        });
      });
    });
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("codeLink.links", (projectId, itemId) => ctx.codeLink.links(projectId, itemId));
      ctx.ipc.handle("codeLink.rescan", (projectId) => ctx.codeLink.scan(projectId));
      ctx.ipc.handle("codeLink.proposals", (projectId, itemId) => ctx.codeLink.proposals(projectId, itemId));
      ctx.ipc.handle("codeLink.resolve", (projectId, proposalId, accept) => ctx.codeLink.resolve(projectId, proposalId, accept));
      ctx.ipc.handle("codeLink.unlinked", (projectId) => ctx.codeLink.unlinked(projectId));
      ctx.ipc.handle("codeLink.linkBranch", (projectId, itemId, repoId, branch) => ctx.codeLink.linkBranch(projectId, itemId, repoId, branch));
      ctx.ipc.handle("codeLink.repos", (projectId) => ctx.codeLink.repoStates(projectId));
      ctx.ipc.handle("codeLink.setRepoPolicy", (projectId, repoId, patch) => ctx.codeLink.setRepoPolicy(projectId, repoId, patch));
      ctx.ipc.handle("codeLink.start", (projectId, itemId, opts) => ctx.codeLink.start(projectId, itemId, opts));
      ctx.ipc.handle("codeLink.sessions", (projectId, itemId) => ctx.codeLink.sessionsOf(projectId, itemId));
      ctx.ipc.handle("codeLink.openPr", (projectId, itemId) => ctx.codeLink.openPr(projectId, itemId));
      ctx.ipc.handle("codeLink.worktree", (projectId, itemId) => ctx.codeLink.worktreeOf(projectId, itemId));
    });
    this.home.inject(["contributions"], (ctx) => this.contribute(ctx));

    const timer =
      this.config.scanMs > 0
        ? setInterval(() => {
            for (const projectId of this.ctx.db.openIds()) this.sessions.sweep(projectId);
            void this.scanOpen();
          }, this.config.scanMs)
        : null;
    timer?.unref?.();
    return () => {
      if (timer) clearInterval(timer);
    };
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  links(projectId: string, itemId?: string): CodeLinkView[] {
    return this.store.links(projectId, itemId);
  }

  proposals(projectId: string, itemId?: string): ProposalView[] {
    return this.store.proposals(projectId, itemId, "open");
  }

  unlinked(projectId: string): UnlinkedBranch[] {
    return this.unlinkedByProject.get(projectId) ?? [];
  }

  repoStates(projectId: string): RepoStateView[] {
    return this.store.repoStates(projectId);
  }

  repoState(projectId: string, repoId: string): RepoStateView | null {
    return this.store.repoState(projectId, repoId);
  }

  sessionsOf(projectId: string, itemId?: string): SessionView[] {
    return this.store.sessions(projectId, itemId ? { itemId } : {});
  }

  lastScanAt(projectId: string): number | null {
    return this.scannedAt.get(projectId) ?? null;
  }

  /** This machine's worktree for the ticket's most recent thread, if one was started here. */
  worktreeOf(projectId: string, itemId: string): string | null {
    for (const link of this.store.links(projectId, itemId)) {
      const dir = link.threadId ? this.worktrees.get(link.threadId) : undefined;
      if (dir && fs.existsSync(dir)) return dir;
    }
    return null;
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** A person answering a proposal: accepting writes the status as a human write; either way the row is settled. */
  resolve(projectId: string, proposalId: string, accept: boolean): ProposalView {
    const proposal = this.store.proposal(projectId, proposalId);
    if (!proposal) throw new Error(`unknown proposal ${proposalId}`);
    if (proposal.state !== "open") return proposal;
    if (accept && proposal.toStatus) this.ctx.items.update(projectId, proposal.itemId, { status: proposal.toStatus }, "human");
    const settled = this.store.setProposalState(projectId, proposalId, accept ? "accepted" : "rejected");
    this.notify(projectId);
    return settled;
  }

  /** Hang a branch on a ticket by hand — for a branch named outside the template. The next scan fills in the rest. */
  linkBranch(projectId: string, itemId: string, repoId: string, branch: string): CodeLinkView {
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    const repo = this.ctx.repos.get(projectId, repoId);
    if (!repo) throw new Error(`unknown repository ${repoId}`);
    const name = branch.trim().replace(/^origin\//, "");
    if (!name) throw new Error("a branch name is required");
    const link = this.store.upsertLink(projectId, { itemId, repoId, branch: name }, { source: "manual", lastSeenAt: Date.now() });
    this.notify(projectId);
    void this.scan(projectId).catch((err) => this.ctx.logger.warn(`rescan after linking ${name} failed: ${message(err)}`));
    return link;
  }

  setRepoPolicy(projectId: string, repoId: string, patch: RepoPolicyPatch): RepoStateView {
    if (!this.ctx.repos.get(projectId, repoId)) throw new Error(`unknown repository ${repoId}`);
    const state = this.store.upsertRepoState(projectId, repoId, patch);
    this.notify(projectId);
    return state;
  }

  /** Start or continue a ticket with a local coding agent. See `Starter` for the gates. */
  start(projectId: string, itemId: string, opts: { mode: StartMode; engine?: string }): Promise<StartResult> {
    return this.starter.start(projectId, itemId, opts);
  }

  /** Push the ticket's branch from its Tomrade worktree and open a pull request. Never from the user's own checkout, never the default branch. */
  async openPr(projectId: string, itemId: string): Promise<OpenPrResult> {
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    const links = this.store.links(projectId, itemId).filter((l) => l.branch);
    const link = primaryOf(links);
    if (!link) return { pushed: false, url: null, created: false, message: `${item.key} has no branch yet` };
    const repo = this.ctx.repos.get(projectId, link.repoId);
    if (!repo) return { pushed: false, url: null, created: false, message: "the repository row is gone" };
    const state = this.store.repoState(projectId, repo.id);
    if (state && !state.agentPush) return { pushed: false, url: compareUrl(repo.remote, repo.defaultBranch, link.branch), created: false, message: `pushing from Tomrade is off for ${repo.name} — push ${link.branch} yourself` };
    if (link.branch === repo.defaultBranch) return { pushed: false, url: null, created: false, message: "never the default branch" };
    const cwd = this.worktreeOf(projectId, itemId);
    if (!cwd) return { pushed: false, url: compareUrl(repo.remote, repo.defaultBranch, link.branch), created: false, message: `no Tomrade worktree for ${link.branch} on this machine — push it from where you work` };

    const pushed = await this.git(["push", "-q", "-u", "origin", `HEAD:refs/heads/${link.branch}`], { cwd, ok: true });
    if (pushed.code !== 0) return { pushed: false, url: null, created: false, message: `git push failed — check your credentials for ${repo.remote}` };

    let url: string | null = null;
    let created = false;
    if (await commandOk("gh")) {
      try {
        const out = await exec("gh", ["pr", "create", "--head", link.branch, "--base", repo.defaultBranch, "--title", `${item.key}: ${item.title}`, "--body", `${item.body ?? ""}\n\nRefs ${item.key}`.trim()], cwd);
        url = out.trim().split("\n").pop() ?? null;
        created = !!url;
      } catch {
        // Already open, most likely: find it rather than fail.
        try {
          url = (await exec("gh", ["pr", "view", link.branch, "--json", "url", "-q", ".url"], cwd)).trim() || null;
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

  // ── the scan ───────────────────────────────────────────────────────────────

  /** One scan per project at a time; a second caller gets the running one. */
  scan(projectId: string): Promise<ScanSummary> {
    const running = this.inFlight.get(projectId);
    if (running) return running;
    const job = this.doScan(projectId).finally(() => this.inFlight.delete(projectId));
    this.inFlight.set(projectId, job);
    return job;
  }

  async scanOpen(): Promise<void> {
    for (const projectId of this.ctx.db.openIds()) {
      try {
        await this.scan(projectId);
      } catch (err) {
        this.ctx.logger.warn(`code scan of ${projectId} failed: ${message(err)}`);
      }
    }
  }

  private async doScan(projectId: string): Promise<ScanSummary> {
    const summary: ScanSummary = { repos: 0, scanned: 0, offline: 0, links: 0, changed: 0, proposals: 0, skipped: [] };
    const prefix = this.prefixOf(projectId);
    const repos = this.ctx.repos.list(projectId);
    summary.repos = repos.length;
    const unlinked: UnlinkedBranch[] = [];
    const now = Date.now();
    for (const repo of repos) {
      const placement = this.ctx.repos.checkout(repo.remote);
      if (!placement.checkout || !fs.existsSync(placement.checkout)) {
        summary.skipped.push({ repoId: repo.id, reason: "no checkout on this machine" });
        if (!this.store.repoState(projectId, repo.id)) this.store.upsertRepoState(projectId, repo.id, {});
        continue;
      }
      const before = this.store.repoState(projectId, repo.id);
      const track = this.store
        .linksForRepo(projectId, repo.id)
        .filter((l) => l.source === "manual" && l.branch)
        .map((l) => l.branch);
      let result: ScanResult;
      try {
        result = await scanRepo(this.git, placement.checkout, { defaultBranch: repo.defaultBranch, prefix, sinceSha: before?.scannedSha ?? null, fetch: this.config.fetch, track });
      } catch (err) {
        summary.skipped.push({ repoId: repo.id, reason: message(err) });
        continue;
      }
      summary.scanned += 1;
      if (result.offline) summary.offline += 1;
      this.store.upsertRepoState(projectId, repo.id, {
        readiness: result.readiness,
        hasBrief: result.hasBrief,
        manifests: result.manifests,
        summary: result.summary,
        scannedSha: result.defaultSha,
        defaultSha: result.defaultSha,
        scannedAt: now
      });
      const outcome = this.absorb(projectId, repo, result, before?.autoDone ?? true, now, unlinked);
      summary.links += outcome.links;
      summary.changed += outcome.changed;
      summary.proposals += outcome.proposals;
    }
    this.unlinkedByProject.set(projectId, unlinked);
    this.scannedAt.set(projectId, now);
    this.notify(projectId);
    return summary;
  }

  /** Turn one repository's scan into links, then judge every ticket the repository touches. */
  private absorb(projectId: string, repo: Repo, result: ScanResult, autoDone: boolean, now: number, unlinked: UnlinkedBranch[]): { links: number; changed: number; proposals: number } {
    const items = this.ctx.items.list({ projectId });
    const byNum = new Map(items.map((i) => [i.keyNum, i]));
    const previous = new Map(this.store.linksForRepo(projectId, repo.id).map((l) => [l.id, l]));
    const seen = new Set<string>();
    const touched = new Set<string>(previous.size ? [...previous.values()].map((l) => l.itemId) : []);
    let links = 0;

    for (const b of result.branches) {
      if (b.keyNum === null) continue;
      const item = byNum.get(b.keyNum);
      if (!item) {
        unlinked.push({ repoId: repo.id, repoName: repo.name, branch: b.name, keyNum: b.keyNum, sha: b.sha, committedAt: b.committedAt });
        continue;
      }
      const link = this.store.upsertLink(
        projectId,
        { itemId: item.id, repoId: repo.id, branch: b.name },
        { headSha: b.sha, headAt: b.committedAt, ahead: b.ahead, behind: b.behind, mergedSha: b.merged ? result.defaultSha : undefined, lastSeenAt: now }
      );
      seen.add(link.id);
      touched.add(item.id);
      links += 1;
      // A branch with commits is a session's heartbeat too.
      for (const s of this.store.sessions(projectId, { itemId: item.id, live: true })) if (s.branch === b.name && (s.lastCommitAt ?? 0) < b.committedAt) this.store.patchSession(projectId, s.id, { lastCommitAt: b.committedAt });
    }

    // A branch linked by hand under a name the template does not know is still one of ours.
    for (const l of previous.values()) {
      if (l.source !== "manual" || seen.has(l.id) || !l.branch) continue;
      const b = result.branches.find((x) => x.name === l.branch);
      if (!b) continue;
      this.store.patchLink(projectId, l.id, { headSha: b.sha, headAt: b.committedAt, ahead: b.ahead, behind: b.behind, mergedSha: b.merged ? result.defaultSha : undefined, lastSeenAt: now });
      seen.add(l.id);
    }

    for (const [keyNum, commit] of result.mergedKeys) {
      const item = byNum.get(keyNum);
      if (!item) continue;
      const own = this.store.links(projectId, item.id).filter((l) => l.repoId === repo.id);
      if (own.length) {
        for (const l of own) if (!l.mergedSha) this.store.patchLink(projectId, l.id, { mergedSha: commit.sha });
      } else {
        this.store.upsertLink(projectId, { itemId: item.id, repoId: repo.id, branch: "" }, { headSha: commit.sha, headAt: commit.at, mergedSha: commit.sha, lastSeenAt: now, source: "scan" });
      }
      touched.add(item.id);
    }

    let changed = 0;
    let proposals = 0;
    for (const itemId of touched) {
      const item = this.ctx.items.get(projectId, itemId);
      if (!item) continue;
      const r = this.judge(projectId, item, repo.id, previous, seen, autoDone);
      changed += r.changed;
      proposals += r.proposals;
    }
    return { links, changed, proposals };
  }

  /** Re-judge one ticket in one repository after a link changed by tool or by hand, taking every branch as present. */
  reevaluate(projectId: string, itemId: string, repoId: string): void {
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) return;
    const links = this.store.links(projectId, itemId).filter((l) => l.repoId === repoId);
    const seen = new Set(links.filter((l) => l.branch).map((l) => l.id));
    this.judge(projectId, item, repoId, new Map(links.map((l) => [l.id, l])), seen, this.store.repoState(projectId, repoId)?.autoDone ?? true);
    this.notify(projectId);
  }

  /** Apply the sync matrix to one ticket in one repository. */
  private judge(projectId: string, item: Item, repoId: string, previous: Map<string, CodeLinkView>, seen: Set<string>, autoDone: boolean): { changed: number; proposals: number } {
    const links = this.store.links(projectId, item.id).filter((l) => l.repoId === repoId);
    if (!links.length) return { changed: 0, proposals: 0 };
    const present = links.filter((l) => l.branch && seen.has(l.id));
    const primary = primaryOf(links);
    const evidence: Evidence = {
      branch: present.length > 0,
      ahead: present.reduce((max, l) => Math.max(max, l.ahead), 0),
      merged: links.some((l) => !!l.mergedSha),
      pr: primary?.prState ?? null,
      movedAfterDone:
        item.status === "done" &&
        present.some((l) => {
          const was = previous.get(l.id);
          return !!was?.headSha && was.headSha !== l.headSha && !l.mergedSha;
        })
    };
    const evidenceSha = primary?.mergedSha ?? primary?.headSha ?? null;
    let changed = 0;
    let proposals = 0;
    const standing = new Set<string>();
    for (let d of decide(item.status, evidence, { autoDone, humanLocked: item.humanLocked })) {
      if (d.kind === "auto") {
        try {
          this.ctx.items.update(projectId, item.id, { status: d.to }, AUTHOR);
          changed += 1;
          continue;
        } catch (err) {
          // A refused write (a policy, a stale version) is a question for a person, not a retry.
          d = { kind: "propose", to: d.to, reason: `${d.reason} — ${message(err)}` } satisfies Decision;
        }
      }
      const to = d.kind === "propose" ? d.to : null;
      standing.add(signature(d.kind, to, d.reason));
      if (this.store.hasRecentProposal(projectId, item.id, d.kind, to, d.reason, evidenceSha)) continue;
      this.store.addProposal(projectId, { itemId: item.id, linkId: primary?.id ?? null, kind: d.kind, fromStatus: item.status, toStatus: to, reason: d.reason, evidenceSha });
      proposals += 1;
    }
    // A proposal the evidence no longer supports is withdrawn, not left for someone to reject.
    for (const p of this.store.proposals(projectId, item.id, "open")) if (!standing.has(signature(p.kind, p.toStatus, p.reason))) this.store.setProposalState(projectId, p.id, "stale");
    return { changed, proposals };
  }

  // ── contributions ──────────────────────────────────────────────────────────

  private contribute(ctx: Context): void {
    ctx.contributions.section({
      id: "code",
      title: "Code",
      render: (item) => {
        const links = this.store.links(item.projectId, item.id);
        const open = this.store.proposals(item.projectId, item.id, "open");
        const sessions = this.store.sessions(item.projectId, { itemId: item.id });
        if (!links.length && !open.length && !sessions.length) return null;
        const primary = primaryOf(links);
        const ordered = primary ? [primary, ...links.filter((l) => l.id !== primary.id)] : links;
        const rows: SectionRow[] = [];
        for (const l of ordered) {
          const repo = this.ctx.repos.get(item.projectId, l.repoId);
          const name = repo?.name ?? "repository";
          if (l.branch) rows.push({ label: "Branch", value: `${l.branch} · ${name}${l.ahead || l.behind ? ` · +${l.ahead} −${l.behind}` : ""}` });
          if (l.prNumber !== null || l.prUrl) rows.push({ label: "Pull request", value: `${l.prNumber !== null ? `#${l.prNumber}` : "open it"}${l.prState ? ` · ${l.prState}` : ""}`, href: l.prUrl ?? undefined });
          else if (l.branch && !l.mergedSha && l.ahead > 0 && this.worktreeOf(item.projectId, item.id)) rows.push({ label: "Pull request", value: "Open pull request", command: "code-link.open-pr" });
          if (l.mergedSha) rows.push({ label: "Merged", value: `${l.mergedSha.slice(0, 7)} on ${repo?.defaultBranch ?? "main"}` });
          if (l.headAt) rows.push({ label: "Last commit", value: ago(l.headAt) });
        }
        const live = sessions.find((s) => s.state !== "ended") ?? sessions[0];
        if (live) {
          const where = live.mode === "terminal" ? "in a terminal" : "run by Tomrade";
          const when = live.lastEventAt ? ago(live.lastEventAt) : ago(live.startedAt);
          rows.push({ label: "Session", value: `${live.state}${live.state === "waiting" ? " for you" : ""} · ${where} · ${when}${live.summary ? ` · ${live.summary}` : ""}` });
          if (live.state !== "running") rows.push({ label: "Continue", value: live.mode === "terminal" ? "Continue in terminal" : "Continue here", command: live.mode === "terminal" ? "code-link.start-terminal" : "code-link.start-run" });
        }
        const worktree = this.worktreeOf(item.projectId, item.id);
        if (worktree) rows.push({ label: "Worktree", value: worktree, command: "code-link.open-terminal" });
        const text = open.map((p) => (p.kind === "flag" ? `⚠ ${p.reason}` : `→ ${p.toStatus}: ${p.reason}`)).join("\n");
        return { rows, text: text || undefined };
      }
    });

    ctx.contributions.badge({
      id: "code-link",
      compute: (items, { projectId }) => {
        const byItem = new Map<string, CodeLinkView[]>();
        for (const l of this.store.links(projectId)) (byItem.get(l.itemId) ?? byItem.set(l.itemId, []).get(l.itemId)!).push(l);
        const flags = new Map<string, ProposalView>();
        for (const p of this.store.proposals(projectId)) if (p.kind === "flag" && !flags.has(p.itemId)) flags.set(p.itemId, p);
        const waiting = new Set<string>();
        for (const s of this.store.sessions(projectId, { live: true })) if (s.state === "waiting") for (const id of s.itemIds) waiting.add(id);
        const out: Record<string, Badge[]> = {};
        for (const item of items) {
          const links = byItem.get(item.id) ?? [];
          const flag = flags.get(item.id);
          if (!links.length && !flag && !waiting.has(item.id)) continue;
          const badges: Badge[] = [];
          if (waiting.has(item.id)) badges.push({ id: "waiting", label: "waiting", tone: "strong", title: "The coding session is waiting for you" });
          if (flag) badges.push({ id: "mismatch", label: "mismatch", tone: "strong", title: flag.reason });
          const primary = primaryOf(links);
          if (primary?.prState === "open") badges.push({ id: "pr", label: primary.prNumber !== null ? `PR #${primary.prNumber}` : "PR", tone: "strong", title: primary.prUrl ?? undefined });
          else if (links.some((l) => l.mergedSha)) badges.push({ id: "merged", label: "merged", tone: "faint" });
          else if (primary?.branch) badges.push({ id: "branch", label: "branch", tone: "neutral", title: primary.branch });
          if (badges.length) out[item.id] = badges;
        }
        return out;
      }
    });

    ctx.contributions.statusItem({
      id: "code-link",
      text: ({ projectId }) => {
        if (!projectId) return null;
        const at = this.scannedAt.get(projectId);
        const parts: string[] = [];
        const live = this.store.sessions(projectId, { live: true }).filter((s) => s.state !== "lost");
        const waiting = live.filter((s) => s.state === "waiting").length;
        if (live.length) parts.push(`${live.length} session${live.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} waiting for you` : ""}`);
        const unlinked = this.unlinked(projectId).length;
        const open = this.store.proposals(projectId).length;
        if (unlinked) parts.push(`${unlinked} unlinked`);
        if (open) parts.push(`${open} to confirm`);
        if (!parts.length && !at) return null;
        return `code: ${parts.join(" · ") || "in sync"}${at ? ` · scanned ${ago(at)}` : ""}`;
      }
    });

    const startCommand = (mode: StartMode) => async (scope: { projectId?: string; itemId?: string | null }) => {
      if (!scope.projectId || !scope.itemId) return { toast: "Select a ticket first" };
      const result = await this.start(scope.projectId, scope.itemId, { mode });
      if (!result.ok) return { toast: result.message };
      if (result.mode === "terminal") return { toast: result.launched ? `${result.continued ? "Continuing" : "Started"} in ${result.branch} — your terminal has it` : `Run this in a terminal:\n${result.command}` };
      return { toast: `${result.continued ? "Continuing" : "Started"} on ${result.branch}` };
    };
    ctx.contributions.command({ id: "code-link.start-run", title: "Start ticket here", group: "Code", run: startCommand("run") });
    ctx.contributions.command({ id: "code-link.start-terminal", title: "Open ticket in terminal", group: "Code", run: startCommand("terminal") });
    ctx.contributions.command({
      id: "code-link.open-pr",
      title: "Open pull request",
      group: "Code",
      run: async ({ projectId, itemId }) => {
        if (!projectId || !itemId) return { toast: "Select a ticket first" };
        const r = await this.openPr(projectId, itemId);
        return { toast: r.message };
      }
    });
    ctx.contributions.command({
      id: "code-link.open-terminal",
      title: "Open worktree in terminal",
      group: "Code",
      run: async ({ projectId, itemId }) => {
        if (!projectId || !itemId) return { toast: "Select a ticket first" };
        const cwd = this.worktreeOf(projectId, itemId);
        if (!cwd) return { toast: "No worktree for this ticket on this machine — start it first" };
        const settings = TerminalSettings.parse(this.ctx.settings.get().codeLink ?? {});
        const launch = await launchTerminal({ cwd, command: 'exec "${SHELL:-bash}"', dir: path.join(this.sessionDir("shell"), path.basename(cwd)) }, settings.terminal);
        return { toast: launch.launched ? `Opened ${cwd}` : `cd ${cwd}` };
      }
    });
    ctx.contributions.command({
      id: "code-link.rescan",
      title: "Rescan repositories",
      group: "Code",
      run: async ({ projectId }) => {
        if (!projectId) return { toast: "Open a project first" };
        const s = await this.scan(projectId);
        const skipped = s.skipped.length ? ` · ${s.skipped.length} skipped` : "";
        return { toast: `Scanned ${s.scanned}/${s.repos} repositories · ${s.changed} moved · ${s.proposals} to confirm${skipped}` };
      }
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private sessionOf(thread: ThreadSummary): SessionView | null {
    return this.store.sessions(thread.projectId, { live: true }).find((s) => s.threadId === thread.id) ?? null;
  }

  /** Per-session files (mcp.json, hooks settings, the prompt, the launch script) live in the Hub where the user can see them. */
  sessionDir(sessionId: string): string {
    return path.join(this.ctx.hub.dir ?? path.join(os.tmpdir(), "tomrade"), "sessions", sessionId);
  }

  private prefixOf(projectId: string): string {
    const row = this.ctx.db.for(projectId).prepare("SELECT key_prefix FROM projects WHERE id = ?").get(projectId) as { key_prefix: string } | undefined;
    return row?.key_prefix ?? "TOM";
  }

  private notify(projectId: string): void {
    this.home.get("ipc")?.send("codeLink.changed", projectId);
  }
}

export default CodeLink;
