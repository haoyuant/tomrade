import type { z } from "zod";
import type { LlmService } from "@tomradex/llm";
import type { RunHandle } from "@tomradex/tools";
import type { Block } from "./thread.js";
import type { TurnIO } from "./turn.js";

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
interface PlaybookRequirements {
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
  /** Aborts when the run is stopped or runs out of time; a step's model calls end with it. */
  signal: AbortSignal;
  /** What a step is doing while no tool runs, for the run's live line; null clears it. */
  activity(label: string | null): void;
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
