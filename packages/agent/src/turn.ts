import type { LlmService } from "@tomradex/llm";
import type { RunHandle, ToolDescriptor } from "@tomradex/tools";
import type { Block, CardView, FocusRef, PendingView, ThreadMessage, UserInput } from "./thread.js";
import type { GeneralExecution, PlaybookIndexEntry, WorkflowInfo } from "./workflow.js";

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
  repositories?: { workstream: string; name: string; path: string | null; defaultBranch: string; readiness?: "empty" | "scaffolded" | "unknown"; hasBrief?: boolean }[];
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
    /** What each kit is for, by kit id (see ToolDefinition.kit). */
    kits?(): Record<string, string>;
    /** These are all the tools the turn may use: the engine adds none of its own (the troubleshooter's scope). */
    only?: boolean;
  };
  playbooks: { index(): PlaybookIndexEntry[]; open(id: string): string | null };
  workflows: { list(): WorkflowInfo[] };
  llm: LlmService | null;
  run: RunHandle;
  signal: AbortSignal;
  /** This engine's external session id from the previous turn, if it stored one. */
  resume?: string;
  /**
   * Messages the person sent into this running turn, for an engine whose `steering` is `queue`. Call it where
   * the model reads next (between tool calls); what it returns enters the transcript there.
   */
  takeSteers?(): string[];
  /**
   * For an engine whose `steering` is `forward` (its agent keeps its own queue: pi, Codex, Claude Code): `forward`
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
