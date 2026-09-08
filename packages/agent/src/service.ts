import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomrade/db";
import type {} from "@tomrade/hub";
import type {} from "@tomrade/oplog";
import type {} from "@tomrade/ipc";
import type { UndoRunResult } from "@tomrade/domain";
import type { LlmService } from "@tomrade/llm";
import type { SettingsSection } from "@tomrade/settings";
import { defineTool, requireProjectId, type RunHandle, type LedgerEntry } from "@tomrade/tools";
import { loadPlaybookDir, resolvePlaybook, type PlaybookVariants } from "./playbooks.js";
import { AgentStore, MIGRATIONS, TABLES, type PendingRecord } from "./store.js";
import {
  isSuspended,
  type AgentEvent,
  type AgentPolicy,
  type Block,
  type CardView,
  type Engine,
  type EngineView,
  type FocusRef,
  type PendingView,
  type Playbook,
  type PlaybookIndexEntry,
  type PlaybookSource,
  type RunView,
  type Suspended,
  type ThreadMessage,
  type ThreadSummary,
  type TurnInput,
  type TurnIO,
  type TurnResult,
  type UserInput,
  type WorkflowIO,
  type WorkflowSpec
} from "./types.js";

/** Where a thread's engine would run, or the one reason it cannot yet. `code` is stable for the renderer to translate. */
export interface WorkdirStatus {
  cwd: string | null;
  remote: string | null;
  branch: string | null;
  worktree: string | null;
  problem: string | null;
  code: "no-checkout" | "no-repos" | "error" | null;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: ThreadMessage[];
  runs: RunView[];
  cards: CardView[];
  pending: PendingView | null;
}

/** Current in-memory work plus durable questions, for main-process observers that load mid-run. */
export interface AgentActivity {
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
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    "agent.threads": (projectId: string) => ThreadSummary[];
    "agent.thread": (projectId: string, threadId: string) => ThreadDetail;
    "agent.newThread": (projectId: string, engine?: string, boardId?: string | null) => ThreadSummary;
    /** Put the thread on a workstream (its repository is where a code engine runs), or back on the whole project. */
    "agent.setWorkstream": (projectId: string, threadId: string, boardId: string | null) => ThreadSummary;
    /** Where the thread's engine would run: ready, or why not yet (no checkout on this machine). */
    "agent.workdir": (projectId: string, threadId: string) => WorkdirStatus;
    "agent.send": (projectId: string, threadId: string, text: string, focus?: FocusRef[]) => { runId: string };
    "agent.answer": (projectId: string, threadId: string, questionId: string, value: string | string[]) => { runId: string };
    "agent.cancel": (runId: string) => boolean;
    "agent.revert": (projectId: string, runId: string) => UndoRunResult;
    "agent.engines": () => EngineView[];
    "agent.setEngine": (projectId: string, threadId: string, engineId: string) => ThreadSummary;
    "agent.playbooks": (projectId?: string) => PlaybookIndexEntry[];
  }
  interface Broadcasts {
    "agent.event": (threadId: string, event: AgentEvent) => void;
  }
}

export const AgentConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** Folder of user playbooks: one SKILL.md per subdirectory. */
    playbooksDir: z.string().optional(),
    /** Hard wall-clock ceiling per run. */
    maxWallMs: z.number().int().min(10_000).default(180_000)
  })
);
export type AgentConfig = z.infer<typeof AgentConfig>;

export interface AgentSettings {
  defaultEngine: string;
  /** A plan pauses for confirmation when it would write more items than this; 0 = never pause. */
  confirmWritesOver: number;
  engines: Record<string, unknown>;
  /** Per-playbook-id: which source wins when several carry the same id. Absent = most specific wins. */
  playbookChoices: Record<string, PlaybookSource>;
}

export const AGENT_SECTION: SettingsSection<AgentSettings> = {
  id: "agent",
  title: "Assistant",
  description: "Which engine conducts a new thread, and when a plan pauses for confirmation before writing.",
  schema: z.object({
    defaultEngine: z.string().default("loop"),
    confirmWritesOver: z.number().int().min(0).default(0),
    engines: z.record(z.string(), z.unknown()).default({}),
    playbookChoices: z.record(z.string(), z.enum(["plugin", "user", "project"])).default({})
  }),
  defaults: { defaultEngine: "loop", confirmWritesOver: 0, engines: {}, playbookChoices: {} },
  order: 11
};

interface RunCtx {
  run: RunView;
  threadId: string;
  projectId: string;
  engine: Engine;
  abort: AbortController;
  handle: RunHandle;
  entries: LedgerEntry[];
  io: TurnIO;
  wio: WorkflowIO;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
export class Agent extends Service {
  static provide = "agent";
  static inject = ["db", "tools", "oplog", "settings"];
  static Config = AgentConfig;

  store!: AgentStore;

  private engines = new Map<string, Engine>();
  private workflows = new Map<string, WorkflowSpec>();
  private playbooks = new Map<string, PlaybookVariants>();
  /** Playbooks read from each project's shared copy; refreshed when a run starts. */
  private projectPlaybooks = new Map<string, Map<string, Playbook>>();
  private activeByThread = new Map<string, RunCtx>();
  private activeById = new Map<string, RunCtx>();

  constructor(
    ctx: Context,
    public readonly config: AgentConfig
  ) {
    super(ctx, "agent");
  }

  [Service.init]() {
    this.ctx.db.migrate("agent", MIGRATIONS, { tables: TABLES });
    this.store = new AgentStore(this.ctx.db);
    // A run left "running" by a killed process has no controller; settle it in
    // every project file that is open now and in each one opened later.
    for (const projectId of this.ctx.db.openIds()) this.store.reconcileInterrupted(projectId);
    this.ctx.on("db/opened", (projectId) => this.store.reconcileInterrupted(projectId));
    this.ctx.settings.register(AGENT_SECTION);
    this.migrateConversationRole();
    this.registerPlatformTools();
    this.loadUserPlaybooks();
    this.ctx.inject(["hub"], (ctx) => {
      if (ctx.hub.dir) this.migratePlaybooksIntoHub(ctx.hub.dir);
      this.loadUserPlaybooks();
      return ctx.on("hub/configured", (dir) => {
        this.migratePlaybooksIntoHub(dir);
        this.loadUserPlaybooks();
      });
    });
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("agent.threads", (projectId) => ctx.agent.store.threads(projectId));
      ctx.ipc.handle("agent.thread", (projectId, threadId) => ctx.agent.thread(projectId, threadId));
      ctx.ipc.handle("agent.newThread", (projectId, engine, boardId) => ctx.agent.newThread(projectId, engine, boardId ?? null));
      ctx.ipc.handle("agent.setWorkstream", (projectId, threadId, boardId) => ctx.agent.setWorkstream(projectId, threadId, boardId));
      ctx.ipc.handle("agent.workdir", (projectId, threadId) => ctx.agent.workdir(projectId, threadId));
      ctx.ipc.handle("agent.send", (projectId, threadId, text, focus) => ctx.agent.send(projectId, threadId, { kind: "text", text, focus }));
      ctx.ipc.handle("agent.answer", (projectId, threadId, questionId, value) => ctx.agent.send(projectId, threadId, { kind: "answer", questionId, value }));
      ctx.ipc.handle("agent.cancel", (runId) => ctx.agent.cancel(runId));
      ctx.ipc.handle("agent.revert", (projectId, runId) => ctx.agent.revert(projectId, runId));
      ctx.ipc.handle("agent.engines", () => ctx.agent.engineViews());
      ctx.ipc.handle("agent.setEngine", (projectId, threadId, engineId) => ctx.agent.setEngine(projectId, threadId, engineId));
      ctx.ipc.handle("agent.playbooks", async (projectId) => {
        if (projectId) await ctx.agent.refreshProjectPlaybooks(projectId);
        return ctx.agent.playbookIndex(projectId);
      });
    });
    return () => {
      for (const rc of this.activeById.values()) rc.abort.abort();
    };
  }

  // ── registries ─────────────────────────────────────────────────────────────
  // These run on the CALLER's context, so a registration dies with its plugin.

  engine(engine: Engine): () => void {
    if (this.engines.has(engine.id)) throw new Error(`engine "${engine.id}" is already registered`);
    return this.ctx.effect(() => {
      this.engines.set(engine.id, engine);
      return () => this.engines.delete(engine.id);
    }, `agent.engine(${engine.id})`);
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
          return this.startWorkflow(spec as WorkflowSpec, args, rc);
        }
      })
    );
    return specDispose;
  }

  // ── views ──────────────────────────────────────────────────────────────────

  thread(projectId: string, threadId: string): ThreadDetail {
    const thread = this.store.thread(projectId, threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const pending = this.store.pending(projectId, threadId);
    return {
      thread,
      messages: this.store.messages(projectId, threadId),
      runs: this.store.runs(projectId, threadId),
      cards: this.store.cards(projectId, threadId),
      pending: pending ? this.pendingView(pending) : null
    };
  }

  activities(): AgentActivity[] {
    const out = new Map<string, AgentActivity>();
    for (const rc of this.activeByThread.values()) {
      const pending = this.store.pending(rc.projectId, rc.threadId);
      out.set(rc.threadId, {
        threadId: rc.threadId,
        run: this.store.run(rc.projectId, rc.run.id) ?? rc.run,
        pending: pending ? this.pendingView(pending) : null
      });
    }
    for (const projectId of this.ctx.db.openIds()) {
      for (const thread of this.store.threads(projectId)) {
        if (out.has(thread.id)) continue;
        const pending = this.store.pending(projectId, thread.id);
        if (pending) out.set(thread.id, { threadId: thread.id, run: null, pending: this.pendingView(pending) });
      }
    }
    return [...out.values()].sort((a, b) => a.threadId.localeCompare(b.threadId));
  }

  private pendingView(record: PendingRecord): PendingView {
    return { threadId: record.threadId, kind: record.kind, workflow: record.workflow, question: record.question, accepts: record.accepts };
  }

  async engineViews(): Promise<EngineView[]> {
    return Promise.all(
      [...this.engines.values()].map(async (engine) => {
        try {
          const state = await engine.available();
          return { id: engine.id, title: engine.title, ok: state.ok, reason: state.reason, picks: engine.picks?.() };
        } catch (err) {
          return { id: engine.id, title: engine.title, ok: false, reason: message(err) };
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

  newThread(projectId: string, engine?: string, boardId: string | null = null): ThreadSummary {
    const chosen = engine ?? this.settingsOf().defaultEngine;
    return this.store.createThread(projectId, this.engines.has(chosen) ? chosen : ([...this.engines.keys()][0] ?? chosen), "", boardId);
  }

  setWorkstream(projectId: string, threadId: string, boardId: string | null): ThreadSummary {
    if (this.activeByThread.has(threadId)) throw new Error("a run is in progress on this thread");
    this.store.touchThread(projectId, threadId, { boardId });
    return this.store.thread(projectId, threadId)!;
  }

  /** Where the thread's engine works, resolved through the workstream's repository and this machine's checkout of it. */
  async workdir(projectId: string, threadId: string): Promise<WorkdirStatus> {
    const none: WorkdirStatus = { cwd: null, remote: null, branch: null, worktree: null, problem: null, code: null };
    const thread = this.store.thread(projectId, threadId);
    if (!thread?.boardId) return none;
    const repos = this.ctx.get("repos") as { workdirFor(projectId: string, boardId: string, threadId: string): Promise<{ cwd: string; worktree: string | null; branch: string; repo: { remote: string } } | null> } | undefined;
    if (!repos) return { ...none, problem: "the repos plugin is not loaded", code: "no-repos" };
    try {
      const view = await repos.workdirFor(projectId, thread.boardId, threadId);
      if (!view) return none;
      return { cwd: view.cwd, remote: view.repo.remote, branch: view.branch, worktree: view.worktree, problem: null, code: null };
    } catch (err) {
      const remote = (err as { remote?: string }).remote ?? null;
      return { ...none, remote, problem: message(err), code: (err as { name?: string }).name === "CheckoutUnsetError" ? "no-checkout" : "error" };
    }
  }

  setEngine(projectId: string, threadId: string, engineId: string): ThreadSummary {
    if (!this.engines.has(engineId)) throw new Error(`unknown engine ${engineId}`);
    if (this.activeByThread.has(threadId)) throw new Error("a run is in progress on this thread");
    const pending = this.store.pending(projectId, threadId);
    if (pending) {
      // Switching conductors abandons the waiting question; say so in the thread.
      this.store.clearPending(projectId, threadId);
      this.broadcast(threadId, { type: "pending", pending: null });
      this.appendAndBroadcast(projectId, threadId, "system", { type: "note", text: "Cancelled the waiting question — the engine changed." }, null);
    }
    this.store.touchThread(projectId, threadId, { engine: engineId });
    const thread = this.store.thread(projectId, threadId)!;
    this.appendAndBroadcast(projectId, threadId, "system", { type: "note", text: `Engine switched to ${this.engines.get(engineId)?.title ?? engineId}.` }, null);
    return thread;
  }

  // ── the turn ───────────────────────────────────────────────────────────────

  send(projectId: string, threadId: string, input: UserInput): { runId: string } {
    const thread = this.store.thread(projectId, threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    if (this.activeByThread.has(threadId)) throw new Error("a run is already in progress on this thread");
    const engine = this.engines.get(thread.engine) ?? [...this.engines.values()][0];
    if (!engine) throw new Error("No engine installed — enable one in the Plugins sheet");

    const text = input.kind === "text" ? input.text : Array.isArray(input.value) ? input.value.join(", ") : input.value;
    const focus = input.kind === "text" && input.focus?.length ? input.focus : undefined;
    this.appendAndBroadcast(projectId, threadId, "user", focus ? { type: "text", text, focus } : { type: "text", text }, null);
    if (!thread.title) this.store.touchThread(projectId, threadId, { title: text.slice(0, 60) });

    const run = this.store.beginRun(projectId, threadId, engine.id);
    const rc = this.makeRunCtx(run, thread, engine);
    this.activeByThread.set(threadId, rc);
    this.activeById.set(run.id, rc);
    this.broadcast(threadId, { type: "run", run });
    void this.drive(rc, input);
    return { runId: run.id };
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
    const changes = this.store.changesOf(projectId, runId);
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
    const kept = result.kept.length ? `; kept ${result.kept.map((k) => k.label).join(", ")} (${result.kept[0].reason})` : "";
    this.appendAndBroadcast(projectId, run.threadId, "system", { type: "note", text: `Reverted ${result.reverted} change${result.reverted === 1 ? "" : "s"} from this run${kept}.` }, runId);
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

  private makeRunCtx(run: RunView, thread: ThreadSummary, engine: Engine): RunCtx {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.config.maxWallMs);
    abort.signal.addEventListener("abort", () => clearTimeout(timer));
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
    const emit = (block: Block) => void this.appendAndBroadcast(thread.projectId, thread.id, block.type === "note" ? "system" : "agent", block, run.id);
    const progress = (p: { activity?: string | null; usage?: { inputTokens: number; outputTokens: number } }) =>
      this.broadcast(thread.id, { type: "progress", runId: run.id, ...p });
    const tools = {
      describe: () => this.ctx.tools.describe(),
      execute: async (name: string, args: unknown): Promise<unknown> => {
        const t0 = Date.now();
        progress({ activity: name });
        try {
          const result = await this.ctx.tools.execute(name, args, { by: engine.author, projectId: thread.projectId, run: handle });
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
      emit,
      delta: (text) => this.broadcast(thread.id, { type: "delta", runId: run.id, text }),
      progress: (usage) => progress({ usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } }),
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
      resume: this.store.external(thread.projectId, thread.id)[engine.id]
    };
    return { run, threadId: thread.id, projectId: thread.projectId, engine, abort, handle, entries, io, wio: { emit, tools, llm, run: handle } };
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
      const settings = this.settingsOf();
      const engineOptions = settings.engines[rc.engine.id];
      const pending = this.store.pending(rc.projectId, rc.threadId);
      // A thread on a workstream runs where that workstream's code is; a missing checkout stops the run before the engine starts.
      const where = await this.workdir(rc.projectId, rc.threadId);
      if (where.problem) throw new Error(where.problem);
      const turnInput: TurnInput = {
        threadId: rc.threadId,
        projectId: rc.projectId,
        input,
        messages: this.store.messages(rc.projectId, rc.threadId),
        cards: this.store.cards(rc.projectId, rc.threadId),
        brief: this.store.brief(rc.projectId),
        pending: pending ? this.pendingView(pending) : null,
        focus: input.kind === "text" && input.focus?.length ? input.focus : undefined,
        options: rc.engine.options && engineOptions !== undefined ? rc.engine.options.parse(engineOptions) : engineOptions,
        ...(where.cwd ? { cwd: where.cwd, workdir: { remote: where.remote!, branch: where.branch!, worktree: where.worktree } } : {})
      };
      result = await rc.engine.turn(turnInput, rc.io);
      if (result.resume) this.store.setExternal(rc.projectId, rc.threadId, rc.engine.id, result.resume);
    } catch (err) {
      if (rc.abort.signal.aborted) {
        result = { stop: "cancelled" };
      } else {
        this.appendAndBroadcast(rc.projectId, rc.threadId, "agent", { type: "error", text: message(err) }, rc.run.id);
        result = { stop: "error", error: message(err) };
      }
    } finally {
      this.finish(rc, result ?? { stop: "error", error: "engine returned nothing" });
    }
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
    const onScript = explicit || pending.accepts === "text" || values.every((v) => pending.question.options?.includes(v));

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
      this.appendAndBroadcast(rc.projectId, rc.threadId, "system", { type: "note", text: `The waiting workflow "${pending.workflow}" is no longer installed.` }, rc.run.id);
      return "engine";
    }
    const outcome = await this.driveWorkflow(spec, pending.step!, spec.state.parse(pending.state), value, rc);
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
    const changes = this.store.changesOf(rc.projectId, rc.run.id);
    if (changes > 0) {
      this.appendAndBroadcast(rc.projectId, rc.threadId, "agent", { type: "changes", runId: rc.run.id, count: changes, items: this.store.changedEntities(rc.projectId, rc.run.id) }, rc.run.id);
    }
    const status = result.stop === "asked" ? "asked" : result.stop === "cancelled" ? "cancelled" : result.stop === "error" ? "error" : "done";
    const run = this.store.endRun(rc.projectId, rc.run.id, { status, stop: result.stop, error: result.error, usage: result.usage, costUsd: result.costUsd, changes });
    this.broadcast(rc.threadId, { type: "done", run });
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
        execute: ({ id }, inv) => {
          const body = this.openPlaybook(id, inv.projectId);
          if (body === null) throw new Error(`unknown playbook "${id}" — available: ${this.playbookIndex(inv.projectId).map((e) => e.id).join(", ") || "(none)"}`);
          return { id, body };
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
