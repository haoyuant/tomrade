import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import type { Engine, RecordRead, ThreadSummary } from "@tomradex/agent";
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
import { FollowOnStore, type FollowOn } from "./follow-ons.js";
import { Handoff, type HandoffResult, type HandoffView } from "./handoff.js";
import { HerdrBridge, type HerdrInstall } from "./herdr-bridge.js";
import { SessionPanel, type AnswerResult, type SessionGlance, type SessionPanelView } from "./panel.js";
import { Landing, type MergeCause, type MergeCheckView, type MergeLocalResult, type OpenPrResult } from "./landing.js";
import { Orientation } from "./orientation.js";
import { SYNC_PROMPT, syncInstructions, syncPrompt, type SyncScope } from "./sync.js";
import { githubHttps } from "@tomradex/github";
import { PLAYBOOKS } from "./playbooks.js";
import { classifyRemoteFailure, probeRemote, readRemoteIdentity, type RemoteIdentity } from "./remote.js";
import { AUTHOR, currentLinks, deliveryMerged, GitScan, LANDED_ELSEWHERE, primaryOf, type ScanSummary, type UnlinkedBranch } from "./scan/absorb.js";
import { Sessions, type SessionMoment } from "./sessions.js";
import { CODE_WORDS, type CodeWords } from "./words.js";
import { Starter, type StartGate, type StartOptions, type StartResult } from "./start.js";
import { CodeLinkStore, MIGRATIONS, TABLES, type CodeLinkView, type DeliveryView, type ProposalView, type Readiness, type RepoStatePatch, type RepoStateView, type SessionView } from "./store.js";
import { readSnapshot, saveSnapshot, snapshotFile } from "./snapshots.js";
import { askLine, permissionAsk, questionAsk } from "./ask.js";
import { Review, type ReviewCursor, type ReviewPage, type ReviewSaid, type ReviewView, type SessionOutcome } from "./review.js";
import { recordOf, resumeCommand } from "./titles.js";
import { AUTO_TERMINAL, TerminalSettings, commandOk, exec, locatedCommand, terminalApps, terminalPath } from "./terminal.js";
import { registerTools } from "./tools.js";
import { type CodeLinkReader, contract, errorMessage } from "@tomradex/contracts";
import { ghRow, probeGh, type GhStatus } from "./gh.js";

export { AUTHOR, deliveryMerged, primaryOf, type ScanSummary, type UnlinkedBranch } from "./scan/absorb.js";
export { compareUrl, MERGE_COMMAND, type MergeCause, type MergeCheckView, type MergeLocalResult, type MergeResult, type OpenPrResult } from "./landing.js";
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
    /** A start was remembered: the next one-click Start goes this way. The renderer hears codeLink.startDefaultsChanged. */
    "codeLink/start-defaults"(): void;
    /** Asked: a window inside Tomrade can show this project's herdr sessions. Its plugin answers true. */
    "codeLink/terminal-window"(projectId: string): Promise<boolean | void> | boolean | void;
    /** Asked: show this session's herdr terminal inside Tomrade. True once a window has. */
    "codeLink/show-session"(projectId: string, sessionId: string): Promise<boolean | void> | boolean | void;
    /** Asked: open a new terminal inside Tomrade that takes this ended session's conversation up again. True once a window has. */
    "codeLink/resume-session"(projectId: string, sessionId: string): Promise<boolean | void> | boolean | void;
    /** Asked: which cell of Tomrade's Terminal window shows each session, numbered as the window numbers them; nothing while no window is open. */
    "codeLink/session-cells"(projectId: string): Promise<Record<string, number> | void> | Record<string, number> | void;
    /** Asked: whether what this session's pane showed was recorded here. */
    "codeLink/raw-output-there"(projectId: string, sessionId: string): Promise<boolean | void> | boolean | void;
    /** Asked: the recording of what this session's pane showed, to play back; the Terminal window's plugin answers. */
    "codeLink/raw-output"(projectId: string, sessionId: string): Promise<RawOutput | null | void> | RawOutput | null | void;
  }
}

/** How long an ended session stays in the session lists, and how many of them do: the rest are the look back's. */
export const RECENT_ENDED_MS = 24 * 60 * 60_000;
export const RECENT_ENDED_MAX = 8;

/** A session as the session lists show it: an ended one with what came of it; a live one with whether its card can answer its prompt. */
export type RecentSession = SessionView & SessionGlance & { outcome: SessionOutcome | null };

/** A recording of a pane's output, as the Terminal window's plugin hands it over to play back elsewhere. */
export interface RawOutput {
  /** In order; those before `at` bring the screen to the stretch's start and are not shown. */
  records: { t: number; w: number; h: number; full: boolean; key: boolean; bytes: Uint8Array }[];
  at: number;
  /** The stretch's own start did not fit: it begins later than the session did. */
  cut: boolean;
  /** The first record paints the whole screen; otherwise the picture fills in as it plays. */
  clean: boolean;
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

export type RepoPolicyPatch = Pick<RepoStatePatch, "branchTemplate" | "autoDone" | "agentPush" | "agentMerge" | "mergePolicy" | "readiness" | "connectAgents">;

/** Several tickets started headless at once from a conversation, with one configuration — the assistant's own engine, or the one the person picked on the card. */
export interface StartBatchRequest {
  itemIds: string[];
  /** The conversation that asked: where each ticket's delivery is reported back. */
  requestedBy: string;
  engine?: string;
  options?: Record<string, unknown>;
  permissionMode?: string;
  /** What each session is to do first, when that is not the ticket's work as written. */
  task?: string;
  allowBlocked?: boolean;
  /** The person said to merge once delivered: Tomrade merges without asking again. */
  autoMerge?: boolean;
  /** The card in that conversation that asked for the configuration; it shows the outcome once started. */
  cardId?: string;
}

/** One ticket of a batch start: started, or stopped at a gate with the one thing that clears it. */
export interface StartBatchEntry extends Pick<Extract<StartResult, { ok: false }>, "board" | "repo" | "remote" | "placed" | "cause" | "bootstrapKey"> {
  itemId: string;
  key: string;
  title: string;
  ok: boolean;
  threadId?: string | null;
  branch?: string;
  engine?: string;
  continued?: boolean;
  gate?: StartGate;
  blockers?: string[];
  message?: string;
}

/** The card a conversation shows for tickets it was asked to start: the person's pick when the assistant could not settle it, then what came of each. */
export interface StartBatchCard {
  tickets: { itemId: string; key: string; title: string }[];
  task?: string;
  /** Why the assistant's own engine could not run them, when the person is asked to pick one. */
  reason?: string;
  /** The configuration settled for them, when the person is only asked whether to start. */
  config?: { engine: string; options?: Record<string, unknown>; permissionMode?: string };
  /** Present once started. */
  results?: StartBatchEntry[];
}

/** The card a conversation shows once a ticket it asked for is delivered under the "ask" policy. */
export interface MergeCard {
  itemId: string;
  key: string;
  title: string;
  repo: string;
  branch: string;
  base: string;
  prUrl: string | null;
  /** `resolving`: the ticket's session was sent back to clear what stood in the way; the card is offered again once it hands over. */
  state: "offered" | "merged" | "refused" | "resolving";
  message?: string;
  /** Why it was refused, when it was. */
  cause?: MergeCause;
}

/** How tickets asked for in a conversation run: the assistant's own engine, what the Start dialog last ran with, or the person's pick. */
export type StartConfig =
  | { choose: false; engine: string; options?: Record<string, unknown>; permissionMode?: string; from: "conversation" | "remembered" }
  | { choose: true; reason: string };

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
    /** The session lists' rows: every live session, and the few that ended in the last day with what came of each. */
    "codeLink.recentSessions": (projectId: string) => RecentSession[];
    /** Which cell of the Terminal window shows each session, by session id; empty while the window is closed. */
    "codeLink.sessionCells": (projectId: string) => Record<string, number>;
    /** Push the ticket's branch from its worktree and open a pull request (gh), or hand back the compare page. */
    "codeLink.openPr": (projectId: string, itemId: string) => OpenPrResult;
    /** A repository with no remote: merge the ticket's branch into the default branch on this machine. */
    "codeLink.mergeLocal": (projectId: string, itemId: string) => MergeLocalResult;
    /** Land the ticket's delivery on the person's word: the pull request through gh, or the branch here without a remote. */
    "codeLink.merge": (projectId: string, itemId: string) => MergeLocalResult;
    /** Start several tickets headless from a conversation, with one configuration. */
    "codeLink.startTickets": (projectId: string, request: StartBatchRequest) => StartBatchEntry[];
    /** A merge refused for a conflict: the ticket's session is sent back to bring its branch up to date, from this conversation. */
    "codeLink.resolveMerge": (projectId: string, itemId: string, requestedBy: string) => StartBatchEntry;
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
    /** Whether gh is there and signed in: a recommendation for opening and merging pull requests, never needed to connect. */
    "codeLink.gh": () => GhStatus;
    /** Sessions started here open in Tomrade's own Terminal window: herdr is the terminal and the window is on. */
    "codeLink.terminalWindow": (projectId: string) => boolean;
    /** Show a session's herdr terminal in Tomrade's Terminal window; false when no window can. */
    "codeLink.showSession": (projectId: string, sessionId: string) => boolean;
    /** A session's conversation from its agent's own record: its end, or the stretch `before` an earlier read's start. */
    "codeLink.conversation": (projectId: string, sessionId: string, before?: number) => RecordRead | null;
    /** What the assistant panel can do with a terminal session: type into its pane, answer its permission prompt. */
    "codeLink.sessionPanel": (projectId: string, sessionId: string) => SessionPanelView;
    /** Text into the session's pane, with Enter, as typed at its keyboard. */
    "codeLink.sessionSay": (projectId: string, sessionId: string, text: string) => boolean;
    /** The agent's declared keys for its permission prompt, pressed in the session's pane. */
    "codeLink.sessionAnswer": (projectId: string, sessionId: string, which: "allow" | "deny") => AnswerResult;
    /** The last lines on the session's pane; null without a pane. Asked by the panel only while it shows the session. */
    "codeLink.sessionTail": (projectId: string, sessionId: string, lines: number) => string | null;
    /** Where a conversation runs — here on its engine's SDK, or in a terminal as a session — and whether it can move now. */
    "codeLink.handoff": (projectId: string, threadId: string) => HandoffView;
    /** The conversation to a terminal cell: its runtime here closed, its engine's CLI resuming the same session there. */
    "codeLink.toTerminal": (projectId: string, threadId: string) => HandoffResult;
    /** The conversation back to the panel once its CLI exited: the next message resumes the same session through the SDK. */
    "codeLink.backToPanel": (projectId: string, threadId: string) => HandoffResult;
    /** How herdr installs on this machine: Homebrew's command where brew is, herdr's own installer on macOS and Linux, else only its install guide. */
    "codeLink.herdrInstall": () => HerdrInstall;
    /** Install herdr in a terminal with that command; the page never names it. */
    "codeLink.installHerdr": () => { launched: boolean; command: string };
    /** One page of ended conversations to look back on, newest first; with `query`, the newest that match it. */
    "codeLink.reviewList": (projectId: string, opts?: { before?: ReviewCursor | null; limit?: number; query?: string }) => ReviewPage;
    /** The ended conversations that said `query`, among the newest few: read one at a time, never all at once. */
    "codeLink.reviewSaid": (projectId: string, query: string) => ReviewSaid;
    /** One ended conversation opened whole, cut by the tickets it worked; null when it is not there. */
    "codeLink.reviewOpen": (projectId: string, ref: { sessionId?: string; threadId?: string }) => ReviewView | null;
    /** What the session's pane showed while it ran, as the Terminal window recorded it; null without a recording. */
    "codeLink.reviewRaw": (projectId: string, sessionId: string) => RawOutput | null;
    /** Take an ended conversation up again in a new Terminal window cell, with its agent's own resume command; false when no window can. */
    "codeLink.resumeInTerminal": (projectId: string, sessionId: string) => boolean;
  }
  interface Broadcasts {
    "codeLink.changed": (projectId: string) => void;
    /** The Terminal window's cells came to show other sessions, or it opened or closed: `codeLink.sessionCells` reads differently. */
    "codeLink.cellsChanged": (projectId: string) => void;
    /** What Start last ran with changed: windows that show a one-click Start read it again. */
    "codeLink.startDefaultsChanged": () => void;
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
    /** How long a Start may take before the person is told it failed, rather than left waiting on a stuck step. */
    startTimeoutMs: z.number().int().min(1).default(120_000),
    /** Where the Start dialog's last used configuration rests, beside the settings file. Null keeps none. */
    defaultsPath: z.string().nullish(),
    /**
     * Write Tomrade into each installed agent's own user-level configuration without a press. Off for a run that must
     * leave the person's agents as they are (a UI check); `missing` only fills a link nobody made, never one that names
     * another Tomrade (a checkout beside the installed app). Settings still connects one by hand.
     */
    linkAgents: z.union([z.boolean(), z.literal("missing"), z.stringbool()]).default(true)
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
        geminiCommand: { title: "Gemini CLI 命令", description: "{geminiHome} 是只给本次会话用的 Gemini 主目录：沿用你自己的 ~/.gemini（登录、扩展、历史），在它设置的副本里加上 Tomrade 的服务，以及向它回报这次会话的 hooks。你自己的文件不会被改动。" },
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
  /** The look back on ended conversations: a page at a time, one opened whole. */
  review!: Review;

  private readonly home: Context;
  private readonly git: Git;
  private starter!: Starter;
  private orientation!: Orientation;
  private followOnStore!: FollowOnStore;
  private scans!: GitScan;
  private landing!: Landing;
  private connections!: Connections;
  private repoConnect!: RepoConnect;
  /** Repositories whose files are being filled in right now, so two triggers do not write at once. */
  private readonly autoConnecting = new Set<string>();
  /** Coalesces the engines' arrivals into one pass over the projects' repositories. */
  private autoConnectTimer: NodeJS.Timeout | null = null;
  private herdr!: HerdrBridge;
  private panel!: SessionPanel;
  private handoff!: Handoff;
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
    this.followOnStore = new FollowOnStore(config.defaultsPath ? path.join(path.dirname(config.defaultsPath), "code-link-follow-ons.json") : null);
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
      prefixOf: (projectId) => this.prefixOf(projectId),
      onMoment: (session, moment) => this.noteMoment(session, moment),
      onWaiting: (session, ask) => this.herdr.waiting(session, askLine(ask, this.words())),
      panes: { alive: (pane) => this.herdr.paneAlive(pane), info: (pane) => this.herdr.pane(pane) },
      // A terminal session cannot be typed into: when the limit lifts the person is told, not the agent.
      onLimit: (session, until) => {
        const agent = this.ctx.get("agent");
        const park = session.threadId && agent ? agent.park(session.projectId, session.threadId, { until, resume: false, note: false }) : null;
        return this.limitedWords(park?.until ?? until ?? Date.now() + 15 * 60_000, park?.known ?? until !== null, false);
      },
      // A pass already running still saw this session as active.
      onEnd: (session) => void this.rescan(session.projectId).catch((err) => this.ctx.logger.warn(`code scan after session ${session.id} ended failed: ${errorMessage(err)}`)),
      onEnded: (session) => void this.saveRecord(session)
    });
    this.herdr = new HerdrBridge({ ctx: this.ctx, store: this.store, sessions: this.sessions, words: () => this.words(), sessionDir: (id) => this.sessionDir(id) });
    this.panel = new SessionPanel(this.ctx, this.store);
    this.review = new Review({ ctx: this.ctx, store: this.store, read: (projectId, sessionId, before) => this.conversation(projectId, sessionId, before), recorded: (projectId, sessionId) => this.herdr.rawOutputThere(projectId, sessionId) });
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
    this.handoff = new Handoff({
      ctx: this.ctx,
      store: this.store,
      sessions: this.sessions,
      starter: this.starter,
      herdr: this.herdr,
      words: () => this.words(),
      notify: (projectId) => this.notify(projectId),
      say: (projectId, threadId, text) => this.sayToThread(projectId, threadId, text)
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
    this.orientation = new Orientation({ ctx: this.ctx, store: this.store, starter: this.starter, words: () => this.words() });
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
        if (typeof id === "string") this.filed(call.projectId, id, call.connection);
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
        excusing: (projectId) => {
          const id = this.sessions.excuser(projectId);
          return id ? this.store.session(projectId, id) : null;
        },
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
        mergeLocal: (projectId, itemId, opts) => this.mergeLocal(projectId, itemId, opts),
        merge: (projectId, itemId) => this.merge(projectId, itemId),
        startConfigFor: (projectId, threadId) => this.startConfigFor(projectId, threadId),
        startTickets: (projectId, request) => this.startTickets(projectId, request),
        resolveMerge: (projectId, itemId, requestedBy) => this.resolveMerge(projectId, itemId, requestedBy)
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
      if (after.status === "done" || after.status === "cancelled") this.followOnStore.drop(intent.projectId, intent.id);
      // Each is taken before it starts, so a ticket follows once; the start runs after this write has settled.
      if (after.status === "done") for (const followOn of this.followOnStore.take(intent.projectId, intent.id)) void Promise.resolve().then(() => this.startFollowOn(followOn, after));
      if (after.status === "done") this.archiveCompletedSessions(intent.projectId);
      if (after.status === "verifying") this.offerMerge(intent.projectId, after);
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
      // Only while the session lives: a conversation brought back to the panel once its CLI exited stays there.
      const placeTerminalThreads = (projectId: string) => {
        for (const session of this.store.sessions(projectId)) {
          if (session.mode !== "terminal" || !session.threadId || session.state === "ended" || session.state === "lost") continue;
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
      // One process on a conversation's session at a time: while its CLI runs in a terminal, nothing starts here.
      ctx.on("agent/before-send", (thread) => this.handoff.refuseSend(thread));
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
        if (event.pending) this.sessions.touch(thread.projectId, session.id, { state: "waiting", activity: null, ask: event.pending.kind === "permission" ? permissionAsk(null, undefined) : questionAsk() });
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
      ctx.ipc.handle("codeLink.recentSessions", (projectId) => ctx.codeLink.recentSessions(projectId));
      ctx.ipc.handle("codeLink.sessionCells", (projectId) => ctx.codeLink.sessionCells(projectId));
      ctx.ipc.handle("codeLink.openPr", (projectId, itemId) => ctx.codeLink.openPr(projectId, itemId));
      ctx.ipc.handle("codeLink.mergeLocal", (projectId, itemId) => ctx.codeLink.mergeLocal(projectId, itemId));
      ctx.ipc.handle("codeLink.merge", (projectId, itemId) => ctx.codeLink.merge(projectId, itemId));
      ctx.ipc.handle("codeLink.startTickets", (projectId, request) => ctx.codeLink.startTickets(projectId, request));
      ctx.ipc.handle("codeLink.resolveMerge", (projectId, itemId, requestedBy) => ctx.codeLink.resolveMerge(projectId, itemId, requestedBy));
      ctx.ipc.handle("codeLink.worktree", (projectId, itemId) => ctx.codeLink.worktreeOf(projectId, itemId));
      ctx.ipc.handle("codeLink.adoptBranch", (projectId, repoId, branch) => ctx.codeLink.adoptBranch(projectId, repoId, branch));
      ctx.ipc.handle("codeLink.connection", (projectId, repoId) => ctx.codeLink.connection(projectId, repoId));
      ctx.ipc.handle("codeLink.connect", (projectId, repoId, mode) => ctx.codeLink.connect(projectId, repoId, mode));
      ctx.ipc.handle("codeLink.setupInTerminal", (engineId, step) => ctx.codeLink.setupInTerminal(engineId, step));
      ctx.ipc.handle("codeLink.startDefaults", () => ctx.codeLink.startDefaults());
      ctx.ipc.handle("codeLink.herdrStatus", () => ctx.codeLink.herdrStatus());
      ctx.ipc.handle("codeLink.gh", () => probeGh());
      ctx.ipc.handle("codeLink.terminalWindow", (projectId) => ctx.codeLink.terminalWindow(projectId));
      ctx.ipc.handle("codeLink.showSession", (projectId, sessionId) => ctx.codeLink.showSession(projectId, sessionId));
      ctx.ipc.handle("codeLink.conversation", (projectId, sessionId, before) => ctx.codeLink.conversation(projectId, sessionId, before));
      ctx.ipc.handle("codeLink.sessionPanel", (projectId, sessionId) => ctx.codeLink.sessionPanel(projectId, sessionId));
      ctx.ipc.handle("codeLink.sessionSay", (projectId, sessionId, text) => ctx.codeLink.sessionSay(projectId, sessionId, text));
      ctx.ipc.handle("codeLink.sessionAnswer", (projectId, sessionId, which) => ctx.codeLink.sessionAnswer(projectId, sessionId, which));
      ctx.ipc.handle("codeLink.sessionTail", (projectId, sessionId, lines) => ctx.codeLink.sessionTail(projectId, sessionId, lines));
      ctx.ipc.handle("codeLink.handoff", (projectId, threadId) => ctx.codeLink.handoffOf(projectId, threadId));
      ctx.ipc.handle("codeLink.toTerminal", (projectId, threadId) => ctx.codeLink.toTerminal(projectId, threadId));
      ctx.ipc.handle("codeLink.backToPanel", (projectId, threadId) => ctx.codeLink.backToPanel(projectId, threadId));
      ctx.ipc.handle("codeLink.herdrInstall", () => ctx.codeLink.herdrInstall());
      ctx.ipc.handle("codeLink.installHerdr", () => ctx.codeLink.installHerdr());
      ctx.ipc.handle("codeLink.reviewList", (projectId, opts) => ctx.codeLink.review.list(projectId, opts));
      ctx.ipc.handle("codeLink.reviewSaid", (projectId, query) => ctx.codeLink.review.saidIn(projectId, query));
      ctx.ipc.handle("codeLink.reviewOpen", (projectId, ref) => ctx.codeLink.review.open(projectId, ref));
      ctx.ipc.handle("codeLink.reviewRaw", (projectId, sessionId) => ctx.codeLink.rawOutput(projectId, sessionId));
      ctx.ipc.handle("codeLink.resumeInTerminal", (projectId, sessionId) => ctx.codeLink.resumeInTerminal(projectId, sessionId));
    });
    // Only on a general look: when an agent's turn failed, gh is never the cause.
    this.home.inject(["doctor"], (ctx) => {
      const doctor = contract(ctx, "doctor");
      doctor?.check({ id: "gh", title: () => CODE_WORDS(doctor.locale())("ghTitle"), applies: (topic) => !(topic as { engineId?: string }).engineId, run: async () => ghRow(await probeGh(), CODE_WORDS(doctor.locale())) });
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
        ? { id: live.id, mode: live.mode, agent: live.agent, state: live.state, summary: live.summary, activity: live.ask ? askLine(live.ask, this.words()) : live.activity, blocked: live.blocked, threadId: live.threadId, worktree: live.worktree, lastEventAt: live.lastEventAt ?? live.startedAt }
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
   * Conversations that ended before Tomrade kept their titles: each finds its
   * record by the agent's session id, read as its agent's engine says, and
   * keeps the title once found. Each session is looked for once.
   */
  findTitles(projectId: string): boolean {
    let found = false;
    for (const s of this.store.sessions(projectId)) {
      if (s.title || s.itemIds.length || !s.externalId || s.state !== "ended" && s.state !== "lost") continue;
      const record = recordOf(this.ctx, s.agent);
      if (!record?.title || this.titlesLooked.has(s.id)) continue;
      this.titlesLooked.add(s.id);
      const transcript = s.transcript ?? record.find(s.externalId, { cwd: s.cwd ?? null });
      const title = transcript ? record.title(transcript) : null;
      if (!title) continue;
      this.store.patchSession(projectId, s.id, { title, transcript, prompted: true });
      found = true;
    }
    return found;
  }

  /**
   * A session's conversation from its agent's own record, read-only: its end, or the stretch `before` an earlier
   * read's start. Null when Tomrade cannot read that agent's record.
   */
  conversation(projectId: string, sessionId: string, before?: number): RecordRead | null {
    const s = this.store.session(projectId, sessionId);
    if (!s?.externalId) return null;
    const record = recordOf(this.ctx, s.agent);
    const file = record ? (s.transcript ?? record.find(s.externalId, { cwd: s.cwd ?? null })) : null;
    const read = record && file ? record.read(file, before === undefined ? undefined : { before }) : null;
    if (read || !s.recordSavedAt) return read;
    // The agent's own record is gone (its CLI cleans old ones up) or unreadable here: what was saved when it ended.
    const saved = snapshotFile(this.recordsDir(), s.agent, s.externalId);
    return saved ? readSnapshot(saved, before) : null;
  }

  /**
   * A ticket session's conversation, saved on this machine as it ends, so it reads back after its agent cleans its
   * own records up. Never synced and never a delivery's file; a failure is only logged.
   */
  private async saveRecord(session: SessionView): Promise<void> {
    if (!session.itemIds.length || !session.externalId) return;
    try {
      // After the hook that ended it has its answer.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const record = recordOf(this.ctx, session.agent);
      const file = record ? (session.transcript ?? record.find(session.externalId, { cwd: session.cwd ?? null })) : null;
      const to = snapshotFile(this.recordsDir(), session.agent, session.externalId);
      if (!record || !file || !to) return;
      const saved = await saveSnapshot(to, session.agent, record, file);
      if (saved) this.store.patchSession(session.projectId, session.id, { recordSavedAt: Date.now(), recordCut: saved.cut });
    } catch (err) {
      this.ctx.logger.warn(`saving session ${session.id}'s conversation failed: ${errorMessage(err)}`);
    }
  }

  private recordsDir(): string {
    return path.join(this.ctx.hub.dir ?? path.join(os.tmpdir(), "tomrade"), "sessions", "records");
  }

  sessionsOf(projectId: string, itemId?: string): SessionView[] {
    return this.store.sessions(projectId, itemId ? { itemId } : {});
  }

  /** What the assistant panel can do with a terminal session besides read its conversation. */
  sessionPanel(projectId: string, sessionId: string): SessionPanelView {
    return this.panel.view(projectId, sessionId);
  }

  /** Text into a terminal session's pane, with Enter, as typed at its keyboard; false when it could not go. */
  sessionSay(projectId: string, sessionId: string, text: string): Promise<boolean> {
    return this.panel.say(projectId, sessionId, text);
  }

  /** The agent's declared keys for its permission prompt, pressed in the session's pane while it shows one; see `SessionPanel.answer`. */
  sessionAnswer(projectId: string, sessionId: string, which: "allow" | "deny"): Promise<AnswerResult> {
    return this.panel.answer(projectId, sessionId, which);
  }

  /** The last lines on a terminal session's pane; null without a pane, or when it is gone. */
  sessionTail(projectId: string, sessionId: string, lines: number): Promise<string | null> {
    return this.panel.tail(projectId, sessionId, lines);
  }

  /** Where a conversation runs, here or in a terminal, and whether it can move now; see `Handoff`. */
  handoffOf(projectId: string, threadId: string): HandoffView {
    return this.handoff.view(projectId, threadId);
  }

  /** The conversation to a terminal cell, its runtime here closed first. */
  toTerminal(projectId: string, threadId: string): Promise<HandoffResult> {
    return this.handoff.toTerminal(projectId, threadId);
  }

  /** The conversation back to the panel, once its CLI exited. */
  backToPanel(projectId: string, threadId: string): Promise<HandoffResult> {
    return this.handoff.backToPanel(projectId, threadId);
  }

  /**
   * Asked on every session change while a list shows: it reads the live rows and a handful of ended ones, not the whole
   * history; each live pane's last lines through the glance, at most once per event and every few seconds.
   */
  async recentSessions(projectId: string, now = Date.now()): Promise<RecentSession[]> {
    const rows = this.store.recentSessions(projectId, now - RECENT_ENDED_MS, RECENT_ENDED_MAX);
    const isEnded = (s: SessionView) => s.state === "ended" || s.state === "lost";
    const ended = rows.filter(isEnded);
    const outcomes = ended.length ? this.review.outcomes(projectId, ended) : new Map<string, SessionOutcome>();
    const glances = await this.panel.glance(rows.filter((s) => !isEnded(s)), now);
    return rows.map((s) => ({ ...s, approval: false, prompt: null, tail: null, ...glances.get(s.id), outcome: outcomes.get(s.id) ?? null }));
  }

  /** The Terminal window's bar: the same glance at these live sessions' panes the panel's cards have, from the same reads. */
  async sessionGlances(projectId: string, sessionIds: string[]): Promise<Map<string, SessionGlance>> {
    const sessions = sessionIds.flatMap((id) => this.store.session(projectId, id) ?? []);
    return sessions.length ? this.panel.glance(sessions) : new Map();
  }

  /** What came of each of these ended sessions, by id, the way every list says it. */
  sessionOutcomes(projectId: string, sessionIds: string[]): Map<string, SessionOutcome> {
    const sessions = sessionIds.flatMap((id) => this.store.session(projectId, id) ?? []);
    return sessions.length ? this.review.outcomes(projectId, sessions) : new Map();
  }

  /** Which Terminal window cell shows each session; empty while no window shows the project. */
  async sessionCells(projectId: string): Promise<Record<string, number>> {
    try {
      return ((await this.ctx.serial("codeLink/session-cells", projectId)) as Record<string, number> | undefined) ?? {};
    } catch (error) {
      this.ctx.logger.warn(`codeLink/session-cells: ${errorMessage(error)}`);
      return {};
    }
  }

  /** The Terminal window's cells show other sessions now: the windows that name cells read them again. */
  cellsChanged(projectId: string): void {
    this.home.get("ipc")?.send("codeLink.cellsChanged", projectId);
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
    const { then, ...rest } = opts;
    const result = await this.withinStartTimeout(projectId, itemId, this.starter.start(projectId, itemId, rest));
    // Only what actually started is remembered, with the engine it settled on: a gate the user had to
    // clear leaves the memory as it was, and an engine the caller left to Tomrade is not lost.
    if (result.ok) {
      this.defaults.write({ mode: rest.mode, engine: result.engine, options: rest.options, permissionMode: rest.permissionMode, playbook: rest.playbook });
      // A start from a conversation, MCP or another window: every open Start button names the new choice at once.
      this.home.emit("codeLink/start-defaults");
      this.home.get("ipc")?.send("codeLink.startDefaultsChanged");
    }
    // The ticket this one was started ahead of follows it with the same choices once it lands.
    if (result.ok && then && then !== itemId && this.ctx.items.get(projectId, then)) {
      this.followOnStore.add({ projectId, itemId: then, afterItemId: itemId, options: { mode: rest.mode, engine: result.engine, options: rest.options, permissionMode: rest.permissionMode, playbook: rest.playbook }, at: Date.now() });
    }
    return result;
  }

  /** A Start stuck on a step that never answers (git waiting on a credential prompt, say) fails with the reason instead. */
  private withinStartTimeout(projectId: string, itemId: string, started: Promise<StartResult>): Promise<StartResult> {
    const ms = this.config.startTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const key = this.ctx.items.get(projectId, itemId)?.key ?? itemId;
        reject(new Error(this.words()("startTimedOut", { key, seconds: Math.ceil(ms / 1000) })));
      }, ms);
    });
    return Promise.race([started, timedOut]).finally(() => clearTimeout(timer));
  }

  /** Tickets waiting to start by themselves once another lands. */
  followOns(): FollowOn[] {
    return this.followOnStore.list();
  }

  private async startFollowOn(followOn: FollowOn, landed: Item): Promise<void> {
    const item = this.ctx.items.get(followOn.projectId, followOn.itemId);
    if (!item || item.status === "done" || item.status === "cancelled") return;
    try {
      const result = await this.start(followOn.projectId, followOn.itemId, followOn.options);
      if (!result.ok) {
        this.ctx.logger.warn(`${item.key} did not start after ${landed.key} landed: ${result.message}`);
        return;
      }
      const agent = this.ctx.get("agent");
      if (result.threadId && agent) agent.store.appendMessage(followOn.projectId, result.threadId, "system", { type: "note", text: this.words()("followOnStarted", { key: item.key, after: landed.key }) }, null);
    } catch (err) {
      this.ctx.logger.warn(`${item.key} did not start after ${landed.key} landed: ${errorMessage(err)}`);
    }
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

  /** An ended conversation taken up again in a new Terminal window cell, by its agent's resume command; false when no window can, or its agent cannot. */
  resumeInTerminal(projectId: string, sessionId: string): Promise<boolean> {
    const s = this.store.session(projectId, sessionId);
    if (!s || !resumeCommand(s.agent, s.externalId)) return Promise.resolve(false);
    return this.herdr.resumeSession(projectId, sessionId);
  }

  /** The recording of what a session's pane showed, from the Terminal window's plugin; null without one. */
  async rawOutput(projectId: string, sessionId: string): Promise<RawOutput | null> {
    try {
      return (await this.ctx.serial("codeLink/raw-output", projectId, sessionId)) ?? null;
    } catch (error) {
      this.ctx.logger.warn(`codeLink/raw-output: ${errorMessage(error)}`);
      return null;
    }
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
   * A ticket an agent filed from its own terminal, before any claim: its conversation takes it when it holds nothing
   * else — one already working a ticket filed a follow-up, not its next one. The filer is the conversation its
   * connection claimed for, else the one whose hooks announced this call; with neither, the only conversation on that
   * repository, if it is the only one — with two, nothing says whose the ticket is, and the agent's own claim decides.
   */
  private filed(projectId: string, itemId: string, connection: string | undefined): void {
    const item = this.ctx.items.get(projectId, itemId);
    const repoId = item ? this.ctx.boards.get(projectId, item.boardId)?.repoId : null;
    // An epic is planned, never worked: no session claims or delivers it.
    if (!item || item.kind !== "ticket" || !repoId) return;
    const conversation = (s: SessionView) => s.externalId ?? s.id;
    const live = this.store.sessions(projectId, { live: true }).filter((s) =>
      s.mode === "terminal" && s.agent !== MCP_AGENT && s.threadId === null && s.repoId === repoId && s.endedAt === null && s.state !== "lost");
    const announced = this.sessions.filer(projectId, item.title);
    const bound = connection ? this.connections.connectedSessions(projectId, connection) : [];
    const announcer = announced && !bound.length ? this.store.session(projectId, announced) : null;
    const filer = bound.length ? new Set(bound.map(conversation)) : announcer ? new Set([conversation(announcer)]) : null;
    const theirs = filer ? live.filter((s) => filer.has(conversation(s))) : live;
    if (new Set(theirs.map(conversation)).size !== 1 || theirs.some((s) => s.itemIds.length)) return;
    // One conversation may have left several rows behind: the one its hooks reached last, not the earlier one a restart left standing.
    const latest = theirs.reduce((best, s) => ((s.lastEventAt ?? s.startedAt) > (best.lastEventAt ?? best.startedAt) ? s : best), theirs[0]!);
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
    if (!link || !this.config.linkAgents) return;
    const state = await link.status();
    if (state.state === "connected" || state.state === "unavailable") return;
    if (state.state === "stale" && this.config.linkAgents === "missing") return;
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

  /** The person said to merge: land the delivery, and tell the conversation that asked for the work how it went. */
  async merge(projectId: string, itemId: string): Promise<MergeLocalResult> {
    const result = await this.landing.merge(projectId, itemId);
    const item = this.ctx.items.get(projectId, itemId);
    if (item) this.reportMerge(projectId, item, result.merged ? "merged" : "refused", result.message, result.cause);
    return result;
  }

  /** The card id a ticket's delivery is reported on in the conversation that asked for it: one per delivery. */
  private mergeCardId(itemId: string, delivery: number): string {
    return `merge-${itemId}-${delivery}`;
  }

  /**
   * Where the ticket's current delivery is talked about: the conversation that asked for it, and the
   * conversation of the session here that delivered it — both get the merge to decide, so it is found
   * from either side. Empty when no conversation in Tomrade had a part in it.
   */
  private mergeThreadsOf(projectId: string, itemId: string): { threadIds: string[]; delivery: number } | null {
    const delivery = this.store.activeDelivery(projectId, itemId) ?? this.store.currentDelivery(projectId, itemId);
    if (!delivery) return null;
    const sessions = this.store.sessions(projectId, { itemId, delivery: delivery.sequence }).sort((a, b) => b.startedAt - a.startedAt);
    const threadIds: string[] = [];
    for (const id of [sessions.find((s) => s.requestedBy)?.requestedBy, ...sessions.filter((s) => s.mode === "headless" && s.threadId).map((s) => s.threadId)]) if (id && !threadIds.includes(id)) threadIds.push(id);
    return threadIds.length ? { threadIds, delivery: delivery.sequence } : null;
  }

  /** What a merge card says about the ticket's delivery right now: its repository, branch and pull request. */
  private mergeCard(projectId: string, item: Item, state: MergeCard["state"], message?: string, cause?: MergeCause): MergeCard | null {
    const link = primaryOf(this.currentLinks(projectId, item.id).filter((l) => l.branch));
    const repo = link ? this.ctx.repos.get(projectId, link.repoId) : null;
    if (!link || !repo) return null;
    return { itemId: item.id, key: item.key, title: item.title, repo: repo.name, branch: link.branch, base: repo.defaultBranch, prUrl: link.prUrl ?? null, state, ...(message ? { message } : {}), ...(cause ? { cause } : {}) };
  }

  /** Put the same merge card in every conversation on the delivery; `onlyExisting` updates the ones that have it rather than posting to all. */
  private placeMergeCard(projectId: string, item: Item, talked: { threadIds: string[]; delivery: number }, card: MergeCard, onlyExisting: boolean): void {
    const agent = this.ctx.get("agent");
    if (!agent) return;
    const id = this.mergeCardId(item.id, talked.delivery);
    for (const threadId of talked.threadIds) {
      const had = agent.store.cards(projectId, threadId).find((c) => c.id === id);
      if (onlyExisting && !had) continue;
      // A fresh offer goes once; a card already offered is left alone, one past that is offered again.
      if (!onlyExisting && had && (had.data as MergeCard).state === card.state) continue;
      try {
        agent.postCard(projectId, threadId, { id, schema: "merge", title: `${item.key} ${item.title}`, data: card }, AUTHOR);
      } catch (err) {
        this.ctx.logger.warn(`merge card for ${item.key} not posted: ${errorMessage(err)}`);
      }
    }
  }

  /**
   * A ticket asked for in a conversation reached Verifying: under the "ask" policy that conversation
   * gets the merge to decide, as a card with the pull request or branch and a Merge button.
   */
  private offerMerge(projectId: string, item: Item): void {
    const agent = this.ctx.get("agent");
    const talked = this.mergeThreadsOf(projectId, item.id);
    if (!agent || !talked) return;
    const card = this.mergeCard(projectId, item, "offered");
    if (!card) return;
    const link = primaryOf(this.currentLinks(projectId, item.id).filter((l) => l.branch));
    const policy = link ? this.store.repoState(projectId, link.repoId)?.mergePolicy : undefined;
    if (policy !== "ask") return;
    // Without a remote the branch is the delivery; with one, the pull request is — a bare pushed branch is not ready yet.
    if (!card.prUrl && this.store.repoState(projectId, link!.repoId)?.remote !== "none") return;
    this.placeMergeCard(projectId, item, talked, card, false);
    // The person said, when asking for the work, to merge it once in: no question, the card reports the outcome.
    const wanted = this.store.sessions(projectId, { itemId: item.id, delivery: talked.delivery }).some((s) => s.autoMerge);
    if (wanted) void this.merge(projectId, item.id).catch((err) => this.ctx.logger.warn(`auto-merge of ${item.key} failed: ${errorMessage(err)}`));
  }

  /** Every merge card on the delivery shows how the merge went; a conversation without one is not told. */
  private reportMerge(projectId: string, item: Item, state: "merged" | "refused", message: string, cause?: MergeCause): void {
    const talked = this.mergeThreadsOf(projectId, item.id);
    const card = talked && this.mergeCard(projectId, item, state, message, cause);
    if (talked && card) this.placeMergeCard(projectId, item, talked, card, true);
  }

  /**
   * A merge that a conflict stood in the way of: the ticket's own session is sent back, from the conversation,
   * to bring its branch up to date and hand over again — the card then offers the merge once more. Sent with
   * the merge wish the session had, so a merge the person asked for up front still happens by itself.
   */
  async resolveMerge(projectId: string, itemId: string, requestedBy: string): Promise<StartBatchEntry> {
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    const link = primaryOf(this.currentLinks(projectId, itemId).filter((l) => l.branch));
    const repo = link ? this.ctx.repos.get(projectId, link.repoId) : null;
    if (!link || !repo) throw new Error(`${item.key} has no branch to bring up to date`);
    const delivery = this.store.activeDelivery(projectId, itemId);
    const sessions = delivery ? this.store.sessions(projectId, { itemId, delivery: delivery.sequence }).sort((a, b) => b.startedAt - a.startedAt) : [];
    const last = sessions.find((s) => s.mode === "headless") ?? sessions[0] ?? null;
    const local = this.store.repoState(projectId, repo.id)?.remote === "none";
    const task = local
      ? `${link.branch} no longer merges into ${repo.defaultBranch}: merge ${repo.defaultBranch} into your branch, resolve every conflict, run the tests, commit, then call link_code with scopeChecked: true again.`
      : `${link.prUrl ?? link.branch} no longer merges into ${repo.defaultBranch}: merge origin/${repo.defaultBranch} into your branch, resolve every conflict, run the tests, push, then call link_code with scopeChecked: true again.`;
    // Back to Doing, so the next hand-over is a transition the merge offer hears.
    if (item.status === "verifying") this.ctx.items.update(projectId, itemId, { status: "doing" }, "human");
    const talked = this.mergeThreadsOf(projectId, itemId);
    const resolving = talked && this.mergeCard(projectId, item, "resolving");
    if (talked && resolving) this.placeMergeCard(projectId, item, talked, resolving, true);
    const [entry] = await this.startTickets(projectId, { itemIds: [itemId], requestedBy, task, ...(last?.agent && last.agent !== "other" ? { engine: last.agent } : {}), ...(last?.autoMerge ? { autoMerge: true } : {}) });
    if (!entry!.ok) {
      const refused = talked && this.mergeCard(projectId, item, "refused", entry!.message ?? `${item.key} could not be started`, "refused");
      if (talked && refused) this.placeMergeCard(projectId, item, talked, refused, true);
    }
    return entry!;
  }

  /**
   * How tickets asked for in a conversation run: with the conversation's own engine when it can code right
   * now, else as the Start dialog last ran — and when neither, the person picks on a card.
   */
  async startConfigFor(projectId: string, threadId: string): Promise<StartConfig> {
    const agent = this.ctx.get("agent");
    if (!agent) return { choose: true, reason: "the agent plugin is not loaded" };
    const thread = agent.store.thread(projectId, threadId);
    const reasons: string[] = [];
    if (thread) {
      const own = await this.starter.pickEngine(agent, thread.engine, false);
      if (own.ok) return { choose: false, engine: own.engine.id, ...(thread.options ? { options: thread.options } : {}), ...(thread.permissionMode ? { permissionMode: thread.permissionMode } : {}), from: "conversation" };
      reasons.push(own.reason);
    }
    const remembered = this.defaults.read();
    if (remembered?.engine && remembered.engine !== "other") {
      const picked = await this.starter.pickEngine(agent, remembered.engine, false);
      if (picked.ok) return { choose: false, engine: picked.engine.id, ...(remembered.options ? { options: remembered.options } : {}), ...(remembered.permissionMode ? { permissionMode: remembered.permissionMode } : {}), from: "remembered" };
      reasons.push(picked.reason);
    }
    return { choose: true, reason: reasons.filter((r, at, all) => all.indexOf(r) === at).join(" · ") || "no coding agent is ready" };
  }

  /** Start each ticket headless with the one configuration, one after another, and show each outcome on the asking card, when there is one, as it comes. */
  async startTickets(projectId: string, request: StartBatchRequest): Promise<StartBatchEntry[]> {
    const results: StartBatchEntry[] = [];
    const seen = new Set<string>();
    for (const itemId of request.itemIds) {
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      results.push(await this.startFromBatch(projectId, itemId, request));
      // The card shows a ticket's outcome before the next one starts: that one's progress is shown from here.
      this.showStarted(projectId, request, results);
    }
    return results;
  }

  private async startFromBatch(projectId: string, itemId: string, request: StartBatchRequest): Promise<StartBatchEntry> {
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) return { itemId, key: itemId, title: "", ok: false, message: `unknown item ${itemId}` };
    const opts: StartOptions = {
      mode: "run",
      ...(request.engine ? { engine: request.engine } : {}),
      ...(request.options ? { options: request.options } : {}),
      ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
      ...(request.allowBlocked ? { allowBlocked: true } : {}),
      ...(request.task?.trim() ? { message: request.task.trim() } : {}),
      ...(request.autoMerge ? { autoMerge: true } : {}),
      requestedBy: request.requestedBy
    };
    try {
      const started = await this.start(projectId, item.id, opts);
      if (started.ok) return { itemId: item.id, key: item.key, title: item.title, ok: true, threadId: started.threadId, branch: started.branch, engine: started.engine, continued: started.continued, ...(started.waitingOn ? { message: started.waitingOn } : {}) };
      // What the gate names travels with it, so the card can offer the same fix as the Start dialog.
      const { ok: _ok, pane: _pane, ...stopped } = started;
      return { itemId: item.id, key: item.key, title: item.title, ok: false, ...stopped };
    } catch (err) {
      return { itemId: item.id, key: item.key, title: item.title, ok: false, message: errorMessage(err) };
    }
  }

  private showStarted(projectId: string, request: StartBatchRequest, results: StartBatchEntry[]): void {
    const agent = this.ctx.get("agent");
    if (agent && request.cardId) {
      const before = agent.store.cards(projectId, request.requestedBy).find((c) => c.id === request.cardId);
      const data = (before?.data ?? {}) as Partial<StartBatchCard>;
      const tickets = [...(data.tickets ?? []), ...results.filter((r) => !data.tickets?.some((t) => t.itemId === r.itemId)).map((r) => ({ itemId: r.itemId, key: r.key, title: r.title }))];
      // A ticket started again from the card after its fix keeps the others' outcomes beside its own.
      const merged = [...(data.results ?? []).filter((r) => !results.some((n) => n.itemId === r.itemId)), ...results];
      // Kept with the outcome, so a ticket started again from the card goes with what the others went with.
      const config = data.config ?? (request.engine ? { engine: request.engine, ...(request.options ? { options: request.options } : {}), ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}) } : undefined);
      try {
        agent.postCard(projectId, request.requestedBy, { id: request.cardId, schema: "start-batch", title: before?.title ?? tickets.map((t) => t.key).join(", "), data: { ...data, tickets, results: merged, ...(config ? { config } : {}) } satisfies StartBatchCard }, AUTHOR);
      } catch (err) {
        this.ctx.logger.warn(`start card not updated: ${errorMessage(err)}`);
      }
    }
  }

  openPr(projectId: string, itemId: string): Promise<OpenPrResult> {
    return this.landing.openPr(projectId, itemId);
  }

  // ── the scan ───────────────────────────────────────────────────────────────

  /** One scan per project at a time; a second caller gets the running one. */
  scan(projectId: string): Promise<ScanSummary> {
    return this.scans.scan(projectId).then((summary) => this.oriented(projectId, summary));
  }

  private rescan(projectId: string): Promise<ScanSummary> {
    return this.scans.rescan(projectId).then((summary) => this.oriented(projectId, summary));
  }

  async scanOpen(): Promise<void> {
    for (const projectId of this.ctx.db.openIds()) {
      try {
        await this.scan(projectId);
      } catch (err) {
        this.ctx.logger.warn(`code scan of ${projectId} failed: ${errorMessage(err)}`);
      }
    }
  }

  /** A scan that found a project in a repository the project knows nothing about yet has it read; the scan's result is not changed by it. */
  private async oriented(projectId: string, summary: ScanSummary): Promise<ScanSummary> {
    try {
      await this.orientation.sweep(projectId);
    } catch (err) {
      this.ctx.logger.warn(`orientation in ${projectId} failed: ${errorMessage(err)}`);
    }
    return summary;
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
  repositoriesOf(projectId: string): { workstream: string; name: string; path: string | null; defaultBranch: string; readiness: Readiness; hasBrief: boolean }[] {
    return this.ctx.boards.list(projectId).flatMap((board) => {
      const repo = board.repoId ? this.ctx.repos.get(projectId, board.repoId) : null;
      if (!repo) return [];
      const checkout = this.ctx.repos.checkout(repo.remote).checkout;
      // A folder outside the checkout is no folder to read from.
      const subdir = checkout ? repoSubfolder(board.repoPath, checkout) : null;
      const folder = checkout && subdir !== null && fs.existsSync(checkout) ? (subdir ? path.join(checkout, subdir) : checkout) : null;
      // What the last scan made of it: a conversation plans against an empty repository differently from a full one.
      const state = this.store.repoState(projectId, repo.id);
      return [{ workstream: board.name, name: repo.name, path: folder, defaultBranch: repo.defaultBranch, readiness: state?.readiness ?? "unknown", hasBrief: state?.hasBrief ?? false }];
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
    this.sayToThread(session.projectId, session.threadId, text);
  }

  /** A line of Tomrade's into a thread, on screen at once. */
  private sayToThread(projectId: string, threadId: string, text: string): void {
    const agent = this.ctx.get("agent");
    if (!agent?.store.thread(projectId, threadId)) return;
    const message = agent.store.appendMessage(projectId, threadId, "system", { type: "note", text }, null);
    this.home.get("ipc")?.send("agent.event", threadId, { type: "message", message });
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
