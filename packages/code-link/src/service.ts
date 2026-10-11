import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import type { ThreadSummary } from "@tomradex/agent";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/contributions";
import type { Badge, SectionRow } from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/repos";
import { normalizeRemote } from "@tomradex/repos";
import type {} from "@tomradex/settings";
import type {} from "@tomradex/write";
import type { Author, Item, Repo } from "@tomradex/domain";
import { GitFolder, gitRunner, type Git } from "@tomradex/storage";
import { writeConnectFiles } from "./connect.js";
import { githubEnvironment, githubHttps, installGithubCredential, migrateGithubCredential, usesTomradeCredential } from "./credentials.js";
import { PLAYBOOKS } from "./playbooks.js";
import { decide, type Decision, type Evidence } from "./rules.js";
import { scanRepo, type ScanResult, type ScannedBranch } from "./scanner.js";
import { classifyRemoteFailure, probeRemote, readRemoteIdentity, type RemoteIdentity } from "./remote.js";
import { Sessions, sessionContext, type SessionMoment } from "./sessions.js";
import { Starter, type StartMode, type StartOptions, type StartResult } from "./start.js";
import { CodeLinkStore, MIGRATIONS, TABLES, type CodeLinkView, type DeliveryView, type ProposalView, type RepoStatePatch, type RepoStateView, type SessionView } from "./store.js";
import { TerminalSettings, commandOk, exec, launchTerminal } from "./terminal.js";
import { registerTools } from "./tools.js";

/** Who the scanner writes as. Evidence from git is not a person's decision, and it is not a model's either. */
export const AUTHOR: Author = "sync:git";

const hasLiveSession = (sessions: SessionView[]): boolean =>
  sessions.some((s) => s.mode === "terminal" || s.state === "running" || s.state === "waiting" || s.state === "error");

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

export interface ConnectResult {
  branch: string;
  /** Files written or changed, relative to the repository root. */
  files: string[];
  committed: boolean;
  pushed: boolean;
  /** The pull request, or the compare page to open one from; null when nothing could be pushed. */
  url: string | null;
  message: string;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "codeLink.links": (projectId: string, itemId?: string) => CodeLinkView[];
    "codeLink.deliveries": (projectId: string, itemId?: string) => DeliveryView[];
    "codeLink.rescan": (projectId: string) => ScanSummary;
    "codeLink.proposals": (projectId: string, itemId?: string) => ProposalView[];
    "codeLink.resolve": (projectId: string, proposalId: string, accept: boolean) => ProposalView;
    "codeLink.unlinked": (projectId: string) => UnlinkedBranch[];
    "codeLink.linkBranch": (projectId: string, itemId: string, repoId: string, branch: string) => CodeLinkView;
    "codeLink.repos": (projectId: string) => RepoStateView[];
    /** The account git will use for this checkout; no secret crosses IPC. */
    "codeLink.remoteIdentity": (remote: string) => RemoteIdentity;
    "codeLink.githubCredentialAccount": (projectId: string, repoId: string) => string | null;
    "codeLink.useGithubCredential": (projectId: string, repoId: string) => RepoStateView;
    "codeLink.setRepoPolicy": (projectId: string, repoId: string, patch: RepoPolicyPatch) => RepoStateView;
    /** Start or continue work on a ticket with a local coding agent, headless or in a terminal. */
    "codeLink.start": (projectId: string, itemId: string, opts: StartOptions) => StartResult;
    "codeLink.sessions": (projectId: string, itemId?: string) => SessionView[];
    /** Push the ticket's branch from its worktree and open a pull request (gh), or hand back the compare page. */
    "codeLink.openPr": (projectId: string, itemId: string) => OpenPrResult;
    /** Where this machine's worktree for the ticket is, if it has one. */
    "codeLink.worktree": (projectId: string, itemId: string) => string | null;
    /** A branch nobody's ticket names becomes a ticket, linked to it. */
    "codeLink.adoptBranch": (projectId: string, repoId: string, branch: string) => Item;
    /** Put Claude/Codex MCP config, agent instructions and hooks into the repository, on a branch, as a pull request. */
    "codeLink.connect": (projectId: string, repoId: string) => ConnectResult;
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
    /** How often sessions are checked against the clock and their process; 0 turns it off. */
    sweepMs: z.number().int().min(0).default(30_000),
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

/** A merge commit shows in the scan itself; a fast-forward only as the head this link last saw ahead of the default branch now sitting inside it. */
const landed = (b: ScannedBranch, was: CodeLinkView | undefined): boolean => b.merged || (b.contained && !!was && was.headSha === b.sha && was.ahead > 0);

/** A GitHub remote's compare page for a branch, or null for another host. */
export function compareUrl(remote: string, defaultBranch: string, branch: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branch)}?expand=1` : null;
}

const SETTINGS_SECTION = {
  id: "codeLink",
  title: "Code link",
  description: "Which terminal opens a ticket, and how Claude Code, Codex or Pi is invoked in it. {prompt}, {mcpConfig}, {mcpUrl}, {settings}, {piExtension}, {resume}, {options} (the model and effort chosen at Start) and {cwd} are filled in.",
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
  static inject = ["db", "items", "boards", "repos", "hub", "settings", "storage"];
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
    for (const projectId of this.ctx.db.openIds()) this.store.repairLegacyDeliveries(projectId);
    this.ctx.on("db/opened", (projectId) => this.store.repairLegacyDeliveries(projectId));
    this.ctx.on("storage/imported", (projectId) => this.store.repairLegacyDeliveries(projectId));
    this.sessions = new Sessions(this.ctx, this.store, {
      dirOf: (id) => this.sessionDir(id),
      onChange: (projectId) => this.notify(projectId),
      onMoment: (session, moment) => this.noteMoment(session, moment),
      onEnd: (session) => {
        // If SessionEnd lands during a scan, wait for that pass before asking
        // again; the first pass still saw this session as active.
        const current = this.inFlight.get(session.projectId);
        void (current ? current.catch(() => undefined) : Promise.resolve())
          .then(() => this.scan(session.projectId))
          .catch((err) => this.ctx.logger.warn(`code scan after session ${session.id} ended failed: ${message(err)}`));
      }
    });
    this.starter = new Starter({
      ctx: this.ctx,
      store: this.store,
      sessions: this.sessions,
      git: this.git,
      scan: (projectId) => this.scan(projectId),
      notify: (projectId) => this.notify(projectId),
      sessionDir: (id) => this.sessionDir(id),
      worktrees: this.worktrees
    });
    this.ctx.settings.register(SETTINGS_SECTION);
    this.ctx.on("write/pre-commit", (intent, next) => {
      if (intent.entity === "item" && intent.op === "update") {
        const before = intent.before as Item | null;
        const after = intent.after as Item | null;
        const active = this.store.activeDelivery(intent.projectId, intent.id);
        const mixed = after?.evidence.resources.some(r => r.role === "output" && r.deliveryId === active?.id) || after?.evidence.submissions.some(s => s.deliveryId === active?.id);
        if (before?.status !== "done" && after?.status === "done" && after.workType === "coding" && mixed) {
          const links = this.currentLinks(intent.projectId, intent.id);
          if (!links.length || links.some(link => !link.mergedSha && link.prState !== "merged")) throw new Error("Merge all code links before accepting this mixed delivery");
        }
      }
      return next();
    });
    this.ctx.on("agent/prepare-turn", async (input) => {
      if (input.purpose === "code" && input.ticket) {
        const item = this.ctx.items.get(input.projectId, input.ticket.id);
        if (item) input.ticket.completionPolicy = this.completionPolicy(input.projectId, item);
      }
      if (input.cwd && input.workdir && githubHttps(input.workdir.remote)) {
        input.env = { ...input.env, ...await githubEnvironment(this.git, input.cwd, this.ctx.settings.config.path) };
      }
    });
    // A headless session cannot have survived a restart; say so, and let the ticket offer Continue.
    for (const projectId of this.ctx.db.openIds()) this.sessions.reconcile(projectId);
    this.ctx.on("db/opened", (projectId) => this.sessions.reconcile(projectId));
    this.ctx.on("repos/checkout-set", (remote) => {
      for (const projectId of this.ctx.db.openIds()) {
        if (!this.ctx.repos.list(projectId).some((repo) => repo.remote === remote)) continue;
        void this.scan(projectId).catch((err) => this.ctx.logger.warn(`code scan after setting ${remote} failed: ${message(err)}`));
      }
    });
    // An earlier version wrote the helper under the Hub; repoint it before a
    // session can fall back to the wrong global account.
    this.home.inject(["repos"], () => {
      for (const projectId of this.ctx.db.openIds()) void this.migrateCredentialHelpers(projectId);
    });

    this.home.inject(["tools"], (ctx) =>
      registerTools(ctx, {
        store: this.store,
        reevaluate: (projectId, itemId, repoId) => this.reevaluate(projectId, itemId, repoId),
        noteProgress: (projectId, sessionId, text) => this.sessions.touch(projectId, sessionId, { summary: text, state: "running" }),
        attach: (projectId, sessionId, itemId, branch, delivery) => this.attach(projectId, sessionId, itemId, branch, delivery),
        externalSession: (projectId, repoId) => this.externalSession(projectId, repoId),
        notify: (projectId) => this.notify(projectId)
      })
    );
    this.home.inject(["mcp"], (ctx) => {
      // Hooks a repository commits carry no token; the cwd and session id in the payload say whose they are.
      ctx.mcp.onEvent((payload) => this.externalEvent(payload));
      // Terminals the user still has open from before a restart keep calling with their tokens; bind those again.
      for (const projectId of this.ctx.db.openIds()) this.rebindSessions(projectId);
      ctx.on("db/opened", (projectId) => this.rebindSessions(projectId));
    });
    // A ticket an agent creates mid-session belongs to that session too.
    this.ctx.on("write/committed", (intent) => {
      const bound = sessionContext.getStore();
      if (bound && intent.entity === "item" && intent.op === "create" && intent.projectId === bound.projectId) {
        const session = this.store.session(bound.projectId, bound.sessionId);
        if (session && !session.itemIds.includes(intent.id)) this.store.patchSession(bound.projectId, session.id, { itemIds: [...session.itemIds, intent.id] });
      }
      if (intent.entity !== "item" || intent.op !== "update") return;
      const before = intent.before as Item | null;
      const after = intent.after as Item | null;
      if (!before || !after || before.status === after.status) return;
      const open = new Set(["backlog", "todo", "doing", "verifying"]);
      if ((before.status === "done" || before.status === "cancelled") && open.has(after.status)) {
        this.store.ensureActiveDelivery(intent.projectId, intent.id, after.updatedAt);
        this.notify(intent.projectId);
        return;
      }
      if (open.has(before.status) && (after.status === "done" || after.status === "cancelled")) {
        const active = this.store.activeDelivery(intent.projectId, intent.id);
        if (!active) return;
        const delivered = this.store.links(intent.projectId, intent.id).some((link) => link.delivery === active.sequence && (!!link.mergedSha || link.prState === "merged"));
        // A person may claim Done before git agrees. Keep that delivery active
        // so the evidence pass can flag the mismatch instead of hiding it.
        if (after.status === "done" && !delivered) return;
        this.store.finishActiveDelivery(intent.projectId, intent.id, after.status === "done" ? "completed" : "cancelled", after.updatedAt);
        for (const proposal of this.store.proposalsForDelivery(intent.projectId, intent.id, active.sequence, "open")) this.store.setProposalState(intent.projectId, proposal.id, "stale");
        this.notify(intent.projectId);
      }
    });
    this.home.inject(["agent"], (ctx) => {
      const placeTerminalThreads = (projectId: string) => {
        for (const session of this.store.sessions(projectId)) {
          if (session.mode !== "terminal" || !session.threadId) continue;
          const thread = ctx.agent.store.thread(projectId, session.threadId);
          if (thread && thread.surface !== "code") ctx.agent.store.touchThread(projectId, thread.id, { surface: "code" });
        }
      };
      for (const projectId of this.ctx.db.openIds()) placeTerminalThreads(projectId);
      ctx.on("db/opened", placeTerminalThreads);
      ctx.on("storage/imported", placeTerminalThreads);
      for (const playbook of PLAYBOOKS) ctx.agent.playbook(playbook);
      ctx.on("agent/run-started", (_run, thread) => {
        const session = this.sessionOf(thread);
        if (session) this.sessions.touch(thread.projectId, session.id, { state: "running" });
      });
      ctx.on("agent/run-ended", (run, thread) => {
        const session = this.sessionOf(thread);
        if (!session) return;
        const externalId = ctx.agent.store.external(thread.projectId, thread.id)[run.engine];
        if (run.error && classifyRemoteFailure(run.error) === "credentials" && /\bgit\b|\bgh\b|origin|repository|github/i.test(run.error)) {
          this.sessions.blockCredentials(thread.projectId, session.id, run.error, { ...(externalId ? { externalId } : {}) });
          return;
        }
        this.sessions.touch(thread.projectId, session.id, {
          state: run.stop === "asked" ? "waiting" : "idle",
          ...(externalId ? { externalId } : {}),
          ...(run.error ? { summary: `stopped: ${run.error.slice(0, 200)}` } : {})
        });
      });
    });
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("codeLink.links", (projectId, itemId) => ctx.codeLink.links(projectId, itemId));
      ctx.ipc.handle("codeLink.deliveries", (projectId, itemId) => ctx.codeLink.deliveries(projectId, itemId));
      ctx.ipc.handle("codeLink.rescan", (projectId) => ctx.codeLink.scan(projectId));
      ctx.ipc.handle("codeLink.proposals", (projectId, itemId) => ctx.codeLink.proposals(projectId, itemId));
      ctx.ipc.handle("codeLink.resolve", (projectId, proposalId, accept) => ctx.codeLink.resolve(projectId, proposalId, accept));
      ctx.ipc.handle("codeLink.unlinked", (projectId) => ctx.codeLink.unlinked(projectId));
      ctx.ipc.handle("codeLink.linkBranch", (projectId, itemId, repoId, branch) => ctx.codeLink.linkBranch(projectId, itemId, repoId, branch));
      ctx.ipc.handle("codeLink.repos", (projectId) => ctx.codeLink.repoStates(projectId));
      ctx.ipc.handle("codeLink.remoteIdentity", (remote) => ctx.codeLink.remoteIdentity(remote));
      ctx.ipc.handle("codeLink.githubCredentialAccount", (projectId, repoId) => ctx.codeLink.githubCredentialAccount(projectId, repoId));
      ctx.ipc.handle("codeLink.useGithubCredential", (projectId, repoId) => ctx.codeLink.useGithubCredential(projectId, repoId));
      ctx.ipc.handle("codeLink.setRepoPolicy", (projectId, repoId, patch) => ctx.codeLink.setRepoPolicy(projectId, repoId, patch));
      ctx.ipc.handle("codeLink.start", (projectId, itemId, opts) => ctx.codeLink.start(projectId, itemId, opts));
      ctx.ipc.handle("codeLink.sessions", (projectId, itemId) => ctx.codeLink.sessionsOf(projectId, itemId));
      ctx.ipc.handle("codeLink.openPr", (projectId, itemId) => ctx.codeLink.openPr(projectId, itemId));
      ctx.ipc.handle("codeLink.worktree", (projectId, itemId) => ctx.codeLink.worktreeOf(projectId, itemId));
      ctx.ipc.handle("codeLink.adoptBranch", (projectId, repoId, branch) => ctx.codeLink.adoptBranch(projectId, repoId, branch));
      ctx.ipc.handle("codeLink.connect", (projectId, repoId) => ctx.codeLink.connect(projectId, repoId));
    });
    this.home.inject(["contributions"], (ctx) => this.contribute(ctx));

    const timer = this.config.scanMs > 0 ? setInterval(() => void this.scanOpen(), this.config.scanMs) : null;
    timer?.unref?.();
    // Sessions are judged more often than repositories are scanned: a process that is gone should read as gone within the minute.
    const sweeper =
      this.config.sweepMs > 0
        ? setInterval(() => {
            for (const projectId of this.ctx.db.openIds()) this.sessions.sweep(projectId);
          }, this.config.sweepMs)
        : null;
    sweeper?.unref?.();
    return () => {
      if (timer) clearInterval(timer);
      if (sweeper) clearInterval(sweeper);
    };
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  links(projectId: string, itemId?: string): CodeLinkView[] {
    return this.store.links(projectId, itemId);
  }

  deliveries(projectId: string, itemId?: string): DeliveryView[] {
    return this.store.deliveries(projectId, itemId);
  }

  private currentLinks(projectId: string, itemId: string): CodeLinkView[] {
    const delivery = this.store.currentDelivery(projectId, itemId);
    return delivery ? this.store.links(projectId, itemId).filter((link) => link.delivery === delivery.sequence) : [];
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

  async remoteIdentity(remote: string): Promise<RemoteIdentity> {
    const checkout = this.ctx.repos.checkout(remote).checkout;
    if (!checkout || !fs.existsSync(checkout)) return { host: null, login: null };
    if (githubHttps(remote) && await usesTomradeCredential(this.git, checkout, this.ctx.settings.config.path)) {
      const account = await this.githubAccount();
      return { host: "github.com", login: account?.replace(/^@/, "") ?? null, tomrade: true };
    }
    return readRemoteIdentity(this.git, checkout, remote);
  }

  private async githubAccount(): Promise<string | null> {
    try {
      const state = await this.ctx.storage.connection("github");
      return state.connected ? state.label ?? null : null;
    } catch {
      return null;
    }
  }

  async githubCredentialAccount(projectId: string, repoId: string): Promise<string | null> {
    const repo = this.ctx.repos.get(projectId, repoId);
    const state = this.store.repoState(projectId, repoId);
    if (!repo || !githubHttps(repo.remote) || !this.ctx.repos.checkout(repo.remote).checkout || state?.remote !== "unreachable" || classifyRemoteFailure(state.remoteDetail ?? "") !== "credentials") return null;
    return this.githubAccount();
  }

  async useGithubCredential(projectId: string, repoId: string): Promise<RepoStateView> {
    const repo = this.ctx.repos.get(projectId, repoId);
    if (!repo || !githubHttps(repo.remote)) throw new Error("Choose an HTTPS GitHub repository to use Tomrade's account.");
    const checkout = this.ctx.repos.checkout(repo.remote).checkout;
    if (!checkout || !fs.existsSync(checkout)) throw new Error("Choose this repository's checkout first.");
    if (!await this.githubAccount()) throw new Error("Connect your GitHub account in Tomrade first.");
    const origin = await new GitFolder(this.git, checkout).remoteUrl();
    if (!origin || !githubHttps(origin) || normalizeRemote(origin) !== normalizeRemote(repo.remote)) throw new Error("The checkout's origin has changed. Choose the checkout again.");
    await installGithubCredential(this.git, checkout, this.ctx.settings.config.path);
    await this.inFlight.get(projectId);
    const probe = await probeRemote(this.git, checkout, repo.defaultBranch);
    const reachable = probe.state !== "offline";
    const state = this.store.upsertRepoState(projectId, repoId, {
      remote: reachable ? "ok" : "unreachable",
      remoteDetail: probe.detail,
      ...(reachable ? { remoteAt: Date.now() } : {})
    });
    if (reachable) {
      for (const session of this.store.sessions(projectId, { live: true })) {
        if (session.repoId === repoId && session.blocked) this.store.patchSession(projectId, session.id, { blocked: null, state: "idle", activity: null });
      }
    }
    this.notify(projectId);
    return state;
  }

  sessionsOf(projectId: string, itemId?: string): SessionView[] {
    return this.store.sessions(projectId, itemId ? { itemId } : {});
  }

  lastScanAt(projectId: string): number | null {
    return this.scannedAt.get(projectId) ?? null;
  }

  /** This machine's worktree for the ticket's most recent thread, if one was started here. */
  worktreeOf(projectId: string, itemId: string): string | null {
    for (const link of this.currentLinks(projectId, itemId)) {
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

  /** Start or continue a ticket with a local agent — headless here or in the user's terminal, coding or General. See `Starter` for the gates. */
  start(projectId: string, itemId: string, opts: StartOptions): Promise<StartResult> {
    return this.starter.start(projectId, itemId, opts);
  }

  /** Bind again the tokens of this machine's live terminal sessions — the ones a restart would otherwise have orphaned. Returns how many. */
  rebindSessions(projectId: string): number {
    let n = 0;
    for (const s of this.store.sessions(projectId, { live: true })) {
      if (s.mode !== "terminal" || s.device !== this.ctx.hub.deviceId || !s.threadId) continue;
      if (this.sessions.rebind(s, `ai:${s.agent}` as Author, this.sessionDir(s.id))) n += 1;
    }
    return n;
  }

  /** A session took a ticket on — its first, or another beside it. */
  attach(projectId: string, sessionId: string, itemId: string, branch: string, delivery: number): void {
    const session = this.store.session(projectId, sessionId);
    if (!session) return;
    this.store.patchSession(projectId, sessionId, {
      delivery,
      itemIds: session.itemIds.includes(itemId) ? session.itemIds : [...session.itemIds, itemId],
      ...(session.branch ? {} : { branch }),
      ...(session.state === "ended" ? {} : { state: "running" as const }),
      lastEventAt: Date.now()
    });
    this.notify(projectId);
  }

  /** The external session a tokenless claim most likely comes from: the latest live one on that repository with no ticket yet, else any live one there. */
  externalSession(projectId: string, repoId: string): SessionView | null {
    const live = this.store.sessions(projectId, { live: true }).filter((s) => s.repoId === repoId && s.threadId === null && s.state !== "lost");
    return live.find((s) => s.itemIds.length === 0) ?? live[0] ?? null;
  }

  /** A branch that names no ticket becomes one, linked from the start. */
  adoptBranch(projectId: string, repoId: string, branch: string): Item {
    const repo = this.ctx.repos.get(projectId, repoId);
    if (!repo) throw new Error(`unknown repository ${repoId}`);
    const name = branch.trim().replace(/^origin\//, "");
    if (!name) throw new Error("a branch name is required");
    const board = this.ctx.boards.list(projectId).find((b) => b.repoId === repoId) ?? this.ctx.boards.defaultFor(projectId);
    const prefix = this.prefixOf(projectId);
    const words =
      name
        .split("/")
        .filter((seg) => !new RegExp(`^${prefix}-\\d+$`, "i").test(seg))
        .join(" ")
        .replace(/[-_]+/g, " ")
        .trim() || name;
    const item = this.ctx.items.create({ projectId, boardId: board.id, title: words.charAt(0).toUpperCase() + words.slice(1), status: "todo", by: "human" });
    this.store.upsertLink(projectId, { itemId: item.id, repoId, branch: name }, { source: "manual", lastSeenAt: Date.now() });
    this.unlinkedByProject.set(
      projectId,
      this.unlinked(projectId).filter((u) => !(u.repoId === repoId && u.branch === name))
    );
    this.notify(projectId);
    void this.scan(projectId).catch((err) => this.ctx.logger.warn(`rescan after adopting ${name} failed: ${message(err)}`));
    return item;
  }

  /**
   * Connect a repository to Tomrade for everyone who clones it: Claude and
   * Codex MCP config, agent instruction files, and Claude lifecycle hooks —
   * written in a worktree on a branch of their own and offered as a pull
   * request, never into the user's checkout.
   */
  async connect(projectId: string, repoId: string): Promise<ConnectResult> {
    const repo = this.ctx.repos.get(projectId, repoId);
    if (!repo) throw new Error(`unknown repository ${repoId}`);
    const board = this.ctx.boards.list(projectId).find((b) => b.repoId === repoId);
    if (!board) throw new Error(`no workstream stands for ${repo.name}`);
    const mcp = this.ctx.get("mcp");
    if (!mcp?.url) throw new Error("the MCP server is not running — enable the mcp plugin");
    const placement = this.ctx.repos.checkout(repo.remote);
    if (!placement.checkout || !fs.existsSync(placement.checkout)) throw new Error(`no checkout of ${repo.name} on this machine`);

    const branch = "tomrade/connect";
    const view = await this.ctx.repos.workdirFor(projectId, board.id, `connect-${Date.now()}`, { branch });
    if (!view?.worktree) throw new Error(`${board.name} runs in your checkout — Connect needs a worktree; switch the workstream off "run in checkout" first`);
    const state = this.store.repoState(projectId, repoId);
    const project = this.ctx.db.for(projectId).prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
    try {
      const files = writeConnectFiles(view.worktree, {
        projectName: project?.name ?? "Tomrade project",
        mcpUrl: mcp.urlFor(projectId)!,
        eventUrl: mcp.eventUrl!,
        prefix: this.prefixOf(projectId),
        branchTemplate: state?.branchTemplate ?? "{key}/{slug}"
      });
      const folder = new GitFolder(this.git, view.worktree);
      const committed = files.length > 0 && (await folder.commit("Connect this repository to Tomrade\n\nProject MCP config lets Claude Code and Codex discover Tomrade, agent instructions describe the ticket conventions, and Claude hooks report session lifecycle back."));
      if (!committed) return { branch, files, committed: false, pushed: false, url: null, message: files.length ? "nothing new to commit" : `${repo.name} is already connected` };
      if (state && !state.agentPush) return { branch, files, committed, pushed: false, url: null, message: `committed on ${branch} in the checkout — pushing from Tomrade is off for ${repo.name}` };
      const pushed = (await this.git(["push", "-q", "-u", "origin", `HEAD:refs/heads/${branch}`], { cwd: view.worktree, ok: true })).code === 0;
      if (!pushed) return { branch, files, committed, pushed: false, url: null, message: `committed on ${branch}, but git push failed — check your credentials for ${repo.remote}` };
      let url: string | null = null;
      let created = false;
      if (await commandOk("gh")) {
        const env = await githubEnvironment(this.git, view.worktree, this.ctx.settings.config.path);
        try {
          url = (await exec("gh", ["pr", "create", "--head", branch, "--base", repo.defaultBranch, "--title", "Connect this repository to Tomrade", "--body", `Adds ${files.join(", ")} so every coding agent working here reports to Tomrade.`], view.worktree, env)).trim().split("\n").pop() ?? null;
          created = !!url;
        } catch {
          try {
            url = (await exec("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"], view.worktree, env)).trim() || null;
          } catch {
            url = null;
          }
        }
      }
      url ??= compareUrl(repo.remote, repo.defaultBranch, branch);
      this.notify(projectId);
      return { branch, files, committed, pushed, url, message: created ? `opened ${url}` : url ? `pushed ${branch} — open the pull request: ${url}` : `pushed ${branch}; open the pull request on your forge` };
    } finally {
      await this.ctx.repos.removeWorktree(view).catch(() => {});
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
        void this.scan(projectId).catch(() => {});
        return { pushed: true, url: null, created: false, message: `${repo.name} had no ${repo.defaultBranch} yet — ${link.branch} became it, so this ticket counts as merged` };
      }
    }

    let url: string | null = null;
    let created = false;
    if (await commandOk("gh")) {
      const env = await githubEnvironment(this.git, cwd, this.ctx.settings.config.path);
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

  // ── the scan ───────────────────────────────────────────────────────────────

  /** Repoint every checkout still naming a Hub helper at the userData one. Idempotent, so a later scan catches one that appears late. */
  private async migrateCredentialHelpers(projectId: string): Promise<void> {
    for (const repo of this.ctx.repos.list(projectId)) {
      const checkout = this.ctx.repos.checkout(repo.remote).checkout;
      if (!checkout || !fs.existsSync(checkout)) continue;
      try {
        await migrateGithubCredential(this.git, checkout, this.ctx.settings.config.path);
      } catch (err) {
        this.ctx.logger.warn(`credential helper migration for ${checkout} failed: ${message(err)}`);
      }
    }
  }

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
    await this.migrateCredentialHelpers(projectId);
    for (const repo of repos) {
      const placement = this.ctx.repos.checkout(repo.remote);
      if (!placement.checkout || !fs.existsSync(placement.checkout)) {
        summary.skipped.push({ repoId: repo.id, reason: "no checkout on this machine" });
        if (!this.store.repoState(projectId, repo.id)) this.store.upsertRepoState(projectId, repo.id, {});
        continue;
      }
      const before = this.store.repoState(projectId, repo.id);
      let result: ScanResult;
      try {
        result = await scanRepo(this.git, placement.checkout, { defaultBranch: repo.defaultBranch, prefix, sinceSha: before?.scannedSha ?? null, fetch: this.config.fetch });
      } catch (err) {
        summary.skipped.push({ repoId: repo.id, reason: message(err) });
        continue;
      }
      summary.scanned += 1;
      if (result.offline) summary.offline += 1;
      this.store.upsertRepoState(projectId, repo.id, {
        readiness: result.readiness,
        remote: result.remote,
        remoteDetail: result.remote === "unreachable" ? result.remoteDetail : null,
        remoteAt: result.remote === "ok" ? now : (before?.remoteAt ?? null),
        hasBrief: result.hasBrief,
        manifests: result.manifests,
        summary: result.summary,
        scannedSha: result.defaultSha,
        defaultSha: result.defaultSha,
        scannedAt: now
      });
      if (result.remote === "ok") {
        for (const session of this.store.sessions(projectId, { live: true })) {
          if (session.repoId === repo.id && session.blocked) this.store.patchSession(projectId, session.id, { blocked: null, state: "idle", activity: null });
        }
      }
      const outcome = await this.absorb(projectId, repo, result, before?.autoDone ?? true, now, unlinked);
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
  private async absorb(projectId: string, repo: Repo, result: ScanResult, autoDone: boolean, now: number, unlinked: UnlinkedBranch[]): Promise<{ links: number; changed: number; proposals: number }> {
    const items = this.ctx.items.list({ projectId });
    const byNum = new Map(items.map((i) => [i.keyNum, i]));
    const previous = new Map(this.store.linksForRepo(projectId, repo.id).map((l) => [l.id, l]));
    const seen = new Set<string>();
    const touched = new Set<string>(previous.size ? [...previous.values()].map((l) => l.itemId) : []);
    let links = 0;

    for (const b of result.branches) {
      for (const keyNum of b.keyNums) {
        const item = byNum.get(keyNum);
        if (!item) {
          unlinked.push({ repoId: repo.id, repoName: repo.name, branch: b.name, keyNum, sha: b.sha, committedAt: b.committedAt });
          continue;
        }
        const sameBranch = [...previous.values()].filter((link) => link.itemId === item.id && link.branch === b.name).sort((a, z) => z.delivery - a.delivery);
        const active = this.store.activeDelivery(projectId, item.id);
        const current = active ? sameBranch.find((link) => link.delivery === active.sequence) : undefined;
        const unchangedHistory = !current ? sameBranch.find((link) => link.headSha === b.sha) : undefined;
        const target = current ?? unchangedHistory;
        const merged = landed(b, target);
        const link = target
          ? this.store.patchLink(projectId, target.id, {
              headSha: b.sha,
              headAt: b.committedAt,
              ahead: b.ahead,
              behind: b.behind,
              mergedSha: merged ? (target.mergedSha ?? result.defaultSha) : undefined,
              lastSeenAt: now
            })
          : this.store.upsertLink(
              projectId,
              { itemId: item.id, repoId: repo.id, branch: b.name },
              { headSha: b.sha, headAt: b.committedAt, ahead: b.ahead, behind: b.behind, mergedSha: merged ? result.defaultSha : undefined, lastSeenAt: now }
            );
        if (merged && link.prState === "open") this.store.patchLink(projectId, link.id, { prState: "merged" });
        if (link.delivery === this.store.activeDelivery(projectId, item.id)?.sequence) seen.add(link.id);
        touched.add(item.id);
        links += 1;
        // A branch with commits is a session's heartbeat too.
        for (const s of this.store.sessions(projectId, { itemId: item.id, delivery: link.delivery, live: true })) if (s.branch === b.name && (s.lastCommitAt ?? 0) < b.committedAt) this.store.patchSession(projectId, s.id, { lastCommitAt: b.committedAt });
      }
    }

    // A branch linked by hand under a name the template does not know is still one of ours.
    for (const l of previous.values()) {
      if (l.source !== "manual" || seen.has(l.id) || !l.branch) continue;
      const b = result.branches.find((x) => x.name === l.branch);
      if (!b) continue;
      const merged = landed(b, l);
      this.store.patchLink(projectId, l.id, { headSha: b.sha, headAt: b.committedAt, ahead: b.ahead, behind: b.behind, mergedSha: merged ? result.defaultSha : undefined, ...(merged && l.prState === "open" ? { prState: "merged" } : {}), lastSeenAt: now });
      seen.add(l.id);
    }

    for (const [keyNum, commit] of result.mergedKeys) {
      const item = byNum.get(keyNum);
      if (!item) continue;
      let active = this.store.activeDelivery(projectId, item.id);
      if (!active && item.status !== "done" && item.status !== "cancelled") active = this.store.ensureActiveDelivery(projectId, item.id, commit.at);
      if (!active) continue;
      const base = active.bases[repo.id];
      if (base && active.sequence > 1) {
        const cwd = this.ctx.repos.checkout(repo.remote).checkout!;
        const ancestor = await this.git(["merge-base", "--is-ancestor", commit.sha, base], { cwd, ok: true });
        if (ancestor.code !== 1) continue;
      } else if (active.sequence > 1) {
        // Without a known starting ref, require branch/PR evidence instead of
        // assigning a historical ticket mention to a reopened delivery.
        continue;
      }
      const own = this.store.links(projectId, item.id).filter((l) => l.repoId === repo.id && l.delivery === active.sequence);
      if (own.length) {
        for (const l of own) {
          // A ticket mention in a squash commit cannot identify which of
          // several branches was merged. Multi-link deliveries require
          // branch ancestry or explicit PR evidence for each link.
          if (own.length > 1) continue;
          if (!l.mergedSha || l.prState === "open") {
            this.store.patchLink(projectId, l.id, { ...(!l.mergedSha ? { mergedSha: commit.sha } : {}), ...(l.prState === "open" ? { prState: "merged" as const } : {}) });
          }
        }
      } else {
        this.store.upsertLink(projectId, { itemId: item.id, repoId: repo.id, branch: "", delivery: active.sequence }, { headSha: commit.sha, headAt: commit.at, mergedSha: commit.sha, lastSeenAt: now, source: "scan" });
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
  completionPolicy(projectId: string, item: Item): "merge" | "human" {
    if (item.workType === "general") return "human";
    const active = this.store.activeDelivery(projectId, item.id);
    if (item.evidence.resources.some(r => r.role === "output" && r.deliveryId === active?.id) || item.evidence.submissions.some(s => s.deliveryId === active?.id)) return "human";
    const links = this.currentLinks(projectId, item.id);
    const defaultRepo = this.ctx.boards.get(projectId, item.boardId)?.repoId;
    const repos = links.length ? links.map(l => l.repoId) : defaultRepo ? [defaultRepo] : [];
    return repos.length && repos.every(id => this.store.repoState(projectId, id)?.autoDone ?? true) ? "merge" : "human";
  }

  private judge(projectId: string, item: Item, repoId: string, previous: Map<string, CodeLinkView>, seen: Set<string>, autoDone: boolean): { changed: number; proposals: number } {
    if (item.workType === "general") return { changed: 0, proposals: 0 };
    const delivery = this.store.activeDelivery(projectId, item.id);
    if (!delivery) return { changed: 0, proposals: 0 };
    autoDone = autoDone && this.completionPolicy(projectId, item) === "merge";
    const links = this.store.links(projectId, item.id).filter((l) => l.repoId === repoId && l.delivery === delivery.sequence);
    if (!links.length) return { changed: 0, proposals: 0 };
    const present = links.filter((l) => l.branch && seen.has(l.id));
    const primary = primaryOf(links);
    const working = hasLiveSession(this.store.sessions(projectId, { itemId: item.id, delivery: delivery.sequence, live: true }));
    const evidence: Evidence = {
      branch: present.length > 0,
      ahead: present.reduce((max, l) => Math.max(max, l.ahead), 0),
      merged: this.currentLinks(projectId, item.id).every(l => !!l.mergedSha || l.prState === "merged"),
      working,
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
    let status = item.status;
    // A previous scan may have written Done just before an unmerged terminal
    // session was rebound after an app restart. Once the live process is visible
    // again, undo that sync-only transition. Definitive merge evidence still wins.
    if (evidence.working && !evidence.merged && status === "done" && item.updatedBy === AUTHOR) {
      this.ctx.items.update(projectId, item.id, { status: "doing" }, AUTHOR);
      status = "doing";
      changed += 1;
    }
    const standing = new Set<string>();
    for (let d of decide(status, evidence, { autoDone, humanLocked: item.humanLocked })) {
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
      if (this.store.hasRecentProposal(projectId, item.id, delivery.sequence, d.kind, to, d.reason, evidenceSha)) continue;
      this.store.addProposal(projectId, { itemId: item.id, delivery: delivery.sequence, linkId: primary?.id ?? null, kind: d.kind, fromStatus: item.status, toStatus: to, reason: d.reason, evidenceSha });
      proposals += 1;
    }
    // A proposal the evidence no longer supports is withdrawn, not left for someone to reject.
    for (const p of this.store.proposalsForDelivery(projectId, item.id, delivery.sequence, "open")) if (!standing.has(signature(p.kind, p.toStatus, p.reason))) this.store.setProposalState(projectId, p.id, "stale");
    if (evidence.merged && this.ctx.items.get(projectId, item.id)?.status === "done") this.store.finishActiveDelivery(projectId, item.id, "completed");
    return { changed, proposals };
  }

  // ── contributions ──────────────────────────────────────────────────────────

  private contribute(ctx: Context): void {
    ctx.contributions.section({
      id: "code",
      title: "Code",
      render: (item) => {
        const links = this.store.links(item.projectId, item.id);
        const delivery = this.store.currentDelivery(item.projectId, item.id);
        const open = delivery ? this.store.proposalsForDelivery(item.projectId, item.id, delivery.sequence, "open") : [];
        const sessions = this.store.sessions(item.projectId, { itemId: item.id, ...(delivery ? { delivery: delivery.sequence } : {}) });
        if (item.workType === "general" && !links.length && !sessions.length) return null;
        if (!delivery && !links.length && !open.length && !sessions.length) return null;
        const current = this.currentLinks(item.projectId, item.id);
        const primary = primaryOf(current);
        const ordered = primary ? [primary, ...current.filter((l) => l.id !== primary.id), ...links.filter((l) => l.delivery !== primary.delivery).reverse()] : [...links].reverse();
        const deliveries = this.store.deliveries(item.projectId, item.id);
        const deliveryBySequence = new Map(deliveries.map((entry) => [entry.sequence, entry]));
        const rows: SectionRow[] = [];
        if (delivery && !current.length) rows.push({ label: "Delivery", icon: "i-merge", state: "live", value: `#${delivery.sequence} · ${delivery.state}` });
        let shownDelivery: number | null = null;
        for (const l of ordered) {
          if (deliveries.length > 1 && shownDelivery !== l.delivery) {
            const entry = deliveryBySequence.get(l.delivery);
            rows.push({ label: "Delivery", icon: "i-merge", state: entry?.state === "active" ? "live" : entry?.state === "completed" ? "ok" : "ended", value: `#${l.delivery} · ${entry?.state ?? "historical"}` });
            shownDelivery = l.delivery;
          }
          const repo = this.ctx.repos.get(item.projectId, l.repoId);
          const name = repo?.name ?? "repository";
          if (l.branch) rows.push({ label: "Branch", icon: "i-branch", mono: true, value: `${l.branch} · ${name}${l.ahead || l.behind ? ` · +${l.ahead} −${l.behind}` : ""}` });
          if (l.prNumber !== null || l.prUrl) {
            rows.push({
              label: "Pull request",
              icon: "i-merge",
              state: l.prState === "merged" ? "ok" : l.prState === "closed" ? "ended" : l.prState === "open" ? "live" : undefined,
              value: `${l.prNumber !== null ? `#${l.prNumber}` : "open it"}${l.prState ? ` · ${l.prState}` : ""}`,
              href: l.prUrl ?? undefined
            });
          } else if (l.branch && !l.mergedSha && l.ahead > 0 && this.worktreeOf(item.projectId, item.id)) {
            rows.push({ label: "Pull request", icon: "i-merge", value: "Open pull request", command: "code-link.open-pr" });
          }
          if (l.mergedSha) rows.push({ label: "Merged", icon: "i-check", state: "ok", mono: true, value: `${l.mergedSha.slice(0, 7)} on ${repo?.defaultBranch ?? "main"}` });
          if (l.headAt) rows.push({ label: "Last commit", icon: "i-clock", value: ago(l.headAt) });
        }
        const live = sessions.find((s) => s.state !== "ended") ?? sessions[0];
        if (live) {
          const where = live.mode === "terminal" ? "in a terminal" : "run by Tomrade";
          const when = live.lastEventAt ? ago(live.lastEventAt) : ago(live.startedAt);
          const state = ({ running: "live", waiting: "waiting", idle: "idle", error: "warn", ended: "ended", lost: "lost" } as const)[live.state];
          // What it is doing beats what it last said; an error is what it last said.
          const doing = live.state === "error" ? (live.summary ?? "stopped") : (live.activity ?? live.summary ?? "");
          rows.push({
            label: "Session",
            icon: live.mode === "terminal" ? "i-terminal" : "i-plug",
            state,
            value: `${live.state}${live.state === "waiting" ? " for you" : ""} · ${where}${doing ? ` · ${doing}` : ""} · last signal ${when}`
          });
          if (live.state !== "running") rows.push({ label: "Continue", icon: "i-send", value: live.mode === "terminal" ? "Continue in terminal" : "Continue here", command: live.mode === "terminal" ? "code-link.start-terminal" : "code-link.start-run" });
        }
        const worktree = this.worktreeOf(item.projectId, item.id);
        if (worktree) rows.push({ label: "Worktree", icon: "i-folder", mono: true, value: worktree, command: "code-link.open-terminal" });
        const proposal = open.find((p) => p.kind === "propose");
        if (proposal) {
          rows.push({ label: "Proposal", icon: "i-warn", state: "warn", value: `Accept → ${proposal.toStatus}`, command: "code-link.accept-proposal" });
          rows.push({ label: "Dismiss", icon: "i-close", value: "Not this time", command: "code-link.reject-proposal" });
        }
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
        const stuck = new Map<string, string>();
        for (const s of this.store.sessions(projectId, { live: true })) {
          for (const id of s.itemIds) {
            if (this.store.currentDelivery(projectId, id)?.sequence !== s.delivery) continue;
            if (s.state === "waiting") waiting.add(id);
            if (s.state === "error") stuck.set(id, s.summary ?? "stopped");
          }
        }
        const out: Record<string, Badge[]> = {};
        for (const item of items) {
          const allLinks = byItem.get(item.id) ?? [];
          const delivery = this.store.currentDelivery(projectId, item.id);
          const links = delivery ? allLinks.filter((link) => link.delivery === delivery.sequence) : [];
          const flag = flags.get(item.id);
          if (!links.length && !flag && !waiting.has(item.id) && !stuck.has(item.id)) continue;
          const badges: Badge[] = [];
          if (waiting.has(item.id)) badges.push({ id: "waiting", label: "waiting", tone: "strong", title: "The coding session is waiting for you" });
          if (stuck.has(item.id)) badges.push({ id: "stuck", label: "stuck", tone: "strong", title: stuck.get(item.id) });
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
        const stuck = live.filter((s) => s.state === "error").length;
        if (live.length) parts.push(`${live.length} session${live.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} waiting for you` : ""}${stuck ? ` · ${stuck} stuck` : ""}`);
        const unlinked = this.unlinked(projectId).length;
        const open = this.store.proposals(projectId).length;
        const unreachable = this.store.repoStates(projectId).filter((repo) => repo.remote === "unreachable").length;
        if (unlinked) parts.push(`${unlinked} unlinked`);
        if (open) parts.push(`${open} to confirm`);
        if (unreachable) parts.push(`${unreachable} unreachable`);
        if (!parts.length && !at) return null;
        return `code: ${parts.join(" · ") || "in sync"}${at ? ` · scanned ${ago(at)}` : ""}`;
      }
    });

    const startCommand = (mode: StartMode) => async (scope: { projectId?: string; itemId?: string | null }) => {
      if (!scope.projectId || !scope.itemId) return { toast: "Select a ticket first" };
      const result = await this.start(scope.projectId, scope.itemId, { mode });
      if (!result.ok) return { toast: result.message };
      const warning = result.warnings?.join("\n");
      const where = result.branch ? ` on ${result.branch}` : "";
      if (result.mode === "terminal") return { toast: `${result.launched ? `${result.continued ? "Continuing" : "Started"}${where} — your terminal has it` : `Run this in a terminal:\n${result.command}`}${warning ? `\n${warning}` : ""}` };
      return { toast: `${result.continued ? "Continuing" : "Started"}${where}${warning ? `\n${warning}` : ""}` };
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
    const settle = (accept: boolean) => (scope: { projectId?: string; itemId?: string | null }) => {
      if (!scope.projectId || !scope.itemId) return { toast: "Select a ticket first" };
      const proposal = this.store.proposals(scope.projectId, scope.itemId, "open").find((p) => p.kind === "propose");
      if (!proposal) return { toast: "Nothing proposed for this ticket" };
      this.resolve(scope.projectId, proposal.id, accept);
      return { toast: accept ? `Moved to ${proposal.toStatus}` : "Dismissed — asked again only on new evidence" };
    };
    ctx.contributions.command({ id: "code-link.accept-proposal", title: "Accept the code proposal", group: "Code", run: settle(true) });
    ctx.contributions.command({ id: "code-link.reject-proposal", title: "Dismiss the code proposal", group: "Code", run: settle(false) });
    ctx.contributions.command({
      id: "code-link.connect",
      title: "Connect repository to coding agents",
      group: "Code",
      run: async ({ projectId, itemId }) => {
        if (!projectId) return { toast: "Open a project first" };
        const item = itemId ? this.ctx.items.get(projectId, itemId) : null;
        const fromItem = item ? this.ctx.boards.get(projectId, item.boardId)?.repoId : null;
        const repos = this.ctx.repos.list(projectId);
        const repoId = fromItem ?? (repos.length === 1 ? repos[0]!.id : null);
        if (!repoId) return { toast: "Select a ticket on the workstream whose repository to connect" };
        const r = await this.connect(projectId, repoId);
        return { toast: r.message };
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

  /** A hook fired without a token: match it to a session by where the agent runs — a Tomrade worktree, or someone's checkout. */
  private externalEvent(payload: unknown): void {
    const p = (payload ?? {}) as { hook_event_name?: string; session_id?: string; cwd?: string };
    if (!p.cwd) return;
    const cwd = path.resolve(p.cwd);
    const within = (root: string) => cwd === root || cwd.startsWith(root + path.sep);
    for (const [threadId, dir] of this.worktrees) {
      if (!within(path.resolve(dir))) continue;
      for (const projectId of this.ctx.db.openIds()) {
        const session = this.store.sessions(projectId, { live: true }).find((s) => s.threadId === threadId);
        if (session) {
          this.sessions.event(projectId, session.id, payload);
          return;
        }
      }
      return;
    }
    for (const projectId of this.ctx.db.openIds()) {
      for (const repo of this.ctx.repos.list(projectId)) {
        const checkout = this.ctx.repos.checkout(repo.remote).checkout;
        if (!checkout || !within(path.resolve(checkout))) continue;
        const known = p.session_id ? this.store.sessions(projectId, { live: true }).find((s) => s.threadId === null && s.repoId === repo.id && s.externalId === p.session_id) : undefined;
        if (known) {
          this.sessions.event(projectId, known.id, payload);
          return;
        }
        // The end of a session never heard of is nothing to record.
        if (p.hook_event_name === "SessionEnd") return;
        const created = this.store.createSession(projectId, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: this.ctx.hub.deviceId, externalId: p.session_id ?? null });
        this.sessions.event(projectId, created.id, payload);
        return;
      }
    }
  }

  private sessionOf(thread: ThreadSummary): SessionView | null {
    return this.store.sessions(thread.projectId, { live: true }).find((s) => s.threadId === thread.id) ?? null;
  }

  /** Headless sessions may annotate their Assistant thread; terminal results stay in Code > Session. */
  private noteMoment(session: SessionView, moment: SessionMoment): void {
    if (session.mode === "terminal") return;
    if (!session.threadId) return;
    const agent = this.ctx.get("agent");
    if (!agent?.store.thread(session.projectId, session.threadId)) return;
    const who = agent.codeEngines().find((engine) => engine.id === session.agent)?.title ?? session.agent;
    const text = moment.kind === "said" ? `${who}: ${moment.text}` : moment.kind === "failed" ? `${who} stopped: ${moment.text}` : `${who} session ended${moment.text ? ` (${moment.text})` : ""}.`;
    const message = agent.store.appendMessage(session.projectId, session.threadId, "system", { type: "note", text }, null);
    this.home.get("ipc")?.send("agent.event", session.threadId, { type: "message", message });
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
