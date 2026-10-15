import type {} from "cordis";
import type { z } from "zod";
import type { Author } from "@tomradex/domain";
import type { LlmService } from "@tomradex/llm";
import type { RunHandle, ToolDescriptor } from "@tomradex/tools";

/**
 * What the user was looking at when they sent a message. Kinds are open on
 * purpose — a plugin can put its own surface on screen (a future "doc").
 * Purely a hint for resolving "this/current"; tools still take explicit ids.
 */
export interface FocusRef {
  kind: string;
  id: string;
  /** Human-readable key where the entity has one (items do, boards don't). */
  key?: string;
  title: string;
}

/** Everything the panel knows how to draw. Engines emit these; the UI has no engine-specific code. */
export type Block =
  | { type: "text"; text: string; focus?: FocusRef[]; attachments?: import("./media.js").MediaRef[]; /** Sent into a running turn; the id the panel gave it. */ steerId?: string }
  | { type: "media"; media: import("./media.js").MediaRef; caption?: string }
  | { type: "trace"; tool: string; args: unknown; ok: boolean; summary: string; ms: number;
      commandResult?: { status: "success" | "no-match" | "condition-false" | "failed" | "declined" | "timed-out" | "interrupted"; exitCode: number | null; output: string } }
  | { type: "question"; id: string; text: string; options?: string[]; multiple?: boolean; freeText?: boolean }
  | { type: "card"; id: string; schema: string; title: string; data: unknown }
  | { type: "status"; text: string }
  | { type: "changes"; runId: string; count: number; items?: { key: string; label: string; op: "created" | "updated" | "deleted" }[] }
  | { type: "note"; text: string }
  /** One stretch of failed model requests, stored once it ends: recovered, or the run gave up. */
  | { type: "retry"; attempts: number; max?: number; reason: string; ms: number; recovered: boolean }
  /** `details`: what the engine knew beyond the one line, folded under it so it can be read and copied. */
  | { type: "error"; text: string; details?: string };

export interface ThreadMessage {
  id: string;
  threadId: string;
  seq: number;
  role: "user" | "agent" | "system";
  block: Block;
  runId: string | null;
  at: number;
}

/**
 * Who owns a thread. `doctor`: a troubleshooting conversation, listed in the
 * panel beside the assistant's. `probe`: a one-turn test the troubleshooter
 * runs on an engine and deletes, never listed.
 */
export type ThreadSurface = "assistant" | "code" | "doctor" | "probe";

/** The threads the assistant panel lists. */
export const PANEL_SURFACES: ThreadSurface[] = ["assistant", "doctor"];

/** A `checklist` card: what was looked at, each row's state as it goes. */
export interface ChecklistCard {
  rows: { id: string; title: string; state: "pending" | "running" | "ok" | "warn" | "fail" | "skip"; line?: string }[];
}

/**
 * What a person can do about a finding, drawn as a button. The backend words
 * the label; the panel knows the verbs, so no plugin ships UI code for them.
 */
export type CardAction =
  /** Runs the engine's declared install or sign-in command in a terminal. */
  | { kind: "install" | "sign-in"; engineId: string; label: string }
  /** Opens settings: the engine's own row, or model settings without one. */
  | { kind: "settings"; engineId?: string; label: string }
  /** Moves that thread to another ready agent and sends its last message again. */
  | { kind: "retry-with"; threadId: string; exclude?: string; label: string }
  /** Says this in the card's own thread. */
  | { kind: "say"; text: string; label: string }
  /** Opens the report about this thread, to read and send to Tomrade's developer. */
  | { kind: "report"; label: string }
  /** Lets one of these agents look into it; `note` says what it will read and where that goes. */
  | { kind: "investigate"; engineIds: string[]; note: string; label: string };

/** A `finding` card: one thing found, how sure, and what to do about it. */
export interface FindingCard {
  tone: "ok" | "warn" | "fail";
  headline: string;
  body?: string;
  confidence?: "high" | "medium" | "low";
  actions: CardAction[];
}

export interface ThreadSummary {
  execution?: GeneralExecution | null;
  /** In a listing for the panel: a run of it is going right now. */
  running?: boolean;
  /** In a listing for the panel: it stopped on a usage limit that lifts then. */
  parkedUntil?: number | null;
  id: string;
  projectId: string;
  /** The workstream the thread stands on, and so the repository it runs in; null for a thread about the whole project. */
  boardId: string | null;
  /** The ticket the thread implements, when it was started from one. Such a thread runs a code engine in its own branch. */
  itemId: string | null;
  /** The branch the thread's worktree is on; null for a free-form thread, which sits detached at the default branch. */
  branch: string | null;
  title: string;
  engine: string;
  /** Which product surface owns the thread. Code sessions use Agent's worktree machinery without becoming Assistant conversations. */
  surface: ThreadSurface;
  permissionMode?: string | null;
  /** Engine option overrides chosen for this thread (model, effort…); merged over the engine's settings. */
  options?: Record<string, unknown> | null;
  archived: boolean;
  /** A person brought it back from the archive: it stays open until they put it away again. */
  restored?: boolean;
  /** What opened it, in the person's words — each named by the plugin that did; chips beside the title. */
  origins?: string[];
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = "running" | "done" | "asked" | "cancelled" | "error";

export interface RunView {
  playbooks?: GeneralExecution["playbook"][];
  execution?: GeneralExecution | null;
  id: string;
  threadId: string;
  status: RunStatus;
  engine: string;
  stop: string | null;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** `usage` split into new input, cache read, cache write and output — what every surface shows. */
  tokens?: import("./tokens.js").TokenBreakdown | null;
  costUsd: number | null;
  changes: number;
  reverted: boolean;
  keptOnRevert: number;
  startedAt: number;
  endedAt: number | null;
  metrics?: import("./evaluation.js").TurnMetrics | null;
}

export interface CardView {
  threadId: string;
  id: string;
  schema: string;
  title: string;
  data: unknown;
  version: number;
  updatedBy: Author | "human";
  updatedAt: number;
}

export type UserInput =
  | { kind: "text"; text: string; focus?: FocusRef[]; attachments?: import("./media.js").MediaRef[] }
  | { kind: "answer"; questionId: string; value: string | string[] };

export interface PendingView {
  threadId: string;
  kind: "ask" | "workflow" | "permission";
  workflow: string | null;
  question: { id: string; text: string; options?: string[]; multiple?: boolean; freeText?: boolean };
  accepts: "options" | "text";
}

/** Pushed to the renderer over the `agent.event` broadcast. `progress` is transient — never persisted. */
export type AgentEvent =
  | { type: "permission-mode"; mode: string }
  | { type: "run"; run: RunView }
  | { type: "message"; message: ThreadMessage }
  | { type: "delta"; runId: string; text: string }
  | { type: "progress"; runId: string; activity?: string | null; retry?: (RetryState & { since: number }) | null; usage?: { inputTokens: number; outputTokens: number }; elapsedMs?: number; metrics?: RunView["metrics"] }
  | { type: "card"; card: CardView }
  | { type: "pending"; pending: PendingView | null }
  | { type: "done"; run: RunView };

export interface WorkflowInfo {
  id: string;
  title: string;
  description: string;
  /** Whether the workflow can start with no arguments — what a menu can offer directly. */
  canStartEmpty: boolean;
}

/** Where a playbook came from. Same id from several sources is a conflict the user can settle in settings. */
export type PlaybookSource = "plugin" | "user" | "project";

/** Recommendations and prerequisites, never permission grants. */
export interface PlaybookRequirements {
  workTypes?: ("coding" | "general")[];
  requires?: string[];
  optionalCapabilities?: string[];
  outputs?: string[];
}

export interface GeneralExecution {
  deliveryId: string;
  playbook: { id: string; source: PlaybookSource; digest: string; body: string; requires: string[] };
}

/** A methodology document: the `when` line lives in every prompt, the body loads on demand. */
export interface Playbook extends PlaybookRequirements {
  id: string;
  title: string;
  when: string;
  tools: string[];
  body: string;
}

export interface PlaybookIndexEntry extends PlaybookRequirements {
  id: string;
  title: string;
  when: string;
  tools: string[];
  /** The source that won for this id. */
  source: PlaybookSource;
  /** Sources that also carry this id and lost — non-empty means a conflict. */
  shadows: PlaybookSource[];
}

/** What a turn is for. A `code` turn edits a repository and gets the engine's fuller powers; a `backlog` turn talks to the app through tools. */
export type TurnPurpose = "backlog" | "code" | "general";

/** A ticket the current one waits on that is neither done nor cancelled: context for the agent, never a lock on it. */
export interface OpenDependency {
  key: string;
  title: string;
  status: string;
}

export interface TurnInput {
  threadId: string;
  projectId: string;
  /** The project the conversation belongs to, named so the model knows where it is. */
  project?: { name: string; keyPrefix: string };
  purpose: TurnPurpose;
  permissionMode?: string;
  /** The ticket a code thread implements — the branch it must stay on, the key its commits must name. */
  ticket?: { id: string; key: string; title: string; branch: string | null; workType?: "coding" | "general"; body?: string | null; completionPolicy?: "merge" | "human"; waitsOn?: OpenDependency[] };
  execution?: GeneralExecution;
  input: UserInput;
  /** Full persisted history, the triggering user message included. */
  messages: ThreadMessage[];
  cards: CardView[];
  brief: string | null;
  /** A question still waiting that the platform did NOT route — off-script input lands here. */
  pending: PendingView | null;
  /** What was on the user's screen when they sent the triggering message; deixis resolves here. */
  focus?: FocusRef[];
  /** Parsed engine options from settings (validated against Engine.options). */
  options: unknown;
  /** Where a code-running engine works: a worktree of the workstream's repository. Absent for a thread without one. */
  cwd?: string;
  /**
   * What this project's Files hold, as the Files plugin renders it for an
   * agent. Discovery only: it tells the engine what is there to look up, and
   * says nothing about what may be read — every path reads either way.
   */
  filesIndex?: { markdown: string; digest: string };
  /** The project's rules, as the person wrote them: every engine follows them. */
  rules?: string;
  /** Ephemeral subprocess credentials supplied by plugins; never persist or include in prompts. */
  env?: Record<string, string>;
  workdir?: { remote: string; branch: string; worktree: string | null };
  /** The project's workstream repositories and where they are on this machine (null: no checkout here), for a main conversation to read. */
  repositories?: { workstream: string; name: string; path: string | null; defaultBranch: string }[];
}

/** A model request failed and the engine is trying again; `attempt` counts the retries so far. */
export interface RetryState {
  attempt: number;
  max?: number;
  reason: string;
  /** How long until the next try, when the engine says. */
  delayMs?: number;
}

export interface TurnIO {
  media?: {
    read(id: string): import("./media.js").MediaContent;
    path(id: string): string;
    publish(upload: import("./media.js").MediaUpload, caption?: string): import("./media.js").MediaRef;
  };
  permissionMode?(mode: string): void;
  /** Pause this live run for a human response. Null means cancelled, never approval. */
  requestPermission?(text: string, options: string[], signal?: AbortSignal): Promise<string | null>;
  /** Persist + broadcast one finished block. Text streams through delta() first. */
  emit(block: Block): void;
  delta(text: string): void;
  /** Live token totals for the working line; call whenever the count grows. */
  progress(usage: { inputTokens?: number; outputTokens?: number }): void;
  /** A tool the engine runs itself is under way (Tomrade's own tools report through `tools`); null when it ends. */
  activity?(label: string | null): void;
  /** A model request failed and will be tried again; null once one goes through. */
  retry?(state: RetryState | null): void;
  tools: {
    describe(): ToolDescriptor[];
    /** Run-bound and ledgered; throws on refusal or failure so the engine can feed the error back. */
    execute(name: string, args: unknown): Promise<unknown>;
  };
  playbooks: { index(): PlaybookIndexEntry[]; open(id: string): string | null };
  workflows: { list(): WorkflowInfo[] };
  llm: LlmService | null;
  run: RunHandle;
  signal: AbortSignal;
  /** This engine's external session id from the previous turn, if it stored one. */
  resume?: string;
  /**
   * Messages the person sent into this running turn, for an engine that `steers`. Call it where
   * the model reads next (between tool calls); what it returns enters the transcript there.
   */
  takeSteers?(): string[];
  /**
   * For an engine whose agent keeps its own steering queue (pi, Codex, Claude Code): `forward`
   * gets each message sent into this turn and resolves whether the agent took it. Call
   * `steered(id)` when the agent reads it; that is where it enters the transcript.
   */
  steerTo?(forward: (steer: { id: string; text: string }) => Promise<boolean>): void;
  steered?(id: string): void;
  /**
   * For an engine that keeps its own session: the conversation so far, to lead the first prompt of a
   * session it starts without `resume` (empty when there is nothing before this message).
   */
  recap?(): string;
}

export interface TurnResult {
  stop: "end" | "asked" | "budget" | "cancelled" | "error";
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number;
  error?: string;
  /** Everything else known about the failure (see describeFailure); shown folded under `error`. */
  details?: string;
  /** External session id to store on the thread for the next turn. */
  resume?: string;
  /** The session in `resume` no longer exists and nothing ran: Tomrade forgets it and runs the turn again in a new one. */
  lostSession?: boolean;
  metrics?: import("./evaluation.js").TurnMetrics;
  /** The engine stopped on a usage or rate limit; `until` is when it lifts, when the engine said. */
  limit?: { until: number | null };
}

/** A thread that stopped on a usage limit, waiting for it to lift. Kept on this machine only: it is this machine's clock that continues it. */
export interface ParkView {
  threadId: string;
  /** The run that hit the limit; null when a terminal session reported it. */
  runId: string | null;
  until: number;
  /** Whether `until` came from the engine's own words, not a guess. */
  known: boolean;
  /** Tomrade continues the thread itself at `until`; otherwise the person is told it can go on. */
  resume: boolean;
  /** How many limited runs in a row this thread has had. */
  attempt: number;
}

/**
 * What an engine can be trusted with. `backlog` talks to the app through its
 * tools; `code` also edits files and runs commands in a repository — only a
 * local coding agent (Claude Code, Codex…) declares it, and only such an engine
 * is offered when a ticket is started.
 */
export type EngineCapability = "backlog" | "code" | "general";

/**
 * What stands between an engine and its first turn, so the app can say how to fix it in the person's language.
 * `repair`: the CLI is there but does not run.
 */
export type EngineNeed = "install" | "repair" | "sign-in" | "model" | "service";

/** Where a local CLI candidate came from, in the order they are tried. */
export type CliSource = "manual" | "path" | "login-path" | "known";

export interface CliAttempt {
  path: string;
  source: CliSource;
  ok: boolean;
  /** The version it printed, or why it did not run. */
  detail: string;
}

/** How a local agent's CLI was looked for and what was found — enough to show its state and to report it. */
export interface LocalCliStatus {
  name: string;
  state: "ready" | "missing" | "broken";
  path?: string;
  source?: CliSource;
  version?: string;
  /** Why the best candidate did not run, when none did. */
  error?: string;
  /** A path the person chose that no longer runs; detection carried on without it. */
  manual?: { path: string; error: string };
  /** Found only inside WSL, where a Windows app cannot run it. */
  wsl?: string;
  attempts: CliAttempt[];
  /** Directories searched, in order. */
  searched: string[];
  platform: string;
  arch: string;
  /** The PATH the app itself runs with. */
  pathEnv: string;
}

export interface EngineAvailability {
  ok: boolean;
  reason?: string;
  need?: EngineNeed;
  /** Present for engines that drive a CLI installed on this machine. */
  cli?: LocalCliStatus;
  /** What it can take on right now, when only part of it is ready; absent means all its capabilities. */
  capabilities?: EngineCapability[];
  /** The folder a local CLI reads its sign-in from, when it is not signed in (CODEX_HOME, CLAUDE_CONFIG_DIR). */
  configDir?: string;
}

/**
 * How a person makes a local agent ready on this machine, as commands: what
 * setup screens show, copy and run in a terminal. Only what an engine declares
 * here can be started in a terminal from the app.
 */
export interface EngineSetup {
  /** Install commands, the recommended one first. */
  install: string[];
  signIn?: string;
  /** Signing in starts the agent itself, which then asks (`/login`); otherwise the command signs in and returns. */
  signInRuns?: boolean;
  docs?: string;
  /** Offered on setup screens before it is installed. */
  suggested?: boolean;
}

/**
 * Tomrade's MCP server in the agent's own user-level configuration, so a
 * session the person opens anywhere outside Tomrade can reach it. Written only
 * when the person asks.
 */
export interface EngineMcpLink {
  status(): Promise<McpLinkView>;
  connect(): Promise<McpLinkView>;
  disconnect(): Promise<McpLinkView>;
  /** Whether the agent will load a `tomrade` server a repository's own config declares; some ask once per folder first. */
  projectApproval?(dir: string): "approved" | "rejected" | "pending";
}

export interface McpLinkView {
  /** `stale`: a `tomrade` server is configured but at another address (an old port, the other Tomrade). */
  state: "connected" | "missing" | "stale" | "unavailable";
  /** The address this Tomrade serves; null while its MCP server is not running. */
  url: string | null;
  /** The address the agent's configuration names, when it names one. */
  configuredUrl: string | null;
  /** Where the agent keeps it, for the person to look at. */
  file: string | null;
  /** Commands that do the same by hand, for when the CLI cannot be run from here. */
  manual: { connect: string; disconnect: string };
  /** Why the last step could not be done or the state could not be read. */
  error?: string;
}

/** A path the person typed or picked, run once to see whether it is the CLI. */
export interface CliCheck {
  ok: boolean;
  path: string;
  version?: string;
  error?: string;
}

/** Anything that can take one turn on a thread. The conductor seam. */
export interface Engine {
  /** Actual formats supported by the selected transport/model; absent means text only. */
  media?(options: unknown): { input: string[]; output: string[] };
  id: string;
  title: string;
  author: Author;
  /** Absent means `["backlog"]`. */
  capabilities?: EngineCapability[];
  /**
   * Engines this one runs in their place: pickers list it alone, and a thread
   * or setting naming one of them is answered by this engine.
   */
  includes?: string[];
  /**
   * No model judges what the user types: free text while a workflow waits is
   * taken as that workflow's answer. A model engine instead reads the reply with
   * the waiting question in its prompt and resumes or cancels the workflow itself.
   */
  literal?: boolean;
  /** `fresh` looks again instead of answering from a recent probe — after the person installs or points at a CLI. */
  available(opts?: { fresh?: boolean }): Promise<EngineAvailability>;
  /** For an engine that runs a local CLI: whether this file is one it can use. */
  checkCli?(file: string): Promise<CliCheck>;
  setup?: EngineSetup;
  /** Engine settings, drawn by the settings UI from the schema. */
  options?: z.ZodType<unknown>;
  /** Quick-pick knobs the panel offers; each writes options[key]. Called per view, so lists can be live. */
  picks?(): EnginePick[];
  /**
   * `default` is what a ticket's session starts in; `mainDefault` what the project's main conversation starts in
   * (it is not a ticket's worktree, so an engine may ask there before changing anything). Absent, both use `default`.
   */
  permissionModes?: { default: string; mainDefault?: string; choices: { value: string; label: string }[] };
  /** False: it runs only inside Tomrade, with no CLI session a person can be handed in a terminal. */
  terminal?: boolean;
  /** True: a CLI Tomrade starts only in a terminal the person sees — handed the ticket, heard over MCP, never driven turn by turn. */
  terminalOnly?: boolean;
  /** True: it runs on the model profiles set up in Tomrade, so a key or model error is fixed there — not in its own sign-in. */
  usesModels?: boolean;
  /** True: it takes messages sent while a turn runs (io.takeSteers); otherwise the panel queues them. */
  steers?: boolean;
  /** What the troubleshooter may read about this engine beyond `available()`. */
  diagnostics?: EngineDiagnostics;
  /** What the engine's own configuration lets its agent run; absent when Tomrade cannot read it. */
  commands?: EngineCommands;
  mcpLink?: EngineMcpLink;
  turn(input: TurnInput, io: TurnIO): Promise<TurnResult>;
}

/**
 * An engine's own evidence, for the troubleshooter and a report. Only what is
 * named here is read: an agent investigating a failure gets no other files.
 */
export interface EngineDiagnostics {
  /** The agent's own log files, newest first; their tails go into a report. */
  logs?(): string[] | Promise<string[]>;
  /** Short facts that tell one setup from another — edition, endpoint, models offered. */
  facts?(): Record<string, string> | Promise<Record<string, string>>;
}

/**
 * Whether the engine's own permission settings let one shell command through,
 * read from its config files — not a promise: a safety check or the remote can
 * still refuse it at run time.
 */
export interface EngineCommands {
  check(command: string, opts: CommandCheckOptions): Promise<CommandCheck>;
  /** Adds `check(...).fix.rule` to `fix.file`, then checks again. */
  allow?(command: string, opts: CommandCheckOptions): Promise<CommandCheck>;
}

export interface CommandCheckOptions {
  /** Where the agent will run, for project-level settings; null reads only the user's. */
  cwd: string | null;
  /** The run gets a fresh worktree of `cwd`: only checked-in project files reach it, not untracked local ones. */
  worktree?: boolean;
  /** The permission mode it will run under; absent, the one its settings default to. */
  permissionMode?: string;
}

export interface CommandCheck {
  /** `asks`: the person approves it when it comes up; `blocked`: refused, or likely to be, without a change. */
  state: "allowed" | "asks" | "blocked";
  /** Why, in a word a screen can name in its own language. */
  why: "bypass" | "allow-rule" | "ask-rule" | "deny-rule" | "prompts" | "auto-mode" | "plan" | "dont-ask";
  mode: string;
  /** The rule that decided it, and the file it is in. */
  rule?: { rule: string; file: string };
  /** The one rule `allow` writes; absent when no added rule would help (a deny rule wins over it). */
  fix?: { rule: string; file: string };
}

/** One quick-pick knob: "model" and "effort" keys get localized group labels; other keys show `title`. */
export interface EnginePick {
  key: string;
  title: string;
  choices: { value: string; label?: string }[];
  /** Choices are suggestions only — settings may hold any string (e.g. a model id the CLI knows). */
  freeText?: boolean;
}

/** One real turn on an engine, asked for by the person: does it answer? */
export interface EngineTry {
  ok: boolean;
  ms: number;
  at: number;
  /** What it said, cut short. */
  reply?: string;
  error?: string;
  details?: string;
}

export interface EngineView {
  id: string;
  title: string;
  capabilities: EngineCapability[];
  ok: boolean;
  reason?: string;
  need?: EngineNeed;
  cli?: LocalCliStatus;
  configDir?: string;
  /** The last try with the settings it has now; a change to its settings clears it. */
  tried?: EngineTry;
  picks?: EnginePick[];
  permissionModes?: Engine["permissionModes"];
  terminal?: boolean;
  terminalOnly?: boolean;
  usesModels?: boolean;
  steers?: boolean;
  setup?: EngineSetup;
  /** Engines it answers for: a thread, run or setting may still name one of them. */
  includes?: string[];
  /** It can put Tomrade's MCP server in its own user-level configuration (`agent.mcpLink`). */
  mcpLink?: boolean;
}

export interface WorkflowQuestion {
  text: string;
  options?: string[];
  multiple?: boolean;
  freeText?: boolean;
}

export type WorkflowTransition<S> =
  | { next: string; state: S }
  | { ask: WorkflowQuestion; state: S }
  | { done: unknown };

export interface WorkflowIO {
  emit(block: Block): void;
  tools: TurnIO["tools"];
  llm: LlmService | null;
  run: RunHandle;
}

/**
 * A resumable, typed step machine, exposed to every engine as a tool. Control
 * flow is code; steps may still call the worker model for content. A step that
 * returns `ask` suspends the workflow — the platform persists the state and
 * routes the user's next on-script input straight back into the same step.
 */
export interface WorkflowSpec<I = unknown, S = unknown> {
  /** Also the tool name — snake_case, globally unique. */
  id: string;
  title: string;
  description: string;
  input: z.ZodType<I>;
  state: z.ZodType<S>;
  entry: string;
  start(input: I, io: WorkflowIO): S | Promise<S>;
  steps: Record<string, (state: S, io: WorkflowIO, answer?: string | string[]) => WorkflowTransition<S> | Promise<WorkflowTransition<S>>>;
  /** What counts as on-script input while suspended: one of the offered options, or any text. */
  accepts?: "options" | "text";
  /** Offered only to engines without a model (Engine.literal); a model holds this conversation itself, in the user's language. */
  literal?: boolean;
}

/**
 * Consulted when a turn ends, while its run is still open, so whatever it starts
 * writes into the same run and asks like any other workflow. `canAsk` is false
 * when the run already ends on a question, failed or was cancelled; a follow-up
 * then only notes what it still owes the thread.
 */
export interface TurnFollowUp {
  id: string;
  after(turn: { projectId: string; threadId: string; runId: string; canAsk: boolean }): FollowUpStart | null | Promise<FollowUpStart | null>;
}

export interface FollowUpStart {
  workflow: string;
  args?: unknown;
}

/** What a suspending tool call returns; engines end their turn when they see one. */
export interface Suspended {
  __suspended: true;
  question: { id: string; text: string; options?: string[] };
  note: string;
}

export const isSuspended = (value: unknown): value is Suspended =>
  typeof value === "object" && value !== null && (value as { __suspended?: unknown }).__suspended === true;

declare module "cordis" {
  interface Events {
    "agent/prepare-turn"(input: TurnInput): Promise<void> | void;
    /** The brief a CLI agent starts a delivery from, before it is handed over. A plugin may add context an in-app turn would get from `agent/prepare-turn`. */
    "agent/prepare-brief"(brief: { projectId: string; itemId: string; filesIndex?: string }): Promise<void> | void;
    /** A run began driving a thread. */
    "agent/run-started"(run: RunView, thread: ThreadSummary): void;
    /** A run settled, however it stopped; `run.stop` says how. */
    "agent/run-ended"(run: RunView, thread: ThreadSummary): void;
    /** A thread stopped on a usage limit and waits for it to lift. */
    "agent/parked"(park: ParkView, thread: ThreadSummary): void;
    /** A parked thread's limit lifted and nobody continues it on its own: the person may. */
    "agent/limit-lifted"(park: ParkView, thread: ThreadSummary): void;
    /** A project's rules file was written through Tomrade. */
    "agent/rules-changed"(projectId: string): void;
  }
}

export interface AgentPolicy {
  id: string;
  /** Runs on tools/pre-execute for calls that belong to an agent run. Throw to refuse; the message reaches the model. */
  before(call: { name: string; args: unknown; by: Author; projectId?: string; run: RunHandle }, next: () => Promise<unknown>): Promise<unknown>;
}
