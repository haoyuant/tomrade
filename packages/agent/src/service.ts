import { randomUUID } from "node:crypto";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomrade/db";
import type {} from "@tomrade/oplog";
import type {} from "@tomrade/ipc";
import type { UndoRunResult } from "@tomrade/domain";
import type { LlmService } from "@tomrade/llm";
import type { SettingsSection } from "@tomrade/settings";
import { defineTool, type RunHandle, type LedgerEntry } from "@tomrade/tools";
import { loadPlaybookDir, resolvePlaybook, type PlaybookVariants } from "./playbooks.js";
import { AgentStore, MIGRATIONS, type PendingRecord } from "./store.js";
import {
  isSuspended,
  type AgentEvent,
  type AgentPolicy,
  type Block,
  type CardView,
  type Engine,
  type EngineView,
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

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: ThreadMessage[];
  runs: RunView[];
  cards: CardView[];
  pending: PendingView | null;
}

declare module "cordis" {
  interface Context {
    agent: Agent;
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    "agent.threads": (projectId: string) => ThreadSummary[];
    "agent.thread": (threadId: string) => ThreadDetail;
    "agent.newThread": (projectId: string, engine?: string) => ThreadSummary;
    "agent.send": (threadId: string, text: string) => { runId: string };
    "agent.answer": (threadId: string, questionId: string, value: string | string[]) => { runId: string };
    "agent.cancel": (runId: string) => boolean;
    "agent.revert": (runId: string) => UndoRunResult;
    "agent.engines": () => EngineView[];
    "agent.setEngine": (threadId: string, engineId: string) => ThreadSummary;
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
    this.ctx.db.migrate("agent", MIGRATIONS);
    this.store = new AgentStore(this.ctx.db);
    this.ctx.settings.register(AGENT_SECTION);
    this.registerPlatformTools();
    this.loadUserPlaybooks();
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("agent.threads", (projectId) => ctx.agent.store.threads(projectId));
      ctx.ipc.handle("agent.thread", (threadId) => ctx.agent.thread(threadId));
      ctx.ipc.handle("agent.newThread", (projectId, engine) => ctx.agent.newThread(projectId, engine));
      ctx.ipc.handle("agent.send", (threadId, text) => ctx.agent.send(threadId, { kind: "text", text }));
      ctx.ipc.handle("agent.answer", (threadId, questionId, value) => ctx.agent.send(threadId, { kind: "answer", questionId, value }));
      ctx.ipc.handle("agent.cancel", (runId) => ctx.agent.cancel(runId));
      ctx.ipc.handle("agent.revert", (runId) => ctx.agent.revert(runId));
      ctx.ipc.handle("agent.engines", () => ctx.agent.engineViews());
      ctx.ipc.handle("agent.setEngine", (threadId, engineId) => ctx.agent.setEngine(threadId, engineId));
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
          if (this.store.pending(rc.threadId)) throw new Error("another question is already waiting for the user");
          return this.startWorkflow(spec as WorkflowSpec, args, rc);
        }
      })
    );
    return specDispose;
  }

  // ── views ──────────────────────────────────────────────────────────────────

  thread(threadId: string): ThreadDetail {
    const thread = this.store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const pending = this.store.pending(threadId);
    return {
      thread,
      messages: this.store.messages(threadId),
      runs: this.store.runs(threadId),
      cards: this.store.cards(threadId),
      pending: pending ? this.pendingView(pending) : null
    };
  }

  private pendingView(record: PendingRecord): PendingView {
    return { threadId: record.threadId, kind: record.kind, workflow: record.workflow, question: record.question, accepts: record.accepts };
  }

  async engineViews(): Promise<EngineView[]> {
    return Promise.all(
      [...this.engines.values()].map(async (engine) => {
        try {
          const state = await engine.available();
          return { id: engine.id, title: engine.title, ok: state.ok, reason: state.reason };
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

  newThread(projectId: string, engine?: string): ThreadSummary {
    const chosen = engine ?? this.settingsOf().defaultEngine;
    const thread = this.store.createThread(projectId, this.engines.has(chosen) ? chosen : ([...this.engines.keys()][0] ?? chosen));
    return thread;
  }

  setEngine(threadId: string, engineId: string): ThreadSummary {
    if (!this.engines.has(engineId)) throw new Error(`unknown engine ${engineId}`);
    if (this.activeByThread.has(threadId)) throw new Error("a run is in progress on this thread");
    const pending = this.store.pending(threadId);
    if (pending) {
      // Switching conductors abandons the waiting question; say so in the thread.
      this.store.clearPending(threadId);
      this.broadcast(threadId, { type: "pending", pending: null });
      this.appendAndBroadcast(threadId, "system", { type: "note", text: "Cancelled the waiting question — the engine changed." }, null);
    }
    this.store.touchThread(threadId, { engine: engineId });
    const thread = this.store.thread(threadId)!;
    this.appendAndBroadcast(threadId, "system", { type: "note", text: `Engine switched to ${this.engines.get(engineId)?.title ?? engineId}.` }, null);
    return thread;
  }

  // ── the turn ───────────────────────────────────────────────────────────────

  send(threadId: string, input: UserInput): { runId: string } {
    const thread = this.store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    if (this.activeByThread.has(threadId)) throw new Error("a run is already in progress on this thread");
    const engine = this.engines.get(thread.engine) ?? [...this.engines.values()][0];
    if (!engine) throw new Error("No engine installed — enable one in the Plugins sheet");

    const text = input.kind === "text" ? input.text : Array.isArray(input.value) ? input.value.join(", ") : input.value;
    this.appendAndBroadcast(threadId, "user", { type: "text", text }, null);
    if (!thread.title) this.store.touchThread(threadId, { title: text.slice(0, 60) });

    const run = this.store.beginRun(threadId, engine.id);
    const rc = this.makeRunCtx(run, thread, engine);
    this.activeByThread.set(threadId, rc);
    this.activeById.set(run.id, rc);
    this.broadcast(threadId, { type: "run", run });
    void this.drive(rc, input);
    return { runId: run.id };
  }

  cancel(runId: string): boolean {
    const rc = this.activeById.get(runId);
    if (!rc) return false;
    rc.abort.abort();
    return true;
  }

  revert(runId: string): UndoRunResult {
    const run = this.store.run(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (this.activeById.has(runId)) throw new Error("that run is still going — stop it first");
    if (run.reverted) return { reverted: 0, kept: [] };
    const result = this.ctx.oplog.undoRun(runId);
    const view = this.store.markReverted(runId, result.kept.length);
    const kept = result.kept.length ? `; kept ${result.kept.map((k) => k.label).join(", ")} (${result.kept[0].reason})` : "";
    this.appendAndBroadcast(run.threadId, "system", { type: "note", text: `Reverted ${result.reverted} change${result.reverted === 1 ? "" : "s"} from this run${kept}.` }, runId);
    this.broadcast(run.threadId, { type: "run", run: view });
    return result;
  }

  /** Set or update a card (the dossier is one). Emits both the live card and a block in the stream the first time. */
  setCard(runId: string, card: { id: string; schema: string; title: string; data: unknown }): CardView {
    const rc = this.activeById.get(runId);
    if (!rc) throw new Error("no active run");
    const before = this.store.cards(rc.threadId).find((c) => c.id === card.id);
    const view = this.store.setCard(rc.threadId, card, rc.engine.author);
    if (!before) this.appendAndBroadcast(rc.threadId, "agent", { type: "card", id: card.id, schema: card.schema, title: card.title, data: card.data }, runId);
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
      waivers: this.store.waivers(thread.id),
      scratch: new Map()
    };
    const emit = (block: Block) => void this.appendAndBroadcast(thread.id, block.type === "note" ? "system" : "agent", block, run.id);
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
          this.store.appendLedger(run.id, entries.length, name, args, true, summary, ms);
          progress({ activity: null });
          if (!suspended) emit({ type: "trace", tool: name, args, ok: true, summary, ms });
          return result;
        } catch (err) {
          const ms = Date.now() - t0;
          const summary = message(err);
          entries.push({ seq: entries.length + 1, tool: name, args, ok: false, summary, ms });
          this.store.appendLedger(run.id, entries.length, name, args, false, summary, ms);
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
      resume: this.store.external(thread.id)[engine.id]
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
      const pending = this.store.pending(rc.threadId);
      const turnInput: TurnInput = {
        threadId: rc.threadId,
        projectId: rc.projectId,
        input,
        messages: this.store.messages(rc.threadId),
        cards: this.store.cards(rc.threadId),
        brief: this.store.brief(rc.projectId),
        pending: pending ? this.pendingView(pending) : null,
        options: rc.engine.options && engineOptions !== undefined ? rc.engine.options.parse(engineOptions) : engineOptions
      };
      result = await rc.engine.turn(turnInput, rc.io);
      if (result.resume) this.store.setExternal(rc.threadId, rc.engine.id, result.resume);
    } catch (err) {
      if (rc.abort.signal.aborted) {
        result = { stop: "cancelled" };
      } else {
        this.appendAndBroadcast(rc.threadId, "agent", { type: "error", text: message(err) }, rc.run.id);
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
    const pending = this.store.pending(rc.threadId);
    if (!pending) return "engine";
    const value = input.kind === "answer" ? input.value : input.kind === "text" ? input.text : "";
    const values = Array.isArray(value) ? value : [value];
    const explicit = input.kind === "answer" && input.questionId === pending.question.id;
    const onScript = explicit || pending.accepts === "text" || values.every((v) => pending.question.options?.includes(v));

    if (pending.waiveRule && values.some((v) => pending.waiveOn.includes(v))) this.store.addWaiver(rc.threadId, pending.waiveRule);

    if (pending.kind === "ask") {
      // The engine asked; whatever came back is its answer.
      this.store.clearPending(rc.threadId);
      this.broadcast(rc.threadId, { type: "pending", pending: null });
      return "engine";
    }
    if (!onScript) return "engine";

    this.store.clearPending(rc.threadId);
    this.broadcast(rc.threadId, { type: "pending", pending: null });
    const spec = this.workflows.get(pending.workflow!);
    if (!spec) {
      this.appendAndBroadcast(rc.threadId, "system", { type: "note", text: `The waiting workflow "${pending.workflow}" is no longer installed.` }, rc.run.id);
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
        this.store.setPending(rc.threadId, {
          kind: "workflow",
          workflow: spec.id,
          step,
          state,
          question,
          accepts: spec.accepts ?? "text",
          waiveRule: null,
          waiveOn: []
        });
        this.appendAndBroadcast(rc.threadId, "agent", { type: "question", ...question }, rc.run.id);
        this.broadcast(rc.threadId, { type: "pending", pending: this.pendingView(this.store.pending(rc.threadId)!) });
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
    const changes = this.store.changesOf(rc.run.id);
    if (changes > 0) this.appendAndBroadcast(rc.threadId, "agent", { type: "changes", runId: rc.run.id, count: changes, items: this.store.changedEntities(rc.run.id) }, rc.run.id);
    const status = result.stop === "asked" ? "asked" : result.stop === "cancelled" ? "cancelled" : result.stop === "error" ? "error" : "done";
    const run = this.store.endRun(rc.run.id, { status, stop: result.stop, error: result.error, usage: result.usage, costUsd: result.costUsd, changes });
    this.broadcast(rc.threadId, { type: "done", run });
  }

  private appendAndBroadcast(threadId: string, role: ThreadMessage["role"], block: Block, runId: string | null): ThreadMessage {
    const msg = this.store.appendMessage(threadId, role, block, runId);
    this.broadcast(threadId, { type: "message", message: msg });
    return msg;
  }

  private broadcast(threadId: string, event: AgentEvent): void {
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
          if (this.store.pending(rc.threadId)) throw new Error("another question is already waiting");
          const question = { id: randomUUID(), text: args.question, options: args.options, multiple: args.multiple, freeText: args.freeText };
          this.store.setPending(rc.threadId, {
            kind: "ask",
            workflow: null,
            step: null,
            state: null,
            question,
            accepts: "text",
            waiveRule: args.waiveRule ?? null,
            waiveOn: args.waiveOn ?? []
          });
          this.appendAndBroadcast(rc.threadId, "agent", { type: "question", ...question }, rc.run.id);
          this.broadcast(rc.threadId, { type: "pending", pending: this.pendingView(this.store.pending(rc.threadId)!) });
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
          if (!inv.projectId) throw new Error("update_project_brief needs a project scope");
          this.store.setBrief(inv.projectId, body);
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
          const pending = rc ? this.store.pending(rc.threadId) : null;
          if (!rc || !pending || pending.kind !== "workflow") throw new Error("no workflow is waiting on this thread");
          const spec = this.workflows.get(pending.workflow!);
          if (!spec) throw new Error(`the waiting workflow "${pending.workflow}" is no longer installed`);
          this.store.clearPending(rc.threadId);
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
          const pending = rc ? this.store.pending(rc.threadId) : null;
          if (!rc || !pending) throw new Error("nothing is waiting on this thread");
          this.store.clearPending(rc.threadId);
          this.broadcast(rc.threadId, { type: "pending", pending: null });
          return { cancelled: pending.workflow ?? "question" };
        }
      })
    );
  }

  /** `<playbooksDir>/<name>/SKILL.md` — the user slot; a plugin's id may coexist. */
  private loadUserPlaybooks(): void {
    if (!this.config.playbooksDir) return;
    const loaded = loadPlaybookDir(this.config.playbooksDir, (file, err) => this.ctx.logger.warn(`playbook ${file} failed to load: ${message(err)}`));
    for (const playbook of loaded) {
      const variants = this.playbooks.get(playbook.id) ?? {};
      if (variants.user) continue;
      variants.user = playbook;
      this.playbooks.set(playbook.id, variants);
    }
  }
}
