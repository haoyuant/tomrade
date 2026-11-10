import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import { z } from "zod";
import { languageName, languageTag, type Item, type LanguageTag } from "@tomradex/domain";
import { looksOutOfBalance } from "@tomradex/agent";
import type {} from "@tomradex/alerts";
import type {} from "@tomradex/code-link";
import type {} from "@tomradex/contributions";
import type { StartOptions } from "@tomradex/code-link";
import type {} from "@tomradex/db";
import type {} from "@tomradex/files";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type { LlmService } from "@tomradex/llm";
import type {} from "@tomradex/settings";
import { errorMessage, localeOf } from "@tomradex/contracts";
import { defineTool, requireProjectId } from "@tomradex/tools";
import { Judgement, judgeSystem, judgeUser, renderBrief, type BriefSpend, type Delivery, type SpendLine } from "./brief.js";
import { applyEdit, cannotRemove, type ShiftEdit } from "./edit.js";
import { DEFAULT_MAX_INSERTS, Triage, insertGate, insertedTicket, reportLine, triageSystem, triageUser, type NotInserted } from "./found.js";
import { PlanReply, planCandidates, planSystem, planUser, readPlan, type ShiftPlan } from "./plan.js";
import { MAX_STEPS, MERGE_WAITS, MERGE_WAIT_MS, advance, failTicket, isStuck, outOfEngines, settingsFor, stepsBetween, takeOverLine, triedEngines, type Action, type NightShift, type NodeConfig, type SessionFacts, type ShiftFinding, type ShiftStep, type ShiftTicket, type TicketFacts, type TicketSettings, type TicketState, type Why } from "./rules.js";
import { WorkRules, ruleConfig, ruleFor, type WorkRule } from "./work-rules.js";
import { NIGHT_SHIFT_WORDS } from "./words.js";

/** "Until it is done" still ends: a run nothing can finish must not stay open for good. */
export const MAX_HOURS = 72;
/** An agent on this computer answers all at once, and a long backlog takes it a while. */
const PLAN_TIMEOUT_MS = 5 * 60_000;
/** How long the morning report waits on its judgements before it goes out without the rest. */
const JUDGING_MS = 3 * 60_000;

/** An API's refusal arrives as a status and its JSON; the person needs the sentence inside. */
const plainError = (err: unknown): string => {
  const text = errorMessage(err);
  return (/"message"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? text).slice(0, 200);
};

const NodeConfigInput = z.object({
  mode: z.enum(["terminal", "run"]).optional(),
  engine: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  permissionMode: z.string().min(1).optional(),
  autoMerge: z.boolean().optional(),
  whenLimited: z.enum(["switch", "wait"]).optional()
});

export const NightShiftInput = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(50),
  /** Terminal panes or background sessions; absent goes as Start last went. */
  mode: z.enum(["terminal", "run"]).optional(),
  engine: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  permissionMode: z.string().min(1).optional(),
  concurrency: z.number().int().min(1).max(8).default(2),
  maxMinutes: z.number().int().min(5).max(MAX_HOURS * 60).default(8 * 60),
  maxUsd: z.number().positive().nullable().default(null),
  maxFailures: z.number().int().min(1).max(20).default(3),
  autoMerge: z.boolean().default(false),
  keepAwake: z.boolean().default(true),
  judge: z.boolean().default(true),
  /** Dependencies from the plan the person took: written to the tickets as the run starts. */
  dependencies: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).max(50).default([]),
  notify: z.enum(["steps", "stuck"]).default("steps"),
  /** Tickets found along the way that may join the run; 0 takes none. */
  maxInserts: z.number().int().min(0).max(10).default(DEFAULT_MAX_INSERTS),
  /** Nobody is there to wait for a limit overnight, so a new run moves on by default. */
  whenLimited: z.enum(["switch", "wait"]).default("switch"),
  /** What the person set on single nodes, by ticket id. */
  nodes: z.record(z.string(), NodeConfigInput).default({})
});
export type NightShiftInput = z.input<typeof NightShiftInput>;

/** A change to a run going now. `stop` must be said: it ends an agent at work. */
export const NightShiftEdit = z.object({
  add: z.array(z.string().min(1)).max(50).default([]),
  remove: z.array(z.object({ itemId: z.string().min(1), stop: z.boolean().default(false) })).max(50).default([]),
  /** A node's config by ticket id; null clears it back to the run's. */
  nodes: z.record(z.string(), NodeConfigInput.nullable()).default({})
});
export type NightShiftEdit = z.input<typeof NightShiftEdit>;

/**
 * A run an agent asked for, waiting on the person. It holds exactly what was shown to them, so a yes
 * can start nothing else; another ask replaces it, and it lapses by itself. Nothing an agent can call answers it.
 */
export interface ShiftProposal {
  id: string;
  projectId: string;
  tickets: { itemId: string; key: string; title: string }[];
  /** Where it runs, the agent, its permissions and its limits, in the person's language. */
  config: string[];
  /** All of it as one message, for a chat. */
  text: string;
  expiresAt: number;
}

/** Long enough to find the message; a yes hours later would answer a plan that has gone stale. */
const PROPOSAL_MS = 30 * 60_000;

export interface NightShiftTicketView extends ShiftTicket {
  /** Why it stands where it does, in the person's language. */
  note: string | null;
}

export interface NightShiftStepView extends ShiftStep {
  /** Why it came to this, in the person's language. */
  note: string | null;
}

/** One step, said for a chat: it names the ticket, so it goes only to the person's own direct chat. */
export interface StepNotice {
  key: string;
  title: string;
  body: string;
}

type PlanAnswer = { reply: PlanReply | null; failed: string };

export interface NightShiftView extends Omit<NightShift, "tickets" | "steps" | "found"> {
  tickets: NightShiftTicketView[];
  steps: NightShiftStepView[];
  found: ShiftFinding[];
  counts: Record<TicketState, number>;
  /** Whether `spentUsd` is the whole of it: terminal agents, and some engines, report no cost. */
  costKnown: boolean;
}

declare module "cordis" {
  interface Context {
    nightShift: NightShifts;
  }
  interface Events {
    "nightShift/changed"(projectId: string): void;
    /** A run waits on the person's yes; `answer` is theirs alone, so it goes only where a person presses it. */
    "nightShift/proposed"(proposal: ShiftProposal, ask: { title: string; yes: string; no: string; answer(yes: boolean): string }): void;
    "nightShift/ended"(shift: NightShiftView): void;
    /** The morning report is written: words for a phone or a chat, which carry no code. */
    "nightShift/briefed"(shift: NightShiftView, notice: { title: string; body: string }): void;
    /** Steps worth telling, and, when one stopped a ticket, words for a phone: numbers only, since a phone's message passes through someone else's service. */
    "nightShift/step"(shift: NightShiftView, notices: StepNotice[], stuck: { title: string; body: string } | null): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "nightShift.current": (projectId: string) => NightShiftView | null;
    "nightShift.list": (projectId: string, limit?: number) => NightShiftView[];
    /** `fresh` asks the model even though nothing it would be shown has changed. */
    "nightShift.plan": (projectId: string, fresh?: boolean) => ShiftPlan;
    "nightShift.rules": (projectId: string) => WorkRule[];
    "nightShift.setRules": (projectId: string, rules: WorkRule[]) => WorkRule[];
    /** Which rule each open ticket falls under, by ticket id. */
    "nightShift.ruleMatches": (projectId: string) => Record<string, string>;
    "nightShift.start": (projectId: string, input: NightShiftInput) => NightShiftView;
    "nightShift.stop": (projectId: string, id: string) => NightShiftView;
    "nightShift.edit": (projectId: string, id: string, edit: NightShiftEdit) => NightShiftView;
    "nightShift.proposal": (projectId: string) => ShiftProposal | null;
    /** The person's answer. It is never a tool: an agent must not be able to give it. */
    "nightShift.decide": (projectId: string, id: string, yes: boolean) => NightShiftView | null;
  }
  interface Broadcasts {
    "nightShift.changed": (projectId: string) => void;
    "nightShift.step": (projectId: string, notices: StepNotice[]) => void;
    "nightShift.proposed": (projectId: string) => void;
  }
}

export const MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS plugin_nightshift_shifts (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status     TEXT NOT NULL,
  doc_json   TEXT NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_nightshift_project ON plugin_nightshift_shifts(project_id, started_at);
`
  },
  {
    version: 2,
    up: `
CREATE TABLE IF NOT EXISTS plugin_nightshift_rules (
  project_id TEXT PRIMARY KEY,
  doc_json   TEXT NOT NULL
);
`
  }
];

/** A shift runs on the machine it was started on: its agents and worktrees are here, and a second machine must not run it again. */
export const TABLES = { plugin_nightshift_shifts: { project: "project_id", export: false }, plugin_nightshift_rules: { project: "project_id", export: { order: "project_id" } } } as const;

export const NightShiftConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** How often a shift looks again when nothing told it to. */
    tickMs: z.number().int().min(50).default(15_000),
    /** How long a burst of session changes settles before a shift looks. */
    settleMs: z.number().int().min(0).default(2_000)
  })
);
export type NightShiftConfig = z.output<typeof NightShiftConfig>;

const OPEN_TO_START = new Set(["backlog", "todo", "doing", "verifying"]);

/** What a report came to, waiting for the run's next pass: only a pass writes a run, so a report never races one. */
type Arrival = { ticket: ShiftTicket; why: string; fromKey: string } | { finding: ShiftFinding } | { edit: ShiftEdit };
const STATES: TicketState[] = ["queued", "running", "limited", "needs-you", "delivered", "done", "failed", "skipped"];

/** A ticket's own settings: the person's hand over a rule, field by field. */
function configOf(item: Pick<Item, "id"> & Item, rules: readonly WorkRule[], manual: NodeConfig | undefined): Pick<ShiftTicket, "config" | "configFrom"> {
  const rule = ruleFor(rules, item);
  const config: NodeConfig = { ...(rule ? ruleConfig(rule) : {}), ...manual };
  if (!Object.keys(config).length) return {};
  return { config, configFrom: manual && Object.keys(manual).length ? { kind: "manual" } : { kind: "rule", name: rule!.name } };
}

export class NightShifts extends Service {
  static provide = "nightShift";
  static inject = ["db", "items", "agent", "codeLink"];
  static Config = NightShiftConfig;

  private readonly home: Context;
  private ticking = false;
  private again = false;
  private settling: ReturnType<typeof setTimeout> | null = null;
  /** Projects with a shift going: a session's every word need not touch the database to learn there is none. */
  private readonly going = new Set<string>();
  private readonly arrivals = new Map<string, Arrival[]>();
  private readonly proposals = new Map<string, { view: ShiftProposal; input: NightShiftInput; timer: ReturnType<typeof setTimeout> }>();
  /** Each project's last plan and what the model was shown for it; a failed one is not kept. */
  private readonly plans = new Map<string, { asked: string; answer: Promise<PlanAnswer> }>();

  constructor(
    ctx: Context,
    public readonly config: NightShiftConfig
  ) {
    super(ctx, "nightShift");
    this.home = ctx;
  }

  [Service.init]() {
    this.home.db.migrate("nightshift", MIGRATIONS, { tables: TABLES });
    const timer = setInterval(() => void this.tick(), this.config.tickMs);
    this.home.effect(() => () => {
      clearInterval(timer);
      if (this.settling) clearTimeout(this.settling);
    }, "night shift tick");
    const resume = (projectId: string) => {
      if (this.running(projectId)) {
        this.going.add(projectId);
        this.home.emit("nightShift/changed", projectId);
        this.kick();
      }
    };
    for (const projectId of this.home.db.openIds()) resume(projectId);
    this.home.on("db/opened", resume);
    this.home.on("codeLink/changed", (projectId) => {
      if (this.going.has(projectId)) this.kick();
    });
    // The run's settings already said what to do, and nobody is there to answer.
    this.home.on("agent/before-switch-offer", (thread) => (this.going.has(thread.projectId) && this.running(thread.projectId)?.tickets.some((t) => t.itemId === thread.itemId) ? true : undefined));
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("nightShift.current", (projectId) => ctx.nightShift.current(projectId));
      ctx.ipc.handle("nightShift.list", (projectId, limit) => ctx.nightShift.list(projectId, limit));
      ctx.ipc.handle("nightShift.plan", (projectId, fresh) => ctx.nightShift.plan(projectId, fresh));
      ctx.ipc.handle("nightShift.rules", (projectId) => ctx.nightShift.rules(projectId));
      ctx.ipc.handle("nightShift.setRules", (projectId, rules) => ctx.nightShift.setRules(projectId, rules));
      ctx.ipc.handle("nightShift.ruleMatches", (projectId) => ctx.nightShift.ruleMatches(projectId));
      ctx.ipc.handle("nightShift.start", (projectId, input) => ctx.nightShift.start(projectId, input));
      ctx.ipc.handle("nightShift.stop", (projectId, id) => ctx.nightShift.stop(projectId, id));
      ctx.ipc.handle("nightShift.edit", (projectId, id, edit) => ctx.nightShift.edit(projectId, id, edit));
      ctx.ipc.handle("nightShift.proposal", (projectId) => ctx.nightShift.proposal(projectId));
      ctx.ipc.handle("nightShift.decide", (projectId, id, yes) => ctx.nightShift.decide(projectId, id, yes));
      ctx.on("nightShift/changed", (projectId) => ctx.ipc.send("nightShift.changed", projectId));
      ctx.on("nightShift/proposed", (proposal) => ctx.ipc.send("nightShift.proposed", proposal.projectId));
      ctx.on("nightShift/step", (shift, notices) => {
        if (notices.length) ctx.ipc.send("nightShift.step", shift.projectId, notices);
      });
    });
    this.home.inject(["tools"], (ctx) => this.registerTools(ctx));
    this.home.inject(["contributions"], (ctx) => {
      const w = () => NIGHT_SHIFT_WORDS(this.locale());
      ctx.contributions.command({ id: "nightShift.open", title: () => w()("commandTitle"), group: () => w()("commandGroup"), run: () => ({ opens: "night-shift" }) });
      ctx.contributions.statusItem({
        id: "night-shift",
        opens: "night-shift",
        icon: "i-terminal",
        title: () => w()("statusTitle"),
        text: ({ projectId }) => {
          const shift = projectId ? this.current(projectId) : null;
          if (!shift) return null;
          const progress = w()("statusText", { done: shift.counts.delivered + shift.counts.done, total: shift.tickets.length });
          return shift.counts["needs-you"] ? `${progress} · ${w()("statusNeedsYou", { n: shift.counts["needs-you"] })}` : progress;
        }
      });
      ctx.on("nightShift/changed", () => ctx.contributions.changed());
    });
  }

  private locale(): LanguageTag {
    return languageTag(localeOf(this.home));
  }

  private rows(projectId: string, where: string, ...args: unknown[]): NightShift[] {
    if (!this.home.db.has(projectId)) return [];
    const rows = this.home.db.for(projectId).prepare(`SELECT doc_json FROM plugin_nightshift_shifts WHERE project_id = ? ${where}`).all(projectId, ...(args as never[])) as { doc_json: string }[];
    return rows.map((r) => JSON.parse(r.doc_json) as NightShift);
  }

  private running(projectId: string): NightShift | null {
    return this.rows(projectId, "AND status = 'running' ORDER BY started_at DESC LIMIT 1")[0] ?? null;
  }

  private save(shift: NightShift): void {
    this.home.db.for(shift.projectId).prepare("INSERT INTO plugin_nightshift_shifts (id, project_id, status, doc_json, started_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, doc_json = excluded.doc_json").run(shift.id, shift.projectId, shift.status, JSON.stringify(shift), shift.startedAt);
    this.home.emit("nightShift/changed", shift.projectId);
  }

  private note(why: Why | null): string | null {
    if (!why) return null;
    const w = NIGHT_SHIFT_WORDS(this.locale());
    const named = (full: "asked" | "error" | "blocked", bare: "askedBare" | "errorBare" | "blockedBare", text: string) => (text ? w(full, { text }) : w(bare));
    switch (why.kind) {
      case "waits-merge": return w("waitsMerge", { keys: why.keys.join(", ") });
      case "waits-upstream": return w("waitsUpstream", { keys: why.keys.join(", ") });
      case "upstream-stuck": return w("upstreamStuck", { keys: why.keys.join(", ") });
      case "waits-outside": return w("waitsOutside", { keys: why.keys.join(", ") });
      case "waits-elsewhere": return w("waitsElsewhere", { keys: why.keys.join(", ") });
      case "halted": return w(why.halt === "stopped" ? "haltedStopped" : why.halt === "deadline" ? "haltedDeadline" : why.halt === "budget" ? "haltedBudget" : "haltedFailures");
      case "asked": return named("asked", "askedBare", why.text);
      case "error": return named("error", "errorBare", why.text);
      case "blocked": return named("blocked", "blockedBare", why.text);
      case "gate": return w("gate", { text: why.text });
      case "merge-refused": return w("mergeRefused", { text: why.text });
      case "merge-conflict": return w("mergeConflict", { text: why.text });
      case "stopped": return w("stopped");
      case "removed": return w("removed");
      case "edit-late": return w("editLate");
      case "ended": return w("ended");
      case "never-started": return w("neverStarted");
      case "checks-failed": return w("checksFailed");
      case "checks-unknown": return w("checksUnknown");
      case "checks-timeout": return w("checksTimeout");
      case "resumes-spent": return w("resumesSpent");
      case "stalled": return w("stalled");
      case "overtime": return w("overtime");
      case "conflict-unresolved": return w("conflictUnresolved");
      case "found": return w("foundFrom", { key: why.fromKey, text: why.text });
      case "switched": return w(why.cause === "balance" ? "switchedBalance" : "switchedLimit", { from: this.engineTitle(why.from), to: this.engineTitle(why.to) });
      case "no-engine": return w("noEngine", { engine: this.engineTitle(why.engine) });
    }
  }

  private engineTitle(id: string): string {
    return this.home.agent.codeEngines().find((engine) => engine.id === id)?.title ?? id;
  }

  private view(shift: NightShift): NightShiftView {
    const counts = Object.fromEntries(STATES.map((s) => [s, shift.tickets.filter((t) => t.state === s).length])) as Record<TicketState, number>;
    const unpriced = this.home.agent.spentOn(shift.projectId, shift.tickets.map((t) => t.itemId), shift.startedAt).unpriced;
    const w = NIGHT_SHIFT_WORDS(this.locale());
    const moved = (t: ShiftTicket) => t.switches?.at(-1);
    const tickets = shift.tickets.map((t) => ({ ...t, note: this.note(t.why) ?? (t.limit?.noEngine ? w("noEngineWaits") : null) ?? this.note(moved(t) ? { kind: "switched", ...moved(t)! } : null) ?? (t.engineLost ? w("engineLost", { engine: t.engineLost }) : null) }));
    const steps = (shift.steps ?? []).map((step) => ({ ...step, note: this.note(step.why) }));
    return { ...shift, tickets, steps, found: shift.found ?? [], counts, costKnown: shift.tickets.every((t) => settingsFor(shift.settings, t).mode === "run") && unpriced === 0 };
  }

  current(projectId: string): NightShiftView | null {
    const shift = this.running(projectId);
    return shift ? this.view(shift) : null;
  }

  list(projectId: string, limit = 10): NightShiftView[] {
    return this.rows(projectId, "ORDER BY started_at DESC LIMIT ?", limit).map((s) => this.view(s));
  }

  /** The project's work rules, in the order they are tried. */
  rules(projectId: string): WorkRule[] {
    if (!this.home.db.has(projectId)) return [];
    const row = this.home.db.for(projectId).prepare("SELECT doc_json FROM plugin_nightshift_rules WHERE project_id = ?").get(projectId) as { doc_json: string } | undefined;
    return row ? WorkRules.parse(JSON.parse(row.doc_json)) : [];
  }

  setRules(projectId: string, rules: WorkRule[]): WorkRule[] {
    const parsed = WorkRules.parse(rules);
    this.home.db.for(projectId).prepare("INSERT INTO plugin_nightshift_rules (project_id, doc_json) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET doc_json = excluded.doc_json").run(projectId, JSON.stringify(parsed));
    this.home.emit("nightShift/changed", projectId);
    return parsed;
  }

  ruleMatches(projectId: string): Record<string, string> {
    const rules = this.rules(projectId);
    return Object.fromEntries(planCandidates(this.home.items.listAll(projectId)).flatMap((item) => {
      const rule = ruleFor(rules, item);
      return rule ? [[item.id, rule.id]] : [];
    }));
  }

  /** The person's starting point for a run. It always answers: with no model, or a model that fails, it is the backlog's own facts. */
  async plan(projectId: string, fresh = false): Promise<ShiftPlan> {
    if (!this.home.db.has(projectId)) throw new Error("That project is not open on this machine");
    const items = this.home.items.listAll(projectId);
    const w = NIGHT_SHIFT_WORDS(this.locale());
    const rules = this.rules(projectId);
    const byId = new Map(items.map((item) => [item.id, item]));
    // A rule that leaves a ticket out outranks the model: it is the person's standing word.
    const ruled = (plan: ShiftPlan): ShiftPlan => ({
      ...plan,
      nodes: plan.nodes.map((node) => {
        const item = byId.get(node.itemId);
        const rule = item ? ruleFor(rules, item) : null;
        return rule?.then.skip ? { ...node, suggested: false, why: w("ruleSkipped", { name: rule.name }) } : node;
      })
    });
    const notCoding = w("notCoding");
    const llm = this.home.get("llm");
    const worker = llm ? await llm.worker().catch(() => null) : null;
    if (!llm || !worker?.ok) return ruled(readPlan(items, null, notCoding, w("planNoEngine")));
    const system = planSystem(languageName(this.locale()));
    const user = planUser(items, this.home.agent.brief(projectId));
    const asked = `${system}\n${user}`;
    const kept = this.plans.get(projectId);
    const { reply, failed } = await (!fresh && kept?.asked === asked ? kept.answer : this.askPlan(llm, projectId, asked, system, user));
    return ruled(readPlan(items, reply, notCoding, w("planFailed", { detail: failed })));
  }

  private askPlan(llm: LlmService, projectId: string, asked: string, system: string, user: string): Promise<PlanAnswer> {
    const answer: Promise<PlanAnswer> = llm
      .completeJson(PlanReply, { system, user, maxTokens: 4000, timeoutMs: PLAN_TIMEOUT_MS, purpose: "night-shift", ...this.defaultAgent() })
      .then(
        (reply) => ({ reply, failed: "" }),
        (err: unknown) => {
          this.home.logger.warn(`auto run plan: ${errorMessage(err)}`);
          if (this.plans.get(projectId)?.answer === answer) this.plans.delete(projectId);
          return { reply: null, failed: plainError(err) };
        }
      );
    this.plans.set(projectId, { asked, answer });
    return answer;
  }

  /** As in a conversation, the default engine does a run's thinking; one that runs on Tomrade's profiles leaves it to the worker. */
  private defaultAgent(): { preferEngine?: string } {
    const { agent } = this.home;
    const id = agent.answering(agent.settingsOf().defaultEngine);
    return agent.engineOf(id)?.usesModels ? {} : { preferEngine: id };
  }

  start(projectId: string, input: NightShiftInput, now = Date.now()): NightShiftView {
    const { parsed, tickets } = this.checked(projectId, input);
    const remembered = this.home.codeLink.startDefaults();
    // The person took these on the plan, so they are the person's writes, and undo takes them back.
    for (const { from, to } of parsed.dependencies) {
      const item = this.home.items.get(projectId, from);
      if (item && !item.blocks.includes(to)) this.home.items.update(projectId, from, { blocks: [...item.blocks, to] }, "human");
    }
    const mode = parsed.mode ?? remembered?.mode ?? "run";
    const engine = parsed.engine ?? remembered?.engine;
    const options = parsed.options ?? (parsed.engine ? undefined : remembered?.options);
    const permissionMode = mode === "run" ? (parsed.permissionMode ?? (parsed.engine ? undefined : remembered?.permissionMode)) : undefined;
    const shift: NightShift = {
      id: randomUUID(),
      projectId,
      settings: { mode, ...(engine ? { engine } : {}), ...(options ? { options } : {}), ...(permissionMode ? { permissionMode } : {}), concurrency: parsed.concurrency, maxMinutes: parsed.maxMinutes, maxUsd: parsed.maxUsd, maxFailures: parsed.maxFailures, autoMerge: parsed.autoMerge, keepAwake: parsed.keepAwake, judge: parsed.judge, notify: parsed.notify, maxInserts: parsed.maxInserts, whenLimited: parsed.whenLimited },
      tickets,
      status: "running",
      halt: null,
      startedAt: now,
      deadlineAt: now + parsed.maxMinutes * 60_000,
      endedAt: null,
      failStreak: 0,
      spentUsd: 0,
      briefPath: null
    };
    this.save(shift);
    this.going.add(projectId);
    this.kick(0);
    return this.view(shift);
  }

  /**
   * An agent found something outside its ticket. A ticket is filed unless the backlog already has it; whether it joins
   * the run is for the limits and then the worker model, never the agent that found it. Anything less than a clear yes stays in the backlog.
   */
  async report(projectId: string, fromKey: string, input: { title: string; body: string; workType?: "coding" | "general" }): Promise<{ outcome: "inserted" | "later" | "duplicate"; key: string; why: string }> {
    const shift = this.running(projectId);
    const from = shift?.tickets.find((t) => t.key === fromKey.toUpperCase());
    if (!shift || !from) throw new Error(`No auto run is working on ${fromKey}: file it with create_item instead`);
    const w = NIGHT_SHIFT_WORDS(this.locale());
    const pending = () => this.arrivals.get(projectId) ?? [];
    const arrive = (arrival: Arrival) => {
      this.arrivals.set(projectId, [...pending(), arrival]);
      this.kick(0);
    };

    const known = await this.duplicateOf(projectId, input);
    if (known) {
      arrive({ finding: { itemId: known.id, key: known.key, title: known.title, fromKey: from.key, why: w("foundDuplicate"), duplicate: true } });
      return { outcome: "duplicate", key: known.key, why: w("foundDuplicate") };
    }

    const found = this.home.items.get(projectId, from.itemId);
    if (!found) throw new Error(`${from.key} is no longer on the backlog: file it with create_item instead`);
    const workType = input.workType ?? "coding";
    const item = this.home.items.create({ projectId, boardId: found.boardId, parentId: found.parentId, title: input.title, body: `${input.body.trim()}\n\n${w("foundBody", { key: from.key })}`, status: "backlog", workType, by: "ai:night-shift" });
    const later = (why: string) => {
      arrive({ finding: { itemId: item.id, key: item.key, title: item.title, fromKey: from.key, why, duplicate: false } });
      return { outcome: "later" as const, key: item.key, why };
    };
    const gateWord = (gate: NotInserted) => w(`notInserted_${gate}`);
    const gate = insertGate(shift, from, workType, pending().filter((a) => "ticket" in a).length);
    if (gate) return later(gateWord(gate));
    const llm = this.home.get("llm");
    const worker = llm ? await llm.worker().catch(() => null) : null;
    if (!llm || !worker?.ok) return later(w("notInserted_noModel"));
    const verdict = await llm
      .completeJson(Triage, { system: triageSystem(languageName(this.locale())), user: triageUser(input, from, shift, this.home.agent.brief(projectId)), maxTokens: 600, timeoutMs: 120_000, purpose: "night-shift", ...this.defaultAgent() })
      .catch((err: unknown) => {
        this.home.logger.warn(`auto run triage: ${errorMessage(err)}`);
        return null;
      });
    if (!verdict) return later(w("notInserted_noModel"));
    const why = verdict.why.trim();
    if (verdict.decision !== "now") return later(why || w("notInserted_declined"));
    // Time passed while the model thought: the run may have stopped, or filled up.
    const now = this.running(projectId);
    const nowGate = now ? insertGate(now, from, workType, pending().filter((a) => "ticket" in a).length) : "halted";
    if (nowGate) return later(gateWord(nowGate));
    arrive({ ticket: insertedTicket(item, from, why, configOf(item, this.rules(projectId), undefined)), why, fromKey: from.key });
    return { outcome: "inserted", key: item.key, why };
  }

  private async duplicateOf(projectId: string, input: { title: string; body: string }): Promise<{ id: string; key: string; title: string } | null> {
    const same = input.title.trim().toLowerCase();
    const open = this.home.items.listAll(projectId).filter((item) => item.status !== "done" && item.status !== "cancelled");
    const exact = open.find((item) => item.title.trim().toLowerCase() === same);
    if (exact) return exact;
    const tools = this.home.get("tools");
    const similar = (await tools?.execute("find_similar", { title: input.title, body: input.body }, { by: "ai:night-shift", projectId }).catch(() => null)) as { verdict?: string; matches?: { id: string }[] } | null | undefined;
    if (similar?.verdict !== "duplicate" || !similar.matches?.[0]) return null;
    return open.find((item) => item.id === similar.matches![0]!.id) ?? null;
  }

  /** Lets what was reported since the last pass into the run, and says so. */
  private arrive(shift: NightShift, now: number): NightShift {
    const arrivals = this.arrivals.get(shift.projectId);
    if (!arrivals?.length) return shift;
    this.arrivals.delete(shift.projectId);
    let next = shift;
    const steps: ShiftStep[] = [];
    for (const arrival of arrivals) {
      if ("edit" in arrival) {
        const applied = applyEdit(next, arrival.edit, now);
        next = applied.shift;
        steps.push(...applied.steps);
        for (const ticket of applied.stopping) this.stopAgent(shift.projectId, ticket);
      } else if ("ticket" in arrival) {
        next = { ...next, tickets: [...next.tickets, arrival.ticket] };
        steps.push({ at: now, kind: "inserted", itemId: arrival.ticket.itemId, key: arrival.ticket.key, title: arrival.ticket.title, why: { kind: "found", fromKey: arrival.fromKey, text: arrival.why } });
      } else {
        const { finding } = arrival;
        next = { ...next, found: [...(next.found ?? []), finding] };
        steps.push({ at: now, kind: finding.duplicate ? "duplicate" : "found", itemId: finding.itemId, key: finding.key, title: finding.title, why: { kind: "found", fromKey: finding.fromKey, text: finding.why } });
      }
    }
    next = { ...next, steps: [...(next.steps ?? []), ...steps].slice(-MAX_STEPS) };
    this.save(next);
    this.tell(next, steps);
    return next;
  }

  /** Whether a shift going anywhere wants the computer kept awake. */
  wantsAwake(): boolean {
    return [...this.going].some((projectId) => this.running(projectId)?.settings.keepAwake);
  }

  /** A run in the words the person answers: which tickets, and everything that decides how they go. */
  private describe(projectId: string, parsed: z.output<typeof NightShiftInput>, tickets: ShiftTicket[]): { config: string[]; text: string } {
    const w = NIGHT_SHIFT_WORDS(this.locale());
    const remembered = this.home.codeLink.startDefaults();
    const mode = parsed.mode ?? remembered?.mode ?? "run";
    const engine = parsed.engine ?? remembered?.engine;
    const permission = mode === "run" ? (parsed.permissionMode ?? (parsed.engine ? undefined : remembered?.permissionMode)) : undefined;
    const config = [
      w(mode === "terminal" ? "whereTerminal" : "whereRun"),
      w("configAgent", { agent: engine ? this.engineTitle(engine) : w("configAgentDefault") }),
      ...(permission ? [w("configPermission", { mode: permission })] : []),
      w("configLimits", { at: parsed.concurrency, hours: Math.round((parsed.maxMinutes / 60) * 10) / 10 }),
      w(parsed.autoMerge ? "configMerge" : "configNoMerge"),
      ...(parsed.maxUsd !== null ? [w("configBudget", { amount: parsed.maxUsd })] : [])
    ];
    const lines = tickets.map((t) => `- ${t.key} ${t.title}`);
    return { config, text: [w("askStart", { n: tickets.length }), ...lines, "", config.join(" · ")].join("\n") };
  }

  /** Checks what `start` would, so an ask that cannot run says so now. */
  private checked(projectId: string, input: NightShiftInput): { parsed: z.output<typeof NightShiftInput>; tickets: ShiftTicket[] } {
    if (!this.home.db.has(projectId)) throw new Error("That project is not open on this machine");
    if (this.running(projectId)) throw new Error("A night shift is already going in this project: stop it, or wait for it to end");
    const parsed = NightShiftInput.parse(input);
    const rules = this.rules(projectId);
    const taken = [...new Set(parsed.itemIds)].map((id) => this.take(projectId, id, rules, parsed.nodes[id]));
    const problems = taken.filter((t) => typeof t === "string");
    if (problems.length) throw new Error(`A night shift cannot take these: ${problems.join("; ")}`);
    return { parsed, tickets: taken.filter((t) => typeof t !== "string") };
  }

  /** The run an agent asked for, put to the person. It replaces any earlier ask, whose yes no longer counts. */
  propose(projectId: string, input: NightShiftInput, now = Date.now()): ShiftProposal {
    const { parsed, tickets } = this.checked(projectId, input);
    this.dropProposal(projectId);
    const view: ShiftProposal = { id: randomUUID(), projectId, tickets: tickets.map(({ itemId, key, title }) => ({ itemId, key, title })), ...this.describe(projectId, parsed, tickets), expiresAt: now + PROPOSAL_MS };
    const timer = setTimeout(() => this.dropProposal(projectId, view.id), PROPOSAL_MS);
    timer.unref?.();
    this.proposals.set(projectId, { view, input, timer });
    this.home.emit("nightShift/changed", projectId);
    const w = NIGHT_SHIFT_WORDS(this.locale());
    const answer = (yes: boolean) => {
      this.decide(projectId, view.id, yes);
      return w(yes ? "proposalStarted" : "proposalDeclined");
    };
    this.home.emit("nightShift/proposed", view, { title: w("proposalTitle"), yes: w("askYes"), no: w("askNo"), answer });
    return view;
  }

  proposal(projectId: string): ShiftProposal | null {
    return this.proposals.get(projectId)?.view ?? null;
  }

  private dropProposal(projectId: string, id?: string): void {
    const held = this.proposals.get(projectId);
    if (!held || (id && held.view.id !== id)) return;
    clearTimeout(held.timer);
    this.proposals.delete(projectId);
    this.home.emit("nightShift/changed", projectId);
  }

  /** The person's answer to the ask they were shown, and only that one. */
  decide(projectId: string, id: string, yes: boolean, now = Date.now()): NightShiftView | null {
    const held = this.proposals.get(projectId);
    if (!held || held.view.id !== id || held.view.expiresAt <= now) throw new Error(NIGHT_SHIFT_WORDS(this.locale())("proposalGone"));
    this.dropProposal(projectId);
    return yes ? this.start(projectId, held.input, now) : null;
  }

  /** A ticket as a run takes it, or why it cannot, in the person's language. */
  private take(projectId: string, id: string, rules: readonly WorkRule[], manual: NodeConfig | undefined): ShiftTicket | string {
    const w = NIGHT_SHIFT_WORDS(this.locale());
    const item = this.home.items.get(projectId, id);
    if (!item) return w("takeGone", { id });
    if (item.kind !== "ticket") return w("takeEpic", { key: item.key });
    if (!OPEN_TO_START.has(item.status)) return w("takeStatus", { key: item.key, status: item.status });
    // Start would put a second prompt into the session already on it.
    if (this.home.codeLink.store.sessions(projectId, { itemId: item.id, live: true }).some((s) => s.state === "running" || s.state === "waiting")) return w("takeBusy", { key: item.key });
    return { itemId: item.id, key: item.key, title: item.title, state: "queued", why: null, threadId: null, branch: null, startedAt: null, nudgedAt: null, resumes: 0, limitedUntil: null, merge: "none", mergeAt: null, mergeWaits: 0, conflictRetried: false, ...configOf(item, rules, manual) };
  }

  /**
   * The person changes a run while it goes. All of it is checked here, so a refusal changes nothing, and it reaches
   * the run through the next pass, so it cannot race one. Whatever moved in between is left as it stands, and said.
   */
  edit(projectId: string, id: string, input: NightShiftEdit): NightShiftView {
    const w = NIGHT_SHIFT_WORDS(this.locale());
    const shift = this.running(projectId);
    if (!shift || shift.id !== id) throw new Error(w("editEnded"));
    if (shift.halt) throw new Error(w("editHalted"));
    const parsed = NightShiftEdit.parse(input);
    const inRun = new Map(shift.tickets.map((t) => [t.itemId, t]));
    const rules = this.rules(projectId);
    const problems: string[] = [];
    const add: ShiftTicket[] = [];
    for (const itemId of new Set(parsed.add)) {
      const known = inRun.get(itemId);
      const taken = known ? w("takeInRun", { key: known.key }) : this.take(projectId, itemId, rules, parsed.nodes[itemId] ?? undefined);
      if (typeof taken === "string") problems.push(taken);
      else add.push(taken);
    }
    for (const { itemId, stop } of parsed.remove) {
      const ticket = inRun.get(itemId);
      const refused = ticket ? cannotRemove(ticket, stop) : "settled";
      if (refused) problems.push(w(refused === "working" ? "removeWorking" : "removeSettled", { key: ticket?.key ?? itemId }));
    }
    const nodes = Object.fromEntries(Object.entries(parsed.nodes).filter(([itemId]) => inRun.has(itemId)));
    for (const itemId of Object.keys(nodes)) if (inRun.get(itemId)!.state !== "queued") problems.push(w("nodeBegun", { key: inRun.get(itemId)!.key }));
    if (problems.length) throw new Error(w("editRefused", { problems: problems.join("; ") }));
    if (!add.length && !parsed.remove.length && !Object.keys(nodes).length) return this.view(shift);
    this.arrivals.set(projectId, [...(this.arrivals.get(projectId) ?? []), { edit: { add, remove: parsed.remove, nodes } }]);
    this.kick(0);
    return this.view(shift);
  }

  /** It ends with what it did: the worktree and the branch stay as they are. */
  private stopAgent(projectId: string, ticket: ShiftTicket): void {
    // A thread parked on a limit would go on by itself when the limit lifts.
    if (ticket.threadId) this.home.agent.unpark(projectId, ticket.threadId);
    for (const session of this.home.codeLink.store.sessions(projectId, { itemId: ticket.itemId, live: true })) {
      void this.home.codeLink.stopSession(projectId, session.id).catch((err: unknown) => this.home.logger.warn(`auto run could not stop ${ticket.key}: ${errorMessage(err)}`));
    }
  }

  /** No new ticket starts; what is at work finishes. */
  stop(projectId: string, id: string): NightShiftView {
    const shift = this.running(projectId);
    if (!shift || shift.id !== id) throw new Error("That night shift is not going");
    const stopped = { ...shift, halt: "stopped" as const };
    this.save(stopped);
    this.kick(0);
    return this.view(stopped);
  }

  private kick(delay = this.config.settleMs): void {
    if (this.settling) clearTimeout(this.settling);
    this.settling = setTimeout(() => {
      this.settling = null;
      void this.tick();
    }, delay);
  }

  private factsOf(shift: NightShift, now: number): (itemId: string) => TicketFacts {
    const { projectId } = shift;
    const cache = new Map<string, TicketFacts>();
    const read = (ticket: ShiftTicket): TicketFacts => {
      const item = this.home.items.get(projectId, ticket.itemId);
      const blockers = (item?.blockedBy ?? []).flatMap((id) => {
        const upstream = this.home.items.get(projectId, id);
        if (!upstream || upstream.status === "done" || upstream.status === "cancelled") return [];
        const elsewhere = (upstream.status === "doing" || upstream.status === "verifying") && !shift.tickets.some((t) => t.itemId === id);
        return [{ itemId: id, key: upstream.key, ...(elsewhere ? { elsewhere } : {}) }];
      });
      const parked = ticket.threadId ? this.home.agent.parked(projectId, ticket.threadId) : null;
      const interrupted = !!ticket.threadId && !!this.home.agent.store.interruptedRun(projectId, ticket.threadId);
      // A limit past its time has lifted, whether or not its timer has said so yet.
      const session = this.sessionFacts(shift, ticket);
      return { status: item?.status ?? null, blockers, session, parkedUntil: parked && parked.until > now ? parked.until : null, interrupted, outOfBalance: session?.state === "error" && looksOutOfBalance(session.summary) };
    };
    return (itemId) => {
      const known = cache.get(itemId);
      if (known) return known;
      const facts = read(shift.tickets.find((t) => t.itemId === itemId)!);
      cache.set(itemId, facts);
      return facts;
    };
  }

  private sessionFacts(shift: NightShift, ticket: ShiftTicket): SessionFacts | null {
    if (ticket.startedAt === null) return null;
    const mine = this.home.codeLink.store.sessions(shift.projectId, { itemId: ticket.itemId }).filter((s) => s.startedAt >= shift.startedAt || s.threadId === ticket.threadId);
    const latest = mine.sort((a, b) => b.startedAt - a.startedAt)[0];
    return latest ? { state: latest.state, engine: latest.agent, headless: latest.mode === "headless", blocked: !!latest.blocked, asks: !!latest.ask, summary: latest.summary, lastEventAt: latest.lastEventAt } : null;
  }

  /** Every project's shift, one pass each; a change while one runs asks for another. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      for (const projectId of [...this.going]) {
        try {
          await this.pass(projectId, now);
        } catch (err) {
          this.home.logger.warn(`night shift in ${projectId}: ${errorMessage(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
    if (this.again) {
      this.again = false;
      this.kick(0);
    }
  }

  private async pass(projectId: string, now: number): Promise<void> {
    const running = this.running(projectId);
    if (!running) {
      this.going.delete(projectId);
      this.arrivals.delete(projectId);
      return;
    }
    const shift = this.arrive(running, now);
    const spent = this.home.agent.spentOn(projectId, shift.tickets.map((t) => t.itemId), shift.startedAt);
    const { shift: next, actions } = advance({ ...shift, spentUsd: spent.usd }, this.factsOf(shift, now), now);
    if (JSON.stringify(next) !== JSON.stringify(shift)) this.save(next);
    let current = next;
    for (const action of actions) current = await this.act(current, action, now);
    const steps = stepsBetween(shift, current, now);
    if (steps.length) current = { ...current, steps: [...(current.steps ?? []), ...steps].slice(-MAX_STEPS) };
    if (current !== next) this.save(current);
    if (steps.length) this.tell(current, steps);
    if (current.status === "ended") {
      this.going.delete(projectId);
      this.home.emit("nightShift/changed", projectId);
      this.home.emit("nightShift/ended", this.view(current));
      void this.brief(current).catch((err) => this.home.logger.warn(`night shift report in ${projectId}: ${errorMessage(err)}`));
    } else if (current !== next) this.kick(0);
  }

  /** Tickets a run never reached are counted in the report; one message each would say nothing more. */
  private tell(shift: NightShift, steps: ShiftStep[]): void {
    const w = NIGHT_SHIFT_WORDS(this.locale());
    const view = this.view(shift);
    const told = steps.filter((step) => step.kind !== "skipped" && (shift.settings.notify !== "stuck" || isStuck(step.kind)));
    const notices = told.map((step) => {
      const word = w(`step_${step.kind}`);
      const note = this.note(step.why);
      return { key: `${shift.id}:${step.itemId}:${step.kind}:${step.at}`, title: `${step.key} ${step.title}`, body: note ? `${word}: ${note}` : word };
    });
    const stuck = steps.some((step) => isStuck(step.kind)) ? { title: w("stuckTitle"), body: w("stuckBody", { attention: view.counts["needs-you"] + view.counts.failed, done: view.counts.delivered + view.counts.done, total: shift.tickets.length }) } : null;
    this.home.emit("nightShift/step", view, notices, stuck);
  }

  /** One model call per delivery, all at once and within one deadline, and a report that stands without any of them. */
  private async deliveries(shift: NightShiftView): Promise<Map<string, Delivery>> {
    const { codeLink, items } = this.home;
    const llm = shift.settings.judge ? this.home.get("llm") : null;
    const worker = llm ? await llm.worker().catch(() => null) : null;
    const deadline = AbortSignal.timeout(JUDGING_MS);
    const delivered = shift.tickets.filter((t) => t.state === "delivered" || t.state === "done");
    const judged = await Promise.all(
      delivered.map(async (ticket): Promise<[string, Delivery]> => {
        const prUrl = codeLink.store.links(shift.projectId, ticket.itemId).find((l) => l.prUrl)?.prUrl ?? null;
        const diff = await codeLink.deliveryDiff(shift.projectId, ticket.itemId).catch(() => null);
        let judgement: Judgement | null = null;
        if (llm && worker?.ok && diff) {
          const item = items.get(shift.projectId, ticket.itemId);
          const said = codeLink.store.sessions(shift.projectId, { itemId: ticket.itemId }).sort((a, b) => b.startedAt - a.startedAt)[0]?.summary ?? null;
          judgement = await llm
            .completeJson(Judgement, { system: judgeSystem(languageName(this.locale())), user: judgeUser({ key: ticket.key, title: ticket.title, body: item?.body ?? null }, said, diff), maxTokens: 2000, timeoutMs: 120_000, signal: deadline, purpose: "night-shift", ...this.defaultAgent() })
            .catch((err: unknown) => {
              this.home.logger.warn(`night shift report on ${ticket.key}: ${deadline.aborted ? "not judged in time" : errorMessage(err)}`);
              return null;
            });
        }
        return [ticket.itemId, { prUrl, stat: diff?.stat ?? null, lines: diff?.lines ?? null, judgement }];
      })
    );
    return new Map(judged);
  }

  /** What the shift's runs cost by ticket and by agent; the report leaves the section out when nothing ran in the app. */
  private spend(shift: NightShift): BriefSpend {
    const { tickets, engines } = this.home.agent.spendByTicket(shift.projectId, shift.tickets.map((t) => t.itemId), shift.startedAt);
    const line = (t: { costUsd: number | null; runs: number; costUnknownRuns: number }): SpendLine => ({ usd: t.costUsd, runs: t.runs, unpriced: t.costUnknownRuns });
    return {
      tickets: new Map([...tickets].map(([itemId, s]) => [itemId, line(s.totals)])),
      agents: engines.map((e) => ({ title: e.title, ...line(e) }))
    };
  }

  /** Writes the morning report into the project's Files and tells the person; returns where it went. */
  async brief(shift: NightShift): Promise<string | null> {
    const view = this.view(shift);
    const w = NIGHT_SHIFT_WORDS(this.locale());
    const ended = new Date(shift.endedAt ?? Date.now());
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = `${ended.getFullYear()}-${pad(ended.getMonth() + 1)}-${pad(ended.getDate())}`;
    const stamp = `${day} ${pad(ended.getHours())}-${pad(ended.getMinutes())}`;
    const body = renderBrief(view, await this.deliveries(view), w, day, this.spend(shift));
    const files = this.home.get("files");
    let briefPath: string | null = null;
    if (files) {
      briefPath = `${w("folder")}/${stamp}.md`;
      await files.write(shift.projectId, briefPath, body, { message: w("title", { date: day }) });
      this.save({ ...shift, briefPath });
    }
    const notice = { title: w("notifyTitle"), body: w("notifyBody", { review: view.counts.delivered, merged: view.counts.done, attention: view.counts["needs-you"] + view.counts.failed }) };
    this.home.get("alerts")?.notify(notice);
    this.home.emit("nightShift/briefed", { ...view, briefPath }, notice);
    return briefPath;
  }

  private async act(shift: NightShift, action: Action, now: number): Promise<NightShift> {
    const ticket = shift.tickets.find((t) => t.itemId === action.itemId)!;
    if (action.kind === "merge") return this.merge(shift, ticket, now);
    if (action.kind === "switch") return this.switchEngine(shift, ticket, now);
    const { how, engineLost } = await this.how(shift, ticket);
    return this.launch(shift, ticket, action.kind === "start" ? { ...how, message: reportLine(ticket.key) } : how, engineLost ? { engineLost } : {});
  }

  /**
   * The agent stopped on quota, so the next one takes the ticket where it stands: the same thread, branch and worktree,
   * with a session of its own. A ticket no agent is left for stays as `outOfEngines` says.
   */
  private async switchEngine(shift: NightShift, ticket: ShiftTicket, now: number): Promise<NightShift> {
    const { projectId } = shift;
    const onThread = this.home.codeLink.store.sessions(projectId, { itemId: ticket.itemId }).filter((s) => s.threadId === ticket.threadId);
    const from = onThread[0]?.agent ?? settingsFor(shift.settings, ticket).engine ?? "";
    const cause = ticket.limit?.cause ?? "limit";
    const replace = (next: ShiftTicket): ShiftTicket[] => shift.tickets.map((t) => (t.itemId === ticket.itemId ? next : t));
    const capability = this.home.items.get(projectId, ticket.itemId)?.workType === "general" ? "general" : "code";
    const to = await this.home.codeLink.nextEngine(triedEngines(ticket, from), { capability, terminal: settingsFor(shift.settings, ticket).mode === "terminal" }).catch(() => null);
    if (!to) {
      const next = outOfEngines(ticket, from);
      return { ...shift, tickets: replace(next), failStreak: shift.failStreak + (next.state === "needs-you" ? 1 : 0) };
    }
    const { limit: _over, ...rest } = ticket;
    const moved: ShiftTicket = { ...rest, state: "running", why: null, limitedUntil: null, nudgedAt: now, switches: [...(ticket.switches ?? []), { from, to, cause, at: now }] };
    // Its thread must not go on by itself when the limit lifts, nor its old agent be told to.
    if (ticket.threadId) this.home.agent.unpark(projectId, ticket.threadId);
    for (const session of onThread) await this.home.codeLink.stopSession(projectId, session.id);
    // Ahead of Start, which leaves a thread with an open question on its engine: nobody is there to answer it.
    if (ticket.threadId && this.home.agent.store.thread(projectId, ticket.threadId)) this.home.agent.setEngine(projectId, ticket.threadId, to);
    const { how } = await this.how(shift, moved);
    return this.launch({ ...shift, tickets: replace(moved) }, moved, { ...how, message: `${takeOverLine(this.engineTitle(from), cause, ticket.said)}\n\n${reportLine(ticket.key)}` });
  }

  private async launch(shift: NightShift, ticket: ShiftTicket, opts: StartOptions, fields: Partial<ShiftTicket> = {}): Promise<NightShift> {
    const patch = (more: Partial<ShiftTicket>): NightShift => ({ ...shift, tickets: shift.tickets.map((t) => (t.itemId === ticket.itemId ? { ...t, ...more } : t)) });
    try {
      const result = await this.home.codeLink.start(shift.projectId, ticket.itemId, opts);
      if (result.ok) return patch({ threadId: result.threadId ?? ticket.threadId, branch: result.branch || ticket.branch, ...fields });
      // Something filed a dependency since the look: it waits like any other blocked ticket.
      if (result.gate === "blocked") return patch({ state: "queued", startedAt: null, nudgedAt: null });
      return failTicket(shift, ticket.itemId, { kind: "gate", text: result.message });
    } catch (err) {
      return failTicket(shift, ticket.itemId, { kind: "gate", text: errorMessage(err) });
    }
  }

  /** How to start or go on with a ticket. An agent its config names that cannot run costs the node its config, not the ticket. */
  private async how(shift: NightShift, ticket: ShiftTicket): Promise<{ how: Omit<TicketSettings, "autoMerge" | "whenLimited">; engineLost: string | null }> {
    // An agent it moved to was picked as able just now, and falling back would be to the one that stopped.
    const wanted = ticket.switches?.length ? undefined : ticket.config?.engine;
    const ready = wanted ? await this.home.agent.engineViews().then((views) => !!views.find((e) => e.id === wanted)?.ok).catch(() => false) : true;
    const config = ready ? ticket : { config: { ...ticket.config, engine: undefined, options: undefined, permissionMode: undefined } };
    const { autoMerge: _autoMerge, whenLimited: _whenLimited, ...how } = settingsFor(shift.settings, { ...config, ...(ticket.switches ? { switches: ticket.switches } : {}) });
    return { how, engineLost: ready ? null : wanted! };
  }

  private async merge(shift: NightShift, ticket: ShiftTicket, now: number): Promise<NightShift> {
    const patch = (fields: Partial<ShiftTicket>): NightShift => ({ ...shift, tickets: shift.tickets.map((t) => (t.itemId === ticket.itemId ? { ...t, ...fields } : t)) });
    const refuse = (why: Why) => patch({ merge: "refused", mergeAt: null, why });
    try {
      const checks = await this.home.codeLink.prChecks(shift.projectId, ticket.itemId);
      if (checks === "failed") return refuse({ kind: "checks-failed" });
      if (checks === "unknown") return refuse({ kind: "checks-unknown" });
      if (checks === "pending") return ticket.mergeWaits >= MERGE_WAITS ? refuse({ kind: "checks-timeout" }) : patch({ merge: "waiting", mergeAt: now + MERGE_WAIT_MS, mergeWaits: ticket.mergeWaits + 1 });
      const merged = await this.home.codeLink.merge(shift.projectId, ticket.itemId);
      if (merged.merged) return patch({ merge: "merged", mergeAt: null, why: null });
      if (merged.cause === "conflict") return await this.resolveConflict(shift, ticket, merged.message, now);
      return refuse({ kind: "merge-refused", text: merged.message });
    } catch (err) {
      return refuse({ kind: "merge-refused", text: errorMessage(err) });
    }
  }

  /** One trip back to its agent, in the place the shift runs; what depends on the ticket keeps waiting meanwhile. */
  private async resolveConflict(shift: NightShift, ticket: ShiftTicket, message: string, now: number): Promise<NightShift> {
    const patch = (fields: Partial<ShiftTicket>): ShiftTicket[] => shift.tickets.map((t) => (t.itemId === ticket.itemId ? { ...t, ...fields } : t));
    const unresolved = (): NightShift => ({ ...shift, failStreak: shift.failStreak + 1, tickets: patch({ state: "needs-you", merge: "refused", mergeAt: null, conflictRetried: true, why: { kind: "conflict-unresolved" } }) });
    if (ticket.conflictRetried) return unresolved();
    // A shift past its limits spends nothing more on it.
    if (shift.halt) return { ...shift, tickets: patch({ merge: "refused", mergeAt: null, why: { kind: "merge-conflict", text: message } }) };
    const { how } = await this.how(shift, ticket);
    const entry = await this.home.codeLink.resolveMerge(shift.projectId, ticket.itemId, null, how).catch(() => null);
    if (!entry?.ok) return unresolved();
    return { ...shift, tickets: patch({ state: "running", why: null, merge: "none", mergeAt: null, mergeWaits: 0, conflictRetried: true, nudgedAt: now, threadId: entry.threadId ?? ticket.threadId }) };
  }

  private registerTools(ctx: Context): void {
    ctx.tools.kit("night-shift", "work through a batch of tickets unattended, overnight");
    const keyToId = (projectId: string, key: string): string => {
      const item = ctx.items.getByKey(projectId, key.toUpperCase());
      if (!item) throw new Error(`no ticket ${key} in this project`);
      return item.id;
    };
    ctx.tools.register(
      defineTool({
        name: "plan_night_shift",
        kit: "night-shift",
        title: "Plan an auto run",
        readOnly: true,
        description: "What an auto run of this project's backlog would take: the tickets suggested, those left out and why, dependencies the backlog lacks, and how many to run at once. Show the person this before asking to start.",
        input: z.object({ projectId: z.string().optional() }),
        execute: async (args, inv) => {
          const plan = await this.plan(requireProjectId("plan_night_shift", args.projectId, inv));
          return { analyzed: plan.analyzed, why: plan.why, summary: plan.summary, suggested: plan.nodes.filter((n) => n.suggested).map((n) => n.key), leftOut: plan.nodes.filter((n) => !n.suggested && n.why).map((n) => ({ key: n.key, why: n.why })), dependencies: plan.proposed.map((e) => ({ before: e.fromKey, after: e.toKey, why: e.why })), concurrency: plan.concurrency, concurrencyWhy: plan.concurrencyWhy };
        }
      })
    );
    ctx.tools.register(
      defineTool({
        name: "start_night_shift",
        kit: "night-shift",
        title: "Ask to start an auto run",
        description:
          "Asks the person to start an auto run: this does not start one by itself, and you cannot answer for them. They see the tickets and every setting and press Start, in the app or in their direct chat. Calling again replaces what they were asked. Once started it works through these tickets unattended, each with its own coding agent on its own branch, in dependency order, within the limits given. A ticket starts only when nothing it waits on is open. Upstream tickets must merge before what depends on them can start, so a chain runs only with autoMerge; without it the dependants are left waiting, not failed. autoMerge merges a delivery only once its pull request's checks pass; on a conflict its agent is sent back once to resolve it.",
        input: z.object({
          keys: z.array(z.string().min(1)).min(1).max(50).describe('Ticket keys in the order to try them, e.g. ["TOM-42", "TOM-43"]'),
          where: z.enum(["terminal", "session"]).optional().describe("terminal: each agent in a pane of the Terminal window. session: background sessions in the assistant panel. Absent goes as Start last went. Ask the user when you do not know which they want."),
          engine: z.string().min(1).optional().describe("The coding agent's engine id; absent goes as Start last went"),
          permissionMode: z.string().min(1).optional().describe("Sessions only. A mode that asks before acting stalls the ticket until morning."),
          concurrency: z.number().int().min(1).max(8).optional().describe("Tickets at work at once; 2 by default. plan_night_shift suggests a number"),
          maxHours: z.number().min(0.1).max(24).optional().describe("No new ticket starts after this long; 8 by default"),
          maxUsd: z.number().positive().optional().describe("No new ticket starts past this spend. Terminal agents report no cost, so it cannot hold them."),
          maxFailures: z.number().int().min(1).max(20).optional().describe("Failures in a row before no new ticket starts; 3 by default"),
          autoMerge: z.boolean().optional().describe("Only when the user said so: merge each delivery once its checks pass"),
          whenLimited: z.enum(["switch", "wait"]).optional().describe("When an agent runs out of quota: switch to the next available agent (the default), or wait for it to recover"),
          projectId: z.string().optional()
        }),
        execute: async (args, inv) => {
          const projectId = requireProjectId("start_night_shift", args.projectId, inv);
          const input: NightShiftInput = {
            itemIds: args.keys.map((key) => keyToId(projectId, key)),
            ...(args.where ? { mode: args.where === "terminal" ? ("terminal" as const) : ("run" as const) } : {}),
            ...(args.engine ? { engine: args.engine } : {}),
            ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
            ...(args.concurrency ? { concurrency: args.concurrency } : {}),
            ...(args.maxHours ? { maxMinutes: Math.round(args.maxHours * 60) } : {}),
            ...(args.maxUsd ? { maxUsd: args.maxUsd } : {}),
            ...(args.maxFailures ? { maxFailures: args.maxFailures } : {}),
            ...(args.autoMerge ? { autoMerge: true } : {}),
            ...(args.whenLimited ? { whenLimited: args.whenLimited } : {})
          };
          const w = NIGHT_SHIFT_WORDS(this.locale());
          // Where the run can ask, the person answers here, in the conversation; a null is a cancelled call, and starts nothing.
          if (inv.ask) {
            const { parsed, tickets } = this.checked(projectId, input);
            const { text } = this.describe(projectId, parsed, tickets);
            if ((await inv.ask(text, [w("askYes"), w("askNo")])) !== w("askYes")) return { started: false, why: "The person said no. Nothing started." };
            return { started: true, shift: this.start(projectId, input) };
          }
          const proposal = this.propose(projectId, input);
          return { started: false, awaiting: "the person", asked: proposal.text, expiresAt: new Date(proposal.expiresAt).toISOString(), note: "Nothing has started and you cannot start it: tell the person it waits for their Start, in the app or in their direct chat. If they want anything different, call this again; that replaces what they were asked." };
        }
      })
    );
    ctx.tools.register(
      defineTool({
        name: "report_finding",
        kit: "code",
        title: "Report a problem outside your ticket",
        description:
          "During an auto run: you found a real problem outside your own ticket. Say so here instead of fixing it. A ticket is filed unless one exists, and something other than you decides whether it joins the run. It does not change your ticket: go on with it, whatever the answer.",
        input: z.object({
          from: z.string().min(1).describe("The ticket you are working on, e.g. TOM-42"),
          title: z.string().min(1).max(200).describe("What is wrong, as a ticket title"),
          body: z.string().min(1).max(4000).describe("What you saw and where, enough for another agent to start from"),
          workType: z.enum(["coding", "general"]).optional().describe("general: it needs a person, not code"),
          projectId: z.string().optional()
        }),
        execute: (args, inv) => this.report(requireProjectId("report_finding", args.projectId, inv), args.from, { title: args.title, body: args.body, ...(args.workType ? { workType: args.workType } : {}) })
      })
    );
    ctx.tools.register(
      defineTool({
        name: "night_shift_status",
        kit: "night-shift",
        title: "Night shift status",
        description: "The project's night shift going now, else its last one: each ticket's state and why, what it spent, and why it stopped.",
        input: z.object({ projectId: z.string().optional() }),
        execute: (args, inv) => {
          const projectId = requireProjectId("night_shift_status", args.projectId, inv);
          return this.current(projectId) ?? this.list(projectId, 1)[0] ?? null;
        }
      })
    );
    ctx.tools.register(
      defineTool({
        name: "stop_night_shift",
        kit: "night-shift",
        title: "Stop the night shift",
        description: "Only on the user's word: no new ticket starts and nothing more is merged. What is at work finishes.",
        input: z.object({ projectId: z.string().optional() }),
        execute: (args, inv) => {
          const projectId = requireProjectId("stop_night_shift", args.projectId, inv);
          const shift = this.running(projectId);
          if (!shift) throw new Error("No night shift is going in this project");
          return this.stop(projectId, shift.id);
        }
      })
    );
  }
}
