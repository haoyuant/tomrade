import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import { DeliveryStore } from "@tomradex/db";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/fields";
import type {} from "@tomradex/oplog";
import type {} from "@tomradex/ipc";
import { writeContext } from "@tomradex/write";
import type { Item, Patch, UndoRunResult } from "@tomradex/domain";
import type { LlmService } from "@tomradex/llm";
import type { SettingsSection } from "@tomradex/settings";
import { defineTool, requireProjectId, type RunHandle, type LedgerEntry } from "@tomradex/tools";
import { loadPlaybookDir, missingPlaybookCapabilities, resolvePlaybook, type PlaybookVariants } from "./playbooks.js";
import { AgentStore, MIGRATIONS, TABLES, type PendingRecord } from "./store.js";
import { AgentMediaStore, type MediaRef, type MediaUpload, type MediaContent } from "./media.js";
import { RULES_MAX_CHARS, generalOpener, generalPrompt, rulesInstructions } from "./prompt.js";
import {
  isSuspended,
  type AgentEvent,
  type AgentPolicy,
  type Block,
  type RetryState,
  type CardView,
  type Engine,
  type CliCheck,
  type McpLinkView,
  type EngineTry,
  type EngineView,
  type FocusRef,
  type GeneralExecution,
  type OpenDependency,
  type ParkView,
  type PendingView,
  type Playbook,
  type PlaybookIndexEntry,
  type PlaybookSource,
  type RunView,
  type Suspended,
  type ThreadMessage,
  type ThreadSummary,
  type TurnFollowUp,
  type TurnInput,
  type TurnIO,
  type TurnResult,
  type UserInput,
  type WorkflowIO,
  type WorkflowSpec,
  type ThreadSurface,
  PANEL_SURFACES
} from "./types.js";
import { AGENT_WORDS, type AgentWords } from "./words.js";
import { looksRateLimited, resetTime, untilLabel } from "./limits.js";
import { describeFailure, readableError, redactSecrets } from "./failure.js";
import { conversationRecap } from "./recap.js";
import { NO_TOKENS, addTokens, runTokens, type TokenBreakdown } from "./tokens.js";

/** Where a thread's engine would run, or the one reason it cannot yet. `code` is stable for the renderer to translate. */
/** Which of these threads a plugin opened, and what to call that: thread id → label. */
export type ThreadOrigins = (projectId: string, threads: ThreadSummary[]) => Iterable<[string, string]>;

export interface WorkdirStatus {
  cwd: string | null;
  remote: string | null;
  branch: string | null;
  worktree: string | null;
  problem: string | null;
  code: "no-checkout" | "no-repos" | "finished" | "error" | null;
}

export interface PlaybookRecommendation {
  workType: "coding" | "general";
  playbookId: string | null;
  confidence: number;
  reason: string;
  source: "llm" | "fallback";
  requires: string[];
}

const recommendationSchema = z.object({
  workType: z.enum(["coding", "general"]),
  playbookId: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1)
});

/** What one engine's finished runs added up to over a stretch of time, across every open project. */
export interface EngineUsage extends TokenBreakdown {
  engine: string;
  title: string;
  runs: number;
  /** Null when none of the runs said what it cost (Codex, the loop): tokens are all there is. */
  costUsd: number | null;
}

export interface UsageSummary {
  /** Since local midnight. */
  today: EngineUsage[];
  /** The last seven days, today included. */
  week: EngineUsage[];
}

/** A ticket's spend: every run of every thread started from it. Both must agree — the board sorts on one, SQL on the other. */
const COST_VALUES_SQL = "SELECT t.item_id AS item_id, SUM(r.cost_usd) AS value FROM plugin_agent_runs r JOIN plugin_agent_threads t ON t.id = r.thread_id WHERE t.item_id IS NOT NULL AND r.cost_usd IS NOT NULL GROUP BY t.item_id";
const COST_EXPR_SQL = "SELECT SUM(r.cost_usd) FROM plugin_agent_runs r JOIN plugin_agent_threads t ON t.id = r.thread_id WHERE t.item_id = i.id";

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: ThreadMessage[];
  runs: RunView[];
  cards: CardView[];
  pending: PendingView | null;
  activePermissionMode?: string;
}

/** How a General ticket is to be run: which engine, which method, and the engine knobs for this delivery. */
export interface GeneralStartOptions {
  engine?: string;
  playbook?: string;
  /** Engine option overrides for the thread (model, effort…); replaces earlier overrides when given. */
  options?: Record<string, unknown>;
  /** The UI that owns the thread; a terminal session is a `code` surface thread the panel does not list. */
  surface?: ThreadSurface;
  /** The engine is a CLI the user runs themselves: no engine plugin is checked and none is required. */
  external?: boolean;
  /** Start although tickets this one waits on are still open; the agent is told which. */
  allowBlocked?: boolean;
}

/** A General delivery ready to run: the thread is bound to the delivery and the playbook, nothing has been sent yet. */
export interface GeneralPreparation {
  threadId: string;
  continued: boolean;
  engine: string;
  cwd: string;
  playbook: GeneralExecution["playbook"];
  /** The first user message of a headless run; the engine's system prompt carries the rest. */
  opener: string;
  /** The whole brief for a CLI agent the user runs in a terminal, which gets no system prompt from Tomrade. */
  prompt: string;
}

/** What a new thread may be about beyond its workstream: the ticket it implements and the branch it works on. */
export interface NewThreadOptions {
  itemId?: string | null;
  branch?: string | null;
  title?: string;
  /** The UI that owns this thread. Defaults to the Assistant panel. */
  surface?: ThreadSurface;
  /** The engine knobs the thread opens with — what the thread it was opened from was using. */
  options?: Record<string, unknown> | null;
}

/** Current in-memory work plus durable questions, for main-process observers that load mid-run. */
export interface AgentActivity {
  projectId: string;
  threadId: string;
  run: RunView | null;
  pending: PendingView | null;
}

declare module "cordis" {
  interface Context {
    agent: Agent;
  }
  interface Events {
    /** Main-process lifecycle stream for feature plugins; renderer IPC is only one consumer. */
    "agent/event"(threadId: string, event: AgentEvent): void;
    /** The assistant panel switched to this thread, for observers that follow the conversation on screen. */
    "agent/showing"(threadId: string): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "agent.recommendPlaybook": (projectId: string, input: { title: string; body?: string | null; workType?: "coding" | "general" }) => PlaybookRecommendation;
    "agent.startGeneral": (projectId: string, itemId: string, opts?: GeneralStartOptions) => { threadId: string; runId: string; continued: boolean };
    "agent.takeoverGeneral": (projectId: string, itemId: string) => { stopped: number };
    "agent.threads": (projectId: string) => ThreadSummary[];
    "agent.thread": (projectId: string, threadId: string) => ThreadDetail;
    "agent.usage": () => UsageSummary;
    /** The project's rules for every agent, as the person wrote them; empty when there are none. */
    "agent.rules": (projectId: string) => { body: string; file: string | null };
    "agent.setRules": (projectId: string, body: string) => { body: string; file: string | null };
    "agent.newThread": (projectId: string, engine?: string, boardId?: string | null, opts?: NewThreadOptions) => ThreadSummary;
    /** Put the thread on a workstream (its repository is where a code engine runs), or back on the whole project. */
    "agent.setWorkstream": (projectId: string, threadId: string, boardId: string | null) => ThreadSummary;
    "agent.archiveThread": (projectId: string, threadId: string) => boolean;
    "agent.archivedThreads": (projectId: string) => ThreadSummary[];
    "agent.unarchiveThread": (projectId: string, threadId: string) => boolean;
    "agent.deleteThread": (projectId: string, threadId: string) => boolean;
    /** Where the thread's engine would run: ready, or why not yet (no checkout on this machine). */
    "agent.workdir": (projectId: string, threadId: string) => WorkdirStatus;
    "agent.send": (projectId: string, threadId: string, text: string, focus?: FocusRef[], attachments?: MediaRef[]) => { runId: string };
    "agent.media.upload": (projectId: string, threadId: string, upload: MediaUpload) => MediaRef;
    "agent.media.read": (projectId: string, threadId: string, id: string) => MediaContent;
    "agent.mediaCapabilities": (engineId: string, options?: unknown) => { input: string[]; output: string[] };
    "agent.answer": (projectId: string, threadId: string, questionId: string, value: string | string[]) => { runId: string };
    "agent.cancel": (runId: string) => boolean;
    /** Into the running turn, when its engine steers; false means it was not taken (queue it instead). */
    "agent.steer": (projectId: string, threadId: string, steerId: string, text: string) => Promise<boolean>;
    "agent.showing": (threadId: string) => void;
    "agent.revert": (projectId: string, runId: string) => UndoRunResult;
    /** `fresh` looks for each engine's CLI again instead of answering from a recent probe. */
    "agent.engines": (opts?: { fresh?: boolean }) => EngineView[];
    /** Runs a file the person picked as an engine's CLI, before it is saved. */
    "agent.checkCli": (engineId: string, file: string) => CliCheck;
    /** Whether the engine's own user-level configuration reaches this Tomrade's MCP server. */
    "agent.mcpLink": (engineId: string) => McpLinkView;
    "agent.linkMcp": (engineId: string, profile?: string) => McpLinkView;
    "agent.unlinkMcp": (engineId: string, profile?: string) => McpLinkView;
    /** One real turn on the engine in a hidden thread of this project: does it answer? */
    "agent.tryEngine": (projectId: string | null, engineId: string) => EngineTry;
    "agent.setPermissionMode": (projectId: string, threadId: string, mode: string) => ThreadSummary;
    "agent.setEngine": (projectId: string, threadId: string, engineId: string) => ThreadSummary;
    /** Engine option overrides for one thread; null clears them so the engine's settings apply again. */
    "agent.setOptions": (projectId: string, threadId: string, options: Record<string, unknown> | null) => ThreadSummary;
    "agent.playbooks": (projectId?: string) => PlaybookIndexEntry[];
  }
  interface Broadcasts {
    "agent.event": (threadId: string, event: AgentEvent) => void;
  }
}

export const AgentConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    mediaDir: z.string().optional(),
    /** Folder of user playbooks: one SKILL.md per subdirectory. */
    playbooksDir: z.string().optional(),
    /** Hard wall-clock ceiling per run, for a thread that talks to the backlog. */
    maxWallMs: z.number().int().min(10_000).default(180_000),
    /** The ceiling for a run that implements a ticket in a repository — hours, not minutes. */
    codeMaxWallMs: z.number().int().min(60_000).default(4 * 60 * 60 * 1000)
  })
);
export type AgentConfig = z.infer<typeof AgentConfig>;

export interface AgentSettings {
  defaultEngine: string;
  /** No longer read: a plan always waits for the person before it is written. */
  confirmWritesOver: number;
  /** A run stopped by a usage limit is continued once the limit lifts. */
  resumeAfterLimit: boolean;
  engines: Record<string, unknown>;
  /** Per-playbook-id: which source wins when several carry the same id. Absent = most specific wins. */
  playbookChoices: Record<string, PlaybookSource>;
}

export const AGENT_SECTION: SettingsSection<AgentSettings> = {
  id: "agent",
  title: "Assistant",
  description: "Which engine conducts a new thread, and when a plan pauses for confirmation before writing.",
  schema: z.object({
    defaultEngine: z.string().default("tomrade"),
    confirmWritesOver: z.number().int().min(0).default(0),
    resumeAfterLimit: z.boolean().default(true),
    engines: z.record(z.string(), z.unknown()).default({}),
    playbookChoices: z.record(z.string(), z.enum(["plugin", "user", "project"])).default({})
  }),
  defaults: { defaultEngine: "tomrade", confirmWritesOver: 0, resumeAfterLimit: true, engines: {}, playbookChoices: {} },
  order: 11
};

interface RunCtx {
  run: RunView;
  thread: ThreadSummary;
  threadId: string;
  projectId: string;
  engine: Engine;
  abort: AbortController;
  handle: RunHandle;
  entries: LedgerEntry[];
  io: TurnIO;
  wio: WorkflowIO;
  /** Text streamed since the engine last kept a block — what a stop or a timeout would otherwise throw away. */
  partial: { text: string };
  /** Whether the wall clock, not the person, ended the run, and what the clock allowed. */
  clock: { timedOut: boolean; limitMs: number };
  /** Stores a stretch of retries still open when the turn ends. */
  settleRetry: (recovered: boolean) => void;
  /** Sent into this turn and not yet handed to the model. */
  steers: { id: string; text: string }[];
  /** Where the engine's agent takes them instead, when it queues them itself. */
  forward: ((steer: { id: string; text: string }) => Promise<boolean>) | null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A limit that does not say when it lifts is tried again after this; a thread limited this many runs in a row is left to the person. */
const LIMIT_RETRY_MS = 15 * 60_000;
const LIMIT_TRIES = 3;
/** How long a try waits for an answer. */
const TRY_MS = 90_000;
/** Limits lift on the provider's clock, not this one. */
const LIMIT_SLACK_MS = 30_000;

const summarize = (value: unknown): string => {
  if (value == null) return "done";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "string") return value.slice(0, 160);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.key === "string" && typeof v.title === "string") return `${v.key} ${v.title}`;
    return JSON.stringify(value).slice(0, 160);
  }
  return String(value);
};

/**
 * The platform every engine runs on. Owns the threads, the runs, the ledger,
 * the cards, suspended workflows and run-scoped undo; holds no opinion about
 * what to do next — that is the registered engine's one job.
 */

/** `promise`, or a rejection once `signal` aborts — for waits that do not take a signal themselves. */
function settleBy<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export class Agent extends Service {
  static provide = "agent";
  static inject = ["db", "tools", "oplog", "settings"];
  static Config = AgentConfig;

  store!: AgentStore;

  private engines = new Map<string, Engine>();
  private trying = new Map<string, Promise<EngineTry>>();
  private tries = new Map<string, { settings: string; tried: EngineTry }>();
  private workflows = new Map<string, WorkflowSpec>();
  private followUps = new Map<string, TurnFollowUp>();
  private playbooks = new Map<string, PlaybookVariants>();
  private readonly origins = new Set<ThreadOrigins>();
  /** Playbooks read from each project's shared copy; refreshed when a run starts. */
  private projectPlaybooks = new Map<string, Map<string, Playbook>>();
  private permissions = new Map<string, { pending: PendingView; answer(value: string | null): void }>();
  private permissionQueues = new Map<string, Promise<unknown>>();
  private activeByThread = new Map<string, RunCtx>();
  private shownThread: string | null = null;
  private activeById = new Map<string, RunCtx>();
  private mediaStore?: AgentMediaStore;
  private parkTimers = new Map<string, NodeJS.Timeout>();
  /** A run Tomrade started because a limit lifted, and how many limited runs came before it. */
  private limitTries = new Map<string, number>();
  private resuming = new Map<string, number>();

  constructor(
    ctx: Context,
    public readonly config: AgentConfig
  ) {
    super(ctx, "agent");
  }

  [Service.init]() {
    this.ctx.db.migrate("agent", MIGRATIONS, { tables: TABLES });
    this.store = new AgentStore(this.ctx.db, (id) => this.answering(id));
    for (const playbook of loadPlaybookDir(fileURLToPath(new URL("../playbooks", import.meta.url)))) this.playbook(playbook);
    // A run left "running" by a killed process has no controller; settle it in
    // every project file that is open now and in each one opened later.
    for (const projectId of this.ctx.db.openIds()) this.store.reconcileInterrupted(projectId, this.words().interrupted);
    this.ctx.on("db/opened", (projectId) => this.store.reconcileInterrupted(projectId, this.words().interrupted));
    for (const projectId of this.ctx.db.openIds()) this.armParked(projectId);
    this.ctx.on("db/opened", (projectId) => this.armParked(projectId));
    this.ctx.effect(() => () => {
      for (const timer of this.parkTimers.values()) clearTimeout(timer);
      this.parkTimers.clear();
    }, "agent limit timers");
    this.ctx.settings.register(AGENT_SECTION);
    // Closing a General ticket on the person's word is fine; closing one an agent worked on is that work's review.
    this.ctx.on("write/pre-commit", (intent, next) => {
      const before = intent.before as Item | null;
      const after = intent.after as Item | null;
      if (intent.entity === "item" && intent.op === "update" && intent.by !== "human" && after?.workType === "general" && after.status === "done" && before?.status !== "done") {
        const active = new DeliveryStore(this.ctx.db).active(intent.projectId, intent.id);
        if (active && this.store.threadsForItem(intent.projectId, intent.id).some((t) => t.execution?.deliveryId === active.id)) throw new Error("General deliveries require human acceptance");
      }
      return next();
    });
    // A conversation that worked on a ticket relays nobody's verdict on it: that review is the person's own.
    this.ctx.on("tools/pre-execute", (call, next) => {
      if (call.name !== "review_delivery" || !call.run) return next();
      const id = String((call.args as { id?: unknown }).id ?? "");
      const items = this.ctx.get("items") as { get(projectId: string, id: string): Item | null; getByKey(projectId: string, key: string): Item | null } | undefined;
      const item = items?.get(call.run.projectId, id) ?? items?.getByKey(call.run.projectId, id);
      const thread = this.store.thread(call.run.projectId, call.run.threadId);
      if (item && thread?.itemId === item.id) throw new Error(`review_delivery: this conversation works on ${item.key}, so it cannot review its delivery — the user accepts it in the delivery panel`);
      return next();
    });
    this.migrateConversationRole();
    this.registerPlatformTools();
    this.ctx.inject(["fields"], (ctx) => ctx.fields.derive({ id: "cost", name: "Cost", names: { zh: "花费" }, unit: "usd", values: COST_VALUES_SQL, expr: COST_EXPR_SQL }));
    this.loadUserPlaybooks();
    this.ctx.inject(["hub"], (ctx) => {
      if (ctx.hub.dir) this.migratePlaybooksIntoHub(ctx.hub.dir);
      this.loadUserPlaybooks();
      return ctx.on("hub/configured", (dir) => {
        this.migratePlaybooksIntoHub(dir);
        this.loadUserPlaybooks();
      });
    });
    // An agent Tomrade did not start reads the rules when it connects; the ones it starts hear them every turn.
    this.ctx.inject(["mcp"], (ctx) => {
      const mcp = ctx.get("mcp") as { instruct(render: (scope: { projectId?: string }) => string | null, options?: { order?: number }): () => void } | undefined;
      mcp?.instruct(({ projectId }) => {
        const rules = projectId ? this.rules(projectId) : null;
        return rules ? rulesInstructions(rules) : null;
      }, { order: -1 });
    });
    this.ctx.inject(["ipc"], (ctx) => {
      // the panel's list says which conversations are working right now
      ctx.ipc.handle("agent.threads", (projectId) => {
        const running = new Set(ctx.agent.activeRuns().map((a) => a.thread.id));
        const parked = new Map(ctx.agent.store.allParked(projectId).map((p) => [p.threadId, p.until]));
        return ctx.agent.withOrigins(projectId, ctx.agent.store.threads(projectId, PANEL_SURFACES)).map((th) => (running.has(th.id) || parked.has(th.id) ? { ...th, ...(running.has(th.id) ? { running: true } : {}), ...(parked.has(th.id) ? { parkedUntil: parked.get(th.id) } : {}) } : th));
      });
      ctx.ipc.handle("agent.thread", (projectId, threadId) => ctx.agent.thread(projectId, threadId));
      ctx.ipc.handle("agent.usage", () => ctx.agent.usage());
      ctx.ipc.handle("agent.rules", (projectId) => ({ body: ctx.agent.rules(projectId) ?? "", file: ctx.agent.rulesFile(projectId) }));
      ctx.ipc.handle("agent.setRules", (projectId, body) => {
        ctx.agent.setRules(projectId, body);
        return { body: ctx.agent.rules(projectId) ?? "", file: ctx.agent.rulesFile(projectId) };
      });
      ctx.ipc.handle("agent.newThread", (projectId, engine, boardId, opts) => ctx.agent.newThread(projectId, engine, boardId ?? null, opts ?? {}));
      ctx.ipc.handle("agent.startGeneral", (projectId, itemId, opts) => ctx.agent.startGeneral(projectId, itemId, opts));
      ctx.ipc.handle("agent.takeoverGeneral", (projectId, itemId) => ctx.agent.takeoverGeneral(projectId, itemId));
      ctx.ipc.handle("agent.setWorkstream", (projectId, threadId, boardId) => ctx.agent.setWorkstream(projectId, threadId, boardId));
      ctx.ipc.handle("agent.archiveThread", (projectId, threadId) => ctx.agent.archiveThread(projectId, threadId));
      ctx.ipc.handle("agent.archivedThreads", (projectId) => ctx.agent.withOrigins(projectId, ctx.agent.store.archivedThreads(projectId, PANEL_SURFACES)));
      ctx.ipc.handle("agent.unarchiveThread", (projectId, threadId) => ctx.agent.unarchiveThread(projectId, threadId, { restored: true }));
      ctx.ipc.handle("agent.deleteThread", (projectId, threadId) => ctx.agent.deleteThread(projectId, threadId));
      ctx.ipc.handle("agent.workdir", (projectId, threadId) => ctx.agent.workdir(projectId, threadId));
      ctx.ipc.handle("agent.send", (projectId, threadId, text, focus, attachments) => ctx.agent.send(projectId, threadId, { kind: "text", text, focus, attachments }));
      ctx.ipc.handle("agent.media.upload", (projectId, threadId, upload) => ctx.agent.uploadMedia(projectId, threadId, upload));
      ctx.ipc.handle("agent.media.read", (projectId, threadId, id) => ctx.agent.readMedia(projectId, threadId, id));
      ctx.ipc.handle("agent.mediaCapabilities", (asked, options) => {
        const engineId = ctx.agent.answering(asked);
        return ctx.agent.engines.get(engineId)?.media?.(options ?? ctx.agent.settingsOf().engines[engineId]) ?? { input: [], output: [] };
      });
      ctx.ipc.handle("agent.setPermissionMode", (projectId, threadId, mode) => ctx.agent.setPermissionMode(projectId, threadId, mode));
      ctx.ipc.handle("agent.answer", (projectId, threadId, questionId, value) => ctx.agent.send(projectId, threadId, { kind: "answer", questionId, value }));
      ctx.ipc.handle("agent.cancel", (runId) => ctx.agent.cancel(runId));
      ctx.ipc.handle("agent.steer", (projectId, threadId, steerId, text) => ctx.agent.steer(projectId, threadId, steerId, text));
      ctx.ipc.handle("agent.showing", (threadId) => ctx.agent.show(threadId));
      ctx.ipc.handle("agent.revert", (projectId, runId) => ctx.agent.revert(projectId, runId));
      ctx.ipc.handle("agent.engines", (opts) => ctx.agent.engineViews(opts?.fresh));
      ctx.ipc.handle("agent.checkCli", async (engineId, file) => {
        const engine = ctx.agent.engines.get(engineId);
        if (!engine?.checkCli) throw new Error(`${engineId} does not run a local CLI`);
        return engine.checkCli(file);
      });
      const mcpLink = (engineId: string) => {
        const link = ctx.agent.engines.get(engineId)?.mcpLink;
        if (!link) throw new Error(`${engineId} cannot be connected to Tomrade's MCP server`);
        return link;
      };
      ctx.ipc.handle("agent.mcpLink", (engineId) => mcpLink(engineId).status());
      ctx.ipc.handle("agent.linkMcp", (engineId, profile) => mcpLink(engineId).connect(profile));
      ctx.ipc.handle("agent.unlinkMcp", (engineId, profile) => mcpLink(engineId).disconnect(profile));
      ctx.ipc.handle("agent.tryEngine", (projectId, engineId) => {
        // Settings opened outside a project: any open project holds the hidden thread as well.
        const where = projectId ?? ctx.db.openIds()[0];
        if (!where) throw new Error("Open a project first — a try runs in one");
        return ctx.agent.tryEngine(where, engineId);
      });
      ctx.ipc.handle("agent.setEngine", (projectId, threadId, engineId) => ctx.agent.setEngine(projectId, threadId, engineId));
      ctx.ipc.handle("agent.setOptions", (projectId, threadId, options) => ctx.agent.setOptions(projectId, threadId, options));
      ctx.ipc.handle("agent.playbooks", async (projectId) => {
        if (projectId) await ctx.agent.refreshProjectPlaybooks(projectId);
        return ctx.agent.playbookIndex(projectId);
      });
      ctx.ipc.handle("agent.recommendPlaybook", (projectId, input) => ctx.agent.recommendPlaybook(projectId, input));
    });
    return () => {
      for (const rc of this.activeById.values()) rc.abort.abort();
    };
  }

  // ── registries ─────────────────────────────────────────────────────────────
  // These run on the CALLER's context, so a registration dies with its plugin.

  /** A registered engine, for a plugin that reads the contract (the troubleshooter). */
  engineOf(id: string): Engine | undefined {
    return this.engines.get(id);
  }

  /** The registered engine that answers for an id: the id itself, or the engine that includes it. */
  answering(id: string): string {
    return [...this.engines.values()].find((e) => e.includes?.includes(id))?.id ?? id;
  }

  /** The engines a person chooses between: none that another engine took in. */
  allEngines(): Engine[] {
    return [...this.engines.values()].filter((e) => this.answering(e.id) === e.id);
  }

  engine(engine: Engine): () => void {
    if (this.engines.has(engine.id)) throw new Error(`engine "${engine.id}" is already registered`);
    return this.ctx.effect(() => {
      this.engines.set(engine.id, engine);
      return () => this.engines.delete(engine.id);
    }, `agent.engine(${engine.id})`);
  }

  /** A plugin names the conversations it opened (thread id → a short label in the person's language). */
  threadOrigins(provider: ThreadOrigins): () => void {
    return this.ctx.effect(() => {
      this.origins.add(provider);
      return () => void this.origins.delete(provider);
    });
  }

  /** The threads with what each plugin says opened them. */
  withOrigins(projectId: string, threads: ThreadSummary[]): ThreadSummary[] {
    if (!this.origins.size || !threads.length) return threads;
    const labels = new Map<string, string[]>();
    for (const provider of this.origins) {
      try {
        for (const [id, label] of provider(projectId, threads)) labels.set(id, [...(labels.get(id) ?? []), label]);
      } catch (err) {
        this.ctx.logger.warn(`thread origins failed: ${message(err)}`);
      }
    }
    return threads.map((th) => (labels.has(th.id) ? { ...th, origins: labels.get(th.id) } : th));
  }

  playbook(playbook: Omit<Playbook, "tools"> & { tools?: string[] }): () => void {
    // Two PLUGINS claiming one id is a programming error. A user SKILL.md with
    // the same id is not: both variants are kept, and which one wins is the
    // user's call (settings.agent.playbookChoices; most specific by default).
    if (this.playbooks.get(playbook.id)?.plugin) throw new Error(`playbook "${playbook.id}" is already registered by a plugin`);
    return this.ctx.effect(() => {
      const variants = this.playbooks.get(playbook.id) ?? {};
      variants.plugin = { ...playbook, tools: playbook.tools ?? [] };
      this.playbooks.set(playbook.id, variants);
      return () => {
        const v = this.playbooks.get(playbook.id);
        if (!v) return;
        delete v.plugin;
        if (!v.user) this.playbooks.delete(playbook.id);
      };
    }, `agent.playbook(${playbook.id})`);
  }

  policy(policy: AgentPolicy): () => void {
    return this.ctx.on("tools/pre-execute", (call, next) => {
      if (!call.run) return next();
      return policy.before(call as Parameters<AgentPolicy["before"]>[0], next as () => Promise<unknown>);
    });
  }

  /** Registers the spec and exposes it as a tool named `spec.id` on every surface. */
  workflow<I, S>(spec: WorkflowSpec<I, S>): () => void {
    if (this.workflows.has(spec.id)) throw new Error(`workflow "${spec.id}" is already registered`);
    const caller = this.ctx;
    const specDispose = caller.effect(() => {
      this.workflows.set(spec.id, spec as WorkflowSpec);
      return () => this.workflows.delete(spec.id);
    }, `agent.workflow(${spec.id})`);
    caller.tools.register(
      defineTool({
        name: spec.id,
        title: spec.title,
        description: spec.description + " (A multi-step workflow: it may pause to ask the user; when the result says the question was posted, end your turn.)",
        input: spec.input as z.ZodObject,
        execute: (args, inv) => {
          if (!inv.run) throw new Error(`${spec.id} runs inside an assistant thread; call it from one`);
          const rc = this.activeById.get(inv.run.id);
          if (!rc) throw new Error(`${spec.id}: no active run`);
          if (this.store.pending(rc.projectId, rc.threadId)) throw new Error("another question is already waiting for the user");
          if (spec.literal && !rc.engine.literal) throw new Error(`${spec.id} is the fixed questionnaire for engines without a model; hold this conversation yourself (open_playbook for the method)`);
          return this.startWorkflow(spec as WorkflowSpec, args, rc);
        }
      })
    );
    return specDispose;
  }

  /** Registers a check that runs after every turn; see TurnFollowUp. */
  followUp(followUp: TurnFollowUp): () => void {
    return this.ctx.effect(() => {
      this.followUps.set(followUp.id, followUp);
      return () => this.followUps.delete(followUp.id);
    }, `agent.followUp(${followUp.id})`);
  }

  // ── views ──────────────────────────────────────────────────────────────────

  thread(projectId: string, threadId: string): ThreadDetail {
    const thread = this.store.thread(projectId, threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const pending = this.store.pending(projectId, threadId);
    return {
      thread,
      activePermissionMode: this.activeByThread.get(threadId)?.io.run.scratch.get("permissionMode") as string | undefined,
      messages: this.store.messages(projectId, threadId),
      runs: this.store.runs(projectId, threadId),
      cards: this.store.cards(projectId, threadId),
      pending: this.permissions.get(threadId)?.pending ?? (pending ? this.pendingView(pending) : null)
    };
  }

  /** The thread the assistant panel last showed; it outlives the panel, so leaving a project keeps it. */
  showing(): string | null {
    return this.shownThread;
  }

  show(threadId: string): void {
    if (threadId === this.shownThread) return;
    this.shownThread = threadId;
    this.ctx.emit("agent/showing", threadId);
  }

  activities(): AgentActivity[] {
    const out = new Map<string, AgentActivity>();
    for (const rc of this.activeByThread.values()) {
      const pending = this.store.pending(rc.projectId, rc.threadId);
      out.set(rc.threadId, {
        projectId: rc.projectId,
        threadId: rc.threadId,
        run: this.store.run(rc.projectId, rc.run.id) ?? rc.run,
        pending: this.permissions.get(rc.threadId)?.pending ?? (pending ? this.pendingView(pending) : null)
      });
    }
    for (const projectId of this.ctx.db.openIds()) {
      for (const thread of this.store.threads(projectId, PANEL_SURFACES)) {
        if (out.has(thread.id)) continue;
        const pending = this.store.pending(projectId, thread.id);
        if (pending) out.set(thread.id, { projectId, threadId: thread.id, run: null, pending: this.pendingView(pending) });
      }
    }
    return [...out.values()].sort((a, b) => a.threadId.localeCompare(b.threadId));
  }

  private pendingView(record: PendingRecord): PendingView {
    return { threadId: record.threadId, kind: record.kind, workflow: record.workflow, question: record.question, accepts: record.accepts };
  }

  async engineViews(fresh = false): Promise<EngineView[]> {
    return Promise.all(
      [...this.engines.values()].filter((engine) => this.answering(engine.id) === engine.id).map(async (engine) => {
        try {
          const state = await engine.available(fresh ? { fresh } : undefined);
          return { id: engine.id, title: engine.title, capabilities: state.capabilities ?? engine.capabilities ?? ["backlog"], ok: state.ok, reason: state.reason, need: state.need, cli: state.cli, ...(state.configDir ? { configDir: state.configDir } : {}), ...(this.triedWith(engine.id) ? { tried: this.triedWith(engine.id) } : {}), picks: engine.picks?.(), permissionModes: engine.permissionModes, ...(engine.terminal === false ? { terminal: false } : {}), ...(engine.terminalOnly ? { terminalOnly: true } : {}), ...(engine.usesModels ? { usesModels: true } : {}), ...(engine.steers ? { steers: true } : {}), ...(engine.setup ? { setup: engine.setup } : {}), ...(engine.includes ? { includes: engine.includes } : {}), ...(engine.mcpLink ? { mcpLink: true } : {}) };
        } catch (err) {
          return { id: engine.id, title: engine.title, capabilities: engine.capabilities ?? ["backlog"], ok: false, reason: message(err) };
        }
      })
    );
  }

  playbookIndex(projectId?: string): PlaybookIndexEntry[] {
    const choices = this.settingsOf().playbookChoices ?? {};
    const ids = new Set<string>(this.playbooks.keys());
    const project = projectId ? this.projectPlaybooks.get(projectId) : undefined;
    for (const id of project?.keys() ?? []) ids.add(id);
    return [...ids]
      .flatMap((id) => {
        const resolved = resolvePlaybook({ ...this.playbooks.get(id), project: project?.get(id) }, choices[id]);
        return resolved ? [resolved.entry] : [];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * `withinMs` is for callers that must not wait on the worker model (an agent creating a ticket):
   * past it, or on any failure, the keyword fallback answers instead.
   */
  async recommendPlaybook(projectId: string, input: { title: string; body?: string | null; workType?: "coding" | "general" }, opts: { withinMs?: number; signal?: AbortSignal } = {}): Promise<PlaybookRecommendation> {
    const started = Date.now();
    const budget = opts.withinMs !== undefined ? AbortSignal.timeout(opts.withinMs) : undefined;
    const signal = budget && opts.signal ? AbortSignal.any([budget, opts.signal]) : budget ?? opts.signal;
    // The refresh can wait on storage; a budgeted caller goes with the playbooks already loaded.
    await settleBy(this.refreshProjectPlaybooks(projectId), signal).catch(() => undefined);
    // A built-in playbook that names no work type steers the assistant (app.guide, studio.build-plugin); it is no method for a ticket.
    const candidates = this.playbookIndex(projectId).filter((entry) => !entry.id.startsWith("backlog.") && (entry.workTypes?.length ? !input.workType || entry.workTypes.includes(input.workType) : entry.source !== "plugin"));
    const words = this.words();
    const candidateIds = new Set(candidates.map((entry) => entry.id));
    const fallback = (): PlaybookRecommendation => {
      const text = `${input.title} ${input.body ?? ""}`.toLowerCase();
      const workType = input.workType ?? (text.match(/bug|fix|implement|code|refactor|repository|repo|api|feature/) ? "coding" : "general");
      const preferred = workType === "coding"
        ? (text.match(/bug|fix|implement|code|refactor|repository|repo|api|feature/) ? "code.implement" : null)
        : (text.match(/design|visual|\bui\b|\bux\b|brand|logo/) ? "design.create" : text.match(/document|guide|write|proposal|spec|文章|文档/) ? "document.write" : text.match(/music|audio|animation|video|media|动图|音乐|视频/) ? "media.generate" : "task.assist");
      const playbookId = preferred && candidateIds.has(preferred) ? preferred : candidates.find((entry) => entry.workTypes?.includes(workType))?.id ?? null;
      const selected = candidates.find((entry) => entry.id === playbookId);
      return { workType, playbookId, confidence: playbookId === preferred ? 0.62 : 0.3, reason: words.recommendedByType, source: "fallback", requires: selected?.requires ?? [] };
    };
    const llm = this.ctx.get("llm") as LlmService | undefined;
    if (!llm || !candidates.length) return fallback();
    try {
      if (!(await settleBy(llm.worker(), signal)).ok) return fallback();
      const result = await settleBy(llm.completeJson(recommendationSchema, {
        // a JSON object with one sentence of reason; no room to ramble, and no second round when there is a fallback
        ...(budget ? { maxTokens: 400, repair: false } : {}),
        signal,
        purpose: "playbook",
        system: `Recommend one execution playbook for a ticket. Return only JSON. Respect the requested workType. Choose playbookId only from the supplied candidates; use null only when none fits. Confidence is 0..1. Explain the recommendation in one short sentence in ${words.reasonLanguage}, for the person who will run the ticket: say why this method suits the work, without naming ids or fields.`,
        user: JSON.stringify({ requestedWorkType: input.workType ?? null, title: input.title, body: input.body ?? "", candidates: candidates.map(({ id, title, when, workTypes, requires, outputs }) => ({ id, title, when, workTypes, requires, outputs })) })
      }), signal);
      if (input.workType && result.workType !== input.workType || (result.playbookId !== null && !candidateIds.has(result.playbookId))) return fallback();
      const selected = candidates.find((entry) => entry.id === result.playbookId);
      return { ...result, source: "llm", requires: selected?.requires ?? [] };
    } catch (error) {
      const why = budget?.aborted ? `no answer within ${opts.withinMs}ms` : opts.signal?.aborted ? "cancelled" : error instanceof Error ? error.message : String(error);
      this.ctx.logger.warn(`playbook recommendation fell back to keywords after ${Date.now() - started}ms: ${why}`);
      return fallback();
    }
  }

  openPlaybook(id: string, projectId?: string): string | null {
    const project = projectId ? this.projectPlaybooks.get(projectId)?.get(id) : undefined;
    const resolved = resolvePlaybook({ ...this.playbooks.get(id), project }, (this.settingsOf().playbookChoices ?? {})[id]);
    return resolved?.winner.body ?? null;
  }

  /**
   * Re-read `.tomrade/playbooks/` from the project's shared copy, when the
   * project has one. Called when a run starts and when the panel asks for the
   * index — never fatal: a project without storage simply has none.
   */
  async refreshProjectPlaybooks(projectId: string): Promise<void> {
    const storage = this.ctx.get("storage") as { artifactDirFor(projectId: string): Promise<string | null> } | undefined;
    let loaded: Playbook[] = [];
    try {
      const dir = storage?.artifactDirFor ? await storage.artifactDirFor(projectId) : null;
      if (dir) loaded = loadPlaybookDir(path.join(dir, "playbooks"), (file, err) => this.ctx.logger.warn(`playbook ${file} failed to load: ${message(err)}`));
    } catch (err) {
      this.ctx.logger.warn(`project playbooks for ${projectId} failed to load: ${message(err)}`);
    }
    this.projectPlaybooks.set(projectId, new Map(loaded.map((pb) => [pb.id, pb])));
  }

  /** Runs and their tokens and spend, per engine, today and over the last week — what Tomrade itself recorded, nothing asked of a provider. */
  usage(now = Date.now()): UsageSummary {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const today = midnight.getTime();
    const week = today - 6 * 86_400_000;
    const titles = new Map([...this.engines.values()].map((e) => [e.id, e.title]));
    const sum = (since: number): EngineUsage[] => {
      const by = new Map<string, EngineUsage>();
      for (const projectId of this.ctx.db.openIds()) {
        const rows = this.ctx.db
          .for(projectId)
          .prepare("SELECT engine, usage_json, metrics_json, cost_usd FROM plugin_agent_runs WHERE started_at >= ?")
          .all(since) as { engine: string; usage_json: string | null; metrics_json: string | null; cost_usd: number | null }[];
        for (const r of rows) {
          const was = by.get(r.engine) ?? { engine: r.engine, title: titles.get(r.engine) ?? r.engine, runs: 0, ...NO_TOKENS, costUsd: null };
          const tokens = runTokens(r.usage_json ? JSON.parse(r.usage_json) : null, r.metrics_json ? JSON.parse(r.metrics_json) : null);
          by.set(r.engine, { ...was, ...addTokens(was, tokens), runs: was.runs + 1, costUsd: r.cost_usd === null ? was.costUsd : (was.costUsd ?? 0) + r.cost_usd });
        }
      }
      return [...by.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.runs - a.runs);
    };
    return { today: sum(today), week: sum(week) };
  }

  /** `<project folder>/.tomrade/rules.md`: text beside the project's playbooks and decisions, travelling with it. */
  rulesFile(projectId: string): string | null {
    const dir = (this.ctx.get("storage") as { artifactDirFor(projectId: string): string | null } | undefined)?.artifactDirFor(projectId);
    return typeof dir === "string" ? path.join(dir, "rules.md") : null;
  }

  /** The project's rules for every agent, as the person wrote them; null when there are none. */
  rules(projectId: string): string | null {
    const file = this.rulesFile(projectId);
    try {
      const body = file ? fs.readFileSync(file, "utf8").trim() : "";
      return body || null;
    } catch {
      return null;
    }
  }

  /** Empty removes the file. Rules are the person's: only their edit, or a rule they confirmed, lands here. */
  setRules(projectId: string, body: string): void {
    const text = body.replace(/\r\n/g, "\n").trim();
    if (text.length > RULES_MAX_CHARS) throw new Error(`Rules are kept under ${RULES_MAX_CHARS} characters — every run reads them; trim some first`);
    const file = this.rulesFile(projectId);
    if (!file) throw new Error("This project has no folder to keep its rules in");
    if (text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${text}\n`, "utf8");
    } else {
      fs.rmSync(file, { force: true });
    }
    this.ctx.emit("agent/rules-changed", projectId);
  }

  settingsOf(): AgentSettings {
    return (this.ctx.settings.get().agent as AgentSettings | undefined) ?? AGENT_SECTION.defaults;
  }

  /** The old global "conversation" model role becomes the loop engine's own profile override, so a multi-profile pick survives. */
  private migrateConversationRole(): void {
    const all = this.ctx.settings.get();
    const legacy = (all.models as { roles?: { conversation?: string } } | undefined)?.roles?.conversation;
    if (!legacy) return;
    const agent = this.settingsOf();
    const loop = (agent.engines.loop ?? {}) as Record<string, unknown>;
    if (loop.profile !== undefined) return;
    this.ctx.settings.set({ ...all, agent: { ...agent, engines: { ...agent.engines, loop: { ...loop, profile: legacy } } } });
  }

  newThread(projectId: string, engine?: string, boardId: string | null = null, opts: NewThreadOptions = {}): ThreadSummary {
    const chosen = this.answering(engine ?? this.settingsOf().defaultEngine);
    const known = this.engines.has(chosen);
    const engineId = known ? chosen : ([...this.engines.keys()][0] ?? chosen);
    const thread = this.store.createThread(projectId, engineId, opts.title ?? "", boardId, opts.itemId ?? null, opts.branch ?? null, opts.surface ?? "assistant");
    // The knobs the thread was opened from — a thread keeps the engine and effort it was started with
    // instead of falling back to the engine's defaults. Only when the engine asked for is the one that
    // answered: knobs picked for a plugin that is gone mean nothing to the engine that took its place.
    if (known && opts.options && Object.keys(opts.options).length) this.store.touchThread(projectId, thread.id, { options: this.acceptedOptions(engineId, opts.options) });
    return this.store.thread(projectId, thread.id)!;
  }

  /** Options the engine's own schema accepts; ones it rejects are dropped rather than leaving a thread that cannot run. */
  private acceptedOptions(engineId: string, options: Record<string, unknown>): Record<string, unknown> | null {
    const schema = this.engines.get(engineId)?.options;
    if (!schema) return options;
    return schema.safeParse(this.optionsOf({ options }, engineId)).success ? options : null;
  }

  /** The engines that may take a code turn — a local coding agent, never the in-app model. */
  codeEngines(): Engine[] {
    return this.allEngines().filter((e) => e.capabilities?.includes("code"));
  }

  private generalStarts = new Set<string>();
  private generalTakeovers = new Set<string>();
  private generalScratch: string | null = null;
  private executionCapabilities = new Map<string, number>();

  async takeoverGeneral(projectId: string, itemId: string): Promise<{ stopped: number }> {
    const key = `${projectId}:${itemId}`;
    if (this.generalStarts.has(key)) throw new Error("The agent is still starting; try takeover again shortly");
    this.generalStarts.add(key);
    this.generalTakeovers.add(key);
    try {
      const active = this.activeRuns().filter(({ thread }) => thread.projectId === projectId && thread.itemId === itemId && thread.execution);
      for (const { run } of active) this.cancel(run.id);
      const deadline = Date.now() + 15_000;
      while (active.some(({ run }) => this.activeById.has(run.id))) {
        if (Date.now() > deadline) throw new Error("The agent has not stopped yet; wait for cancellation before taking over");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      for (const { thread } of active) this.appendAndBroadcast(projectId, thread.id, "system", { type: "note", text: this.words().humanTookOver }, null);
      return { stopped: active.length };
    } finally {
      this.generalStarts.delete(key);
      this.generalTakeovers.delete(key);
    }
  }

  /** A plugin advertises an available capability; this never grants tool permissions. */
  capability(name: string): () => void {
    this.executionCapabilities.set(name, (this.executionCapabilities.get(name) ?? 0) + 1);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const count = (this.executionCapabilities.get(name) ?? 1) - 1;
      if (count) this.executionCapabilities.set(name, count);
      else this.executionCapabilities.delete(name);
    };
  }

  private async withGeneralLock<T>(projectId: string, itemId: string, work: () => Promise<T>): Promise<T> {
    const key = `${projectId}:${itemId}`;
    if (this.generalStarts.has(key)) throw new Error("This ticket is already starting");
    this.generalStarts.add(key);
    try {
      return await work();
    } finally {
      this.generalStarts.delete(key);
    }
  }

  /** Everything Start does for a General ticket short of sending the first message — what a terminal session needs before the user's own CLI takes over. */
  prepareGeneral(projectId: string, itemId: string, opts: GeneralStartOptions = {}): Promise<GeneralPreparation> {
    return this.withGeneralLock(projectId, itemId, async () => (await this.prepare(projectId, itemId, opts)).preparation);
  }

  async startGeneral(projectId: string, itemId: string, opts: GeneralStartOptions = {}): Promise<{ threadId: string; runId: string; continued: boolean }> {
    return this.withGeneralLock(projectId, itemId, async () => {
      const { preparation, item } = await this.prepare(projectId, itemId, { ...opts, external: false });
      const { runId } = this.send(projectId, preparation.threadId, { kind: "text", text: preparation.opener });
      return { threadId: preparation.threadId, runId, continued: preparation.continued };
    });
  }

  private async prepare(projectId: string, itemId: string, opts: GeneralStartOptions): Promise<{ preparation: GeneralPreparation; item: Item }> {
    const items = this.ctx.get("items") as { get(projectId: string, id: string): Item | null; update(projectId: string, id: string, patch: Patch, by: "human"): Item } | undefined;
    const item = items?.get(projectId, itemId);
    if (!item || item.kind !== "ticket" || item.workType !== "general") throw new Error("Choose a General ticket");
    if (item.humanLocked) throw new Error("Unlock the ticket before starting an agent");
    if (item.status === "done" || item.status === "cancelled") throw new Error("Reopen the ticket before starting another delivery");
    const waitsOn = this.waitsOn(projectId, item);
    if (waitsOn.length && !opts.allowBlocked) throw new Error(`${item.key} waits on ${waitsOn.map(d => d.key).join(", ")} — start anyway to work ahead of them`);
    const deliveries = new DeliveryStore(this.ctx.db);
    const active = deliveries.active(projectId, itemId);
    let thread = active ? this.store.threadsForItem(projectId, itemId).find(t => !t.archived && t.execution?.deliveryId === active.id) : undefined;
    if (thread && this.activeByThread.has(thread.id)) throw new Error("An agent is already working on this ticket");
    // A CLI the user runs themselves needs no engine plugin here; the thread keeps whatever engine it has.
    const asked = opts.engine && this.answering(opts.engine);
    let engineId = asked && this.engines.has(asked) ? asked : thread?.engine ?? this.answering(this.settingsOf().defaultEngine);
    if (!opts.external) {
      const engine = asked ? this.engines.get(asked) : (thread ? this.engines.get(thread.engine) : [...this.engines.values()].find(e => e.capabilities?.includes("general")));
      if (!engine?.capabilities?.includes("general")) throw new Error("No compatible General execution engine is available");
      const available = await engine.available();
      if (!available.ok) throw new Error(available.reason ?? "The selected engine is unavailable");
      engineId = engine.id;
    }
    await this.refreshProjectPlaybooks(projectId);
    let selected = thread?.execution?.playbook;
    if (!selected || (opts.playbook && opts.playbook !== selected.id)) {
      const id = opts.playbook ?? item.playbookId ?? "task.assist";
      const source = resolvePlaybook({ ...this.playbooks.get(id), project: this.projectPlaybooks.get(projectId)?.get(id) }, this.settingsOf().playbookChoices[id]);
      if (!source) throw new Error(`Unknown playbook ${id}`);
      selected = { id, source: source.entry.source, digest: createHash("sha256").update(JSON.stringify(source.winner)).digest("hex"), body: source.winner.body, requires: source.winner.requires ?? [] };
    }
    const missing = missingPlaybookCapabilities(selected, [...this.executionCapabilities.keys()]);
    if (missing.length) throw new Error(`Missing capabilities: ${missing.join(", ")}`);
    // Re-read after asynchronous preflight; a human may have closed or changed it.
    const latest = items!.get(projectId, itemId);
    if (!latest || latest.version !== item.version) throw new Error("The ticket changed while preparing execution; start again");
    const delivery = deliveries.ensure(projectId, itemId);
    const continued = !!thread;
    const surface = opts.surface ?? "assistant";
    if (!thread) thread = this.newThread(projectId, engineId, item.boardId, { itemId, title: `${item.key} ${item.title}`, surface });
    else {
      if (!opts.external && thread.engine !== engineId) this.setEngine(projectId, thread.id, engineId);
      if (thread.surface !== surface) this.store.touchThread(projectId, thread.id, { surface });
    }
    if (opts.options !== undefined) this.store.touchThread(projectId, thread.id, { options: opts.options });
    this.store.setExecution(projectId, thread.id, { deliveryId: delivery.id, playbook: selected });
    const patch: Patch = {};
    if (item.status === "backlog" || item.status === "todo") patch.status = "doing";
    // The ticket's Method field says what actually runs.
    if (item.playbookId !== selected.id) patch.playbookId = selected.id;
    if (Object.keys(patch).length) items!.update(projectId, itemId, patch, "human");
    const where = await this.workdir(projectId, thread.id, { create: true, revive: true });
    if (!where.cwd) throw new Error(where.problem ?? "no working folder for this delivery");
    const ticket = { key: item.key, title: item.title, body: item.body, waitsOn };
    // A terminal agent gets no system prompt from Tomrade, so whatever an
    // in-app turn would be told has to travel in the brief itself.
    const context: { projectId: string; itemId: string; filesIndex?: string } = { projectId, itemId };
    await this.ctx.parallel("agent/prepare-brief", context);
    const rules = this.rules(projectId);
    const prompt = generalPrompt({ ticket, cwd: where.cwd, playbook: selected, continued, ...(context.filesIndex ? { filesIndex: context.filesIndex } : {}), ...(rules ? { rules } : {}) });
    return { preparation: { threadId: thread.id, continued, engine: engineId, cwd: where.cwd, playbook: selected, opener: generalOpener(ticket, continued), prompt }, item };
  }

  /** Runs in flight right now, across projects — what a quit would interrupt. */
  activeRuns(): { run: RunView; thread: ThreadSummary }[] {
    return [...this.activeById.values()].map((rc) => ({ run: rc.run, thread: rc.thread }));
  }

  setWorkstream(projectId: string, threadId: string, boardId: string | null): ThreadSummary {
    if (this.activeByThread.has(threadId)) throw new Error("a run is in progress on this thread");
    this.store.touchThread(projectId, threadId, { boardId });
    return this.store.thread(projectId, threadId)!;
  }

  archiveThread(projectId: string, threadId: string): boolean {
    if (this.activeByThread.has(threadId)) throw new Error("a run is in progress on this thread");
    if (!this.store.thread(projectId, threadId)) return false;
    this.store.setArchived(projectId, threadId, true);
    return true;
  }

  /** `restored`: a person brought it back by hand, so automatic archiving leaves it alone from now on. */
  unarchiveThread(projectId: string, threadId: string, opts: { restored?: boolean } = {}): boolean {
    if (!this.store.thread(projectId, threadId)) return false;
    this.store.setArchived(projectId, threadId, false, opts);
    return true;
  }

  /**
   * One real turn on the engine, in a thread nobody sees, deleted after: does it answer now? Never part
   * of readiness — it costs the person's quota and a flaky network would lock out an engine that works.
   */
  tryEngine(projectId: string, engineId: string, signal?: AbortSignal): Promise<EngineTry> {
    const running = this.trying.get(engineId);
    if (running) return running;
    const settings = JSON.stringify(this.settingsOf().engines[engineId] ?? null);
    const attempt = this.runTry(projectId, engineId, signal).then((tried) => {
      this.tries.set(engineId, { settings, tried });
      return tried;
    }).finally(() => this.trying.delete(engineId));
    this.trying.set(engineId, attempt);
    return attempt;
  }

  /** The last try, while the engine's settings are the ones it ran with. */
  private triedWith(engineId: string): EngineTry | undefined {
    const last = this.tries.get(engineId);
    return last && last.settings === JSON.stringify(this.settingsOf().engines[engineId] ?? null) ? last.tried : undefined;
  }

  private async runTry(projectId: string, engineId: string, signal?: AbortSignal): Promise<EngineTry> {
    const started = Date.now();
    const out = (rest: Omit<EngineTry, "ms" | "at">): EngineTry => ({ ...rest, ms: Date.now() - started, at: Date.now() });
    const thread = this.newThread(projectId, engineId, null, { surface: "probe", title: "probe" });
    try {
      const { runId } = this.send(projectId, thread.id, { kind: "text", text: this.words().tryAsk });
      const ended = await new Promise<boolean>((resolve) => {
        const done = (value: boolean) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); off(); resolve(value); };
        const off = this.ctx.on("agent/run-ended", (run) => { if (run.id === runId) done(true); });
        const timer = setTimeout(() => done(false), TRY_MS);
        const abort = () => done(false);
        signal?.addEventListener("abort", abort);
        if (this.store.run(projectId, runId)?.status !== "running") done(true);
      });
      if (!ended) {
        this.cancel(runId);
        // let the cancelled run settle before its thread is deleted
        for (let n = 0; n < 50 && this.activeByThread.has(thread.id); n++) await new Promise((resolve) => setTimeout(resolve, 100));
        return out({ ok: false, error: signal?.aborted ? "cancelled" : this.words().tryTimeout(TRY_MS / 1000) });
      }
      const run = this.store.run(projectId, runId);
      const messages = this.store.messages(projectId, thread.id);
      const failure = messages.find((m) => m.block.type === "error")?.block;
      const said = messages.filter((m) => m.role === "agent" && m.block.type === "text").map((m) => (m.block as { text: string }).text).join("\n").trim();
      const reply = said ? { reply: said.length > 200 ? `${said.slice(0, 200)}…` : said } : {};
      if (run?.status === "done" && !failure) return out({ ok: true, ...reply });
      return out({ ok: false, ...reply, error: failure?.type === "error" ? failure.text : (run?.error ?? run?.stop ?? "failed"), ...(failure?.type === "error" && failure.details ? { details: failure.details } : {}) });
    } catch (error) {
      return out({ ok: false, error: message(error) });
    } finally {
      if (!this.activeByThread.has(thread.id)) this.deleteThread(projectId, thread.id);
    }
  }

  deleteThread(projectId: string, threadId: string): boolean {
    if (this.activeByThread.has(threadId)) throw new Error("a run is in progress on this thread");
    if (!this.store.thread(projectId, threadId)) return false;
    this.store.deleteThread(projectId, threadId);
    this.media().removeThread(projectId, threadId);
    return true;
  }

  /**
   * Where the thread's engine works, resolved through the workstream's repository and this machine's checkout of it.
   * Only a run or a Start may `create` a missing worktree; looking never does. A finished thread
   * (archived, or its ticket done) gets its worktree back only through `revive` — a fresh Start.
   */
  async workdir(projectId: string, threadId: string, opts: { create?: boolean; revive?: boolean } = {}): Promise<WorkdirStatus> {
    const none: WorkdirStatus = { cwd: null, remote: null, branch: null, worktree: null, problem: null, code: null };
    const thread = this.store.thread(projectId, threadId);
    if (thread?.execution) {
      this.generalScratch ??= this.ctx.db.config.dir === ":memory:" ? fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-general-")) : path.join(this.ctx.db.config.dir, "general-work");
      const identity = createHash("sha256").update(`${projectId}:${thread.execution.deliveryId}`).digest("hex");
      const cwd = path.join(this.generalScratch, identity);
      fs.mkdirSync(cwd, { recursive: true });
      return { ...none, cwd };
    }
    if (!thread?.boardId) return none;
    const repos = this.ctx.get("repos") as
      | { workdirFor(projectId: string, boardId: string, threadId: string, opts?: { branch?: string | null; create?: boolean }): Promise<{ cwd: string | null; worktree: string | null; branch: string; repo: { remote: string } } | null> }
      | undefined;
    if (!repos) return { ...none, problem: "the repos plugin is not loaded", code: "no-repos" };
    try {
      // A ticket that is done, or no longer there at all, has nothing left to rebuild.
      const ticket = thread.itemId ? this.itemOf(projectId, thread.itemId) : null;
      const finished = thread.archived || (!!thread.itemId && (!ticket || ticket.status === "done"));
      const create = !!opts.create && (!finished || !!opts.revive);
      const view = await repos.workdirFor(projectId, thread.boardId, threadId, { branch: thread.branch, create });
      if (!view) return none;
      if (!view.cwd) {
        // Not there and not made. Unfinished work gets it on its first run; finished work only through a new Start.
        const refused = finished && !thread.archived && !opts.revive;
        const key = ticket?.key ?? thread.title;
        return { ...none, remote: view.repo.remote, branch: view.branch, problem: refused ? this.words().finishedNoWorktree(key) : null, code: refused ? "finished" : null };
      }
      return { cwd: view.cwd, remote: view.repo.remote, branch: view.branch, worktree: view.worktree, problem: null, code: null };
    } catch (err) {
      const remote = (err as { remote?: string }).remote ?? null;
      return { ...none, remote, problem: message(err), code: (err as { name?: string }).name === "CheckoutUnsetError" ? "no-checkout" : "error" };
    }
  }

  setPermissionMode(projectId: string, threadId: string, mode: string): ThreadSummary {
    const thread = this.store.thread(projectId, threadId);
    if (!thread) throw new Error("unknown thread");
    const choices = this.engines.get(thread.engine)?.permissionModes?.choices;
    if (!choices?.some((choice) => choice.value === mode)) throw new Error("Unsupported permission mode");
    this.store.touchThread(projectId, threadId, { permissionMode: mode });
    return this.store.thread(projectId, threadId)!;
  }

  setEngine(projectId: string, threadId: string, asked: string): ThreadSummary {
    const engineId = this.answering(asked);
    if (!this.engines.has(engineId)) throw new Error(`unknown engine ${engineId}`);
    if (this.activeByThread.has(threadId)) throw new Error("a run is in progress on this thread");
    const pending = this.store.pending(projectId, threadId);
    if (pending) {
      // Switching conductors abandons the waiting question; say so in the thread.
      this.store.clearPending(projectId, threadId);
      this.broadcast(threadId, { type: "pending", pending: null });
      this.appendAndBroadcast(projectId, threadId, "system", { type: "note", text: this.words().cancelledWaiting }, null);
    }
    // Overrides belong to the engine they were picked for.
    this.store.touchThread(projectId, threadId, { engine: engineId, permissionMode: null, options: null });
    const thread = this.store.thread(projectId, threadId)!;
    this.appendAndBroadcast(projectId, threadId, "system", { type: "note", text: this.words().engineSwitched(this.engines.get(engineId)?.title ?? engineId) }, null);
    return thread;
  }

  /** Engine knobs for this thread alone — what the Start dialog and the panel's quick picks write. Null puts the engine's settings back in charge. */
  setOptions(projectId: string, threadId: string, options: Record<string, unknown> | null): ThreadSummary {
    const thread = this.store.thread(projectId, threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const engine = this.engines.get(thread.engine);
    if (engine?.options && options) engine.options.parse(this.optionsOf({ ...thread, options }, engine.id));
    this.store.touchThread(projectId, threadId, { options });
    return this.store.thread(projectId, threadId)!;
  }

  /** The session to resume: the engine's own, else one an engine it took in left on the thread. */
  private resumeOf(thread: ThreadSummary, engine: Engine): string | undefined {
    const external = this.store.external(thread.projectId, thread.id);
    return external[engine.id] ?? engine.includes?.map((id) => external[id]).find(Boolean);
  }

  /** The engine's settings with the thread's overrides on top — what a turn runs with. */
  optionsOf(thread: Pick<ThreadSummary, "options">, engineId: string): object {
    const base = this.settingsOf().engines[engineId];
    const saved = base && typeof base === "object" ? (base as Record<string, unknown>) : {};
    const overrides = thread.options;
    // Never undefined: an engine that has never been configured still has object options, which is
    // what its schema expects (each field optional or defaulted).
    if (!overrides || !Object.keys(overrides).length) return saved;
    return { ...saved, ...overrides };
  }

  // ── the turn ───────────────────────────────────────────────────────────────

  private media(): AgentMediaStore {
    this.mediaStore ??= new AgentMediaStore(this.config.mediaDir ?? (this.ctx.db.config.dir === ":memory:"
      ? fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-media-"))
      : path.join(path.dirname(this.ctx.db.config.dir), "agent-media")));
    return this.mediaStore;
  }

  uploadMedia(projectId: string, threadId: string, upload: MediaUpload): MediaRef {
    if (!this.store.thread(projectId, threadId)) throw new Error("Unknown thread");
    return this.media().add(projectId, threadId, upload);
  }

  readMedia(projectId: string, threadId: string, id: string): MediaContent {
    if (!this.store.thread(projectId, threadId)) throw new Error("Unknown thread");
    return this.media().read(projectId, threadId, id);
  }

  /** Providers publish through the platform so MCP and the in-app loop share output. */
  runSignal(runId: string): AbortSignal {
    const rc = this.activeById.get(runId);
    if (!rc) throw new Error("No active run");
    return rc.abort.signal;
  }

  publishMedia(runId: string, upload: MediaUpload, caption?: string, source?: MediaRef): MediaRef {
    const rc = this.activeById.get(runId);
    if (!rc || rc.abort.signal.aborted) throw new Error("No active run");
    const media = this.uploadMedia(rc.projectId, rc.threadId, upload);
    if (source) media.source = this.media().reference(rc.projectId, rc.threadId, source.id);
    this.appendAndBroadcast(rc.projectId, rc.threadId, "agent", { type: "media", media, caption }, runId);
    return media;
  }

  /** A transport retries the same request id without starting a second run, even after restart. */
  send(projectId: string, threadId: string, input: UserInput, delivery?: { requestId: string; source?: Record<string, string> }): { runId: string } {
    const fingerprint = createHash("sha256").update(JSON.stringify([threadId, input, delivery?.source ?? null])).digest("hex");
    if (delivery) {
      if (!delivery.requestId.trim() || delivery.requestId.length > 512) throw new Error("Invalid input request id");
      const receipt = this.store.inputReceipt(projectId, delivery.requestId);
      if (receipt) {
        if (receipt.thread_id !== threadId || receipt.fingerprint !== fingerprint) throw new Error("Input request id already belongs to different input");
        return { runId: receipt.run_id };
      }
    }
    const record = (runId: string) => {
      if (delivery) this.store.recordInput(projectId, delivery.requestId, threadId, fingerprint, runId, delivery.source);
    };
    const thread = this.store.thread(projectId, threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    if (thread.archived && !this.activeByThread.has(threadId)) throw new Error(this.words().archivedReadOnly);
    const ticket = thread.itemId && !thread.execution && !this.activeByThread.has(threadId) ? this.itemOf(projectId, thread.itemId) : null;
    // A done ticket's conversation changes nothing until the ticket is reopened.
    if (ticket?.status === "done") throw new Error(this.words().reopenToContinue(ticket.key));
    if (thread.execution && this.generalTakeovers.has(`${projectId}:${thread.itemId}`)) throw new Error("Human takeover is in progress; wait for the agent to stop");
    const permission = this.permissions.get(threadId);
    if (permission && input.kind === "answer") {
      if (input.questionId !== permission.pending.question.id || typeof input.value !== "string" || !permission.pending.question.options?.includes(input.value)) throw new Error("Invalid or expired permission response");
      const active = this.activeByThread.get(threadId)!;
      const value = input.value;
      const msg = this.store.transaction(projectId, () => {
        const msg = this.store.appendMessage(projectId, threadId, "user", { type: "text", text: value }, active.run.id);
        record(active.run.id);
        return msg;
      });
      this.broadcast(threadId, { type: "message", message: msg });
      permission.answer(value);
      return { runId: active.run.id };
    }
    if (this.activeByThread.has(threadId)) throw new Error("a run is already in progress on this thread");
    if (input.kind === "answer" && this.store.pending(projectId, threadId)?.question.id !== input.questionId) throw new Error("Invalid or expired question response");
    const engine = this.engines.get(thread.engine) ?? [...this.engines.values()].find((e) => !e.terminalOnly);
    if (!engine) throw new Error("No engine installed — enable one in the Plugins sheet");
    if (engine.terminalOnly) throw new Error(`${engine.title} runs only in a terminal — start the ticket "In a terminal", or pick another engine`);

    const text = input.kind === "text" ? input.text : Array.isArray(input.value) ? input.value.join(", ") : input.value;
    const focus = input.kind === "text" && input.focus?.length ? input.focus : undefined;
    if (input.kind === "text" && (input.attachments?.length ?? 0) > 8) throw new Error("Attach at most eight files per message");
    const attachments = input.kind === "text" ? input.attachments?.map(ref => this.media().reference(projectId, threadId, ref.id)) : undefined;
    const accepted = engine.media?.(this.optionsOf(thread, engine.id))?.input ?? [];
    for (const attachment of attachments ?? []) if (!accepted.includes(attachment.mime)) throw new Error(`The selected model/agent does not accept ${attachment.mime}`);
    if (input.kind === "text") input = { ...input, attachments };
    const { msg, run } = this.store.transaction(projectId, () => {
      const msg = this.store.appendMessage(projectId, threadId, "user", { type: "text", text, focus, attachments }, null);
      if (!thread.title) this.store.touchThread(projectId, threadId, { title: text.slice(0, 60) });
      const run = this.store.beginRun(projectId, threadId, engine.id);
      record(run.id);
      return { msg, run };
    });
    // Notify and execute only after the input, run and receipt committed together.
    this.broadcast(threadId, { type: "message", message: msg });
    const tries = this.resuming.get(threadId);
    this.resuming.delete(threadId);
    this.clearPark(projectId, threadId);

    if (tries !== undefined) this.limitTries.set(run.id, tries);
    const rc = this.makeRunCtx(run, thread, engine);
    this.activeByThread.set(threadId, rc);
    this.activeById.set(run.id, rc);
    this.broadcast(threadId, { type: "run", run });
    this.ctx.emit("agent/run-started", run, thread);
    void this.drive(rc, input);
    return { runId: run.id };
  }

  /** A message for the running turn: held until the engine reaches a point where the model reads it. */
  async steer(projectId: string, threadId: string, steerId: string, text: string): Promise<boolean> {
    const rc = this.activeByThread.get(threadId);
    if (!rc || rc.projectId !== projectId || !rc.engine.steers || rc.abort.signal.aborted || !text.trim()) return false;
    const steer = { id: steerId, text: text.trim() };
    rc.steers.push(steer);
    if (!rc.forward) return true;
    const taken = await rc.forward(steer).catch(() => false);
    const at = rc.steers.indexOf(steer);
    if (!taken && at >= 0) rc.steers.splice(at, 1);
    return taken;
  }

  /** Stop a suspended question without starting an engine just to clear it. */
  cancelWaiting(projectId: string, threadId: string): boolean {
    if (this.activeByThread.has(threadId) || !this.store.pending(projectId, threadId)) return false;
    this.store.clearPending(projectId, threadId);
    this.appendAndBroadcast(projectId, threadId, "system", { type: "note", text: this.words().stopped }, null);
    this.broadcast(threadId, { type: "pending", pending: null });
    return true;
  }

  cancel(runId: string): boolean {
    const rc = this.activeById.get(runId);
    if (rc) {
      rc.abort.abort();
      return true;
    }
    // No in-memory RunCtx — e.g. the process restarted since this run began.
    // Reconcile directly against the DB row so the button isn't a silent no-op.
    const projectId = this.store.projectOfRun(runId);
    const run = projectId ? this.store.run(projectId, runId) : null;
    if (!projectId || !run || run.status !== "running") return false;
    const changes = this.store.changesOf(projectId, runId) + this.ctx.oplog.runChanges(projectId, runId).length;
    const view = this.store.endRun(projectId, runId, { status: "cancelled", stop: "cancelled", error: "Interrupted — no active process to cancel.", changes });
    this.broadcast(run.threadId, { type: "done", run: view });
    return true;
  }

  revert(projectId: string, runId: string): UndoRunResult {
    const run = this.store.run(projectId, runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (this.activeById.has(runId)) throw new Error("that run is still going — stop it first");
    if (run.reverted) return { reverted: 0, kept: [] };
    const result = this.ctx.oplog.undoRun(projectId, runId);
    const view = this.store.markReverted(projectId, runId, result.kept.length);
    const kept = result.kept.length ? { labels: result.kept.map((k) => k.label).join(", "), reason: result.kept[0].reason } : null;
    this.appendAndBroadcast(projectId, run.threadId, "system", { type: "note", text: this.words().reverted(result.reverted, kept) }, runId);
    this.broadcast(run.threadId, { type: "run", run: view });
    return result;
  }

  /** Set or update a card (the dossier is one). Emits both the live card and a block in the stream the first time. */
  setCard(runId: string, card: { id: string; schema: string; title: string; data: unknown }): CardView {
    const rc = this.activeById.get(runId);
    if (!rc) throw new Error("no active run");
    const before = this.store.cards(rc.projectId, rc.threadId).find((c) => c.id === card.id);
    const view = this.store.setCard(rc.projectId, rc.threadId, card, rc.engine.author);
    if (!before) this.appendAndBroadcast(rc.projectId, rc.threadId, "agent", { type: "card", id: card.id, schema: card.schema, title: card.title, data: card.data }, runId);
    this.broadcast(rc.threadId, { type: "card", card: view });
    return view;
  }

  brief(projectId: string): string | null {
    return this.store.brief(projectId);
  }

  /** The words the platform writes into a conversation, in the person's language now. */
  private words(): AgentWords {
    return AGENT_WORDS[(this.ctx.get("settings") as { locale?: () => "en" | "zh" } | undefined)?.locale?.() ?? "en"];
  }

  private makeRunCtx(run: RunView, thread: ThreadSummary, engine: Engine): RunCtx {
    const abort = new AbortController();
    // The wall clock bounds the agent, not the person: it stops while a permission question waits.
    const wall = { left: thread.itemId ? this.config.codeMaxWallMs : this.config.maxWallMs, since: Date.now(), timer: undefined as NodeJS.Timeout | undefined };
    const clock = { timedOut: false, limitMs: wall.left };
    const partial = { text: "" };
    const steers: RunCtx["steers"] = [];
    const runClock = () => { wall.since = Date.now(); wall.timer = setTimeout(() => { clock.timedOut = true; abort.abort(); }, Math.max(0, wall.left)); };
    const holdClock = () => { clearTimeout(wall.timer); wall.left -= Date.now() - wall.since; };
    runClock();
    abort.signal.addEventListener("abort", () => clearTimeout(wall.timer));
    const entries: LedgerEntry[] = [];
    const handle: RunHandle = {
      id: run.id,
      threadId: thread.id,
      projectId: thread.projectId,
      author: engine.author,
      ledger: { all: () => [...entries], find: (pred) => entries.find(pred) },
      waivers: this.store.waivers(thread.projectId, thread.id),
      scratch: new Map()
    };
    // A stretch of failed model requests: live on the working line while it lasts, one stored row once it ends.
    let retrying: (RetryState & { since: number; first: number }) | null = null;
    const settleRetry = (recovered: boolean) => {
      if (!retrying) return;
      const { attempt, max, reason, first } = retrying;
      retrying = null;
      this.appendAndBroadcast(thread.projectId, thread.id, "agent", { type: "retry", attempts: attempt, ...(max ? { max } : {}), reason, ms: Date.now() - first, recovered }, run.id);
      progress({});
    };
    const emit = (block: Block) => {
      // anything the model said or did means a request went through; an error means the retries ran out
      if (block.type === "error") settleRetry(false);
      else if (block.type !== "note" && block.type !== "status" && block.type !== "changes") settleRetry(true);
      // the engine kept what it streamed; nothing is left to rescue
      if (block.type === "text") partial.text = "";
      this.appendAndBroadcast(thread.projectId, thread.id, block.type === "note" ? "system" : "agent", block, run.id);
    };
    const startedAt = performance.now();
    // Engines report authoritative counters when they have them; between reports the streamed text is a
    // conservative estimate of the reply, and every event carries the latest figure so the live line never blanks.
    let reported = { inputTokens: 0, outputTokens: 0 };
    let streamedSinceReport = 0;
    const progress = (p: { activity?: string | null; usage?: { inputTokens: number; outputTokens: number } }) => {
      if (p.usage) {
        reported = p.usage;
        streamedSinceReport = 0;
      }
      const usage = { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens + Math.ceil(streamedSinceReport / 4) };
      const retry = retrying ? { attempt: retrying.attempt, ...(retrying.max ? { max: retrying.max } : {}), reason: retrying.reason, ...(retrying.delayMs !== undefined ? { delayMs: retrying.delayMs } : {}), since: retrying.since } : null;
      this.broadcast(thread.id, { type: "progress", runId: run.id, elapsedMs: Math.round(performance.now() - startedAt), ...p, retry, usage });
    };
    progress({});
    const requestPermission: NonNullable<TurnIO["requestPermission"]> = (text, options, signal) => {
      const previous = this.permissionQueues.get(thread.id) ?? Promise.resolve();
      const request = previous.catch(() => {}).then(() => new Promise<string | null>((resolve) => {
        if (abort.signal.aborted || signal?.aborted) { resolve(null); return; }
        const pending: PendingView = { threadId: thread.id, kind: "permission", workflow: null, accepts: "options",
          question: { id: randomUUID(), text, options, freeText: false } };
        const cancel = () => answer(null);
        let held = true;
        holdClock();
        const answer = (value: string | null) => {
          abort.signal.removeEventListener("abort", cancel);
          signal?.removeEventListener("abort", cancel);
          if (held && !abort.signal.aborted) runClock();
          held = false;
          if (this.permissions.get(thread.id)?.pending.question.id === pending.question.id) {
            this.permissions.delete(thread.id);
            const durable = this.store.pending(thread.projectId, thread.id);
            this.broadcast(thread.id, { type: "pending", pending: durable ? this.pendingView(durable) : null });
          }
          resolve(value);
        };
        this.permissions.set(thread.id, { pending, answer });
        abort.signal.addEventListener("abort", cancel, { once: true });
        signal?.addEventListener("abort", cancel, { once: true });
        emit({ type: "question", ...pending.question });
        this.broadcast(thread.id, { type: "pending", pending });
      }));
      this.permissionQueues.set(thread.id, request);
      void request.finally(() => { if (this.permissionQueues.get(thread.id) === request) this.permissionQueues.delete(thread.id); });
      return request;
    };
    const tools = {
      describe: () => this.ctx.tools.describe().filter((tool) => {
        const surface = this.ctx.tools.get(tool.name)?.surface;
        return (!surface || surface === thread.surface) && (engine.literal || !this.workflows.get(tool.name)?.literal);
      }),
      execute: async (name: string, args: unknown): Promise<unknown> => {
        const t0 = Date.now();
        settleRetry(true);
        progress({ activity: name });
        try {
          const result = await this.ctx.tools.execute(name, args, { by: engine.author, projectId: thread.projectId, run: handle, signal: abort.signal, ask: (text, options) => requestPermission(text, options) });
          const ms = Date.now() - t0;
          const suspended = isSuspended(result);
          const summary = suspended ? "waiting for the user" : summarize(result);
          entries.push({ seq: entries.length + 1, tool: name, args, ok: true, summary, ms });
          this.store.appendLedger(thread.projectId, run.id, entries.length, name, args, true, summary, ms);
          progress({ activity: null });
          if (!suspended) emit({ type: "trace", tool: name, args, ok: true, summary, ms });
          return result;
        } catch (err) {
          const ms = Date.now() - t0;
          const summary = message(err);
          entries.push({ seq: entries.length + 1, tool: name, args, ok: false, summary, ms });
          this.store.appendLedger(thread.projectId, run.id, entries.length, name, args, false, summary, ms);
          progress({ activity: null });
          emit({ type: "trace", tool: name, args, ok: false, summary, ms });
          throw err;
        }
      }
    };
    const llm = (this.ctx.get("llm") as LlmService | undefined) ?? null;
    const io: TurnIO = {
      media: {
        read: id => this.readMedia(thread.projectId, thread.id, id),
        path: id => this.media().localPath(thread.projectId, thread.id, id),
        publish: (upload, caption) => this.publishMedia(run.id, upload, caption)
      },
      emit,
      permissionMode: (mode) => { handle.scratch.set("permissionMode", mode); this.broadcast(thread.id, { type: "permission-mode", mode }); },
      requestPermission,
      delta: (text) => {
        settleRetry(true);
        partial.text += text;
        streamedSinceReport += text.length;
        this.broadcast(thread.id, { type: "delta", runId: run.id, text });
        progress({});
      },
      progress: (usage) => progress({ usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } }),
      activity: (label) => {
        if (label) settleRetry(true);
        progress({ activity: label });
      },
      retry: (state) => {
        if (!state) return settleRetry(true);
        retrying = { ...state, since: Date.now(), first: retrying?.first ?? Date.now() };
        progress({});
      },
      tools,
      playbooks: { index: () => this.playbookIndex(thread.projectId), open: (id) => this.openPlaybook(id, thread.projectId) },
      workflows: {
        list: () =>
          [...this.workflows.values()].map((spec) => ({
            id: spec.id,
            title: spec.title,
            description: spec.description,
            canStartEmpty: (spec.input as z.ZodType).safeParse({}).success
          }))
      },
      llm,
      run: handle,
      signal: abort.signal,
      resume: this.resumeOf(thread, engine),
      recap: () => conversationRecap(this.store.messages(thread.projectId, thread.id)),
      takeSteers: () => {
        if (abort.signal.aborted) return [];
        const taken = steers.splice(0);
        for (const s of taken) this.appendAndBroadcast(thread.projectId, thread.id, "user", { type: "text", text: s.text, steerId: s.id }, run.id);
        return taken.map((s) => s.text);
      },
      steerTo: (forward) => { rc.forward = forward; },
      steered: (id) => {
        const at = steers.findIndex((s) => s.id === id);
        if (at < 0) return;
        const [s] = steers.splice(at, 1);
        this.appendAndBroadcast(thread.projectId, thread.id, "user", { type: "text", text: s.text, steerId: s.id }, run.id);
      }
    };
    const rc: RunCtx = { run, thread, threadId: thread.id, projectId: thread.projectId, engine, abort, handle, entries, io, wio: { emit, tools, llm, run: handle, signal: abort.signal, activity: (label) => io.activity?.(label) }, partial, clock, settleRetry, steers, forward: null };
    return rc;
  }

  private itemOf(projectId: string, itemId: string): Item | null {
    return (this.ctx.get("items") as { get(projectId: string, id: string): Item | null } | undefined)?.get(projectId, itemId) ?? null;
  }

  /** The ticket a code thread implements, as the engine should hear about it. */
  private ticketOf(thread: ThreadSummary): TurnInput["ticket"] {
    if (!thread.itemId) return undefined;
    const items = this.ctx.get("items") as { get(projectId: string, id: string): Item | null } | undefined;
    const item = items?.get(thread.projectId, thread.itemId);
    return item ? { id: item.id, key: item.key, title: item.title, branch: thread.branch, workType: item.workType, body: item.body, waitsOn: this.waitsOn(thread.projectId, item) } : undefined;
  }

  /** Open dependencies are the human's call at Start; once work is under way they are what the agent is told, not a reason to stop it. */
  private waitsOn(projectId: string, item: Item): OpenDependency[] {
    const items = this.ctx.get("items") as { get(projectId: string, id: string): Item | null } | undefined;
    return item.blockedBy.flatMap((id) => {
      const dependency = items?.get(projectId, id);
      return dependency && dependency.status !== "done" && dependency.status !== "cancelled" ? [{ key: dependency.key, title: dependency.title, status: dependency.status }] : [];
    });
  }

  private async drive(rc: RunCtx, input: UserInput): Promise<void> {
    let result: TurnResult | null = null;
    try {
      const routed = await this.routePending(rc, input);
      if (routed === "suspended") {
        result = { stop: "asked" };
        return;
      }
      await this.refreshProjectPlaybooks(rc.projectId);
      if (!rc.thread.execution && this.ticketOf(rc.thread)?.workType === "general") throw new Error("Start General work from the ticket to bind its delivery and playbook before executing");
      if (rc.thread.execution) {
        const ticket = this.ticketOf(rc.thread);
        const items = this.ctx.get("items") as { get(projectId: string, id: string): Item | null } | undefined;
        const currentItem = items?.get(rc.projectId, rc.thread.itemId!);
        if (!currentItem || currentItem.humanLocked || currentItem.status === "done" || currentItem.status === "cancelled") throw new Error("The ticket is closed, missing, or human-locked");
        const active = new DeliveryStore(this.ctx.db).active(rc.projectId, rc.thread.itemId!);
        if (!ticket || ticket.workType !== "general" || active?.id !== rc.thread.execution.deliveryId) throw new Error("This thread no longer belongs to an active General delivery");
        if (!rc.engine.capabilities?.includes("general")) throw new Error("This engine cannot execute General work");
        const missing = missingPlaybookCapabilities(rc.thread.execution.playbook, [...this.executionCapabilities.keys()]);
        if (missing.length) throw new Error(`Missing capabilities: ${missing.join(", ")}`);
      }
      const engineOptions = this.optionsOf(rc.thread, rc.engine.id);
      const pending = this.store.pending(rc.projectId, rc.threadId);
      // A thread on a workstream runs where that workstream's code is; a missing checkout stops the run before the engine starts.
      const where = await this.workdir(rc.projectId, rc.threadId, { create: true });
      if (where.problem) throw new Error(where.problem);
      const modes = rc.engine.permissionModes;
      const selectedMode = modes ? rc.thread.permissionMode ?? (rc.thread.itemId ? modes.default : modes.mainDefault ?? modes.default) : undefined;
      if (selectedMode) rc.io.permissionMode?.(selectedMode);
      const project = (this.ctx.get("projects") as { get(id: string): { name: string; keyPrefix: string } | null } | undefined)?.get(rc.projectId);
      const rules = this.rules(rc.projectId);
      const turnInput: TurnInput = {
        threadId: rc.threadId,
        projectId: rc.projectId,
        ...(project ? { project: { name: project.name, keyPrefix: project.keyPrefix } } : {}),
        purpose: rc.thread.execution ? "general" : rc.thread.itemId ? "code" : "backlog",
        execution: rc.thread.execution ?? undefined,
        permissionMode: selectedMode,
        ticket: this.ticketOf(rc.thread),
        input,
        ...(rules ? { rules } : {}),
        messages: this.store.messages(rc.projectId, rc.threadId),
        cards: this.store.cards(rc.projectId, rc.threadId),
        brief: this.store.brief(rc.projectId),
        pending: pending ? this.pendingView(pending) : null,
        focus: input.kind === "text" && input.focus?.length ? input.focus : undefined,
        options: rc.engine.options && engineOptions !== undefined ? rc.engine.options.parse(engineOptions) : engineOptions,
        ...(where.cwd ? { cwd: where.cwd } : {}),
        ...(where.remote && where.branch ? { workdir: { remote: where.remote, branch: where.branch, worktree: where.worktree } } : {})
      };
      await this.ctx.parallel("agent/prepare-turn", turnInput);
      rc.handle.cwd = turnInput.cwd;
      rc.handle.env = turnInput.env;
      if (turnInput.cwd && turnInput.purpose !== "backlog") rc.io.run.scratch.set("mediaWorkdir", turnInput.cwd);
      result = await rc.engine.turn(turnInput, rc.io);
      if (result.lostSession && rc.io.resume && !rc.abort.signal.aborted) {
        // Its session is gone (another config folder, cleared history): rather than failing every
        // message on the same dead id, run the turn again in a new session with the conversation carried in.
        this.store.setExternal(rc.projectId, rc.threadId, rc.engine.id, null);
        this.appendAndBroadcast(rc.projectId, rc.threadId, "system", { type: "note", text: this.words().sessionLost(rc.engine.title) }, rc.run.id);
        rc.io.resume = undefined;
        result = await rc.engine.turn(turnInput, rc.io);
      }
      if (result.resume) this.store.setExternal(rc.projectId, rc.threadId, rc.engine.id, result.resume);
      // Engines may return normally while handling an interrupt. Cancellation
      // remains authoritative even when the adapter reports a successful end.
      if (rc.abort.signal.aborted) result = { ...result, stop: "cancelled" };
    } catch (err) {
      if (rc.abort.signal.aborted) {
        result = { stop: "cancelled" };
      } else {
        result = { stop: "error", error: message(err), details: describeFailure({ error: err }) };
      }
    } finally {
      rc.settleRetry(result?.stop !== "error" && result?.stop !== "cancelled" && !!result);
      this.finish(rc, await this.runFollowUps(rc, result ?? { stop: "error", error: "engine returned nothing" }));
    }
  }

  /** The turn is over but the run is not: follow-ups may still write into it, or end it on a question. */
  private async runFollowUps(rc: RunCtx, result: TurnResult): Promise<TurnResult> {
    let canAsk = result.stop === "end" && !rc.abort.signal.aborted && !this.store.pending(rc.projectId, rc.threadId);
    for (const followUp of this.followUps.values()) {
      if (rc.abort.signal.aborted) break;
      try {
        const start = await followUp.after({ projectId: rc.projectId, threadId: rc.threadId, runId: rc.run.id, canAsk });
        const spec = start && canAsk ? this.workflows.get(start.workflow) : undefined;
        if (!spec) continue;
        const outcome = await this.asRun(rc, () => this.startWorkflow(spec, spec.input.parse(start!.args ?? {}), rc));
        if (isSuspended(outcome)) {
          result = { ...result, stop: "asked" };
          canAsk = false;
        }
      } catch (err) {
        if (!rc.abort.signal.aborted) this.ctx.logger.warn(`follow-up ${followUp.id} failed: ${message(err)}`);
      }
    }
    // A stop while a follow-up still worked ends the run as stopped, not as the turn's own ending.
    return rc.abort.signal.aborted && result.stop !== "error" ? { ...result, stop: "cancelled" } : result;
  }

  /** Writes a workflow makes outside a tool call still belong to the run, so they count and revert with it. */
  private asRun<T>(rc: RunCtx, work: () => Promise<T>): Promise<T> {
    return writeContext.run({ runId: rc.run.id, author: rc.engine.author }, work);
  }

  /**
   * On-script input goes straight back into the thing that asked: a suspended
   * workflow resumes deterministically, an engine's own question is simply
   * cleared so the engine reads the answer. Off-script input leaves the
   * question standing and hands the turn to the engine, which sees it in
   * `TurnInput.pending` and holds resume_workflow / cancel_workflow.
   */
  private async routePending(rc: RunCtx, input: UserInput): Promise<"engine" | "suspended"> {
    const pending = this.store.pending(rc.projectId, rc.threadId);
    if (!pending) return "engine";
    const value = input.kind === "answer" ? input.value : input.kind === "text" ? input.text : "";
    const values = Array.isArray(value) ? value : [value];
    const explicit = input.kind === "answer" && input.questionId === pending.question.id;
    // Typed text is an answer only to an engine that cannot judge it; a model tells an answer from an instruction that moves on.
    const onScript = explicit || (pending.accepts === "text" && !!rc.engine.literal) || values.every((v) => pending.question.options?.includes(v));

    if (pending.waiveRule && values.some((v) => pending.waiveOn.includes(v))) this.store.addWaiver(rc.projectId, rc.threadId, pending.waiveRule);

    if (pending.kind === "ask") {
      // The engine asked; whatever came back is its answer.
      this.store.clearPending(rc.projectId, rc.threadId);
      this.broadcast(rc.threadId, { type: "pending", pending: null });
      return "engine";
    }
    if (!onScript) return "engine";

    this.store.clearPending(rc.projectId, rc.threadId);
    this.broadcast(rc.threadId, { type: "pending", pending: null });
    const spec = this.workflows.get(pending.workflow!);
    if (!spec) {
      this.appendAndBroadcast(rc.projectId, rc.threadId, "system", { type: "note", text: this.words().workflowGone(pending.workflow ?? "") }, rc.run.id);
      return "engine";
    }
    const outcome = await this.asRun(rc, () => this.driveWorkflow(spec, pending.step!, spec.state.parse(pending.state), value, rc));
    return isSuspended(outcome) ? "suspended" : "engine";
  }

  private startWorkflow(spec: WorkflowSpec, args: unknown, rc: RunCtx): Promise<unknown> {
    return (async () => {
      const state: unknown = await spec.start(args, rc.wio);
      return this.driveWorkflow(spec, spec.entry, state, undefined, rc);
    })();
  }

  /** Control is code while a workflow runs: steps transition, ask, or finish; asks persist and suspend. */
  private async driveWorkflow(spec: WorkflowSpec, step: string, state: unknown, answer: string | string[] | undefined, rc: RunCtx): Promise<unknown> {
    for (let guard = 0; guard < 200; guard += 1) {
      const fn = spec.steps[step];
      if (!fn) throw new Error(`workflow ${spec.id} has no step "${step}"`);
      const transition = await fn(state, rc.wio, answer);
      answer = undefined;
      if ("done" in transition) return transition.done;
      state = transition.state;
      if ("ask" in transition) {
        const question = { id: randomUUID(), ...transition.ask };
        this.store.setPending(rc.projectId, rc.threadId, {
          kind: "workflow",
          workflow: spec.id,
          step,
          state,
          question,
          accepts: spec.accepts ?? "text",
          waiveRule: null,
          waiveOn: []
        });
        this.appendAndBroadcast(rc.projectId, rc.threadId, "agent", { type: "question", ...question }, rc.run.id);
        this.broadcast(rc.threadId, { type: "pending", pending: this.pendingView(this.store.pending(rc.projectId, rc.threadId)!) });
        const suspended: Suspended = { __suspended: true, question, note: "Question posted to the user. End your turn and wait for the reply." };
        return suspended;
      }
      step = transition.next;
    }
    throw new Error(`workflow ${spec.id} did not finish within 200 steps`);
  }

  private finish(rc: RunCtx, result: TurnResult): void {
    rc.abort.abort();
    this.activeByThread.delete(rc.threadId);
    this.activeById.delete(rc.run.id);
    // A run cut short keeps what it had already said, marked as unfinished, and says why it ended.
    if ((result.stop === "cancelled" || result.stop === "error") && rc.partial.text.trim()) {
      this.appendAndBroadcast(rc.projectId, rc.threadId, "agent", { type: "text", text: `${rc.partial.text.trim()} …` }, rc.run.id);
    }
    if (result.stop === "cancelled") {
      const w = this.words();
      this.appendAndBroadcast(rc.projectId, rc.threadId, "system", { type: "note", text: rc.clock.timedOut ? w.timeLimit(rc.clock.limitMs) : w.stopped }, rc.run.id);
    }
    if (result.stop === "budget") {
      this.appendAndBroadcast(rc.projectId, rc.threadId, "system", { type: "note", text: this.words().budget }, rc.run.id);
    }
    if (result.stop === "error") {
      const raw = result.error ?? "The engine stopped without an error message.";
      const text = readableError(raw);
      // The provider's full body stays under details when the line keeps only its message.
      const details = text === raw ? result.details : [describeFailure({ error: raw }), result.details].filter(Boolean).join("\n\n");
      this.appendAndBroadcast(rc.projectId, rc.threadId, "agent", { type: "error", text: redactSecrets(text), ...(details ? { details } : {}) }, rc.run.id);
    }
    // Settings and anything else an undo provider tracks by run count too, and go with the run's Undo.
    const elsewhere = this.ctx.oplog.runChanges(rc.projectId, rc.run.id);
    const changes = this.store.changesOf(rc.projectId, rc.run.id) + elsewhere.length;
    if (changes > 0) {
      this.appendAndBroadcast(rc.projectId, rc.threadId, "agent", { type: "changes", runId: rc.run.id, count: changes, items: [...this.store.changedEntities(rc.projectId, rc.run.id), ...elsewhere] }, rc.run.id);
    }
    const status = result.stop === "asked" ? "asked" : result.stop === "cancelled" ? "cancelled" : result.stop === "error" ? "error" : "done";
    const tries = this.limitTries.get(rc.run.id) ?? 0;
    this.limitTries.delete(rc.run.id);
    const limit = status === "error" && (result.limit || looksRateLimited(result.error)) ? { until: result.limit?.until ?? resetTime(result.error) } : null;
    const park = limit ? this.park(rc.projectId, rc.threadId, { until: limit.until, runId: rc.run.id, attempt: tries + 1 }) : null;
    const run = this.store.endRun(rc.projectId, rc.run.id, { status, stop: result.stop, error: result.error, usage: result.usage, metrics: result.metrics, costUsd: result.costUsd, changes });
    this.broadcast(rc.threadId, { type: "done", run });
    const thread = this.store.thread(rc.projectId, rc.threadId) ?? rc.thread;
    if (park) this.ctx.emit("agent/parked", park, thread);
    this.ctx.emit("agent/run-ended", run, thread);
  }

  /** The thread waiting for a usage limit to lift, if it is. */
  parked(projectId: string, threadId: string): ParkView | null {
    return this.store.parked(projectId, threadId);
  }

  /**
   * Holds a thread until a usage limit lifts: the conversation says so, and at
   * `until` Tomrade continues it — or, when it cannot (a terminal session, the
   * setting off, too many limited runs in a row), says the person can.
   */
  park(projectId: string, threadId: string, limit: { until: number | null; runId?: string | null; attempt?: number; resume?: boolean; /** A terminal session's thread holds no conversation to write into. */ note?: boolean }): ParkView {
    const attempt = limit.attempt ?? (this.store.parked(projectId, threadId)?.attempt ?? 0) + 1;
    const park: ParkView = {
      threadId,
      runId: limit.runId ?? null,
      until: limit.until ?? Date.now() + LIMIT_RETRY_MS,
      known: limit.until !== null,
      resume: (limit.resume ?? true) && this.settingsOf().resumeAfterLimit !== false && attempt <= LIMIT_TRIES,
      attempt
    };
    this.store.park(projectId, park);
    this.armPark(projectId, park);
    if (limit.note === false) return park;
    const w = this.words();
    const locale = (this.ctx.get("settings") as { locale?: () => "en" | "zh" } | undefined)?.locale?.() ?? "en";
    const said = attempt > LIMIT_TRIES && (limit.resume ?? true) ? w.limitGaveUp(LIMIT_TRIES) : w.limited(untilLabel(park.until, locale), park.known, park.resume);
    this.appendAndBroadcast(projectId, threadId, "system", { type: "note", text: said }, park.runId);
    return park;
  }

  /** Someone continued the thread another way — a terminal session resumed by hand. */
  unpark(projectId: string, threadId: string): void {
    if (this.parkTimers.has(threadId) || this.store.parked(projectId, threadId)) this.clearPark(projectId, threadId);
  }

  private clearPark(projectId: string, threadId: string): void {
    clearTimeout(this.parkTimers.get(threadId));
    this.parkTimers.delete(threadId);
    this.store.unpark(projectId, threadId);
  }

  private armParked(projectId: string): void {
    for (const park of this.store.allParked(projectId)) this.armPark(projectId, park);
  }

  private armPark(projectId: string, park: ParkView): void {
    clearTimeout(this.parkTimers.get(park.threadId));
    const delay = Math.max(0, park.until - Date.now()) + LIMIT_SLACK_MS;
    this.parkTimers.set(park.threadId, setTimeout(() => this.liftPark(projectId, park.threadId), delay));
  }

  private liftPark(projectId: string, threadId: string): void {
    this.parkTimers.delete(threadId);
    if (!this.ctx.db.openIds().includes(projectId)) return;
    const park = this.store.parked(projectId, threadId);
    if (!park) return;
    this.store.unpark(projectId, threadId);
    const thread = this.store.thread(projectId, threadId);
    if (!thread || this.activeByThread.has(threadId)) return;
    if (park.resume && this.settingsOf().resumeAfterLimit !== false) {
      this.resuming.set(threadId, park.attempt);
      try {
        this.send(projectId, threadId, { kind: "text", text: this.words().continueAfterLimit });
        return;
      } catch (err) {
        this.resuming.delete(threadId);
        this.appendAndBroadcast(projectId, threadId, "system", { type: "note", text: message(err) }, null);
      }
    }
    this.ctx.emit("agent/limit-lifted", { ...park, resume: false }, thread);
  }

  private appendAndBroadcast(projectId: string, threadId: string, role: ThreadMessage["role"], block: Block, runId: string | null): ThreadMessage {
    const msg = this.store.appendMessage(projectId, threadId, role, block, runId);
    this.broadcast(threadId, { type: "message", message: msg });
    return msg;
  }

  private broadcast(threadId: string, event: AgentEvent): void {
    this.ctx.emit("agent/event", threadId, event);
    this.ctx.get("ipc")?.send("agent.event", threadId, event);
  }

  // ── platform tools ─────────────────────────────────────────────────────────

  private registerPlatformTools(): void {
    this.ctx.tools.register(defineTool({
      name: "read_media_source", title: "Read a diagram source",
      description: "Read a conversation's JSON diagram source by media ID. Returns a bounded text page with nextOffset; concatenate pages for the complete JSON before editing.",
      input: z.object({ id: z.string(), offset: z.number().int().nonnegative().default(0) }),
      execute: ({ id, offset }, inv) => {
        if (!inv.run) throw new Error("Requires an active conversation");
        const content = this.readMedia(inv.run.projectId, inv.run.threadId, id);
        if (content.mime !== "application/json") throw new Error("This media is not a diagram source");
        const text = Buffer.from(content.base64, "base64").toString("utf8");
        return { id, text: text.slice(offset, offset + 1800), nextOffset: offset + 1800 < text.length ? offset + 1800 : null };
      }
    }));
    this.ctx.tools.register(defineTool({
      name: "display_media", title: "Display generated media",
      description: "Display an image, HTML diagram, audio, video or PDF generated in this local agent's working directory. The user can preview, download or save it to Files. Only files within the current execution directory are accepted.",
      input: z.object({ path: z.string(), mime: z.string(), caption: z.string().optional() }),
      execute: ({ path: filename, mime, caption }, inv) => {
        const rc = inv.run && this.activeById.get(inv.run.id);
        const directory = rc?.io.run.scratch.get("mediaWorkdir");
        if (!rc || typeof directory !== "string") throw new Error("This engine has no local media working directory; use a rendering tool instead");
        const root = fs.realpathSync(directory);
        const file = fs.realpathSync(path.resolve(root, filename));
        const relative = path.relative(root, file);
        if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) throw new Error("Media must be inside the execution directory");
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Not a supported media file or larger than 32 MiB");
        return this.publishMedia(rc.run.id, { name: path.basename(file), mime, base64: fs.readFileSync(file).toString("base64") }, caption);
      }
    }));
    this.ctx.tools.register(
      defineTool({
        name: "ask_user",
        title: "Ask the user",
        description:
          "Ask the user a question, optionally with options rendered as buttons. The question is posted and your turn ends; the reply arrives as the next user message. Set multiple: true whenever the options are combinable (the user then picks any subset and confirms). Set waiveRule/waiveOn to record an explicit rule waiver when the user picks one of those options.",
        input: z.object({
          question: z.string().min(1),
          options: z.array(z.string()).optional(),
          multiple: z.boolean().optional(),
          freeText: z.boolean().optional(),
          waiveRule: z.string().optional(),
          waiveOn: z.array(z.string()).optional()
        }),
        execute: (args, inv) => {
          if (!inv.run) throw new Error("ask_user runs inside an assistant thread");
          const rc = this.activeById.get(inv.run.id);
          if (!rc) throw new Error("no active run");
          if (this.store.pending(rc.projectId, rc.threadId)) throw new Error("another question is already waiting");
          const question = { id: randomUUID(), text: args.question, options: args.options, multiple: args.multiple, freeText: args.freeText };
          this.store.setPending(rc.projectId, rc.threadId, {
            kind: "ask",
            workflow: null,
            step: null,
            state: null,
            question,
            accepts: "text",
            waiveRule: args.waiveRule ?? null,
            waiveOn: args.waiveOn ?? []
          });
          this.appendAndBroadcast(rc.projectId, rc.threadId, "agent", { type: "question", ...question }, rc.run.id);
          this.broadcast(rc.threadId, { type: "pending", pending: this.pendingView(this.store.pending(rc.projectId, rc.threadId)!) });
          const suspended: Suspended = { __suspended: true, question, note: "Question posted to the user. End your turn and wait for the reply." };
          return suspended;
        }
      })
    );

    this.ctx.tools.register(
      defineTool({
        name: "open_playbook",
        title: "Open a playbook",
        description: "Load the full body of one playbook from the index into view.",
        input: z.object({ id: z.string().min(1) }),
        whole: true,
        execute: ({ id }, inv) => {
          const source = resolvePlaybook({ ...this.playbooks.get(id), project: inv.projectId ? this.projectPlaybooks.get(inv.projectId)?.get(id) : undefined }, this.settingsOf().playbookChoices[id]);
          if (!source) throw new Error(`unknown playbook "${id}" — available: ${this.playbookIndex(inv.projectId).map((e) => e.id).join(", ") || "(none)"}`);
          const snapshot = { id, source: source.entry.source, digest: createHash("sha256").update(JSON.stringify(source.winner)).digest("hex"), body: source.winner.body, requires: source.winner.requires ?? [] };
          const missing = missingPlaybookCapabilities(snapshot, [...this.executionCapabilities.keys()]);
          if (missing.length) throw new Error(`Missing capabilities: ${missing.join(", ")}`);
          if (inv.projectId && inv.run) this.store.recordPlaybook(inv.projectId, inv.run.id, snapshot);
          return snapshot;
        }
      })
    );

    this.ctx.tools.register(
      defineTool({
        name: "update_project_brief",
        title: "Update the project brief",
        description: "Rewrite the agent-maintained project memory: what this product is, its conventions, its main epics. Injected into every future run.",
        input: z.object({ body: z.string() }),
        execute: ({ body }, inv) => {
          this.store.setBrief(requireProjectId("update_project_brief", undefined, inv), body);
          return { ok: true };
        }
      })
    );

    this.ctx.tools.register(
      defineTool({
        name: "get_project_rules",
        title: "Read the project rules",
        description: "The rules the person set for every agent working in this project (Project settings → Rules). Follow them throughout; empty when there are none.",
        input: z.object({ projectId: z.string().optional() }),
        readOnly: true,
        execute: ({ projectId }, inv) => ({ rules: this.rules(requireProjectId("get_project_rules", projectId, inv)) ?? "" })
      })
    );

    this.ctx.tools.register(
      defineTool({
        name: "propose_rule",
        title: "Propose a project rule",
        description:
          "When the user corrects how you work in a way that should hold for every agent in this project from now on (\"always write tickets in Chinese\", \"never touch the billing module\"), offer it as a project rule. The user confirms before anything is written; one short imperative sentence per rule. Not for one-off instructions, and not for facts about the product — those belong in the project brief.",
        input: z.object({ rule: z.string().min(3).max(300).describe("One short imperative sentence.") }),
        execute: async ({ rule }, inv) => {
          const projectId = requireProjectId("propose_rule", undefined, inv);
          if (!inv.ask) throw new Error("Nobody here can confirm a rule. Tell the user they can add it in Project settings → Rules.");
          const w = this.words();
          const line = rule.replace(/\s+/g, " ").trim().replace(/^[-*]\s*/, "");
          const answer = await inv.ask(w.proposeRule(line), [w.addRule, w.skipRule]);
          if (answer !== w.addRule) return { added: false, note: "The user did not add it. Follow it for this conversation only if they asked you to." };
          const current = this.rules(projectId);
          this.setRules(projectId, current ? `${current}\n- ${line}` : `- ${line}`);
          return { added: true, file: this.rulesFile(projectId) };
        }
      })
    );

    this.ctx.tools.register(
      defineTool({
        name: "resume_workflow",
        title: "Resume the waiting workflow",
        description: "Feed an answer into the workflow that is waiting on this thread — use it when the user's message answers the pending question in other words.",
        input: z.object({ answer: z.union([z.string(), z.array(z.string())]) }),
        execute: async ({ answer }, inv) => {
          if (!inv.run) throw new Error("resume_workflow runs inside an assistant thread");
          const rc = this.activeById.get(inv.run.id);
          const pending = rc ? this.store.pending(rc.projectId, rc.threadId) : null;
          if (!rc || !pending || pending.kind !== "workflow") throw new Error("no workflow is waiting on this thread");
          const spec = this.workflows.get(pending.workflow!);
          if (!spec) throw new Error(`the waiting workflow "${pending.workflow}" is no longer installed`);
          this.store.clearPending(rc.projectId, rc.threadId);
          this.broadcast(rc.threadId, { type: "pending", pending: null });
          return this.driveWorkflow(spec, pending.step!, spec.state.parse(pending.state), answer, rc);
        }
      })
    );

    this.ctx.tools.register(
      defineTool({
        name: "cancel_workflow",
        title: "Cancel the waiting workflow",
        description: "Abandon the workflow that is waiting for an answer on this thread.",
        input: z.object({}),
        execute: (_args, inv) => {
          if (!inv.run) throw new Error("cancel_workflow runs inside an assistant thread");
          const rc = this.activeById.get(inv.run.id);
          const pending = rc ? this.store.pending(rc.projectId, rc.threadId) : null;
          if (!rc || !pending) throw new Error("nothing is waiting on this thread");
          this.store.clearPending(rc.projectId, rc.threadId);
          this.broadcast(rc.threadId, { type: "pending", pending: null });
          return { cancelled: pending.workflow ?? "question" };
        }
      })
    );
  }

  /** `<playbooksDir>/<name>/SKILL.md` — the user slot; a plugin's id may coexist. */
  /**
   * The user's playbooks live in the Hub folder (`<Hub>/playbooks/`) and travel
   * with it; the configured `playbooksDir` is where they lived before the Hub
   * existed, and is moved into the Hub the first time one is chosen.
   */
  private userPlaybooksDir(): string | null {
    const hub = this.ctx.get("hub") as { dir: string | null } | undefined;
    if (hub?.dir) return path.join(hub.dir, "playbooks");
    return this.config.playbooksDir ?? null;
  }

  private migratePlaybooksIntoHub(hubDir: string): void {
    const legacy = this.config.playbooksDir;
    const target = path.join(hubDir, "playbooks");
    if (!legacy || legacy === target || !fs.existsSync(legacy) || fs.existsSync(target)) return;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(legacy, target);
    } catch (err) {
      this.ctx.logger.warn(`playbooks were not moved into the Hub: ${message(err)}`);
    }
  }

  loadUserPlaybooks(): void {
    for (const [id, variants] of this.playbooks) {
      delete variants.user;
      if (!variants.plugin) this.playbooks.delete(id);
    }
    const dir = this.userPlaybooksDir();
    if (!dir || !fs.existsSync(dir)) return;
    const loaded = loadPlaybookDir(dir, (file, err) => this.ctx.logger.warn(`playbook ${file} failed to load: ${message(err)}`));
    for (const playbook of loaded) {
      const variants = this.playbooks.get(playbook.id) ?? {};
      variants.user = playbook;
      this.playbooks.set(playbook.id, variants);
    }
  }
}
