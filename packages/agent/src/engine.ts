import type { z } from "zod";
import type { Author } from "@tomradex/domain";
import type { TurnInput, TurnIO, TurnResult } from "./turn.js";

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

/** Where a local CLI candidate came from, in the order they are tried; `managed` is the copy Tomrade installed in its own folder. */
export type CliSource = "manual" | "path" | "login-path" | "known" | "managed";

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
  /** Not found, but this agent's desktop app is installed — which does not include the CLI. */
  desktopApp?: string;
  /** Found only as the copy inside this desktop app, which serves that app and cannot serve Tomrade on its own. */
  insideApp?: string;
  /** Not found, and this login shell did not answer in time: the folders its startup files add to PATH went unsearched. */
  shellTimedOut?: string;
  attempts: CliAttempt[];
  /** Directories searched, in order. */
  searched: string[];
  platform: string;
  arch: string;
  /** The PATH the app itself runs with. */
  pathEnv: string;
  /** Folders a new terminal has that the app's PATH lacks, put ahead of PATH for the CLI and what it starts. */
  pathDirs?: string[];
}

export interface EngineAvailability {
  ok: boolean;
  reason?: string;
  need?: EngineNeed;
  /** Present for engines that drive a CLI installed on this machine. */
  cli?: LocalCliStatus;
  /** What it can take on right now, when only part of it is ready; absent means all its capabilities. */
  capabilities?: EngineCapability[];
  /** How it installs on this machine, when that differs from the engine's declared setup — an installer that is not here is left out. */
  setup?: EngineSetup;
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
  /** The agent's official download page, opened in the system browser beside these commands, for those without the tools they need: one that offers the CLI. */
  download?: string;
  /** The agent's desktop app, when it has one: whether installing it puts the CLI where Tomrade finds it. */
  desktop?: { title: string; shipsCli: boolean };
  /** Offered on setup screens before it is installed. */
  suggested?: boolean;
  /** Installs Tomrade runs itself in the background, most reliable first; one that does not fit this machine is skipped. Absent, only the terminal commands remain. */
  installers?: EngineInstaller[];
  /** A sign-in command Tomrade runs and watches itself: it opens or prints a browser address and needs no typing. Without it, signing in happens in a terminal while Tomrade polls. */
  signInRun?: { args: string[] };
}

/**
 * One way Tomrade itself installs the CLI, no terminal and no admin rights.
 * `npm` runs through the system npm when it answers, else the app's borrowed
 * one; `script` is the agent's official installer for one platform family;
 * `brew` is tried only where Homebrew is already installed.
 */
export type EngineInstaller =
  | { kind: "npm"; package: string }
  | { kind: "script"; url: string; shell: "sh" | "powershell" }
  | { kind: "brew"; name: string; cask?: boolean };

export type EngineSetupStep = "install" | "sign-in";

/** Why a setup step failed, sorted into a kind a screen can word in the person's language. */
export interface EngineSetupFailure {
  /** `native-missing`: installed, but its bin is still the placeholder its postinstall should have replaced. */
  kind: "network" | "registry" | "permission" | "disk-full" | "unsupported" | "not-found" | "not-on-path" | "native-missing" | "timeout" | "exit" | "cancelled";
  /** The underlying words, English or the tool's own, for the details view. */
  message: string;
  /** The file found after an install that did not run; `message` is what running it said. */
  path?: string;
}

/** Where one engine's setup step stands; pushed as it moves. */
export interface EngineSetupProgress {
  engineId: string;
  step: EngineSetupStep;
  /** `waiting`: a sign-in that needs the person — in the browser, or in the terminal when `terminal` is set. */
  phase: "running" | "checking" | "waiting" | "done" | "failed";
  /** Which installer is being tried ("script", "npm", "brew"). */
  installer?: string;
  /** The last lines of output: the latest while an installer runs, its end on a failure. */
  output?: string;
  /** When the installer being tried started, for the screen to count the time. */
  startedAt?: number;
  /** The installer printed nothing new for a while: it may be stuck. */
  stalled?: boolean;
  /** A registry npm can be retried with (`--registry`), offered when the default one looks unreachable or slow. */
  mirror?: string;
  /** The folder npm is installing into instead of the system's global one, which it could not write: Tomrade's own (`--prefix`). */
  prefix?: string;
  failure?: EngineSetupFailure;
  /** The version detection reported once the step was done; absent when the step was already satisfied. */
  version?: string;
  /** The sign-in address caught from the agent's output, for the screen to open when the agent did not. */
  url?: string;
  /** Signing in needs the agent's own terminal session (`setup.signIn`); Tomrade keeps watching until it is signed in. */
  terminal?: boolean;
  /** The ways the agent itself offers to sign in (`local.signIn`), and the one this step runs. */
  methods?: EngineSignInMethod[];
  method?: string;
}

/** One way an agent offers to sign in, read from the agent itself. */
export interface EngineSignInMethod {
  id: string;
  name: string;
  description?: string;
  /** `agent`: Tomrade asks and the agent signs in itself (a browser); `terminal`: the person runs it in a terminal; `other`: what the description says, by hand. */
  kind: "agent" | "terminal" | "other";
}

/** Signing in through the agent's own protocol (ACP's `authMethods`), not a command of its CLI. */
export interface EngineSignIn {
  methods(signal: AbortSignal): Promise<EngineSignInMethod[]>;
  /**
   * An `agent` method runs until the agent says it is done, its output passed along; it throws with the
   * agent's words when it fails. A `terminal` one is only picked: it becomes `setup.signIn`, which the person runs.
   */
  start(methodId: string, opts: { signal: AbortSignal; onOutput(text: string): void }): Promise<void>;
}

/**
 * Tomrade's MCP server in the agent's own user-level configuration, so a
 * session the person opens anywhere outside Tomrade can reach it. Written only
 * when the person asks.
 */
export interface EngineMcpLink {
  status(): Promise<McpLinkView>;
  /** `profile` names one of `status().profiles`; without it, the agent's own (the first). Answers as `status()` does. */
  connect(profile?: string): Promise<McpLinkView>;
  disconnect(profile?: string): Promise<McpLinkView>;
  /** Whether the agent will load a `tomrade` server a repository's own config declares; some ask once per folder first. */
  projectApproval?(dir: string): "approved" | "rejected" | "pending";
  /** The same, for each of its profiles. */
  projectApprovals?(dir: string): McpProjectApproval[];
  /** A session of the agent started somewhere — its transcript names the profile it ran under. */
  sawTranscript?(file: string): void;
}

export interface McpProjectApproval {
  profile: string;
  state: "approved" | "rejected" | "pending";
  /** How to start the agent under that profile, for the person to run in the checkout. */
  command: string;
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
  /** The configuration folder this describes, for an agent that has several (CLAUDE_CONFIG_DIR per account). */
  profile?: string;
  /** Every profile, this one first, when there is more than one. */
  profiles?: McpLinkView[];
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
  /**
   * `fresh` looks again instead of answering from a recent probe — after the person installs or points at a CLI.
   * `options`: whether it can run a turn with these engine options, such as the model a thread picked.
   */
  available(opts?: { fresh?: boolean; options?: unknown }): Promise<EngineAvailability>;
  /** Engine settings, drawn by the settings UI from the schema. */
  options?: z.ZodType<unknown>;
  /** `default` is what a session starts in until the person picks another mode. */
  permissionModes?: { default: string; choices: { value: string; label: string }[] };
  /** Whether a ticket can be handed to its CLI in a terminal. Absent: `{ mode: "handoff" }`. */
  terminal?: EngineTerminal;
  /** True: it runs on the model profiles set up in Tomrade, so a key or model error is fixed there — not in its own sign-in. */
  usesModels?: boolean;
  /** How it takes messages sent while a turn runs; absent, the panel queues them until the turn ends. */
  steering?: EngineSteering;
  /** The agent's own setup on this machine: its CLI, install, connection, permissions and knobs. */
  local?: EngineLocal;
  turn(input: TurnInput, io: TurnIO): Promise<TurnResult>;
}

export interface EngineTerminal {
  /**
   * `none`: it runs only inside Tomrade, with no CLI session a person can be handed in a terminal.
   * `handoff`: a ticket can also be handed to its CLI in a terminal.
   * `only`: a CLI Tomrade starts only in a terminal the person sees — handed the ticket, heard over MCP, never driven turn by turn.
   */
  mode: "none" | "handoff" | "only";
  /** `link`: in a terminal it reaches Tomrade only through its own user-level connection (`local.mcpLink`), so that comes first. Absent: `session`. */
  via?: "session" | "link";
  /** That connection carries no session token, so the session's first act is claim_ticket, which joins it to the session Start made. */
  claims?: boolean;
  /**
   * The command that starts it in a terminal, when its CLI does not take
   * Claude Code's flags: the same `{bin}`, `{options}`, `{prompt}`, `{resume}`,
   * `{mcpConfig}`, `{mcpUrl}`, `{token}`, `{settings}`, `{piExtension}`,
   * `{dshPatch}` and `{dshReporter}` placeholders.
   */
  command?: string;
}

/**
 * `queue`: Tomrade holds them and the engine takes them where its model reads next (`io.takeSteers`).
 * `forward`: its agent keeps its own steering queue; each is handed over (`io.steerTo`) and placed when read (`io.steered`).
 */
export type EngineSteering = "queue" | "forward";

export interface EngineLocal {
  /** Whether this file is a CLI it can use. */
  checkCli?(file: string): Promise<CliCheck>;
  setup?: EngineSetup;
  /** Quick-pick knobs the panel offers; each writes options[key]. Called per view, so lists can be live. */
  picks?(): EnginePick[];
  /** What the troubleshooter may read about this engine beyond `available()`. */
  diagnostics?: EngineDiagnostics;
  /** What the engine's own configuration lets its agent run; absent when Tomrade cannot read it. */
  commands?: EngineCommands;
  mcpLink?: EngineMcpLink;
  /** It signs in through its own protocol; setup runs this in place of `setup.signInRun`. */
  signIn?: EngineSignIn;
  /** One answer from its agent outside a turn — how a try reaches an engine that runs only in a terminal. */
  ask?(prompt: string, signal?: AbortSignal): Promise<string>;
}

/** The flat members an engine had before they were grouped; `Agent.engine` still maps them once, at registration. */
export interface FlatEngineMembers {
  /** @deprecated `terminal: { mode: "none" }` for false. */
  terminal?: boolean;
  /** @deprecated `terminal: { mode: "only" }`. */
  terminalOnly?: boolean;
  /** @deprecated `terminal: { via: "link" }`. */
  terminalViaLink?: boolean;
  /** @deprecated `terminal: { claims: true }`. */
  terminalClaims?: boolean;
  /** @deprecated `steering`; read as `"queue"`, and a turn's `io` offers both protocols either way. */
  steers?: boolean;
  /** @deprecated `local.checkCli`. */
  checkCli?(file: string): Promise<CliCheck>;
  /** @deprecated `local.setup`. */
  setup?: EngineSetup;
  /** @deprecated `local.picks`. */
  picks?(): EnginePick[];
  /** @deprecated `local.diagnostics`. */
  diagnostics?: EngineDiagnostics;
  /** @deprecated `local.commands`. */
  commands?: EngineCommands;
  /** @deprecated `local.mcpLink`. */
  mcpLink?: EngineMcpLink;
}

/** What `Agent.engine` takes: an engine, or one still in the flat shape. */
export type EngineRegistration = Engine | (Omit<Engine, "terminal"> & FlatEngineMembers);

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
  /** `searchesWeb`: the model searches the web on its own, so needs no web search key. */
  choices: { value: string; label?: string; searchesWeb?: boolean }[];
  /** Choices are suggestions only — settings may hold any string (e.g. a model id the CLI knows). */
  freeText?: boolean;
  /** The engine is still asking its agent for the choices; ask again shortly. */
  pending?: boolean;
  /** The engine asked its agent for the choices and the agent could not answer: why. On the model pick, it cannot run a turn yet. */
  failed?: string;
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
  /** Runs only in a terminal, yet answers a try through its agent (`local.ask`). */
  asks?: boolean;
  usesModels?: boolean;
  steers?: boolean;
  setup?: EngineSetup;
  /** Engines it answers for: a thread, run or setting may still name one of them. */
  includes?: string[];
  /** It can put Tomrade's MCP server in its own user-level configuration (`agent.mcpLink`). */
  mcpLink?: boolean;
}
