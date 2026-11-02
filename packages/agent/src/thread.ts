import type { Author } from "@tomradex/domain";
import type { RetryState } from "./turn.js";
import type { GeneralExecution } from "./workflow.js";

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
  /** `tail`: the end of a text result too long for the summary, where a command says how it went (a test run's counts). */
  | { type: "trace"; tool: string; args: unknown; ok: boolean; summary: string; ms: number; tail?: string;
      commandResult?: { status: "success" | "no-match" | "condition-false" | "failed" | "declined" | "timed-out" | "interrupted"; exitCode: number | null; output: string } }
  | { type: "question"; id: string; text: string; options?: string[]; multiple?: boolean; freeText?: boolean }
  | { type: "card"; id: string; schema: string; title: string; data: unknown }
  | { type: "status"; text: string }
  | { type: "changes"; runId: string; count: number; items?: { key: string; label: string; op: "created" | "updated" | "deleted" }[] }
  /** `settingsFor`: the engine whose settings change what the note is about; the panel links there. `threadFor`: another conversation the note is about (one this conversation's coding moved to); the panel links there too. `claimed`: the key of the ticket the conversation claimed here — its writing code for that ticket starts at this note. `interrupted`: the app closed while a run was going — this conversation's (or, with `threadFor`, that one's); the latest such note offers to continue. */
  | { type: "note"; text: string; settingsFor?: string; threadFor?: string; claimed?: string; interrupted?: boolean }
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
  /** Opens settings: the engine's own row, or model settings without one; `pane` opens that pane instead. */
  | { kind: "settings"; engineId?: string; pane?: string; label: string }
  /** Moves that thread to another ready agent and sends its last message again. */
  | { kind: "retry-with"; threadId: string; exclude?: string; label: string }
  /** Says this in the card's own thread. */
  | { kind: "say"; text: string; label: string }
  /** Installs one of Tomrade's own plugins from the official catalog; `done` is what the person is told once it is on. */
  | { kind: "install-plugin"; pluginId: string; done: string; label: string }
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
  /** In a listing for the panel: the app closed while its last run was going, and nobody has continued or waved it away since. */
  interrupted?: boolean;
  id: string;
  projectId: string;
  /** The workstream the thread stands on, and so the repository it runs in; null for a thread about the whole project. */
  boardId: string | null;
  /** The ticket the thread implements, when it was started from one. Such a thread runs a code engine in its own branch. */
  itemId: string | null;
  /** The branch the thread's worktree is on; null for a free-form thread, which sits detached at the default branch. */
  branch: string | null;
  /** The conversation this one was opened under, to write its code in the background: it sits under that one in every list, works in its checkout, and reports back into it. */
  parentId: string | null;
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
  /** What it said last: the first sentence of the agent's last text, written once a turn ends. */
  said?: string | null;
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
  /** A run the app's closing interrupted (`stop: "interrupted"`): when the person waved that away; null while it still waits on them. */
  dismissedAt?: number | null;
  /** Running on another machine, as its last sync said: this one shows it, never drives or settles it. */
  elsewhere?: boolean;
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
  /** `switch`: Tomrade asks whether another engine takes over from one stopped by a limit; no engine waits for the answer. */
  kind: "ask" | "workflow" | "permission" | "switch";
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
