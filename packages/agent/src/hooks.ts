import type {} from "cordis";
import type { Author } from "@tomradex/domain";
import type { Message, ToolSpec } from "@tomradex/llm";
import type { RunHandle } from "@tomradex/tools";
import type { ParkView, RunView, ThreadSummary } from "./thread.js";
import type { Engine, EngineTry } from "./engine.js";
import type { TurnInput, TurnPurpose } from "./turn.js";

declare module "cordis" {
  interface Events {
    "agent/prepare-turn"(input: TurnInput): Promise<void> | void;
    /** The brief a CLI agent starts a delivery from, before it is handed over. A plugin may add context an in-app turn would get from `agent/prepare-turn`. */
    "agent/prepare-brief"(brief: { projectId: string; itemId: string; filesIndex?: string }): Promise<void> | void;
    /** A message is about to start a run on the thread. The first listener to answer with a reason refuses it; the reason reaches the person. */
    "agent/before-send"(thread: ThreadSummary): string | void;
    /** A run began driving a thread. */
    "agent/run-started"(run: RunView, thread: ThreadSummary): void;
    /** A run settled, however it stopped; `run.stop` says how. */
    "agent/run-ended"(run: RunView, thread: ThreadSummary): void;
    /** Whether a thread is left interrupted changed: the app's closing cut its run short, or the person continued, waved it away, archived or restored it. */
    "agent/interrupted-changed"(projectId: string, threadId: string): void;
    /** A thread and its rows are gone. */
    "agent/thread-deleted"(projectId: string, threadId: string): void;
    /** A thread stopped on a usage limit and waits for it to lift. */
    "agent/parked"(park: ParkView, thread: ThreadSummary): void;
    /** A parked thread's limit lifted and nobody continues it on its own: the person may. */
    "agent/limit-lifted"(park: ParkView, thread: ThreadSummary): void;
    /** An engine was registered — a plugin's local agent, a CLI agent, the built-in loop. */
    "agent/engine-added"(engine: Engine): void;
    /** A test message on an engine (`tryEngine`) came back, answered or not. */
    "agent/engine-tried"(engineId: string, tried: EngineTry): void;
    /** A project's rules file was written through Tomrade. */
    "agent/rules-changed"(projectId: string): void;
    /**
     * Each model request an in-app engine (`engine-loop`) is about to send: a listener may change its
     * system prompt, tools and messages, before or after `next()`; what comes back is sent. CLI agents
     * run their own loop and send nothing through here.
     */
    "agent/request"(request: AgentRequest, next: () => Promise<AgentRequest>): Promise<AgentRequest>;
    /** A model request an in-app engine sent failed. The first listener to answer decides what to try instead. */
    "agent/request-error"(failure: AgentRequestFailure): Promise<AgentRetry | void> | AgentRetry | void;
    /** An in-app turn is about to end. The first listener to answer keeps it going, with a message to the model. */
    "agent/turn-stopping"(ending: TurnEnding): Promise<{ continue: string } | void> | { continue: string } | void;
    /**
     * A CLI agent's hook reached Tomrade — Claude Code, Codex, dsh and the rest. The first listener to
     * answer decides; the answer reaches the agent only when `answerable` (a session Tomrade started).
     */
    "agent/cli-hook"(call: CliHookCall): Promise<CliHookAnswer | void> | CliHookAnswer | void;
  }
}

/** What a CLI agent's hook says happened, in one set of names whichever agent sent it. */
export type CliHookEvent = "session-start" | "prompt" | "pre-tool" | "post-tool" | "stop" | "session-end";

export interface CliHookCall {
  event: CliHookEvent;
  /** The agent that sent it: `claude-code`, `codex`, `dsh`, `pi`, `workbuddy`, `cursor`, `opencode`, `hermes`… */
  agent: string;
  /** Whether an answer reaches the agent: true in a session Tomrade started, false for a connected repository's hooks. */
  answerable: boolean;
  projectId: string;
  /** Tomrade's code session the hook belongs to. */
  sessionId: string;
  /** The ticket the session works, when it has one. */
  ticket: string | null;
  cwd: string | null;
  tool?: { name: string; input: unknown; output?: string; error?: string };
  /** What the model said last, at `stop`. */
  text?: string;
  /** The hook's own payload, as the agent sent it. */
  raw: Record<string, unknown>;
}

/** Refuse the tool (`pre-tool`), add context for the model, or keep the turn going (`stop`). */
export interface CliHookAnswer {
  deny?: string;
  context?: string;
  continue?: string;
}

/** Which turn, step and model profile a request belongs to: read, never changed. */
export interface AgentTurnInfo {
  runId: string;
  threadId: string;
  projectId: string;
  purpose: TurnPurpose;
  profile: string;
  step: number;
}

/** One model request as an in-app engine is about to send it. */
export interface AgentRequest {
  /** Stable from turn to turn: what a provider caches. */
  system: string;
  /** What changes between turns, sent after the cached part. */
  systemTail?: string;
  tools: ToolSpec[];
  messages: Message[];
  turn: AgentTurnInfo;
}

export interface AgentRequestFailure {
  error: unknown;
  request: AgentRequest;
  /** How many times this step was already tried again on a listener's answer. */
  attempt: number;
}

/** Send the request again: changed, on another model profile, or both. */
export interface AgentRetry {
  request?: Partial<Pick<AgentRequest, "system" | "tools" | "messages">>;
  profile?: string;
}

export interface TurnEnding {
  /** What the model said last. */
  text: string;
  turn: AgentTurnInfo;
  /** How many times this turn was already kept going. */
  continued: number;
}

export interface AgentPolicy {
  id: string;
  /** Runs on tools/pre-execute for calls that belong to an agent run. Throw to refuse; the message reaches the model. */
  before(call: { name: string; args: unknown; by: Author; projectId?: string; run: RunHandle }, next: () => Promise<unknown>): Promise<unknown>;
}
