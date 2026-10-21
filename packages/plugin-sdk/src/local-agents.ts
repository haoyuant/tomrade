import type { z } from "zod";

type Maybe<T> = T | Promise<T>;

/** SDK 0.2.17. How much an agent may do without asking, as Tomrade settles it for one turn. */
export type LocalAgentPolicy = "full-access" | "ask" | "read-only";

/** SDK 0.2.17. What a "not ready" means: what the person has to do about it. */
export type LocalAgentNeed = "install" | "repair" | "sign-in" | "model" | "service";

/** SDK 0.2.17. The permission modes Tomrade knows, for `acp.permissionModes`. */
export const PERMISSION_CHOICES = {
  "full-access": { value: "full-access", label: "Full access" },
  ask: { value: "ask", label: "Ask permissions" },
  "read-only": { value: "read-only", label: "Read only" },
  local: { value: "local", label: "Local rules" }
} as const;

/** SDK 0.2.17. Thrown from `lend.ask` when the CLI said, in its own words, that it is not signed in. */
export class NotSignedIn extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSignedIn";
  }
}

export interface LocalAgentChoice {
  value: string;
  label?: string;
}

/** What the agent offered the last time a session opened, for the Model and Effort picks. Kept across restarts. */
export interface LocalAgentCatalog {
  models: LocalAgentChoice[];
  efforts: LocalAgentChoice[];
}

export interface LocalAgentPick {
  key: string;
  title: string;
  choices: LocalAgentChoice[];
  /** Choices are suggestions only: settings may hold any string. */
  freeText?: boolean;
}

/**
 * SDK 0.2.18. An installer script the app runs for the person: `script` (a
 * POSIX shell installer) as `curl -fsSL <url> | bash`, `powershell` as
 * `irm <url> | iex`. Plugin code names only the address.
 */
export type LocalAgentInstaller = { script: string } | { powershell: string };

/** How the agent is installed and signed in, for setup screens. */
export interface LocalAgentSetup {
  /** Install commands, the recommended one first; an installer script by its address (SDK 0.2.18). */
  install: (string | LocalAgentInstaller)[];
  signIn?: string;
  /** Signing in starts the agent itself, which then asks; otherwise the command signs in and returns. */
  signInRuns?: boolean;
  docs?: string;
  /** SDK 0.2.25. The agent's official download page, opened in the system browser beside these commands, for those without the tools they need: one that offers the CLI. */
  download?: string;
  /** SDK 0.2.25. The agent's desktop app, when it has one: whether installing it puts the CLI where Tomrade finds it. Setup screens say so either way. */
  desktop?: { title: string; shipsCli: boolean };
  suggested?: boolean;
}

/** The machine a CLI is looked for on, for `cli.bundled`. */
export interface LocalCliHost {
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
  /** Where Windows' installed-apps list says apps whose display name matches were installed; none elsewhere. */
  installs(displayName: RegExp): Promise<string[]>;
}

/** A copy of the CLI inside a desktop app. */
export interface BundledCli {
  file: string;
  /** The app's binary that runs `file` as Node; absent when `file` is the app's own launcher, run as it is. */
  runtime?: string;
}

/** A desktop app of the same agent that lacks the CLI, named when the CLI is missing but the app is there. */
export interface LocalAgentDesktopApp {
  title: string;
  /** macOS bundle names, looked for in /Applications and ~/Applications. */
  mac?: string[];
  /** Windows install folders, relative to %LOCALAPPDATA% or Program Files. */
  windows?: string[];
  paths?: string[];
}

export interface LocalCliRunOptions {
  cwd?: string;
  /** Laid over Tomrade's own environment; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  stdin?: string;
  signal?: AbortSignal;
  /** Stopped after this long, and answered with `error.killed`. */
  timeoutMs?: number;
}

export interface LocalCliResult {
  code: number | null;
  stdout: string;
  /** Its last few thousand characters. */
  stderr: string;
  /** Set when there was no exit to report: it did not start, or it was stopped. */
  error?: { message: string; killed?: boolean; code?: string | number | null };
}

/**
 * SDK 0.2.17. The agent's CLI as Tomrade found it — the path the person chose
 * in Settings, else PATH, a login shell's PATH, npm's prefix, WSL or a bundled
 * app — started the way Tomrade starts its own agents (no console window, its
 * process tree stopped on Windows).
 */
export interface LocalCli {
  readonly name: string;
  /** Runs it to its end: all of stdout, the tail of stderr. */
  run(args: string[], opts?: LocalCliRunOptions): Promise<LocalCliResult>;
  /** Runs it with stdout read as JSON lines, each line that parses handed to `onLine`. */
  jsonl(args: string[], opts: LocalCliRunOptions & { onLine(line: Record<string, unknown>): void }): Promise<{ code: number | null; stderr: string }>;
}

/** Tomrade's MCP server, for the agent's own configuration; null while it is not running. */
export interface LocalAgentMcp {
  url: string | null;
  /** Where the agent's hooks post its session's events. */
  eventUrl: string | null;
}

export interface LocalAgentIo<O> {
  cli: LocalCli;
  mcp: LocalAgentMcp;
  /** The person's settings for this agent (`engines.<id>`), read through `options`. */
  options: O;
}

/** How a connection to Tomrade looks from the agent's side, as the Assistant settings show it. */
export interface McpLinkState {
  /** `stale`: a `tomrade` server is configured, but at another address. */
  state: "connected" | "missing" | "stale" | "unavailable";
  url: string | null;
  configuredUrl: string | null;
  file: string | null;
  /** Commands that do the same by hand. */
  manual: { connect: string; disconnect: string };
  error?: string;
}

/**
 * The agent's own user-level connection to Tomrade, so sessions a person
 * starts reach it too: managed by the plugin, or by the agent's own
 * `mcp add` / `mcp remove`, which Tomrade runs.
 */
export type LocalAgentMcpLink<O> =
  | {
      status(io: LocalAgentIo<O>): Maybe<McpLinkState>;
      connect(io: LocalAgentIo<O>): Maybe<McpLinkState>;
      disconnect(io: LocalAgentIo<O>): Maybe<McpLinkState>;
    }
  | {
      cli: {
        /** Where the agent keeps it. */
        file(): string;
        /** The address its `tomrade` entry names; null when there is none; throws when the file cannot be read. */
        configuredUrl(): string | null;
        add(url: string): string[];
        remove(): string[];
      };
    };

/** One worker call: the instructions and the conversation as text. */
export interface LentRequest {
  system: string;
  transcript: string;
}

export interface LentAnswer {
  text: string;
  /** All of the input, what the cache read included. */
  inputTokens: number;
  cacheReadTokens?: number;
  outputTokens: number;
}

export interface LocalAgentOptions {
  command?: string;
  model?: string;
  effort?: string;
}

/** How Tomrade talks to an agent that speaks the Agent Client Protocol on stdio. */
export interface LocalAgentAcp<O> {
  permissionModes: { default: string; choices: { value: string; label: string }[] };
  /** What starts its ACP server on stdio — for a turn, and for the short session that reads its model list. */
  args(options: O): string[];
  env?(options: O): Record<string, string>;
  /** The agent's own session mode for a policy; Tomrade answers whatever it still asks. */
  mode?(policy: LocalAgentPolicy): string | undefined;
  /** "always": it registers HTTP MCP servers without advertising that it can. */
  httpMcp?: "advertised" | "always";
  /** How a stored session reopens; "never": a cold turn opens a new session with the conversation recapped. */
  reopen?: "resume" | "load" | "never";
  /** A tool call's own name, for an agent whose updates carry none but put it in the call's id. */
  callName?(toolCallId: string): string | undefined;
  /** Where tokens are reported: the prompt's answer for the turn, a running session total, or per request in a usage update. */
  usage?: "turn" | "session" | ((update: Record<string, any>) => { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null);
  /** The prompt's `inputTokens` leaves out what `cachedReadTokens` and `cachedWriteTokens` count. */
  cacheApart?: boolean;
  /** How it takes a message sent while a turn runs: its own `session/steer` method, or a `/steer` prompt alongside. */
  steer?: "method" | "slash";
  /** Effort levels to offer before a session has advertised its own. */
  efforts?: string[];
  /** The agent's own words for a turn it ended on "refusal". */
  failure?(response: Record<string, any>): string | undefined;
  /**
   * Its CLI can also be handed a ticket in a terminal. SDK 0.2.23: `{ via: "link" }` says it reaches Tomrade
   * there only through its user-level connection (`mcpLink`); absent `via` is `"session"`.
   */
  terminal?: boolean | { via?: "session" | "link" };
  /** @deprecated since SDK 0.2.23: `terminal: { via: "link" }`. Still read, for plugins built before it. */
  terminalViaLink?: boolean;
}

/**
 * SDK 0.2.17. A coding agent installed on this machine, run by Tomrade: over
 * ACP inside the app when `acp` is given, else only in a terminal the person
 * sees (handed the ticket, heard over MCP). Settings live under `engines.<id>`.
 */
export interface LocalAgentSpec<O extends LocalAgentOptions = LocalAgentOptions> {
  /** The engine's id, carrying the namespace. */
  id: string;
  title: string;
  cli: {
    name: string;
    /** Copies inside desktop apps, tried after PATH. */
    bundled?(host: LocalCliHost): Maybe<BundledCli[]>;
    desktopApp?: LocalAgentDesktopApp;
  };
  /** The English tail of "not found — …"; `{install}` stands for the first of `setup.install` (SDK 0.2.18). */
  install: string;
  setup?: LocalAgentSetup;
  /** The agent's settings (`engines.<id>`), drawn by the settings UI; an ACP agent needs one with `command`. */
  options?: z.ZodType<O>;
  /** What gets a signed-out agent going, said after its own error. */
  signIn?: string;
  /** A run that tells whether the agent can work yet; it may also fill in the catalog's models. */
  probe?: { args: string[]; says(output: string, catalog: LocalAgentCatalog): boolean | null; reason: string; need?: LocalAgentNeed };
  /** Whether it is signed in, read without running it; null: no clear answer, taken as yes. */
  signedIn?: { ask(): Maybe<boolean | null>; reason: string };
  /** The agent's own logs and setup facts, for the troubleshooter. */
  diagnostics?: { logs?(): string[]; facts?(catalog: LocalAgentCatalog): Record<string, string> };
  acp?: LocalAgentAcp<O>;
  /** A terminal-only agent's picks (an ACP agent's come from its sessions). */
  picks?: LocalAgentPick[];
  mcpLink?: LocalAgentMcpLink<O>;
  /** Its sign-in lent to Tomrade's worker for one-shot calls, in Automatic order by `rank` (lowest first). */
  lend?: { rank?: number; ask(request: LentRequest, io: LocalAgentIo<O> & { signal?: AbortSignal }): Promise<LentAnswer> };
}
