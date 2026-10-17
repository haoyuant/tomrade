import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import type { CommandCheck, ThreadSummary } from "@tomradex/agent";
import { untilLabel } from "@tomradex/agent";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/contributions";
import type { Badge, SectionRow } from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/repos";
import { normalizeRemote, sameRepository } from "@tomradex/repos";
import type {} from "@tomradex/settings";
import type {} from "@tomradex/write";
import type { Author, Item, Repo } from "@tomradex/domain";
import { GitFolder, gitRunner, type Git } from "@tomradex/storage";
import { keysInText, parseBranch, subjectPr } from "./keys.js";
import { githubPull, readPull, type ForgePull } from "./forge.js";
import { inspectConnection, inspectConnectFiles, type AgentConnectionView, type ConnectionView } from "./connection.js";
import { writeConnectFiles } from "./connect.js";
import { StartDefaultsStore, type StartDefaultsView } from "./defaults.js";
import { SYNC_PROMPT, syncInstructions, syncPrompt, type SyncScope } from "./sync.js";
import { githubHttps } from "@tomradex/github";
import { PLAYBOOKS } from "./playbooks.js";
import { decide, type Decision, type Evidence } from "./rules.js";
import { scanRepo, type ScanResult, type ScannedBranch } from "./scanner.js";
import { classifyRemoteFailure, probeRemote, readRemoteIdentity, type RemoteIdentity } from "./remote.js";
import { Sessions, type SessionMoment } from "./sessions.js";
import { CODE_WORDS, type CodeWords } from "./words.js";
import { Starter, type StartMode, type StartOptions, type StartResult } from "./start.js";
import { CodeLinkStore, MIGRATIONS, TABLES, type CodeLinkView, type DeliveryView, type ProposalView, type RepoStatePatch, type RepoStateView, type SessionView } from "./store.js";
import { TerminalSettings, commandOk, exec, launchTerminal, setupTerminal } from "./terminal.js";
import { registerTools } from "./tools.js";

/** Who the scanner writes as. Evidence from git is not a person's decision, and it is not a model's either. */
export const AUTHOR: Author = "sync:git";

const hasLiveSession = (sessions: SessionView[]): boolean =>
  sessions.some((s) => s.mode === "terminal" || s.state === "running" || s.state === "waiting" || s.state === "error");

declare module "cordis" {
  interface Context {
    codeLink: CodeLink;
  }
  interface Events {
    /** Links or sessions of a project changed — for main-process observers; the renderer hears codeLink.changed. */
    "codeLink/changed"(projectId: string): void;
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

export interface MergeLocalResult {
  merged: boolean;
  /** The default branch's head after the merge; null when nothing was merged. */
  sha: string | null;
  message: string;
}

/** A ticket's current delivery: its code, primary link first, the session working on it, and what git proposes. */
export interface CodeSummaryView {
  delivery: { sequence: number; state: DeliveryView["state"] } | null;
  links: {
    repo: string;
    branch: string | null;
    ahead: number;
    behind: number;
    prNumber: number | null;
    prUrl: string | null;
    prState: CodeLinkView["prState"];
    mergedSha: string | null;
    lastCommitAt: number | null;
  }[];
  session: (Pick<SessionView, "id" | "mode" | "agent" | "state" | "summary" | "activity" | "blocked" | "threadId" | "worktree"> & { lastEventAt: number }) | null;
  proposals: Pick<ProposalView, "id" | "kind" | "toStatus" | "reason">[];
}

export type RepoPolicyPatch =Pick<RepoStatePatch, "branchTemplate" | "autoDone" | "agentPush" | "agentMerge" | "readiness">;

/** The command an agent merges with when the repository lets it. */
export const MERGE_COMMAND = "gh pr merge";

/** Whether one local coding agent's own settings let it merge; `check` is null when Tomrade cannot read them. */
export interface MergeCheckView {
  engine: string;
  title: string;
  check: CommandCheck | null;
}

export interface ConnectResult {
  agents: AgentConnectionView[];
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
    /** Check origin again from this checkout now, first repairing a credential helper that can no longer run. */
    "codeLink.recheckRemote": (projectId: string, repoId: string) => RepoStateView;
    "codeLink.setRepoPolicy": (projectId: string, repoId: string, patch: RepoPolicyPatch) => RepoStateView;
    /** Whether each installed coding agent's own settings let it run gh pr merge here. */
    "codeLink.mergeChecks": (projectId: string, repoId: string) => MergeCheckView[];
    /** Write the one rule an agent's settings need to merge, then check again. */
    "codeLink.allowMerge": (projectId: string, repoId: string, engineId: string) => MergeCheckView;
    /** Start or continue work on a ticket with a local coding agent, headless or in a terminal. */
    "codeLink.start": (projectId: string, itemId: string, opts: StartOptions) => StartResult;
    "codeLink.sessions": (projectId: string, itemId?: string) => SessionView[];
    /** Push the ticket's branch from its worktree and open a pull request (gh), or hand back the compare page. */
    "codeLink.openPr": (projectId: string, itemId: string) => OpenPrResult;
    /** A repository with no remote: merge the ticket's branch into the default branch on this machine. */
    "codeLink.mergeLocal": (projectId: string, itemId: string) => MergeLocalResult;
    /** Where this machine's worktree for the ticket is, if it has one. */
    "codeLink.worktree": (projectId: string, itemId: string) => string | null;
    /** A branch nobody's ticket names becomes a ticket, linked to it. */
    "codeLink.adoptBranch": (projectId: string, repoId: string, branch: string) => Item;
    /** Connection evidence on the default and connection branches of the local clone. */
    "codeLink.connection": (projectId: string, repoId: string) => ConnectionView;
    /** Put agent configuration into the repository on its own branch. */
    "codeLink.connect": (projectId: string, repoId: string) => ConnectResult;
    /** Install or sign in to a local agent in a terminal, with the command its engine declares. */
    "codeLink.setupInTerminal": (engineId: string, step: "install" | "signIn") => { launched: boolean; command: string };
    /** What the Start dialog last ran with on this machine, so it opens the way it was left. */
    "codeLink.startDefaults": () => StartDefaultsView | null;
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
    fetch: z.boolean().default(true),
    /** Where the Start dialog's last used configuration rests, beside the settings file. Null keeps none. */
    defaultsPath: z.string().nullish()
  })
);
export type CodeLinkConfig = z.infer<typeof CodeLinkConfig>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** git's last word on a failure, which is the one that says why. */
const lastLine = (text: string | undefined) => (text ?? "").trim().split("\n").pop() ?? "";

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

/** The agent of a session known only by its MCP connection. */
export const MCP_AGENT = "mcp";

const SETTINGS_SECTION = {
  id: "codeLink",
  title: "Code link",
  description: "Which terminal opens a ticket, and how Claude Code, Codex or Pi is invoked in it. {prompt}, {mcpConfig}, {mcpUrl}, {settings}, {piExtension}, {resume}, {options} (the model and effort chosen at Start) and {cwd} are filled in.",
  schema: TerminalSettings,
  defaults: TerminalSettings.parse({}),
  order: 30,
  words: {
    zh: {
      title: "代码关联",
      description: "用哪个终端打开工作项，以及在终端里怎样调用 Claude Code、Codex 或 Pi。命令里的 {prompt}、{mcpConfig}、{mcpUrl}、{settings}、{piExtension}、{resume}、{options}（开始时选的模型和推理强度）和 {cwd} 会自动填入。",
      fields: {
        terminal: { title: "终端应用", description: "Terminal、iTerm、Warp、Ghostty……凡是 `open -a` 能打开的都行。填 none 则只准备好命令，供你复制。" },
        claudeCommand: { title: "Claude Code 命令" },
        codexCommand: { title: "Codex 命令" },
        piCommand: { title: "Pi 命令", description: "Pi 没有 MCP 参数；{piExtension} 是只在本次会话生效的扩展，负责注册 Tomrade 的服务，并像 Claude 的 hooks 一样回报进展。" },
        geminiCommand: { title: "Gemini CLI 命令", description: "{geminiSettings} 是只在本次会话生效的设置文件，作为最低一层读取，你自己的 Gemini 设置仍然优先。" },
        opencodeCommand: { title: "OpenCode 命令", description: "{opencodeConfig} 是只在本次会话生效的配置，会和你自己的 OpenCode 配置合并。" },
        workbuddyCommand: { title: "WorkBuddy 命令" },
        hermesCommand: { title: "Hermes 命令", description: "Hermes 没有 MCP 参数，从它自己的 config.yaml 读 tomrade 服务，请求头引用这个终端导出的 $TOMRADE_MCP_TOKEN。先在设置里的 Hermes 下连接到 Tomrade。" },
        otherCommand: { title: "其他智能体命令", description: "其他带 MCP 客户端的命令行智能体，比如 Gemini CLI、OpenCode、aider……留空表示没有设置。会自动填入 {mcpUrl}、{token}（也在 $TOMRADE_MCP_TOKEN 里）、{prompt} 和 {resume}（会话 id 本身）。" }
      }
    }
  }
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
  static inject = ["db", "items", "boards", "repos", "hub", "settings", "storage", "github"];
  static Config = CodeLinkConfig;

  /**
   * What GitHub says about a pull request: through Tomrade's GitHub account, else `gh`
   * (with the checkout's credential when there is one); null when neither can ask.
   * Replaceable, so tests never reach the network.
   */
  pulls = async (repo: string, number: number, cwd: string | null): Promise<ForgePull | null> => {
    const route = `/repos/${repo}/pulls/${number}`;
    try {
      if (await this.ctx.github.token()) return readPull(await this.ctx.github.api.request("GET", route));
    } catch {
      // Not readable with this account: gh may still have one that is.
    }
    if (!(await commandOk("gh"))) return null;
    try {
      return readPull(JSON.parse(await exec("gh", ["api", route.slice(1)], cwd ?? os.homedir(), cwd ? await this.ctx.github.environment(this.git, cwd) : undefined)));
    } catch {
      return null;
    }
  };

  store!: CodeLinkStore;
  sessions!: Sessions;

  private readonly home: Context;
  private readonly git: Git;
  private starter!: Starter;
  private readonly unlinkedByProject = new Map<string, UnlinkedBranch[]>();
  private readonly scannedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<ScanSummary>>();
  /** Folders hooks events came from that were already looked at for a checkout: one look per folder, not per event. */
  private readonly placeLooked = new Set<string>();
  /** Machine-local: each thread's worktree, for the section and the terminal. */
  private readonly worktrees = new Map<string, string>();
  /**
   * Which sessions each outside client's MCP connection claimed for — several when it works tickets in parallel —
   * and the one a call without a key means; in memory, so a restart asks the client to name its ticket again.
   */
  private readonly connections = new Map<string, { projectId: string; sessionIds: string[]; current: string }>();
  /** Threads with a run going, so a question raised mid-run finds its session: agent events name only the thread. */
  private readonly running = new Map<string, ThreadSummary>();
  /** What the Start dialog last ran with on this machine (see `defaults.ts`). */
  private readonly defaults: StartDefaultsStore;

  constructor(
    ctx: Context,
    public readonly config: CodeLinkConfig
  ) {
    super(ctx, "codeLink");
    this.home = ctx;
    this.git = gitRunner(config.gitBinary);
    this.defaults = new StartDefaultsStore(config.defaultsPath ?? null);
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
      // A terminal session cannot be typed into: when the limit lifts the person is told, not the agent.
      onLimit: (session, until) => {
        const agent = this.ctx.get("agent");
        const park = session.threadId && agent ? agent.park(session.projectId, session.threadId, { until, resume: false, note: false }) : null;
        return this.limitedWords(park?.until ?? until ?? Date.now() + 15 * 60_000, park?.known ?? until !== null, false);
      },
      // A pass already running still saw this session as active.
      onEnd: (session) => void this.rescan(session.projectId).catch((err) => this.ctx.logger.warn(`code scan after session ${session.id} ended failed: ${message(err)}`))
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
        // A person's acceptance always lands (TOM-129); only an agent or a sync waits for every link to merge.
        if (intent.by !== "human" && before?.status !== "done" && after?.status === "done" && after.workType === "coding" && mixed) {
          const links = this.currentLinks(intent.projectId, intent.id);
          if (!links.length || links.some(link => !link.mergedSha && link.prState !== "merged")) throw new Error("Merge all code links before accepting this mixed delivery");
        }
      }
      return next();
    });
    this.ctx.on("agent/prepare-turn", async (input) => {
      if (input.purpose === "backlog") input.repositories = this.repositoriesOf(input.projectId);
      if (input.purpose === "code" && input.ticket) {
        const item = this.ctx.items.get(input.projectId, input.ticket.id);
        if (item) input.ticket.completionPolicy = this.completionPolicy(input.projectId, item);
      }
      if (input.cwd && input.workdir && githubHttps(input.workdir.remote)) {
        input.env = { ...input.env, ...await this.ctx.github.environment(this.git, input.cwd) };
      }
    });
    // A headless session cannot have survived a restart; say so, and let the ticket offer Continue.
    for (const projectId of this.ctx.db.openIds()) this.sessions.reconcile(projectId);
    this.ctx.on("db/opened", (projectId) => this.sessions.reconcile(projectId));
    this.ctx.on("repos/checkout-set", (remote) => {
      for (const projectId of this.ctx.db.openIds()) {
        if (!this.ctx.repos.list(projectId).some((repo) => repo.remote === remote)) continue;
        void this.rescan(projectId).catch((err) => this.ctx.logger.warn(`code scan after setting ${remote} failed: ${message(err)}`));
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
        handOver: (projectId, itemId, repoId) => this.handOver(projectId, itemId, repoId),
        dropSuggested: (projectId, itemId, repoId, branch) => this.dropSuggested(projectId, itemId, repoId, branch),
        noteProgress: (projectId, sessionId, text) => this.sessions.touch(projectId, sessionId, { summary: text, state: "running" }),
        blockMerge: (projectId, sessionId, reason) => this.sessions.blockMerge(projectId, sessionId, reason),
        attach: (projectId, sessionId, itemId, branch, delivery, opts) => this.attach(projectId, sessionId, itemId, branch, delivery, opts),
        externalSession: (projectId, repoId) => this.externalSession(projectId, repoId),
        connected: (projectId, connection) => this.connected(projectId, connection),
        connectedSessions: (projectId, connection) => this.connectedSessions(projectId, connection),
        bindConnection: (projectId, connection, sessionId, leaving) => this.bindConnection(projectId, connection, sessionId, leaving),
        bound: (sessionId) => this.boundAnywhere(sessionId),
        connectionSession: (projectId, repoId, worktree) => this.connectionSession(projectId, repoId, worktree),
        successor: (projectId, from, repoId, worktree) => this.successor(projectId, from, repoId, worktree),
        notify: (projectId) => this.notify(projectId),
        summary: (projectId, itemId) => this.summary(projectId, itemId),
        mergeLocal: (projectId, itemId, opts) => this.mergeLocal(projectId, itemId, opts)
      })
    );
    this.home.inject(["mcp"], (ctx) => {
      // Hooks a repository commits carry no token; the cwd and session id in the payload say whose they are.
      ctx.mcp.onEvent((payload) => this.externalEvent(payload));
      ctx.on("mcp/closed", (connection) => this.disconnected(connection));
      ctx.mcp.prompt({
        name: SYNC_PROMPT,
        title: "Sync with Tomrade",
        description: "Bring this session's work back into the Tomrade backlog: match it to tickets, link code, update status, file follow-ups.",
        render: ({ projectId }) => syncPrompt(this.syncScope(projectId))
      });
      ctx.mcp.instruct(({ projectId }) => syncInstructions(this.syncScope(projectId)));
      // Terminals the user still has open from before a restart keep calling with their tokens; bind those again.
      for (const projectId of this.ctx.db.openIds()) this.rebindSessions(projectId);
      ctx.on("db/opened", (projectId) => this.rebindSessions(projectId));
    });
    this.ctx.on("write/committed", (intent) => {
      if (intent.entity !== "item" || intent.op !== "update") return;
      const before = intent.before as Item | null;
      const after = intent.after as Item | null;
      if (!before || !after || before.status === after.status) return;
      if (after.status === "done") this.archiveCompletedSessions(intent.projectId);
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
      for (const projectId of this.ctx.db.openIds()) this.archiveCompletedSessions(projectId);
      ctx.on("db/opened", (projectId) => this.archiveCompletedSessions(projectId));
      ctx.on("storage/imported", (projectId) => this.archiveCompletedSessions(projectId));
      for (const playbook of PLAYBOOKS) ctx.agent.playbook(playbook);
      // A thread on a ticket is one Start opened.
      ctx.agent.threadOrigins((_projectId, threads) => threads.filter((th) => th.itemId).map((th) => [th.id, this.words().origin] as [string, string]));
      ctx.on("agent/run-started", (_run, thread) => {
        this.running.set(thread.id, thread);
        const session = this.sessionOf(thread);
        if (session) this.sessions.touch(thread.projectId, session.id, { state: "running", activity: null });
      });
      // A permission question mid-run holds the run's clock and can wait for hours:
      // the session says it is waiting for the person, and runs again once answered.
      ctx.on("agent/event", (threadId, event) => {
        if (event.type !== "pending") return;
        const thread = this.running.get(threadId);
        const session = thread && this.sessionOf(thread);
        if (!thread || !session) return;
        if (event.pending) this.sessions.touch(thread.projectId, session.id, { state: "waiting", activity: event.pending.kind === "permission" ? this.words().needsApproval : this.words().askingYou });
        else if (session.state === "waiting") this.sessions.touch(thread.projectId, session.id, { state: "running", activity: null });
      });
      ctx.on("agent/run-ended", (run, thread) => {
        this.running.delete(thread.id);
        this.archiveCompletedSessions(thread.projectId);
        const session = this.sessionOf(thread);
        if (!session) return;
        const externalId = ctx.agent.store.external(thread.projectId, thread.id)[run.engine];
        if (run.error && classifyRemoteFailure(run.error) === "credentials" && /\bgit\b|\bgh\b|origin|repository|github/i.test(run.error)) {
          this.sessions.blockCredentials(thread.projectId, session.id, run.error, { ...(externalId ? { externalId } : {}) });
          return;
        }
        // a run that failed is stuck until someone looks, not idle — unless it only waits for a limit Tomrade will see out
        const park = run.error ? ctx.agent.parked(thread.projectId, thread.id) : null;
        this.sessions.touch(thread.projectId, session.id, {
          state: run.stop === "asked" ? "waiting" : park?.resume ? "idle" : run.error ? "error" : "idle",
          activity: null,
          ...(externalId ? { externalId } : {}),
          ...(park ? { summary: this.limitedWords(park.until, park.known, park.resume) } : run.error ? { summary: `stopped: ${run.error.slice(0, 200)}` } : {})
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
      ctx.ipc.handle("codeLink.recheckRemote", (projectId, repoId) => ctx.codeLink.recheckRemote(projectId, repoId));
      ctx.ipc.handle("codeLink.setRepoPolicy", (projectId, repoId, patch) => ctx.codeLink.setRepoPolicy(projectId, repoId, patch));
      ctx.ipc.handle("codeLink.mergeChecks", (projectId, repoId) => ctx.codeLink.mergeChecks(projectId, repoId));
      ctx.ipc.handle("codeLink.allowMerge", (projectId, repoId, engineId) => ctx.codeLink.allowMerge(projectId, repoId, engineId));
      ctx.ipc.handle("codeLink.start", (projectId, itemId, opts) => ctx.codeLink.start(projectId, itemId, opts));
      ctx.ipc.handle("codeLink.sessions", (projectId, itemId) => ctx.codeLink.sessionsOf(projectId, itemId));
      ctx.ipc.handle("codeLink.openPr", (projectId, itemId) => ctx.codeLink.openPr(projectId, itemId));
      ctx.ipc.handle("codeLink.mergeLocal", (projectId, itemId) => ctx.codeLink.mergeLocal(projectId, itemId));
      ctx.ipc.handle("codeLink.worktree", (projectId, itemId) => ctx.codeLink.worktreeOf(projectId, itemId));
      ctx.ipc.handle("codeLink.adoptBranch", (projectId, repoId, branch) => ctx.codeLink.adoptBranch(projectId, repoId, branch));
      ctx.ipc.handle("codeLink.connection", (projectId, repoId) => ctx.codeLink.connection(projectId, repoId));
      ctx.ipc.handle("codeLink.connect", (projectId, repoId) => ctx.codeLink.connect(projectId, repoId));
      ctx.ipc.handle("codeLink.setupInTerminal", (engineId, step) => ctx.codeLink.setupInTerminal(engineId, step));
      ctx.ipc.handle("codeLink.startDefaults", () => ctx.codeLink.startDefaults());
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

  /** A ticket's code as one read for whoever is not looking at the desktop: an IM card, an agent asking. */
  summary(projectId: string, itemId: string): CodeSummaryView {
    const delivery = this.store.currentDelivery(projectId, itemId);
    const current = this.currentLinks(projectId, itemId);
    const primary = primaryOf(current);
    const links = primary ? [primary, ...current.filter((l) => l.id !== primary.id)] : [];
    const sessions = this.store.sessions(projectId, { itemId, ...(delivery ? { delivery: delivery.sequence } : {}) });
    const live = sessions.find((s) => s.state !== "ended") ?? null;
    return {
      delivery: delivery ? { sequence: delivery.sequence, state: delivery.state } : null,
      links: links.map((l) => ({
        repo: this.ctx.repos.get(projectId, l.repoId)?.name ?? l.repoId,
        branch: l.branch || null,
        ahead: l.ahead,
        behind: l.behind,
        prNumber: l.prNumber,
        prUrl: l.prUrl,
        prState: l.prState,
        mergedSha: l.mergedSha,
        lastCommitAt: l.headAt
      })),
      session: live
        ? { id: live.id, mode: live.mode, agent: live.agent, state: live.state, summary: live.summary, activity: live.activity, blocked: live.blocked, threadId: live.threadId, worktree: live.worktree, lastEventAt: live.lastEventAt ?? live.startedAt }
        : null,
      proposals: this.store.proposals(projectId, itemId, "open").map((p) => ({ id: p.id, kind: p.kind, toStatus: p.toStatus, reason: p.reason }))
    };
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
    if (githubHttps(remote) && await this.ctx.github.usesHelper(this.git, checkout)) {
      const account = await this.githubAccount();
      return { host: "github.com", login: account?.replace(/^@/, "") ?? null, tomrade: true };
    }
    return readRemoteIdentity(this.git, checkout, remote);
  }

  private githubAccount(): Promise<string | null> {
    return this.ctx.github.account().catch(() => null);
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
    await this.ctx.github.installHelper(this.git, checkout);
    return this.probeAndRecord(projectId, repoId, checkout, repo.defaultBranch);
  }

  async recheckRemote(projectId: string, repoId: string): Promise<RepoStateView> {
    const repo = this.ctx.repos.get(projectId, repoId);
    const checkout = repo ? this.ctx.repos.checkout(repo.remote).checkout : null;
    if (!repo || !checkout || !fs.existsSync(checkout)) throw new Error("Choose this repository's checkout first.");
    await this.migrateCredentialHelpers(projectId);
    return this.probeAndRecord(projectId, repoId, checkout, repo.defaultBranch);
  }

  private async probeAndRecord(projectId: string, repoId: string, checkout: string, branch: string): Promise<RepoStateView> {
    await this.inFlight.get(projectId);
    const probe = await probeRemote(this.git, checkout, branch);
    const reachable = probe.state !== "offline";
    const state = this.store.upsertRepoState(projectId, repoId, {
      remote: reachable ? "ok" : "unreachable",
      remoteDetail: probe.detail,
      ...(reachable ? { remoteAt: Date.now() } : {})
    });
    if (reachable) {
      for (const session of this.store.sessions(projectId, { live: true })) {
        if (session.repoId === repoId && session.blocked === "credentials") this.store.patchSession(projectId, session.id, { blocked: null, state: "idle", activity: null });
      }
    }
    this.notify(projectId);
    return state;
  }

  sessionsOf(projectId: string, itemId?: string): SessionView[] {
    return this.store.sessions(projectId, itemId ? { itemId } : {});
  }

  /**
   * A finished ticket's work is put away once: its sessions end, and its threads — with a session or
   * without one — go to the archive. A running thread waits for its run to end; a thread a person
   * brought back from the archive stays where they put it.
   */
  private archiveCompletedSessions(projectId: string): void {
    const agent = this.ctx.get("agent");
    if (!agent) return;
    const running = new Set(agent.activeRuns().map(({ thread }) => thread.id));
    const done = (itemId: string) => this.ctx.items.get(projectId, itemId)?.status === "done";
    const sessions = this.store.sessions(projectId);
    let changed = false;
    for (const session of sessions) {
      // Shared sessions stay available while any associated ticket still needs work.
      if (session.state === "ended" || !session.itemIds.length || !session.itemIds.every(done)) continue;
      if (session.threadId && running.has(session.threadId)) continue;
      this.sessions.end(projectId, session.id, "ended", true);
      changed = true;
    }
    for (const thread of agent.store.threads(projectId, null)) {
      if (!thread.itemId || thread.restored || running.has(thread.id)) continue;
      const shared = sessions.filter((session) => session.threadId === thread.id).flatMap((session) => session.itemIds);
      if (![thread.itemId, ...shared].every(done)) continue;
      agent.archiveThread(projectId, thread.id);
      changed = true;
    }
    if (changed) this.notify(projectId);
  }

  lastScanAt(projectId: string): number | null {
    return this.scannedAt.get(projectId) ?? null;
  }

  /** This machine's worktree for the ticket's most recent thread, if one was started here. */
  /** Only a command an engine declares can be run this way; the page names the engine and the step, never the command. */
  async setupInTerminal(engineId: string, step: "install" | "signIn"): Promise<{ launched: boolean; command: string }> {
    const setup = (await this.ctx.get("agent")?.engineViews())?.find((e) => e.id === engineId)?.setup;
    const command = step === "install" ? setup?.install[0] : setup?.signIn;
    if (!command) throw new Error(`${engineId} has no ${step} command`);
    const settings = TerminalSettings.parse(this.ctx.settings.get().codeLink ?? {});
    const { launched } = await setupTerminal(command, path.join(this.sessionDir("setup"), engineId), settings.terminal);
    return { launched, command };
  }

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
    if (!engine.commands?.allow) throw new Error(`${engine.title}'s settings cannot be changed from Tomrade — allow gh pr merge there yourself`);
    return { engine: engine.id, title: engine.title, check: await this.mergeCheck(projectId, repoId, engineId, true) };
  }

  private async mergeCheck(projectId: string, repoId: string, engineId: string, allow: boolean): Promise<CommandCheck | null> {
    const repo = this.ctx.repos.get(projectId, repoId);
    if (!repo) throw new Error(`unknown repository ${repoId}`);
    const engine = this.ctx.get("agent")?.codeEngines().find((e) => e.id === engineId);
    if (!engine?.commands) return null;
    const placement = this.ctx.repos.checkout(repo.remote);
    const remembered = this.defaults.read();
    const permissionMode = remembered?.engine === engineId && remembered.permissionMode ? remembered.permissionMode : engine.permissionModes?.default;
    const opts = { cwd: placement.checkout ?? null, worktree: !placement.runInCheckout, ...(permissionMode ? { permissionMode } : {}) };
    return allow && engine.commands.allow ? engine.commands.allow(MERGE_COMMAND, opts) : engine.commands.check(MERGE_COMMAND, opts);
  }

  /** Start or continue a ticket with a local agent — headless here or in the user's terminal, coding or General. See `Starter` for the gates. */
  async start(projectId: string, itemId: string, opts: StartOptions): Promise<StartResult> {
    const result = await this.starter.start(projectId, itemId, opts);
    // Only what actually started is remembered, with the engine it settled on: a gate the user had to
    // clear leaves the memory as it was, and an engine the caller left to Tomrade is not lost.
    if (result.ok) this.defaults.write({ mode: opts.mode, engine: result.engine, options: opts.options, permissionMode: opts.permissionMode, playbook: opts.playbook });
    return result;
  }

  /** What the Start dialog last ran with on this machine; null when nothing usable is remembered. */
  startDefaults(): StartDefaultsView | null {
    return this.defaults.read();
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

  /** A session took a ticket on — its first, another beside it, or (`replace`) the next once the last is finished. */
  attach(projectId: string, sessionId: string, itemId: string, branch: string, delivery: number, opts: { replace?: boolean } = {}): void {
    const session = this.store.session(projectId, sessionId);
    if (!session) return;
    // A new delivery is new work: the branch merged in the last one must not be read as this one's.
    const fresh = opts.replace || (session.itemIds.includes(itemId) && session.delivery !== delivery);
    this.store.patchSession(projectId, sessionId, {
      delivery,
      itemIds: opts.replace ? [itemId] : session.itemIds.includes(itemId) ? session.itemIds : [...session.itemIds, itemId],
      ...(session.branch && !fresh ? {} : { branch }),
      ...(session.state === "ended" ? {} : { state: "running" as const }),
      lastEventAt: Date.now()
    });
    this.notify(projectId);
  }

  /**
   * The hooks session a tokenless claim most likely comes from: the latest live
   * one on that repository that holds no ticket and no client's connection yet.
   * Never one that already holds a ticket — that is another terminal's.
   */
  externalSession(projectId: string, repoId: string): SessionView | null {
    const taken = new Set([...this.connections.values()].filter((c) => c.projectId === projectId).flatMap((c) => c.sessionIds));
    return this.store.sessions(projectId, { live: true }).find((s) => s.repoId === repoId && s.threadId === null && s.state !== "lost" && !s.itemIds.length && !taken.has(s.id)) ?? null;
  }

  /** The live session an outside client's connection last claimed for, if any: the one its calls without a key mean. */
  connected(projectId: string, connection: string): SessionView | null {
    const sessions = this.connectedSessions(projectId, connection);
    return sessions.find((s) => s.id === this.connections.get(connection)?.current) ?? null;
  }

  /** Every live session an outside client's connection claimed for; the ones that ended are let go. */
  connectedSessions(projectId: string, connection: string): SessionView[] {
    const bound = this.connections.get(connection);
    if (!bound || bound.projectId !== projectId) return [];
    const live = bound.sessionIds.map((id) => this.store.session(projectId, id)).filter((s): s is SessionView => !!s && s.endedAt === null && s.state !== "ended" && s.state !== "lost");
    if (!live.length) this.connections.delete(connection);
    else if (live.length !== bound.sessionIds.length) {
      const ids = live.map((s) => s.id);
      this.connections.set(connection, { projectId, sessionIds: ids, current: ids.includes(bound.current) ? bound.current : ids[ids.length - 1] });
    }
    return live;
  }

  /**
   * From now on this connection's calls without a key belong to the session; a connection it had before is let go.
   * The connection keeps the other sessions it works tickets in, except the one it is `leaving` for this one.
   */
  bindConnection(projectId: string, connection: string, sessionId: string, leaving?: string): void {
    for (const [other, bound] of this.connections) {
      if (other === connection || !bound.sessionIds.includes(sessionId)) continue;
      const rest = bound.sessionIds.filter((id) => id !== sessionId);
      if (!rest.length) this.connections.delete(other);
      else this.connections.set(other, { ...bound, sessionIds: rest, current: bound.current === sessionId ? rest[rest.length - 1] : bound.current });
    }
    const held = this.connections.get(connection);
    const kept = held?.projectId === projectId ? held.sessionIds.filter((id) => id !== sessionId && id !== leaving) : [];
    this.connections.set(connection, { projectId, sessionIds: [...kept, sessionId], current: sessionId });
  }

  boundAnywhere(sessionId: string): boolean {
    return [...this.connections.values()].some((c) => c.sessionIds.includes(sessionId));
  }

  /**
   * A session for a client that reports no hooks — Cursor, Gemini CLI, any MCP
   * client: followed only through its connection, so its notes and merge
   * hand-offs still reach the ticket. It ends when the connection closes.
   */
  connectionSession(projectId: string, repoId: string | null, worktree: string | null = null): SessionView {
    return this.store.createSession(projectId, { repoId: repoId ?? "", branch: "", itemIds: [], mode: "terminal", agent: MCP_AGENT, threadId: null, device: this.ctx.hub.deviceId, worktree });
  }

  /**
   * An outside agent that handed its ticket's merge to the person goes on to the next ticket as a
   * new session with the same identity, so its hooks and calls follow the new one (the newest is
   * matched first). The one it leaves keeps the ticket and the merge waiting on the person.
   */
  successor(projectId: string, from: SessionView, repoId: string | null, worktree: string | null = null): SessionView {
    return this.store.createSession(projectId, { repoId: repoId ?? from.repoId, branch: "", itemIds: [], mode: from.mode, agent: from.agent, threadId: null, device: this.ctx.hub.deviceId, externalId: from.externalId, worktree });
  }

  /**
   * A session another one took over from: nothing reaches it any more, so once its merge lands it is over.
   * Two sessions of one agent working in worktrees of their own run side by side; neither took over from the other.
   */
  private superseded(projectId: string, s: SessionView): boolean {
    if (s.threadId !== null) return false;
    const apart = (o: SessionView) => !!s.worktree && !!o.worktree && s.worktree !== o.worktree;
    if (s.externalId) return this.store.sessions(projectId, { live: true }).some((o) => o.id !== s.id && o.agent === s.agent && o.externalId === s.externalId && o.startedAt >= s.startedAt && !apart(o));
    return s.agent === MCP_AGENT && !this.boundAnywhere(s.id);
  }

  private disconnected(connection: string): void {
    const bound = this.connections.get(connection);
    if (!bound) return;
    this.connections.delete(connection);
    // A hooks session ends when its agent says so; one known only by its connection ends with it.
    for (const id of bound.sessionIds) {
      const session = this.store.session(bound.projectId, id);
      if (session?.agent === MCP_AGENT && !this.boundAnywhere(session.id)) this.sessions.end(bound.projectId, session.id);
    }
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

  async connection(projectId: string, repoId: string): Promise<ConnectionView> {
    const repo = this.ctx.repos.get(projectId, repoId);
    if (!repo) throw new Error(`unknown repository ${repoId}`);
    const mcp = this.ctx.get("mcp");
    const mcpUrl = mcp?.urlFor(projectId) ?? null;
    const branch = "tomrade/connect";
    const base = { mcpUrl, configuredUrl: null, instance: mcp?.badge().kind ?? "dev", branch, url: null, agents: [] as AgentConnectionView[] } as const;
    if (!mcpUrl || !mcp?.eventUrl) return { ...base, state: "unavailable" };
    const cwd = this.ctx.repos.checkout(repo.remote).checkout;
    if (!cwd || !fs.existsSync(cwd)) return { ...base, state: "no-checkout" };
    const exists = async (ref: string) => (await this.git(["rev-parse", "--verify", "--quiet", ref], { cwd, ok: true })).code === 0;
    const local = `refs/heads/${repo.defaultBranch}`;
    const remote = `refs/remotes/origin/${repo.defaultBranch}`;
    const hasLocal = await exists(local);
    const hasRemote = await exists(remote);
    // Prefer local work that is ahead; otherwise use the latest fetched default branch.
    const ref = hasLocal && (!hasRemote || (await this.git(["merge-base", "--is-ancestor", remote, local], { cwd, ok: true })).code === 0) ? local : remote;
    const current = await inspectConnection(this.git, cwd, ref, mcpUrl, mcp.eventUrl);
    const configuredUrl = current.configuredUrl;
    if (current.connected) {
      const link = this.ctx.get("agent")?.engineOf("claude-code")?.mcpLink;
      const claudeApproval = link?.projectApproval?.(cwd);
      const claudeApprovals = link?.projectApprovals?.(cwd);
      return { ...base, agents: current.agents, configuredUrl, state: "connected", ...(claudeApproval ? { claudeApproval } : {}), ...(claudeApprovals ? { claudeApprovals } : {}) };
    }
    for (const pendingRef of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      if (!(await exists(pendingRef))) continue;
      if ((await this.git(["merge-base", "--is-ancestor", pendingRef, ref], { cwd, ok: true })).code === 0) continue;
      const pending = await inspectConnection(this.git, cwd, pendingRef, mcpUrl, mcp.eventUrl);
      if (pending.connected) return { ...base, agents: pending.agents, configuredUrl, state: "pending", url: compareUrl(repo.remote, repo.defaultBranch, branch) };
    }
    return { ...base, agents: current.agents, configuredUrl, state: configuredUrl && configuredUrl !== mcpUrl ? "other-instance" : "unconnected" };
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
    const mcp = this.ctx.get("mcp");
    if (!mcp?.url) throw new Error("the MCP server is not running — enable the mcp plugin");
    const placement = this.ctx.repos.checkout(repo.remote);
    if (!placement.checkout || !fs.existsSync(placement.checkout)) throw new Error(`no checkout of ${repo.name} on this machine`);

    const branch = "tomrade/connect";
    const w = this.words();
    await new GitFolder(this.git, placement.checkout).fetch(repo.defaultBranch);
    const connection = await this.connection(projectId, repoId);
    if (connection.state === "connected") {
      return { branch, agents: connection.agents, files: [], committed: false, pushed: false, url: null, message: w.connected };
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-connect-"));
    const worktree = path.join(temporary, "repo");
    const exists = async (ref: string) => (await this.git(["rev-parse", "--verify", "--quiet", ref], { cwd: placement.checkout!, ok: true })).code === 0;
    const base = await exists(`refs/remotes/origin/${repo.defaultBranch}`) ? `origin/${repo.defaultBranch}` : repo.defaultBranch;
    try {
      if (await exists(`refs/heads/${branch}`)) await this.git(["worktree", "add", worktree, branch], { cwd: placement.checkout });
      else if (await exists(`refs/remotes/origin/${branch}`)) await this.git(["worktree", "add", "-b", branch, worktree, `origin/${branch}`], { cwd: placement.checkout });
      else if (await exists(base)) await this.git(["worktree", "add", "-b", branch, worktree, base], { cwd: placement.checkout });
      else await this.git(["worktree", "add", "--orphan", "-b", branch, worktree], { cwd: placement.checkout });
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    const state = this.store.repoState(projectId, repoId);
    const project = this.ctx.db.for(projectId).prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
    try {
      if (await exists(base)) await this.git(["merge", "--no-edit", base], { cwd: worktree });
      const files = writeConnectFiles(worktree, {
        projectName: project?.name ?? "Tomrade project",
        mcpUrl: mcp.urlFor(projectId)!,
        eventUrl: mcp.eventUrl!,
        prefix: this.prefixOf(projectId),
        branchTemplate: state?.branchTemplate ?? "{key}/{slug}"
      });
      const agents = inspectConnectFiles(worktree, mcp.urlFor(projectId)!, mcp.eventUrl!).agents;
      const folder = new GitFolder(this.git, worktree);
      const committed = files.length > 0 && (await folder.commit("Connect this repository to Tomrade\n\nProject MCP config lets Claude Code, Codex and WorkBuddy discover Tomrade, a project extension does it for Pi, agent instructions describe the ticket conventions, and their hooks report session lifecycle back."));

      if (!(await folder.remoteUrl())) return { branch, agents, files, committed, pushed: false, url: null, message: w.connectLocal(branch, repo.defaultBranch) };
      if (state && !state.agentPush) return { branch, agents, files, committed, pushed: false, url: null, message: w.connectPushOff(branch) };
      const pushed = (await this.git(["push", "-q", "-u", "origin", `HEAD:refs/heads/${branch}`], { cwd: worktree, ok: true })).code === 0;
      if (!pushed) return { branch, agents, files, committed, pushed: false, url: null, message: w.connectPushFailed(branch) };
      let url: string | null = null;
      let created = false;
      if (await commandOk("gh")) {
        const env = await this.ctx.github.environment(this.git, worktree);
        try {
          url = (await exec("gh", ["pr", "create", "--head", branch, "--base", repo.defaultBranch, "--title", "Connect this repository to Tomrade", "--body", `Adds ${files.join(", ")} to connect agent tools and Claude Code/Codex/WorkBuddy/Pi lifecycle reports. Review Codex hooks with /hooks after merging.`], worktree, env)).trim().split("\n").pop() ?? null;
          created = !!url;
        } catch {
          try {
            url = (await exec("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"], worktree, env)).trim() || null;
          } catch {
            url = null;
          }
        }
      }
      url ??= compareUrl(repo.remote, repo.defaultBranch, branch);
      this.notify(projectId);
      return { branch, agents, files, committed, pushed, url, message: created ? w.connectOpened : w.connectPushed(branch) };
    } finally {
      await this.git(["worktree", "remove", "--force", worktree], { cwd: placement.checkout, ok: true });
      fs.rmSync(temporary, { recursive: true, force: true });
      this.notify(projectId);
    }
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
    if (!open.length) return no(w.mergeNoBranch(item.key));
    if (open.length > 1) return no(w.mergeMany(item.key));
    const link = open[0]!;
    const repo = this.ctx.repos.get(projectId, link.repoId);
    if (!repo) return no(w.mergeNoBranch(item.key));
    const base = repo.defaultBranch;
    if (link.branch === base) return no(w.mergeNoBranch(item.key));
    const checkout = this.ctx.repos.checkout(repo.remote).checkout;
    if (!checkout || !fs.existsSync(checkout)) return no(w.mergeNoCheckout(repo.name));
    if (await new GitFolder(this.git, checkout).remoteUrl()) return no(w.mergeHasRemote(repo.name));
    if (opts.agent && !this.store.repoState(projectId, repo.id)?.agentMerge) return no(w.mergeAgentOff(repo.name));

    const list = await this.git(["worktree", "list", "--porcelain"], { cwd: checkout, ok: true });
    const holder = list.stdout.split("\n\n").map((block) => ({ path: /^worktree (.+)$/m.exec(block)?.[1], branch: /^branch (.+)$/m.exec(block)?.[1] })).find((b) => b.branch === `refs/heads/${base}`)?.path;
    let cwd = holder;
    let temporary: string | null = null;
    if (cwd) {
      const dirty = await this.git(["status", "--porcelain", "--untracked-files=no"], { cwd, ok: true });
      if (dirty.code !== 0 || dirty.stdout.trim()) return no(w.mergeDirty(base, cwd));
    } else {
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-merge-"));
      cwd = path.join(temporary, "repo");
      const added = await this.git(["worktree", "add", "-q", cwd, base], { cwd: checkout, ok: true });
      if (added.code !== 0) {
        fs.rmSync(temporary, { recursive: true, force: true });
        return no(w.mergeFailed(lastLine(added.stderr)));
      }
    }
    try {
      const head = async () => (await this.git(["rev-parse", "HEAD"], { cwd: cwd! })).stdout.trim();
      let message: string;
      if ((await this.git(["merge-base", "--is-ancestor", link.branch, "HEAD"], { cwd, ok: true })).code === 0) {
        message = w.mergeAlready(link.branch, base);
      } else {
        // The subject leads with the key, so the commit also reads as this ticket's on any later scan.
        const merged = await this.git(["merge", "--no-ff", "-m", `${item.key}: ${item.title}`, "-m", `Merge branch '${link.branch}'`, link.branch], { cwd, ok: true });
        if (merged.code !== 0) {
          const conflicted = (await this.git(["diff", "--name-only", "--diff-filter=U"], { cwd, ok: true })).stdout.trim().split("\n").filter(Boolean);
          await this.git(["merge", "--abort"], { cwd, ok: true });
          return no(conflicted.length ? w.mergeConflict(link.branch, base, conflicted.join(", ")) : w.mergeFailed(lastLine(merged.stderr || merged.stdout)));
        }
        message = "";
      }
      const sha = await head();
      this.store.patchLink(projectId, link.id, { mergedSha: sha, ahead: 0 });
      this.reevaluate(projectId, itemId, repo.id);
      this.notify(projectId);
      return { merged: true, sha, message: message || w.mergeDone(link.branch, base, sha.slice(0, 7)) };
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
        void this.scan(projectId).catch(() => {});
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

  // ── the scan ───────────────────────────────────────────────────────────────

  /** Repoint every checkout still naming a Hub helper at the userData one. Idempotent, so a later scan catches one that appears late. */
  private async migrateCredentialHelpers(projectId: string): Promise<void> {
    for (const repo of this.ctx.repos.list(projectId)) {
      const checkout = this.ctx.repos.checkout(repo.remote).checkout;
      if (!checkout || !fs.existsSync(checkout)) continue;
      try {
        await this.ctx.github.migrateHelper(this.git, checkout);
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

  /** A pass that sees a change made just now: it waits out a running pass, which may have started before the change. */
  private rescan(projectId: string): Promise<ScanSummary> {
    const running = this.inFlight.get(projectId);
    return (running ? running.catch(() => undefined) : Promise.resolve()).then(() => this.scan(projectId));
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
    this.archiveCompletedSessions(projectId);
    const summary: ScanSummary = { repos: 0, scanned: 0, offline: 0, links: 0, changed: 0, proposals: 0, skipped: [] };
    const prefix = this.prefixOf(projectId);
    try {
      await this.ctx.repos.adoptOrigins(projectId);
    } catch (err) {
      this.ctx.logger.warn(`adopting new origins in ${projectId} failed: ${message(err)}`);
    }
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
        // Nothing here can be read from git, but GitHub can still say what became of its pull requests.
        const outcome = await this.settlePulls(projectId, repo);
        this.releaseMerged(projectId, repo.id);
        summary.changed += outcome.changed;
        summary.proposals += outcome.proposals;
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
          if (session.repoId === repo.id && session.blocked === "credentials") this.store.patchSession(projectId, session.id, { blocked: null, state: "idle", activity: null });
        }
      }
      const outcome = await this.absorb(projectId, repo, result, before?.autoDone ?? true, now, unlinked);
      this.releaseMerged(projectId, repo.id);
      summary.links += outcome.links;
      summary.changed += outcome.changed;
      summary.proposals += outcome.proposals;
    }
    for (const item of this.ctx.items.list({ projectId })) this.closeEmptyScannedDelivery(projectId, item, now);
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
        // A recreated branch is not a request to reopen a closed ticket.
        if (!target && (item.status === "done" || item.status === "cancelled")) continue;
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

    // A branch the scan once linked for a mention (another ticket's branch, a commit naming this one in passing)
    // is not this ticket's work; left in, its unmerged commits hold "every link merged" open for good.
    for (const l of previous.values()) {
      if (seen.has(l.id) || l.source !== "scan" || !l.branch || l.mergedSha || l.prNumber !== null || l.prUrl || l.prState || l.threadId) continue;
      const b = result.branches.find((x) => x.name === l.branch);
      const item = this.ctx.items.get(projectId, l.itemId);
      if (!b || b.ahead === 0 || !item || b.keyNums.includes(item.keyNum)) continue;
      if (l.delivery !== this.store.activeDelivery(projectId, item.id)?.sequence) continue;
      if (this.store.sessions(projectId, { itemId: item.id, delivery: l.delivery }).some((session) => session.branch === l.branch)) continue;
      this.store.removeLink(projectId, l.id);
      touched.add(item.id);
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

    // A branch deleted after its merge, or one whose ticket commits landed through
    // another branch, never reads as merged above: settle it from the commits it
    // last pointed at, which stay in the clone after a prune.
    if (result.defaultSha) {
      const prefix = this.prefixOf(projectId);
      const cwd = this.ctx.repos.checkout(repo.remote).checkout!;
      for (const l of previous.values()) {
        if (seen.has(l.id) || l.mergedSha || !l.branch || !l.headSha || l.ahead === 0) continue;
        const item = this.ctx.items.get(projectId, l.itemId);
        if (!item || l.delivery !== this.store.activeDelivery(projectId, item.id)?.sequence) continue;
        const sha = result.branches.find((b) => b.name === l.branch)?.sha ?? l.headSha;
        const log = await this.git(["log", "--format=%s%x1f%b%x1e", `${result.defaultSha}..${sha}`], { cwd, ok: true });
        if (log.code !== 0) continue;
        // A branch named for the ticket is all its work; one found by commit keys owes only the commits naming it.
        const pending = parseBranch(l.branch, prefix) === item.keyNum ? !!log.stdout.trim() : keysInText(log.stdout, prefix).includes(item.keyNum);
        if (pending) continue;
        this.store.patchLink(projectId, l.id, { mergedSha: result.defaultSha, ...(l.prState === "open" ? { prState: "merged" as const } : {}) });
        touched.add(item.id);
      }
    }

    // A branch the scan saw with nothing of its own (renamed away, cut and dropped) and gone since was
    // never part of the work; left in, it would hold the delivery's "every link merged" open for good.
    // Only beside another link, and never one an agent, a session or a pull request named.
    if (!result.offline) {
      for (const l of previous.values()) {
        if (seen.has(l.id) || l.source !== "scan" || !l.branch || l.ahead > 0 || l.mergedSha || l.prNumber !== null || l.prUrl || l.prState || l.threadId) continue;
        if (result.branches.some((b) => b.name === l.branch)) continue;
        const item = this.ctx.items.get(projectId, l.itemId);
        if (!item || l.delivery !== this.store.activeDelivery(projectId, item.id)?.sequence) continue;
        if (!this.store.links(projectId, item.id).some((o) => o.id !== l.id && o.delivery === l.delivery)) continue;
        this.store.removeLink(projectId, l.id);
        touched.add(item.id);
      }
      // A claim's suggested branch left beside the pull request the work went into, from before link_code dropped it.
      for (const l of this.store.linksForRepo(projectId, repo.id)) {
        if (l.source !== "mcp" || !l.branch || (l.prNumber === null && !l.prUrl)) continue;
        if (l.delivery !== this.store.activeDelivery(projectId, l.itemId)?.sequence) continue;
        if (this.dropSuggested(projectId, l.itemId, repo.id, l.branch, (name) => result.branches.some((b) => b.name === name))) touched.add(l.itemId);
      }
    }

    for (const item of items) this.closeEmptyScannedDelivery(projectId, item, now, repo.id);

    // A link's pull request is settled by what GitHub says about it; the commit-message rules
    // below are for links it cannot answer for (no pull request, not GitHub, no account, offline).
    const answered = new Set<string>();
    if (result.defaultRef) {
      const cwd = this.ctx.repos.checkout(repo.remote).checkout!;
      for (const { link: l, item, pull } of await this.askPulls(projectId, repo, cwd)) {
        if (pull.merged && pull.mergeSha) {
          // Merged into the default branch, or into another branch that has not reached it yet.
          const landed = await this.git(["merge-base", "--is-ancestor", pull.mergeSha, result.defaultRef], { cwd, ok: true });
          if (landed.code > 1) continue; // the merge commit is not here yet: the local rules decide
          answered.add(l.id);
          if (landed.code === 0) {
            this.store.patchLink(projectId, l.id, { mergedSha: pull.mergeSha, prState: "merged" });
            touched.add(item.id);
          }
        } else {
          answered.add(l.id);
          if (pull.state === "closed") {
            this.store.patchLink(projectId, l.id, { prState: "closed" });
            touched.add(item.id);
          }
        }
      }
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
          if (answered.has(l.id)) continue;
          // A ticket mention in a squash commit cannot identify which of
          // several branches was merged. Multi-link deliveries require
          // branch ancestry or explicit PR evidence for each link.
          if (own.length > 1 && (l.prNumber === null || l.prNumber !== subjectPr(commit.subject))) continue;
          if (!l.mergedSha || l.prState === "open") {
            this.store.patchLink(projectId, l.id, { ...(!l.mergedSha ? { mergedSha: commit.sha } : {}), ...(l.prState === "open" ? { prState: "merged" as const } : {}) });
          }
        }
      } else {
        this.store.upsertLink(projectId, { itemId: item.id, repoId: repo.id, branch: "", delivery: active.sequence }, { headSha: commit.sha, headAt: commit.at, mergedSha: commit.sha, lastSeenAt: now, source: "scan" });
      }
      touched.add(item.id);
    }

    // Without GitHub's answer: a squash merge never makes the branch an ancestor of the default
    // branch, and a scan that read its commit before the links settled will not read it again,
    // so look for the pull request's own commit, `… (#N)`, wherever it is.
    if (result.defaultRef) {
      const cwd = this.ctx.repos.checkout(repo.remote).checkout!;
      for (const l of this.store.linksForRepo(projectId, repo.id)) {
        if (l.prNumber === null || l.mergedSha || l.prState === "closed" || answered.has(l.id)) continue;
        const item = this.ctx.items.get(projectId, l.itemId);
        if (!item || l.delivery !== this.store.activeDelivery(projectId, item.id)?.sequence) continue;
        const log = await this.git(["log", "--format=%H%x1f%s", "-n", "20", "--fixed-strings", `--grep=#${l.prNumber}`, result.defaultRef], { cwd, ok: true });
        if (log.code !== 0) continue;
        const sha = log.stdout.split("\n").map((line) => line.split("\x1f")).find(([, subject]) => subjectPr(subject ?? "") === l.prNumber)?.[0];
        if (!sha) continue;
        this.store.patchLink(projectId, l.id, { mergedSha: sha, prState: "merged" });
        touched.add(item.id);
      }
    }

    // A branch carrying the commits of a sibling whose pull request was squash-merged never reads as merged
    // above: those commits never reach the default branch. With nothing past the merged head, it landed too.
    if (result.defaultRef) {
      const cwd = this.ctx.repos.checkout(repo.remote).checkout!;
      for (const l of this.store.linksForRepo(projectId, repo.id)) {
        if (l.mergedSha || !l.branch || !l.headSha || l.ahead === 0 || l.prNumber !== null || l.prUrl || l.prState) continue;
        if (l.delivery !== this.store.activeDelivery(projectId, l.itemId)?.sequence) continue;
        const sha = result.branches.find((b) => b.name === l.branch)?.sha ?? l.headSha;
        const siblings = this.store.links(projectId, l.itemId).filter((o) => o.id !== l.id && o.repoId === repo.id && o.delivery === l.delivery && o.mergedSha && o.headSha);
        let carrier: CodeLinkView | undefined;
        for (const o of siblings) {
          if (o.headSha === sha || (await this.git(["merge-base", "--is-ancestor", sha, o.headSha!], { cwd, ok: true })).code === 0) {
            carrier = o;
            break;
          }
        }
        if (!carrier) continue;
        this.store.patchLink(projectId, l.id, { mergedSha: carrier.mergedSha });
        touched.add(l.itemId);
      }
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

  /** What GitHub says about each unsettled pull request of a repository's current deliveries, asked once per pull request. */
  private async askPulls(projectId: string, repo: Repo, cwd: string | null): Promise<{ link: CodeLinkView; item: Item; pull: ForgePull }[]> {
    const asked = new Map<string, Promise<ForgePull | null>>();
    const out: { link: CodeLinkView; item: Item; pull: ForgePull }[] = [];
    for (const link of this.store.linksForRepo(projectId, repo.id)) {
      if (link.mergedSha || link.prState === "closed" || (link.prNumber === null && !link.prUrl)) continue;
      const item = this.ctx.items.get(projectId, link.itemId);
      if (!item || link.delivery !== this.store.activeDelivery(projectId, item.id)?.sequence) continue;
      const ref = await githubPull(link.prUrl, link.prNumber, repo.remote);
      if (!ref) continue;
      const key = `${ref.repo}#${ref.number}`;
      if (!asked.has(key)) asked.set(key, this.pulls(ref.repo, ref.number, cwd));
      const pull = await asked.get(key)!;
      if (pull) out.push({ link, item, pull });
    }
    return out;
  }

  /**
   * A repository with no checkout here: GitHub alone settles its pull requests. Without the
   * default branch to look in, a merge counts only when GitHub says it went into that branch.
   */
  private async settlePulls(projectId: string, repo: Repo): Promise<{ changed: number; proposals: number }> {
    const touched = new Set<string>();
    for (const { link, item, pull } of await this.askPulls(projectId, repo, null)) {
      if (pull.merged && pull.mergeSha && pull.base === repo.defaultBranch) this.store.patchLink(projectId, link.id, { mergedSha: pull.mergeSha, prState: "merged" });
      else if (!pull.merged && pull.state === "closed") this.store.patchLink(projectId, link.id, { prState: "closed" });
      else continue;
      touched.add(item.id);
    }
    let changed = 0;
    let proposals = 0;
    const autoDone = this.store.repoState(projectId, repo.id)?.autoDone ?? true;
    for (const itemId of touched) {
      const item = this.ctx.items.get(projectId, itemId);
      if (!item) continue;
      const r = this.judge(projectId, item, repo.id, new Map(), new Set(), autoDone);
      changed += r.changed;
      proposals += r.proposals;
    }
    return { changed, proposals };
  }

  /** A merge the agent was refused is over once someone merged it. */
  private releaseMerged(projectId: string, repoId: string): void {
    for (const session of this.store.sessions(projectId, { live: true })) {
      if (session.repoId !== repoId || session.blocked !== "merge") continue;
      const links = session.itemIds.flatMap((id) => this.currentLinks(projectId, id)).filter((l) => l.repoId === repoId);
      if (!links.length || !links.every((l) => !!l.mergedSha || l.prState === "merged")) continue;
      if (this.superseded(projectId, session)) this.sessions.end(projectId, session.id, "ended", true);
      else this.store.patchSession(projectId, session.id, { blocked: null, state: "idle", activity: null });
    }
  }

  private closeEmptyScannedDelivery(projectId: string, item: Item, now: number, repoId?: string): void {
    if (item.status !== "done" && item.status !== "cancelled") return;
    const active = this.store.activeDelivery(projectId, item.id);
    if (!active) return;
    const links = this.store.links(projectId, item.id).filter(link => link.delivery === active.sequence);
    // Cross-repository attempts must wait until every repository has been scanned.
    if (repoId && links.some(link => link.repoId !== repoId)) return;
    if (!links.length || links.some(link => link.source !== "scan" || link.ahead > 0 || link.mergedSha || link.prNumber !== null || link.prUrl || link.prState || link.threadId)) return;
    if (this.store.sessions(projectId, { itemId: item.id, delivery: active.sequence }).length) return;
    if (item.evidence.resources.some(resource => resource.role === "output" && resource.deliveryId === active.id) || item.evidence.submissions.some(submission => submission.deliveryId === active.id)) return;
    // Keep the accidental attempt as cancelled history; it has no delivery evidence.
    this.store.finishActiveDelivery(projectId, item.id, "cancelled", now);
    for (const proposal of this.store.proposalsForDelivery(projectId, item.id, active.sequence, "open")) this.store.setProposalState(projectId, proposal.id, "stale");
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

  /**
   * The branch a claim suggested, once the work is linked on `branch` instead: nothing on it (no commit, no pull
   * request, never seen by a scan), yet it would hold the delivery's "every link merged" open for good. It goes,
   * and the sessions on it move to `branch`. A suggested branch with anything on it is real work and stays.
   */
  dropSuggested(projectId: string, itemId: string, repoId: string, branch: string, present: (name: string) => boolean = () => false): boolean {
    const delivery = this.store.activeDelivery(projectId, itemId);
    if (!delivery || !branch) return false;
    const empty = this.store
      .links(projectId, itemId)
      .filter((l) => l.repoId === repoId && l.delivery === delivery.sequence && l.branch && l.branch !== branch && l.source === "mcp")
      .filter((l) => !l.headSha && l.ahead === 0 && !l.mergedSha && l.prNumber === null && !l.prUrl && !l.prState && !l.threadId && !present(l.branch));
    for (const l of empty) {
      this.store.removeLink(projectId, l.id);
      for (const s of this.store.sessions(projectId, { itemId, delivery: delivery.sequence })) if (s.branch === l.branch) this.store.patchSession(projectId, s.id, { branch });
    }
    return empty.length > 0;
  }

  /** Without a remote there is no pull request: a session's scoped hand-over is the request for review. */
  handOver(projectId: string, itemId: string, repoId: string): void {
    if (this.store.repoState(projectId, repoId)?.remote !== "none") return;
    const item = this.ctx.items.get(projectId, itemId);
    if (!item || item.humanLocked || !["backlog", "todo", "doing"].includes(item.status)) return;
    this.ctx.items.update(projectId, itemId, { status: "verifying" }, AUTHOR);
    this.notify(projectId);
  }

  /** Each workstream's repository and its folder on this machine — what a main conversation reads the code from. */
  repositoriesOf(projectId: string): { workstream: string; name: string; path: string | null; defaultBranch: string }[] {
    return this.ctx.boards.list(projectId).flatMap((board) => {
      const repo = board.repoId ? this.ctx.repos.get(projectId, board.repoId) : null;
      if (!repo) return [];
      const checkout = this.ctx.repos.checkout(repo.remote).checkout;
      const subdir = board.repoPath.replace(/^\/+|\/+$/g, "");
      const folder = checkout && fs.existsSync(checkout) ? (subdir ? path.join(checkout, subdir) : checkout) : null;
      return [{ workstream: board.name, name: repo.name, path: folder, defaultBranch: repo.defaultBranch }];
    });
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

  /** The words the backend writes for the person, in their language at the moment they are written. */
  private limitedWords(until: number, known: boolean, resumes: boolean): string {
    const locale = this.ctx.settings.locale?.() ?? "en";
    return CODE_WORDS[locale].limited(untilLabel(until, locale), known, resumes);
  }

  private words(): CodeWords {
    return CODE_WORDS[this.ctx.settings.locale?.() ?? "en"];
  }

  private contribute(ctx: Context): void {
    ctx.contributions.section({
      id: "code",
      title: () => this.words().section,
      render: (item) => {
        const w = this.words();
        const since = (at: number) => w.ago(Math.max(0, Math.round((Date.now() - at) / 1000)));
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
        if (delivery && !current.length) rows.push({ label: w.delivery, icon: "i-merge", state: "live", value: `#${delivery.sequence} · ${w.deliveryState(delivery.state)}` });
        let shownDelivery: number | null = null;
        for (const l of ordered) {
          if (deliveries.length > 1 && shownDelivery !== l.delivery) {
            const entry = deliveryBySequence.get(l.delivery);
            rows.push({ label: w.delivery, icon: "i-merge", state: entry?.state === "active" ? "live" : entry?.state === "completed" ? "ok" : "ended", value: `#${l.delivery} · ${entry ? w.deliveryState(entry.state) : w.historical}` });
            shownDelivery = l.delivery;
          }
          const repo = this.ctx.repos.get(item.projectId, l.repoId);
          const name = repo?.name ?? w.repository;
          if (l.branch) rows.push({ label: w.branch, icon: "i-branch", mono: true, value: `${l.branch} · ${name}${l.ahead || l.behind ? ` · +${l.ahead} −${l.behind}` : ""}` });
          if (l.prNumber !== null || l.prUrl) {
            rows.push({
              label: w.pullRequest,
              icon: "i-merge",
              state: l.prState === "merged" ? "ok" : l.prState === "closed" ? "ended" : l.prState === "open" ? "live" : undefined,
              value: `${l.prNumber !== null ? `#${l.prNumber}` : w.openIt}${l.prState ? ` · ${w.prState(l.prState)}` : ""}`,
              href: l.prUrl ?? undefined
            });
          } else if (l.branch && !l.mergedSha && l.ahead > 0 && this.store.repoState(item.projectId, l.repoId)?.remote === "none") {
            rows.push({ label: w.pullRequest, icon: "i-merge", value: w.mergeLocal(repo?.defaultBranch ?? "main"), command: "code-link.merge-local" });
          } else if (l.branch && !l.mergedSha && l.ahead > 0 && this.worktreeOf(item.projectId, item.id)) {
            rows.push({ label: w.pullRequest, icon: "i-merge", value: w.openPr, command: "code-link.open-pr" });
          }
          if (l.prState === "open" && l.prUrl && sessions.some((s) => s.blocked === "merge" && s.state !== "ended")) {
            rows.push({ label: w.mergeByHand, icon: "i-warn", state: "warn", value: w.mergeBlocked, href: l.prUrl });
          }
          if (l.mergedSha) rows.push({ label: w.merged, icon: "i-check", state: "ok", mono: true, value: w.mergedOn(l.mergedSha.slice(0, 7), repo?.defaultBranch ?? "main") });
          if (l.headAt) rows.push({ label: w.lastCommit, icon: "i-clock", value: since(l.headAt) });
        }
        const live = sessions.find((s) => s.state !== "ended") ?? sessions[0];
        if (live) {
          const where = live.mode === "terminal" ? w.inTerminal : w.runByTomrade;
          const when = since(live.lastEventAt ?? live.startedAt);
          const state = ({ running: "live", waiting: "waiting", idle: "idle", error: "warn", ended: "ended", lost: "lost" } as const)[live.state];
          // What it is doing beats what it last said; an error is what it last said.
          const doing = live.state === "error" ? (live.summary ?? w.stopped) : (live.activity ?? live.summary ?? "");
          rows.push({
            label: w.session,
            icon: live.mode === "terminal" ? "i-terminal" : "i-plug",
            state,
            value: `${w.sessionState(live.state)} · ${where}${doing ? ` · ${doing}` : ""} · ${w.lastSignal(when)}`
          });
          if (live.state !== "running") rows.push({ label: w.continue, icon: "i-send", value: live.mode === "terminal" ? w.continueTerminal : w.continueHere, command: live.mode === "terminal" ? "code-link.start-terminal" : "code-link.start-run" });
          if (live.threadId) rows.push({ label: w.conversation, icon: "i-panel", value: live.state === "waiting" ? w.openWaiting : w.openInAssistant, command: "code-link.open-thread" });
        }
        const worktree = this.worktreeOf(item.projectId, item.id);
        if (worktree) rows.push({ label: w.worktree, icon: "i-folder", mono: true, value: worktree, command: "code-link.open-terminal" });
        else if (live?.worktree && live.state !== "ended") rows.push({ label: w.worktree, icon: "i-folder", mono: true, value: live.worktree });
        const proposal = open.find((p) => p.kind === "propose");
        if (proposal) {
          rows.push({ label: w.proposal, icon: "i-warn", state: "warn", value: w.accept(w.status(proposal.toStatus ?? "")), command: "code-link.accept-proposal" });
          rows.push({ label: w.dismiss, icon: "i-close", value: w.notThisTime, command: "code-link.reject-proposal" });
        }
        const text = open.map((p) => (p.kind === "flag" ? `⚠ ${p.reason}` : `→ ${w.status(p.toStatus ?? "")}: ${p.reason}`)).join("\n");
        return { rows, text: text || undefined };
      }
    });

    ctx.contributions.badge({
      id: "code-link",
      compute: (items, { projectId }) => {
        const w = this.words();
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
            if (s.state !== "error") continue;
            const summary = s.summary ?? w.stopped;
            const repo = s.blocked === "merge" ? this.ctx.repos.get(projectId, s.repoId) : null;
            const checkout = repo ? this.ctx.repos.checkout(repo.remote).checkout : null;
            stuck.set(id, repo && !(checkout && fs.existsSync(checkout)) ? `${summary}\n${w.mergeUnseen(repo.name)}` : summary);
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
          if (waiting.has(item.id)) badges.push({ id: "waiting", label: w.badgeWaiting, tone: "strong", title: w.badgeWaitingTitle });
          if (stuck.has(item.id)) badges.push({ id: "stuck", label: w.badgeStuck, tone: "strong", title: stuck.get(item.id) });
          if (flag) badges.push({ id: "mismatch", label: w.badgeMismatch, tone: "strong", title: flag.reason });
          const primary = primaryOf(links);
          if (primary?.prState === "open") badges.push({ id: "pr", label: primary.prNumber !== null ? `PR #${primary.prNumber}` : "PR", tone: "strong", title: primary.prUrl ?? undefined });
          else if (links.some((l) => l.mergedSha)) badges.push({ id: "merged", label: w.badgeMerged, tone: "faint" });
          else if (primary?.branch) badges.push({ id: "branch", label: w.badgeBranch, tone: "neutral", title: primary.branch });
          if (badges.length) out[item.id] = badges;
        }
        return out;
      }
    });

    ctx.contributions.statusItem({
      id: "code-link",
      opens: "code-inbox",
      text: ({ projectId }) => {
        if (!projectId) return null;
        const w = this.words();
        const at = this.scannedAt.get(projectId);
        const parts: string[] = [];
        const live = this.store.sessions(projectId, { live: true }).filter((s) => s.state !== "lost");
        const waiting = live.filter((s) => s.state === "waiting").length;
        const stuck = live.filter((s) => s.state === "error").length;
        if (live.length) parts.push([w.sessions(live.length), waiting ? w.waitingCount(waiting) : "", stuck ? w.stuckCount(stuck) : ""].filter(Boolean).join(" · "));
        const unlinked = this.unlinked(projectId).length;
        const open = this.store.proposals(projectId).length;
        const unreachable = this.store.repoStates(projectId).filter((repo) => repo.remote === "unreachable").length;
        if (unlinked) parts.push(w.unlinked(unlinked));
        if (open) parts.push(w.toConfirm(open));
        if (unreachable) parts.push(w.unreachable(unreachable));
        if (!parts.length && !at) return null;
        return w.statusLine(parts.join(" · "), at ? w.ago(Math.max(0, Math.round((Date.now() - at) / 1000))) : null);
      }
    });

    const group = () => this.words().group;
    const startCommand = (mode: StartMode) => async (scope: { projectId?: string; itemId?: string | null }) => {
      const w = this.words();
      if (!scope.projectId || !scope.itemId) return { toast: w.selectTicket };
      const result = await this.start(scope.projectId, scope.itemId, { mode });
      // the Start dialog says what stopped it and offers the fix; the toast is for surfaces that cannot open it
      if (!result.ok) return { toast: result.message, startDialog: mode };
      const warning = result.warnings?.join("\n");
      const started = w.started(result.continued, result.branch);
      if (result.mode === "terminal") return { toast: `${result.launched ? `${started}${w.terminalHasIt}` : w.runThis(result.command ?? "")}${warning ? `\n${warning}` : ""}` };
      // a run here is followed in its conversation, which opens with it
      if (result.waitingOn) return { toast: w.waitingOn(result.waitingOn), showThread: result.threadId };
      return { toast: `${started}${warning ? `\n${warning}` : ""}`, showThread: result.threadId };
    };
    ctx.contributions.command({ id: "code-link.start-run", title: () => this.words().cmdStartRun, group, run: startCommand("run") });
    ctx.contributions.command({ id: "code-link.start-terminal", title: () => this.words().cmdStartTerminal, group, run: startCommand("terminal") });
    ctx.contributions.command({
      id: "code-link.open-pr",
      title: () => this.words().cmdOpenPr,
      group,
      run: async ({ projectId, itemId }) => {
        if (!projectId || !itemId) return { toast: this.words().selectTicket };
        const r = await this.openPr(projectId, itemId);
        return { toast: r.message };
      }
    });
    ctx.contributions.command({
      id: "code-link.merge-local",
      title: () => this.words().cmdMergeLocal,
      group,
      run: async ({ projectId, itemId }) => {
        if (!projectId || !itemId) return { toast: this.words().selectTicket };
        return { toast: (await this.mergeLocal(projectId, itemId)).message };
      }
    });
    ctx.contributions.command({
      id: "code-link.open-thread",
      title: () => this.words().cmdOpenThread,
      group,
      run: ({ projectId, itemId }) => {
        if (!projectId || !itemId) return { toast: this.words().selectTicket };
        const sessions = this.store.sessions(projectId, { itemId }).filter((s) => s.threadId);
        const threadId = (sessions.find((s) => s.state !== "ended") ?? sessions[0])?.threadId ?? this.store.links(projectId, itemId).find((l) => l.threadId)?.threadId;
        return threadId ? { showThread: threadId } : { toast: this.words().noConversation };
      }
    });
    ctx.contributions.command({
      id: "code-link.open-terminal",
      title: () => this.words().cmdOpenTerminal,
      group,
      run: async ({ projectId, itemId }) => {
        if (!projectId || !itemId) return { toast: this.words().selectTicket };
        const cwd = this.worktreeOf(projectId, itemId);
        if (!cwd) return { toast: this.words().noWorktree };
        const settings = TerminalSettings.parse(this.ctx.settings.get().codeLink ?? {});
        const launch = await launchTerminal({ cwd, command: 'exec "${SHELL:-bash}"', dir: path.join(this.sessionDir("shell"), path.basename(cwd)) }, settings.terminal);
        return { toast: launch.launched ? this.words().opened(cwd) : `cd ${cwd}` };
      }
    });
    const settle = (accept: boolean) => (scope: { projectId?: string; itemId?: string | null }) => {
      const w = this.words();
      if (!scope.projectId || !scope.itemId) return { toast: w.selectTicket };
      const proposal = this.store.proposals(scope.projectId, scope.itemId, "open").find((p) => p.kind === "propose");
      if (!proposal) return { toast: w.nothingProposed };
      this.resolve(scope.projectId, proposal.id, accept);
      return { toast: accept ? w.movedTo(w.status(proposal.toStatus ?? "")) : w.dismissed };
    };
    ctx.contributions.command({ id: "code-link.accept-proposal", title: () => this.words().cmdAccept, group, run: settle(true) });
    ctx.contributions.command({ id: "code-link.reject-proposal", title: () => this.words().cmdReject, group, run: settle(false) });
    ctx.contributions.command({
      id: "code-link.connect",
      title: () => this.words().cmdConnect,
      group,
      run: async ({ projectId, itemId }) => {
        if (!projectId) return { toast: this.words().openProject };
        const item = itemId ? this.ctx.items.get(projectId, itemId) : null;
        const fromItem = item ? this.ctx.boards.get(projectId, item.boardId)?.repoId : null;
        const repos = this.ctx.repos.list(projectId);
        const repoId = fromItem ?? (repos.length === 1 ? repos[0]!.id : null);
        if (!repoId) return { toast: this.words().pickWorkstream };
        const r = await this.connect(projectId, repoId);
        return { toast: r.message };
      }
    });
    ctx.contributions.command({
      id: "code-link.rescan",
      title: () => this.words().cmdRescan,
      group,
      run: async ({ projectId }) => {
        if (!projectId) return { toast: this.words().openProject };
        const s = await this.scan(projectId);
        return { toast: this.words().scanned(s.scanned, s.repos, s.changed, s.proposals, s.skipped.length) };
      }
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** A hook fired without a token: match it to a session by where the agent runs — a Tomrade worktree, or someone's checkout. */
  private externalEvent(payload: unknown): void {
    const p = (payload ?? {}) as { hook_event_name?: string; session_id?: string; cwd?: string; transcript_path?: string; tomrade_agent?: string };
    if (!p.cwd || !p.session_id) return;
    const agent = p.tomrade_agent === "codex" || p.tomrade_agent === "workbuddy" || p.tomrade_agent === "pi" || p.tomrade_agent === "hermes" ? p.tomrade_agent : "claude-code";
    // Where the transcript lives tells which of the person's Claude Code accounts ran it.
    if (agent === "claude-code" && typeof p.transcript_path === "string") this.ctx.get("agent")?.engineOf("claude-code")?.mcpLink?.sawTranscript?.(p.transcript_path);
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
    const mine = (projectId: string) => this.store.sessions(projectId, { live: true }).filter((s) => s.threadId === null && s.agent === agent && s.externalId === p.session_id);
    // The agent itself is gone: every session it had, parallel or not, ends with it.
    const deliver = (projectId: string, sessions: SessionView[]) => {
      for (const s of p.hook_event_name === "SessionEnd" ? sessions : sessions.slice(0, 1)) this.sessions.event(projectId, s.id, payload);
    };
    // One agent working tickets in parallel, each in a worktree it named: an event from inside one is that session's.
    for (const projectId of this.ctx.db.openIds()) {
      const all = mine(projectId);
      const placed = all.filter((s) => s.worktree && within(path.resolve(s.worktree))).sort((a, b) => b.worktree!.length - a.worktree!.length)[0];
      if (placed) {
        deliver(projectId, [placed, ...all.filter((s) => s.id !== placed.id)]);
        return;
      }
    }
    for (const projectId of this.ctx.db.openIds()) {
      for (const repo of this.ctx.repos.list(projectId)) {
        const checkout = this.ctx.repos.checkout(repo.remote).checkout;
        if (!checkout || !within(path.resolve(checkout))) continue;
        // Anywhere else in the checkout, the newest of its sessions there.
        const known = mine(projectId).filter((s) => s.repoId === repo.id);
        if (known.length) {
          deliver(projectId, known);
          return;
        }
        // The end of a session never heard of is nothing to record.
        if (p.hook_event_name === "SessionEnd") return;
        const created = this.store.createSession(projectId, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent, threadId: null, device: this.ctx.hub.deviceId, externalId: p.session_id ?? null });
        this.sessions.event(projectId, created.id, payload);
        return;
      }
    }
    void this.placeFrom(cwd).catch((err) => this.ctx.logger.warn(`placing a checkout from ${cwd} failed: ${message(err)}`));
  }

  /**
   * A coding session in a checkout, or a worktree of one, of a project repository this machine has
   * no checkout of: that checkout's main working tree is the repository's checkout from now on.
   */
  private async placeFrom(cwd: string): Promise<void> {
    if (this.placeLooked.has(cwd)) return;
    this.placeLooked.add(cwd);
    const common = await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, ok: true });
    const gitDir = common.code === 0 ? common.stdout.trim() : "";
    // A bare repository, or a git dir kept apart from its working tree, has no main working tree to name.
    if (path.basename(gitDir) !== ".git") return;
    const top = path.dirname(gitDir);
    const origin = await this.git(["remote", "get-url", "origin"], { cwd: top, ok: true });
    if (origin.code !== 0 || !origin.stdout.trim()) return;
    for (const projectId of this.ctx.db.openIds()) {
      for (const repo of this.ctx.repos.list(projectId)) {
        const placed = this.ctx.repos.checkout(repo.remote).checkout;
        if (placed && fs.existsSync(placed)) continue;
        if (!(await sameRepository(origin.stdout.trim(), repo.remote))) continue;
        await this.ctx.repos.setCheckout(repo.remote, top);
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
    const who = agent.codeEngines().find((engine) => engine.id === agent.answering(session.agent))?.title ?? session.agent;
    const text = moment.kind === "said" ? `${who}: ${moment.text}` : moment.kind === "failed" ? `${who} stopped: ${moment.text}` : `${who} session ended${moment.text ? ` (${moment.text})` : ""}.`;
    const message = agent.store.appendMessage(session.projectId, session.threadId, "system", { type: "note", text }, null);
    this.home.get("ipc")?.send("agent.event", session.threadId, { type: "message", message });
  }

  /** Per-session files (mcp.json, hooks settings, the prompt, the launch script) live in the Hub where the user can see them. */
  sessionDir(sessionId: string): string {
    return path.join(this.ctx.hub.dir ?? path.join(os.tmpdir(), "tomrade"), "sessions", sessionId);
  }

  private syncScope(projectId: string | undefined): SyncScope | null {
    if (!projectId || !this.ctx.db.has(projectId)) return null;
    const row = this.ctx.db.for(projectId).prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
    return row ? { projectName: row.name, prefix: this.prefixOf(projectId) } : null;
  }

  private prefixOf(projectId: string): string {
    const row = this.ctx.db.for(projectId).prepare("SELECT key_prefix FROM projects WHERE id = ?").get(projectId) as { key_prefix: string } | undefined;
    return row?.key_prefix ?? "TOM";
  }

  private notify(projectId: string): void {
    this.home.emit("codeLink/changed", projectId);
    this.home.get("ipc")?.send("codeLink.changed", projectId);
  }
}

export default CodeLink;
