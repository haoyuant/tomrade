import type {} from "cordis";
import type { z } from "zod";
import type { Author } from "@tomrade/domain";
import type { LlmService } from "@tomrade/llm";
import type { RunHandle, ToolDescriptor } from "@tomrade/tools";

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
  | { type: "text"; text: string; focus?: FocusRef[] }
  | { type: "trace"; tool: string; args: unknown; ok: boolean; summary: string; ms: number }
  | { type: "question"; id: string; text: string; options?: string[]; multiple?: boolean; freeText?: boolean }
  | { type: "card"; id: string; schema: string; title: string; data: unknown }
  | { type: "status"; text: string }
  | { type: "changes"; runId: string; count: number; items?: { key: string; label: string; op: "created" | "updated" | "deleted" }[] }
  | { type: "note"; text: string }
  | { type: "error"; text: string };

export interface ThreadMessage {
  id: string;
  threadId: string;
  seq: number;
  role: "user" | "agent" | "system";
  block: Block;
  runId: string | null;
  at: number;
}

export interface ThreadSummary {
  id: string;
  projectId: string;
  title: string;
  engine: string;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = "running" | "done" | "asked" | "cancelled" | "error";

export interface RunView {
  id: string;
  threadId: string;
  status: RunStatus;
  engine: string;
  stop: string | null;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  costUsd: number | null;
  changes: number;
  reverted: boolean;
  keptOnRevert: number;
  startedAt: number;
  endedAt: number | null;
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
  | { kind: "text"; text: string; focus?: FocusRef[] }
  | { kind: "answer"; questionId: string; value: string | string[] };

export interface PendingView {
  threadId: string;
  kind: "ask" | "workflow";
  workflow: string | null;
  question: { id: string; text: string; options?: string[]; multiple?: boolean; freeText?: boolean };
  accepts: "options" | "text";
}

/** Pushed to the renderer over the `agent.event` broadcast. `progress` is transient — never persisted. */
export type AgentEvent =
  | { type: "run"; run: RunView }
  | { type: "message"; message: ThreadMessage }
  | { type: "delta"; runId: string; text: string }
  | { type: "progress"; runId: string; activity?: string | null; usage?: { inputTokens: number; outputTokens: number } }
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

/** A methodology document: the `when` line lives in every prompt, the body loads on demand. */
export interface Playbook {
  id: string;
  title: string;
  when: string;
  tools: string[];
  body: string;
}

export interface PlaybookIndexEntry {
  id: string;
  title: string;
  when: string;
  tools: string[];
  /** The source that won for this id. */
  source: PlaybookSource;
  /** Sources that also carry this id and lost — non-empty means a conflict. */
  shadows: PlaybookSource[];
}

export interface TurnInput {
  threadId: string;
  projectId: string;
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
}

export interface TurnIO {
  /** Persist + broadcast one finished block. Text streams through delta() first. */
  emit(block: Block): void;
  delta(text: string): void;
  /** Live token totals for the working line; call whenever the count grows. */
  progress(usage: { inputTokens?: number; outputTokens?: number }): void;
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
}

export interface TurnResult {
  stop: "end" | "asked" | "budget" | "cancelled" | "error";
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number;
  error?: string;
  /** External session id to store on the thread for the next turn. */
  resume?: string;
}

/** Anything that can take one turn on a thread. The conductor seam. */
export interface Engine {
  id: string;
  title: string;
  author: Author;
  available(): Promise<{ ok: boolean; reason?: string }>;
  /** Engine settings, drawn by the settings UI from the schema. */
  options?: z.ZodType<unknown>;
  /** Quick-pick knobs the panel offers; each writes options[key]. Called per view, so lists can be live. */
  picks?(): EnginePick[];
  turn(input: TurnInput, io: TurnIO): Promise<TurnResult>;
}

/** One quick-pick knob: "model" and "effort" keys get localized group labels; other keys show `title`. */
export interface EnginePick {
  key: string;
  title: string;
  choices: { value: string; label?: string }[];
  /** Choices are suggestions only — settings may hold any string (e.g. a model id the CLI knows). */
  freeText?: boolean;
}

export interface EngineView {
  id: string;
  title: string;
  ok: boolean;
  reason?: string;
  picks?: EnginePick[];
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
}

/** What a suspending tool call returns; engines end their turn when they see one. */
export interface Suspended {
  __suspended: true;
  question: { id: string; text: string; options?: string[] };
  note: string;
}

export const isSuspended = (value: unknown): value is Suspended =>
  typeof value === "object" && value !== null && (value as { __suspended?: unknown }).__suspended === true;

export interface AgentPolicy {
  id: string;
  /** Runs on tools/pre-execute for calls that belong to an agent run. Throw to refuse; the message reaches the model. */
  before(call: { name: string; args: unknown; by: Author; projectId?: string; run: RunHandle }, next: () => Promise<unknown>): Promise<unknown>;
}
