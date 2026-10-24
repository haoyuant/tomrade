import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import type { Engine, ThreadSummary } from "@tomradex/agent";
import { untilLabel } from "@tomradex/agent";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/repos";
import { normalizeRemote } from "@tomradex/repos";
import type {} from "@tomradex/settings";
import type {} from "@tomradex/write";
import { repoSubfolder, type Item } from "@tomradex/domain";
import { GitFolder, gitRunner, type Git } from "@tomradex/git";
import { readPull, type ForgePull } from "./forge.js";
import { agentsNeedingFiles, type ConnectionView } from "./connection.js";
import { CONNECT_AGENTS, type ConnectFileWriter, type ConnectorAgent, type Connectors } from "./connect.js";
import { RepoConnect, type ConnectMode, type ConnectResult } from "./connect-repo.js";
import { Connections, MCP_AGENT } from "./connections.js";
import { contribute } from "./contrib.js";
import { StartDefaultsStore, type StartDefaultsView } from "./defaults.js";
import { HerdrBridge, type HerdrInstall } from "./herdr-bridge.js";
import { Landing, type MergeCheckView, type MergeLocalResult, type OpenPrResult } from "./landing.js";
import { SYNC_PROMPT, syncInstructions, syncPrompt, type SyncScope } from "./sync.js";
import { githubHttps } from "@tomradex/github";
import { PLAYBOOKS } from "./playbooks.js";
import { classifyRemoteFailure, probeRemote, readRemoteIdentity, type RemoteIdentity } from "./remote.js";
import { currentLinks, deliveryMerged, GitScan, LANDED_ELSEWHERE, primaryOf, type ScanSummary, type UnlinkedBranch } from "./scan/absorb.js";
import { Sessions, type SessionMoment } from "./sessions.js";
import { CODE_WORDS, type CodeWords } from "./words.js";
import { Starter, type StartOptions, type StartResult } from "./start.js";
import { CodeLinkStore, MIGRATIONS, TABLES, type CodeLinkView, type DeliveryView, type ProposalView, type RepoStatePatch, type RepoStateView, type SessionView } from "./store.js";
import { findCodexRollout, findTranscript, readConversation, transcriptTitleFor, type ConversationLine } from "./titles.js";
import { AUTO_TERMINAL, TerminalSettings, commandOk, exec, locatedCommand, terminalApps, terminalPath } from "./terminal.js";
import { registerTools } from "./tools.js";
import { type CodeLinkReader, errorMessage } from "@tomradex/contracts";

export { AUTHOR, deliveryMerged, primaryOf, type ScanSummary, type UnlinkedBranch } from "./scan/absorb.js";
export { compareUrl, MERGE_COMMAND, type MergeCheckView, type MergeLocalResult, type OpenPrResult } from "./landing.js";
export type { ConnectMode, ConnectResult } from "./connect-repo.js";
export { MCP_AGENT } from "./connections.js";
export { lastSaid } from "./herdr-bridge.js";

declare module "cordis" {
  interface Context {
    codeLink: CodeLink;
  }
  interface Events {
    /** Links or sessions of a project changed — for main-process observers; the renderer hears codeLink.changed. */
    "codeLink/changed"(projectId: string): void;
    /** Asked: a window inside Tomrade can show this project's herdr sessions. Its plugin answers true. */
    "codeLink/terminal-window"(projectId: string): Promise<boolean | void> | boolean | void;
    /** Asked: show this session's herdr terminal inside Tomrade. True once a window has. */
    "codeLink/show-session"(projectId: string, sessionId: string): Promise<boolean | void> | boolean | void;
  }
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

export type RepoPolicyPatch =Pick<RepoStatePatch, "branchTemplate" | "autoDone" | "agentPush" | "agentMerge" | "readiness" | "connectAgents">;

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
    /** Put agent configuration into the repository on its own branch, or (local) into the checkout alone, kept out of git. */
    "codeLink.connect": (projectId: string, repoId: string, mode?: ConnectMode) => ConnectResult;
    /** Install or sign in to a local agent in a terminal, with the command its engine declares. */
    "codeLink.setupInTerminal": (engineId: string, step: "install" | "signIn") => { launched: boolean; command: string };
    /** What the Start dialog last ran with on this machine, so it opens the way it was left. */
    "codeLink.startDefaults": () => StartDefaultsView | null;
    "codeLink.herdrStatus": () => "notInstalled" | "notRunning" | "running";
    /** Sessions started here open in Tomrade's own Terminal window: herdr is the terminal and the window is on. */
    "codeLink.terminalWindow": (projectId: string) => boolean;
    /** Show a session's herdr terminal in Tomrade's Terminal window; false when no window can. */
    "codeLink.showSession": (projectId: string, sessionId: string) => boolean;
    /** How herdr installs on this machine: Homebrew's command where brew is, herdr's own installer on macOS and Linux, else only its install guide. */
    "codeLink.herdrInstall": () => HerdrInstall;
    /** Install herdr in a terminal with that command; the page never names it. */
    "codeLink.installHerdr": () => { launched: boolean; command: string };
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


const SETTINGS_SECTION = {
  id: "codeLink",
  title: "Code link",
  description: "Which terminal opens a ticket, and how Claude Code, Codex or Pi is invoked in it. {bin} (the CLI Tomrade found), {prompt}, {mcpConfig}, {mcpUrl}, {settings}, {piExtension}, {resume}, {options} (the model and effort chosen at Start) and {cwd} are filled in.",
  schema: TerminalSettings,
  defaults: TerminalSettings.parse({}),
  choices: () => ({ terminal: [AUTO_TERMINAL, ...terminalApps()] }),
  order: 30,
  words: {
    en: { fields: { terminal: { options: { [AUTO_TERMINAL]: CODE_WORDS("en")("terminalAuto") } } } },
    zh: {
      title: "代码关联",
      description: "用哪个终端打开工单，以及在终端里怎样调用 Claude Code、Codex 或 Pi。命令里的 {bin}（Tomrade 找到的命令行工具）、{prompt}、{mcpConfig}、{mcpUrl}、{settings}、{piExtension}、{resume}、{options}（开始时选的模型和推理强度）和 {cwd} 会自动填入。",
      fields: {
        terminal: { title: "终端应用", description: `${CODE_WORDS("zh")("terminalAutoHelp")}${CODE_WORDS("zh")("terminalHelp")}`, options: { [AUTO_TERMINAL]: CODE_WORDS("zh")("terminalAuto") } },
        claudeCommand: { title: "Claude Code 命令" },
        codexCommand: { title: "Codex 命令" },
        piCommand: { title: "Pi 命令", description: "Pi 没有 MCP 参数；{piExtension} 是只在本次会话生效的扩展，负责注册 Tomrade 的服务，并像 Claude 的 hooks 一样回报进展。" },
        geminiCommand: { title: "Gemini CLI 命令", description: "{geminiHome} 是只给本次会话用的 Gemini 主目录：沿用你自己的 ~/.gemini（登录、扩展、历史），在它设置的副本里加上 Tomrade 的服务。你自己的文件不会被改动。" },
        opencodeCommand: { title: "OpenCode 命令", description: "{opencodeConfig} 是只在本次会话生效的配置，会和你自己的 OpenCode 配置合并。" },
        workbuddyCommand: { title: "WorkBuddy 命令" },
        agyCommand: { title: "Antigravity CLI 命令", description: "agy 没有 MCP 参数：它通过自己用户级的 tomrade 服务连到 Tomrade（先在设置里的 Antigravity CLI 下连接），开始时先认领工单。" },
        cursorCommand: { title: "Cursor 命令", description: "cursor-agent 没有 MCP 参数：它通过自己用户级的 tomrade 服务连到 Tomrade（先在设置里的 Cursor 下连接），开始时先认领工单。" },
        dshCommand: { title: "DeepSeek Harness 命令", description: "DeepSeek Harness 没有终端交互界面：工单作为一次 headless 运行，通过 {dshReporter} 显示过程并回报，用 --session-id 续接。{bin} 是 Tomrade 找到的 dsh（包括桌面版自带的），{dshPatch} 只为这次运行加上 Tomrade 的服务。" },
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
export class CodeLink extends Service implements CodeLinkReader {
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
  private scans!: GitScan;
  private landing!: Landing;
  private connections!: Connections;
  private repoConnect!: RepoConnect;
  /** Repositories whose files are being filled in right now, so two triggers do not write at once. */
  private readonly autoConnecting = new Set<string>();
  /** Coalesces the engines' arrivals into one pass over the projects' repositories. */
  private autoConnectTimer: NodeJS.Timeout | null = null;
  private herdr!: HerdrBridge;
  /** The engines' connection-file writers; Connect reads them when it runs, so load order does not matter. */
  private readonly connectors = new Map<ConnectorAgent, ConnectFileWriter>();
  /** Ended sessions already looked for a transcript title. */
  private readonly titlesLooked = new Set<string>();
  /** Machine-local: each thread's worktree, for the section and the terminal. */
  private readonly worktrees = new Map<string, string>();
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
      onWaiting: (session, activity) => this.herdr.waiting(session, activity),
      panes: { alive: (pane) => this.herdr.paneAlive(pane), info: (pane) => this.herdr.pane(pane) },
      // A terminal session cannot be typed into: when the limit lifts the person is told, not the agent.
      onLimit: (session, until) => {
        const agent = this.ctx.get("agent");
        const park = session.threadId && agent ? agent.park(session.projectId, session.threadId, { until, resume: false, note: false }) : null;
        return this.limitedWords(park?.until ?? until ?? Date.now() + 15 * 60_000, park?.known ?? until !== null, false);
      },
      // A pass already running still saw this session as active.
      onEnd: (session) => void this.rescan(session.projectId).catch((err) => this.ctx.logger.warn(`code scan after session ${session.id} ended failed: ${errorMessage(err)}`))
    });
    this.herdr = new HerdrBridge({ ctx: this.ctx, store: this.store, sessions: this.sessions, words: () => this.words(), sessionDir: (id) => this.sessionDir(id) });
    this.starter = new Starter({
      ctx: this.ctx,
      store: this.store,
      sessions: this.sessions,
      herdr: this.herdr,
      git: this.git,
      scan: (projectId) => this.scan(projectId),
      notify: (projectId) => this.notify(projectId),
      sessionDir: (id) => this.sessionDir(id),
      worktrees: this.worktrees
    });
    this.connections = new Connections({
      ctx: this.ctx,
      store: this.store,
      sessions: this.sessions,
      git: this.git,
      worktrees: this.worktrees,
      sessionDir: (id) => this.sessionDir(id),
      notify: (projectId) => this.notify(projectId),
      findPane: (projectId, sessionId, payload) => this.herdr.findPane(projectId, sessionId, payload)
    });
    this.scans = new GitScan({
      ctx: this.ctx,
      store: this.store,
      sessions: this.sessions,
      git: this.git,
      config: this.config,
      pulls: (repo, number, cwd) => this.pulls(repo, number, cwd),
      notify: (projectId) => this.notify(projectId),
      prefixOf: (projectId) => this.prefixOf(projectId),
      archiveCompletedSessions: (projectId) => this.archiveCompletedSessions(projectId),
      superseded: (projectId, session) => this.connections.superseded(projectId, session)
    });
    this.landing = new Landing({
      ctx: this.ctx,
      store: this.store,
      git: this.git,
      defaults: this.defaults,
      words: () => this.words(),
      notify: (projectId) => this.notify(projectId),
      reevaluate: (projectId, itemId, repoId) => this.reevaluate(projectId, itemId, repoId),
      scan: (projectId) => this.scan(projectId),
      worktreeOf: (projectId, itemId) => this.worktreeOf(projectId, itemId)
    });
    this.repoConnect = new RepoConnect({
      ctx: this.ctx,
      store: this.store,
      git: this.git,
      words: () => this.words(),
      notify: (projectId) => this.notify(projectId),
      prefixOf: (projectId) => this.prefixOf(projectId),
      lastHooks: (projectId, repoId) => this.connections.lastHooks(projectId, repoId),
      connectors: this.connectorSet()
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
          if (!deliveryMerged(links)) throw new Error("Merge all code links before accepting this mixed delivery");
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
    this.ctx.on("db/opened", (projectId) => {
      this.sessions.reconcile(projectId);
      void this.autoConnectProject(projectId);
    });
    this.ctx.on("repos/checkout-set", (remote) => {
      for (const projectId of this.ctx.db.openIds()) {
        const repo = this.ctx.repos.list(projectId).find((row) => row.remote === remote);
        if (!repo) continue;
        void this.rescan(projectId).catch((err) => this.ctx.logger.warn(`code scan after setting ${remote} failed: ${errorMessage(err)}`));
        void this.autoConnectRepo(projectId, repo.id);
      }
    });
    // An earlier version wrote the helper under the Hub; repoint it before a
    // session can fall back to the wrong global account.
    this.home.inject(["repos"], () => {
      for (const projectId of this.ctx.db.openIds()) void this.scans.migrateCredentialHelpers(projectId);
    });

    this.home.inject(["tools"], (ctx) => {
      // A ticket an agent files while it holds none is the one it works: the terminal it speaks from takes it, so
      // the sidebar names the ticket at once and the calls that name it later reach that session.
      ctx.on("tools/result", (call, outcome) => {
        if (call.name !== "create_item" || !outcome.ok || call.by !== `ai:${MCP_AGENT}` || !call.projectId) return;
        const id = (outcome.result as { id?: unknown } | null)?.id;
        if (typeof id === "string") this.filed(call.projectId, id);
      });
      return registerTools(ctx, {
        store: this.store,
        reevaluate: (projectId, itemId, repoId) => this.reevaluate(projectId, itemId, repoId),
        handOver: (projectId, itemId, repoId) => this.handOver(projectId, itemId, repoId),
        dropSuggested: (projectId, itemId, repoId, branch) => this.dropSuggested(projectId, itemId, repoId, branch),
        noteProgress: (projectId, sessionId, text) => this.sessions.touch(projectId, sessionId, { summary: text, state: "running" }),
        blockMerge: (projectId, sessionId, reason) => this.sessions.blockMerge(projectId, sessionId, reason),
        attach: (projectId, sessionId, itemId, branch, delivery, opts) => this.attach(projectId, sessionId, itemId, branch, delivery, opts),
        externalSession: (projectId, repoId, key) => this.externalSession(projectId, repoId, key),
        awaitingClaim: (projectId, itemId) => this.awaitingClaim(projectId, itemId),
        connected: (projectId, connection) => this.connected(projectId, connection),
        freeSibling: (projectId, session) => this.connections.freeSibling(projectId, session),
        connectedSessions: (projectId, connection) => this.connectedSessions(projectId, connection),
        bindConnection: (projectId, connection, sessionId, leaving) => this.bindConnection(projectId, connection, sessionId, leaving),
        bound: (sessionId) => this.boundAnywhere(sessionId),
        connectionSession: (projectId, repoId, worktree) => this.connectionSession(projectId, repoId, worktree),
        successor: (projectId, from, repoId, worktree) => this.successor(projectId, from, repoId, worktree),
        letGo: (projectId, connection, sessionId, itemId) => this.letGo(projectId, connection, sessionId, itemId),
        rescan: (projectId) => this.rescan(projectId),
        notify: (projectId) => this.notify(projectId),
        summary: (projectId, itemId) => this.summary(projectId, itemId),
        mergeLocal: (projectId, itemId, opts) => this.mergeLocal(projectId, itemId, opts)
      });
    });
    this.home.inject(["mcp"], (ctx) => {
      // Hooks a repository commits carry no token; the cwd and session id in the payload say whose they are.
      ctx.mcp.onEvent((payload) => this.connections.externalEvent(payload));
      ctx.on("mcp/closed", (connection) => this.connections.disconnected(connection));
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
    this.home.inject(["agent", "mcp"], (ctx) => {
      // Every engine that can carry Tomrade in its own configuration gets it without a person pressing Connect,
      // whether it was registered before this plugin or after it: the engine's own file, never anyone else's.
      const connect = (engine: Engine) => {
        void this.autoConnect(engine)
          // An agent that has just become usable is one more the repositories can be set up for.
          .then(() => this.scheduleAutoConnectRepos())
          .catch((err) => this.ctx.logger.warn(`connecting ${engine.id} to Tomrade failed: ${errorMessage(err)}`));
      };
      for (const engine of ctx.agent.codeEngines()) connect(engine);
      ctx.on("agent/engine-added", connect);
      // A test message that came back is the agent working here: link it then too, in case its first attempt was too early.
      ctx.on("agent/engine-tried", (engineId, tried) => {
        const engine = tried.ok ? ctx.agent.engineOf(engineId) : null;
        if (engine) connect(engine);
      });
    });
    // A restart leaves the repositories as they were: an agent's hooks reach Tomrade from its next session, not from the
    // next person who presses Connect.
    this.home.inject(["agent", "repos", "mcp"], () => {
      for (const projectId of this.ctx.db.openIds()) void this.autoConnectProject(projectId);
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
      ctx.agent.threadOrigins((_projectId, threads) => threads.filter((th) => th.itemId).map((th) => [th.id, this.words()("origin")] as [string, string]));
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
        if (event.pending) this.sessions.touch(thread.projectId, session.id, { state: "waiting", activity: event.pending.kind === "permission" ? this.words()("needsApproval") : this.words()("askingYou") });
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
      ctx.ipc.handle("codeLink.connect", (projectId, repoId, mode) => ctx.codeLink.connect(projectId, repoId, mode));
      ctx.ipc.handle("codeLink.setupInTerminal", (engineId, step) => ctx.codeLink.setupInTerminal(engineId, step));
      ctx.ipc.handle("codeLink.startDefaults", () => ctx.codeLink.startDefaults());
      ctx.ipc.handle("codeLink.herdrStatus", () => ctx.codeLink.herdrStatus());
      ctx.ipc.handle("codeLink.terminalWindow", (projectId) => ctx.codeLink.terminalWindow(projectId));
      ctx.ipc.handle("codeLink.showSession", (projectId, sessionId) => ctx.codeLink.showSession(projectId, sessionId));
      ctx.ipc.handle("codeLink.herdrInstall", () => ctx.codeLink.herdrInstall());
      ctx.ipc.handle("codeLink.installHerdr", () => ctx.codeLink.installHerdr());
    });
    this.home.inject(["contributions"], (ctx) => contribute(ctx, { ctx: this.ctx, codeLink: this, herdr: this.herdr, words: () => this.words() }));
    this.herdr.follow(this.home);

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
      if (this.autoConnectTimer) clearTimeout(this.autoConnectTimer);
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
    return currentLinks(this.store, projectId, itemId);
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
    return this.scans.unlinkedByProject.get(projectId) ?? [];
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
    await this.scans.migrateCredentialHelpers(projectId);
    return this.probeAndRecord(projectId, repoId, checkout, repo.defaultBranch);
  }

  private async probeAndRecord(projectId: string, repoId: string, checkout: string, branch: string): Promise<RepoStateView> {
    await this.scans.inFlight.get(projectId);
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

  /**
   * Conversations that ended before Tomrade kept their titles: a Claude Code
   * or CodeBuddy one finds its transcript by the agent's session id, a Codex
   * one its rollout, and keeps the title once found. Each session is looked
   * for once.
   */
  findTitles(projectId: string): boolean {
    let found = false;
    for (const s of this.store.sessions(projectId)) {
      if (s.title || s.itemIds.length || !["claude-code", "workbuddy", "codex"].includes(s.agent) || !s.externalId || s.state !== "ended" && s.state !== "lost") continue;
      if (this.titlesLooked.has(s.id)) continue;
      this.titlesLooked.add(s.id);
      const transcript = s.transcript ?? (s.agent === "codex" ? findCodexRollout(s.externalId) : findTranscript(s.externalId));
      const title = transcript ? transcriptTitleFor(s.agent, transcript) : null;
      if (!title) continue;
      this.store.patchSession(projectId, s.id, { title, transcript, prompted: true });
      found = true;
    }
    return found;
  }

  /** A session's conversation from its agent's own record, read-only; null when Tomrade cannot read that agent's record. */
  conversation(projectId: string, sessionId: string): { lines: ConversationLine[]; cut: boolean } | null {
    const s = this.store.session(projectId, sessionId);
    if (!s?.externalId) return null;
    const file = s.agent === "claude-code" || s.agent === "workbuddy" ? (s.transcript ?? findTranscript(s.externalId)) : s.agent === "codex" ? findCodexRollout(s.externalId) : null;
    return file ? readConversation(s.agent, file) : null;
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
      this.sessions.end(projectId, session.id, "ended", true, "its tickets are done");
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
    return this.scans.scannedAt.get(projectId) ?? null;
  }

  /** This machine's worktree for the ticket's most recent thread, if one was started here. */
  /** Only a command an engine declares can be run this way; the page names the engine and the step, never the command. */
  async setupInTerminal(engineId: string, step: "install" | "signIn"): Promise<{ launched: boolean; command: string }> {
    const agent = this.ctx.get("agent");
    const setup = (await agent?.engineViews())?.find((e) => e.id === engineId)?.setup;
    const declared = step === "install" ? setup?.install[0] : setup?.signIn;
    if (!declared) throw new Error(`${engineId} has no ${step} command`);
    // Signing in runs the CLI Tomrade found, wherever that was: a terminal without Node or Tomrade's folders finds no bare name.
    const found = step === "signIn" ? (await agent?.engineOf(engineId)?.available().catch(() => null))?.cli : undefined;
    const cli = found?.state === "ready" ? found : undefined;
    const command = cli ? locatedCommand(declared, cli.name, cli.path) : declared;
    const { launched } = await this.herdr.setup(command, path.join(this.sessionDir("setup"), engineId), terminalPath(cli));
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
    // The person's word that the passing merge delivered this ticket: its link reads as merged by that commit.
    if (accept && proposal.reason.startsWith(LANDED_ELSEWHERE) && proposal.linkId && proposal.evidenceSha) {
      const link = this.store.links(projectId, proposal.itemId).find((l) => l.id === proposal.linkId);
      if (link && !link.mergedSha) this.store.patchLink(projectId, link.id, { mergedSha: proposal.evidenceSha });
    }
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
    void this.scan(projectId).catch((err) => this.ctx.logger.warn(`rescan after linking ${name} failed: ${errorMessage(err)}`));
    return link;
  }

  setRepoPolicy(projectId: string, repoId: string, patch: RepoPolicyPatch): RepoStateView {
    if (!this.ctx.repos.get(projectId, repoId)) throw new Error(`unknown repository ${repoId}`);
    // Known agents only, in their usual order — a plugin's own included; choosing none goes back to the ones found here.
    const known = [...CONNECT_AGENTS, ...this.connectors.keys()].filter((id, at, all) => all.indexOf(id) === at);
    const connectAgents = patch.connectAgents?.length ? known.filter((id) => patch.connectAgents!.includes(id)) : patch.connectAgents && null;
    const state = this.store.upsertRepoState(projectId, repoId, { ...patch, connectAgents });
    this.notify(projectId);
    return state;
  }

  mergeChecks(projectId: string, repoId: string): Promise<MergeCheckView[]> {
    return this.landing.mergeChecks(projectId, repoId);
  }

  allowMerge(projectId: string, repoId: string, engineId: string): Promise<MergeCheckView> {
    return this.landing.allowMerge(projectId, repoId, engineId);
  }

  /** Start or continue a ticket with a local agent — headless here or in the user's terminal, coding or General. See `Starter` for the gates. */
  async start(projectId: string, itemId: string, opts: StartOptions): Promise<StartResult> {
    const result = await this.starter.start(projectId, itemId, opts);
    // Only what actually started is remembered, with the engine it settled on: a gate the user had to
    // clear leaves the memory as it was, and an engine the caller left to Tomrade is not lost.
    if (result.ok) this.defaults.write({ mode: opts.mode, engine: result.engine, options: opts.options, permissionMode: opts.permissionMode, playbook: opts.playbook });
    return result;
  }

  // ── herdr ──────────────────────────────────────────────────────────────────

  herdrStatus(): Promise<"notInstalled" | "notRunning" | "running"> {
    return this.herdr.herdrStatus();
  }

  terminalWindow(projectId: string): Promise<boolean> {
    return this.herdr.terminalWindow(projectId);
  }

  showSession(projectId: string, sessionId: string): Promise<boolean> {
    return this.herdr.showSession(projectId, sessionId);
  }

  showInHerdr(projectId: string, itemId: string): Promise<string | null> {
    return this.herdr.showInHerdr(projectId, itemId);
  }

  herdrInstall(): Promise<HerdrInstall> {
    return this.herdr.herdrInstall();
  }

  async installHerdr(): Promise<{ launched: boolean; command: string }> {
    return this.herdr.installHerdr(await this.herdrInstall());
  }

  /** What the Start dialog last ran with on this machine; null when nothing usable is remembered. */
  startDefaults(): StartDefaultsView | null {
    return this.defaults.read();
  }

  // ── outside sessions and their connections ─────────────────────────────────

  rebindSessions(projectId: string): number {
    return this.connections.rebindSessions(projectId);
  }

  attach(projectId: string, sessionId: string, itemId: string, branch: string, delivery: number, opts: { replace?: boolean } = {}): void {
    this.connections.attach(projectId, sessionId, itemId, branch, delivery, opts);
  }

  /**
   * A ticket an agent filed from its own terminal, before any claim: the one live session that holds nothing and
   * stands on that repository takes it. Exactly one — with two, nothing says whose the ticket is, and the agent's
   * own claim decides; a session already working a ticket filed a follow-up, not its next one.
   */
  private filed(projectId: string, itemId: string): void {
    const item = this.ctx.items.get(projectId, itemId);
    const repoId = item ? this.ctx.boards.get(projectId, item.boardId)?.repoId : null;
    if (!item || !repoId) return;
    const free = this.store.sessions(projectId, { live: true }).filter((s) =>
      s.mode === "terminal" && s.agent !== MCP_AGENT && s.threadId === null && s.repoId === repoId && s.endedAt === null && s.state !== "lost" && !s.itemIds.length);
    // One conversation may have left several rows behind; two conversations never share a ticket. Only the first is
    // a ticket's, and of its rows the one its hooks reached last — not the earlier one a restart left standing.
    if (new Set(free.map((s) => s.externalId ?? s.id)).size !== 1) return;
    const latest = free.reduce((best, s) => ((s.lastEventAt ?? s.startedAt) > (best.lastEventAt ?? best.startedAt) ? s : best), free[0]!);
    this.attach(projectId, this.connections.freshest(projectId, latest).id, item.id, "", this.store.ensureActiveDelivery(projectId, item.id, item.updatedAt).sequence);
  }

  externalSession(projectId: string, repoId: string, key?: string): SessionView | null {
    return this.connections.externalSession(projectId, repoId, key);
  }

  awaitingClaim(projectId: string, itemId: string): SessionView | null {
    return this.connections.awaitingClaim(projectId, itemId);
  }

  connected(projectId: string, connection: string): SessionView | null {
    return this.connections.connected(projectId, connection);
  }

  connectedSessions(projectId: string, connection: string): SessionView[] {
    return this.connections.connectedSessions(projectId, connection);
  }

  bindConnection(projectId: string, connection: string, sessionId: string, leaving?: string): void {
    this.connections.bindConnection(projectId, connection, sessionId, leaving);
  }

  boundAnywhere(sessionId: string): boolean {
    return this.connections.boundAnywhere(sessionId);
  }

  connectionSession(projectId: string, repoId: string | null, worktree: string | null = null): SessionView {
    return this.connections.connectionSession(projectId, repoId, worktree);
  }

  successor(projectId: string, from: SessionView, repoId: string | null, worktree: string | null = null): SessionView {
    return this.connections.successor(projectId, from, repoId, worktree);
  }

  letGo(projectId: string, connection: string, sessionId: string, itemId: string): void {
    this.connections.letGo(projectId, connection, sessionId, itemId);
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
    this.scans.unlinkedByProject.set(
      projectId,
      this.unlinked(projectId).filter((u) => !(u.repoId === repoId && u.branch === name))
    );
    this.notify(projectId);
    void this.scan(projectId).catch((err) => this.ctx.logger.warn(`rescan after adopting ${name} failed: ${errorMessage(err)}`));
    return item;
  }

  // ── connecting a repository ────────────────────────────────────────────────

  /**
   * An agent that can carry Tomrade in its own configuration gets it without a
   * person pressing Connect: a missing or stale link is written again, and a
   * connected one is left alone. Only installed agents are touched; a failure
   * is logged and the settings section still offers the manual way.
   */
  private async autoConnect(engine: Engine): Promise<void> {
    const link = engine.local?.mcpLink;
    if (!link) return;
    const state = await link.status();
    if (state.state === "connected" || state.state === "unavailable") return;
    const available = await engine.available().catch(() => null);
    if (available?.cli?.state === "missing") return;
    const next = await link.connect();
    if (next.state !== "connected") {
      this.ctx.logger.warn(`connecting ${engine.title} to Tomrade left it ${next.state}${next.error ? `: ${next.error}` : ""}`);
    }
  }

  /**
   * An agent works the same whether its files were written by hand or not: fill
   * in what the repository is missing for this machine, nothing tracked, no
   * branch. What Connect would already call complete is left untouched.
   */
  private async autoConnectRepo(projectId: string, repoId: string): Promise<void> {
    const key = `${projectId}\0${repoId}`;
    if (this.autoConnecting.has(key)) return;
    this.autoConnecting.add(key);
    try {
      // Only an agent this machine has: nobody gets files for one they do not run, and a machine that recognises none writes nothing.
      const installed = await this.repoConnect.installedAgents(projectId, repoId);
      if (!installed.length) return;
      const view = await this.repoConnect.connection(projectId, repoId);
      // A pending branch is the person's to merge; a repository Tomrade cannot reach is not ours to write.
      if (view.state !== "connected" && view.state !== "unconnected" && view.state !== "other-instance") return;
      const missing = agentsNeedingFiles(view.agents.filter((agent) => installed.includes(agent.id)), this.connectorSet());
      if (!missing.length) return;
      await this.repoConnect.ensureLocal(projectId, repoId, missing);
    } catch (err) {
      this.ctx.logger.warn(`auto-connecting ${repoId} to Tomrade failed: ${errorMessage(err)}`);
    } finally {
      this.autoConnecting.delete(key);
    }
  }

  private async autoConnectProject(projectId: string): Promise<void> {
    for (const repo of this.ctx.repos.list(projectId)) await this.autoConnectRepo(projectId, repo.id);
  }

  /** The engines arrive together at startup: one pass over every repository, a moment later, not one per engine. */
  private scheduleAutoConnectRepos(): void {
    if (this.autoConnectTimer) return;
    this.autoConnectTimer = setTimeout(() => {
      this.autoConnectTimer = null;
      for (const projectId of this.ctx.db.openIds()) void this.autoConnectProject(projectId);
    }, 300);
    this.autoConnectTimer.unref?.();
  }

  /** The engine-registered connection writers, as Connect reads them. */
  private connectorSet(): Connectors {
    return Object.assign((agent: ConnectorAgent) => this.connectors.get(agent), { agents: () => [...this.connectors.keys()] });
  }

  /**
   * An engine's writer for its agent's connection file (Pi's extension), so
   * Connect writes and reads that file without code-link importing the engine.
   * Returns the unregistering function.
   */
  registerConnector(agent: ConnectorAgent, writer: ConnectFileWriter): () => void {
    this.connectors.set(agent, writer);
    return () => {
      if (this.connectors.get(agent) === writer) this.connectors.delete(agent);
    };
  }

  connection(projectId: string, repoId: string): Promise<ConnectionView> {
    return this.repoConnect.connection(projectId, repoId);
  }

  connect(projectId: string, repoId: string, mode: ConnectMode = "team"): Promise<ConnectResult> {
    return this.repoConnect.connect(projectId, repoId, mode);
  }

  // ── landing ────────────────────────────────────────────────────────────────

  mergeLocal(projectId: string, itemId: string, opts: { agent?: boolean } = {}): Promise<MergeLocalResult> {
    return this.landing.mergeLocal(projectId, itemId, opts);
  }

  openPr(projectId: string, itemId: string): Promise<OpenPrResult> {
    return this.landing.openPr(projectId, itemId);
  }

  // ── the scan ───────────────────────────────────────────────────────────────

  /** One scan per project at a time; a second caller gets the running one. */
  scan(projectId: string): Promise<ScanSummary> {
    return this.scans.scan(projectId);
  }

  private rescan(projectId: string): Promise<ScanSummary> {
    return this.scans.rescan(projectId);
  }

  scanOpen(): Promise<void> {
    return this.scans.scanOpen();
  }

  reevaluate(projectId: string, itemId: string, repoId: string): void {
    this.scans.reevaluate(projectId, itemId, repoId);
  }

  dropSuggested(projectId: string, itemId: string, repoId: string, branch: string, present?: (name: string) => boolean): boolean {
    return this.scans.dropSuggested(projectId, itemId, repoId, branch, present);
  }

  handOver(projectId: string, itemId: string, repoId: string): void {
    this.scans.handOver(projectId, itemId, repoId);
  }

  completionPolicy(projectId: string, item: Item): "merge" | "human" {
    return this.scans.completionPolicy(projectId, item);
  }

  /** Each workstream's repository and its folder on this machine — what a main conversation reads the code from. */
  repositoriesOf(projectId: string): { workstream: string; name: string; path: string | null; defaultBranch: string }[] {
    return this.ctx.boards.list(projectId).flatMap((board) => {
      const repo = board.repoId ? this.ctx.repos.get(projectId, board.repoId) : null;
      if (!repo) return [];
      const checkout = this.ctx.repos.checkout(repo.remote).checkout;
      // A folder outside the checkout is no folder to read from.
      const subdir = checkout ? repoSubfolder(board.repoPath, checkout) : null;
      const folder = checkout && subdir !== null && fs.existsSync(checkout) ? (subdir ? path.join(checkout, subdir) : checkout) : null;
      return [{ workstream: board.name, name: repo.name, path: folder, defaultBranch: repo.defaultBranch }];
    });
  }

  /** Project checkouts first, then any workstream subfolders, for a terminal's directory picker. */
  repositoryFoldersOf(projectId: string): { name: string; path: string }[] {
    const roots = this.ctx.repos.list(projectId).flatMap((repo) => {
      const folder = this.ctx.repos.checkout(repo.remote).checkout;
      return folder && fs.existsSync(folder) ? [{ name: repo.name, path: folder }] : [];
    });
    const folders = [...roots, ...this.repositoriesOf(projectId).flatMap((repo) => repo.path ? [{ name: repo.name, path: repo.path }] : [])];
    return folders.filter((folder, i) => folders.findIndex((other) => path.resolve(other.path) === path.resolve(folder.path)) === i);
  }

  // ── words ──────────────────────────────────────────────────────────────────

  /** The words the backend writes for the person, in their language at the moment they are written. */
  private limitedWords(until: number, known: boolean, resumes: boolean): string {
    const w = this.words();
    return w(known ? "limitedLifts" : "limitedNextTry", { when: untilLabel(until, w.locale), resumes: resumes ? w("limitedResumes") : "" });
  }

  private words(): CodeWords {
    return CODE_WORDS(this.ctx.settings.locale?.());
  }

  // ── helpers ────────────────────────────────────────────────────────────────

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
