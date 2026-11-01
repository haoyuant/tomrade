import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import { z } from "zod";
import { languageTag, type LanguageTag } from "@tomradex/domain";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/code-link";
import type {} from "@tomradex/contributions";
import type { StartOptions } from "@tomradex/code-link";
import type {} from "@tomradex/db";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type {} from "@tomradex/settings";
import { errorMessage, localeOf } from "@tomradex/contracts";
import { defineTool, requireProjectId } from "@tomradex/tools";
import { MERGE_WAITS, MERGE_WAIT_MS, advance, failTicket, type Action, type NightShift, type SessionFacts, type ShiftTicket, type TicketFacts, type TicketState, type Why } from "./rules.js";
import { NIGHT_SHIFT_WORDS } from "./words.js";

export const NightShiftInput = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(50),
  /** Terminal panes or background sessions; absent goes as Start last went. */
  mode: z.enum(["terminal", "run"]).optional(),
  engine: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  permissionMode: z.string().min(1).optional(),
  concurrency: z.number().int().min(1).max(8).default(2),
  maxMinutes: z.number().int().min(5).max(24 * 60).default(8 * 60),
  maxUsd: z.number().positive().nullable().default(null),
  maxFailures: z.number().int().min(1).max(20).default(3),
  autoMerge: z.boolean().default(false)
});
export type NightShiftInput = z.input<typeof NightShiftInput>;

export interface NightShiftTicketView extends ShiftTicket {
  /** Why it stands where it does, in the person's language. */
  note: string | null;
}

export interface NightShiftView extends Omit<NightShift, "tickets"> {
  tickets: NightShiftTicketView[];
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
    "nightShift/ended"(shift: NightShiftView): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "nightShift.current": (projectId: string) => NightShiftView | null;
    "nightShift.list": (projectId: string, limit?: number) => NightShiftView[];
    "nightShift.start": (projectId: string, input: NightShiftInput) => NightShiftView;
    "nightShift.stop": (projectId: string, id: string) => NightShiftView;
  }
  interface Broadcasts {
    "nightShift.changed": (projectId: string) => void;
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
  }
];

/** A shift runs on the machine it was started on: its agents and worktrees are here, and a second machine must not run it again. */
export const TABLES = { plugin_nightshift_shifts: { project: "project_id", export: false } } as const;

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
const STATES: TicketState[] = ["queued", "running", "limited", "needs-you", "delivered", "done", "failed", "skipped"];

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
        this.kick();
      }
    };
    for (const projectId of this.home.db.openIds()) resume(projectId);
    this.home.on("db/opened", resume);
    this.home.on("codeLink/changed", (projectId) => {
      if (this.going.has(projectId)) this.kick();
    });
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("nightShift.current", (projectId) => ctx.nightShift.current(projectId));
      ctx.ipc.handle("nightShift.list", (projectId, limit) => ctx.nightShift.list(projectId, limit));
      ctx.ipc.handle("nightShift.start", (projectId, input) => ctx.nightShift.start(projectId, input));
      ctx.ipc.handle("nightShift.stop", (projectId, id) => ctx.nightShift.stop(projectId, id));
      ctx.on("nightShift/changed", (projectId) => ctx.ipc.send("nightShift.changed", projectId));
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
      case "halted": return w(why.halt === "stopped" ? "haltedStopped" : why.halt === "deadline" ? "haltedDeadline" : why.halt === "budget" ? "haltedBudget" : "haltedFailures");
      case "asked": return named("asked", "askedBare", why.text);
      case "error": return named("error", "errorBare", why.text);
      case "blocked": return named("blocked", "blockedBare", why.text);
      case "gate": return w("gate", { text: why.text });
      case "merge-refused": return w("mergeRefused", { text: why.text });
      case "merge-conflict": return w("mergeConflict", { text: why.text });
      case "stopped": return w("stopped");
      case "ended": return w("ended");
      case "never-started": return w("neverStarted");
      case "checks-failed": return w("checksFailed");
      case "checks-unknown": return w("checksUnknown");
      case "checks-timeout": return w("checksTimeout");
      case "resumes-spent": return w("resumesSpent");
      case "stalled": return w("stalled");
      case "overtime": return w("overtime");
    }
  }

  private view(shift: NightShift): NightShiftView {
    const counts = Object.fromEntries(STATES.map((s) => [s, shift.tickets.filter((t) => t.state === s).length])) as Record<TicketState, number>;
    const unpriced = this.home.agent.spentOn(shift.projectId, shift.tickets.map((t) => t.itemId), shift.startedAt).unpriced;
    return { ...shift, tickets: shift.tickets.map((t) => ({ ...t, note: this.note(t.why) })), counts, costKnown: shift.settings.mode === "run" && unpriced === 0 };
  }

  current(projectId: string): NightShiftView | null {
    const shift = this.running(projectId);
    return shift ? this.view(shift) : null;
  }

  list(projectId: string, limit = 10): NightShiftView[] {
    return this.rows(projectId, "ORDER BY started_at DESC LIMIT ?", limit).map((s) => this.view(s));
  }

  start(projectId: string, input: NightShiftInput, now = Date.now()): NightShiftView {
    if (!this.home.db.has(projectId)) throw new Error("That project is not open on this machine");
    if (this.running(projectId)) throw new Error("A night shift is already going in this project: stop it, or wait for it to end");
    const parsed = NightShiftInput.parse(input);
    const remembered = this.home.codeLink.startDefaults();
    const tickets: ShiftTicket[] = [];
    const problems: string[] = [];
    for (const id of new Set(parsed.itemIds)) {
      const item = this.home.items.get(projectId, id);
      if (!item) problems.push(`no ticket ${id}`);
      else if (item.kind !== "ticket") problems.push(`${item.key} is an epic`);
      else if (!OPEN_TO_START.has(item.status)) problems.push(`${item.key} is ${item.status}`);
      // Start would put a second prompt into the session already on it.
      else if (this.home.codeLink.store.sessions(projectId, { itemId: item.id, live: true }).some((s) => s.state === "running" || s.state === "waiting")) problems.push(`${item.key} has an agent on it already`);
      else tickets.push({ itemId: item.id, key: item.key, title: item.title, state: "queued", why: null, threadId: null, branch: null, startedAt: null, nudgedAt: null, resumes: 0, limitedUntil: null, merge: "none", mergeAt: null, mergeWaits: 0 });
    }
    if (problems.length) throw new Error(`A night shift cannot take these: ${problems.join("; ")}`);
    const mode = parsed.mode ?? remembered?.mode ?? "run";
    const engine = parsed.engine ?? remembered?.engine;
    const options = parsed.options ?? (parsed.engine ? undefined : remembered?.options);
    const permissionMode = mode === "run" ? (parsed.permissionMode ?? (parsed.engine ? undefined : remembered?.permissionMode)) : undefined;
    const shift: NightShift = {
      id: randomUUID(),
      projectId,
      settings: { mode, ...(engine ? { engine } : {}), ...(options ? { options } : {}), ...(permissionMode ? { permissionMode } : {}), concurrency: parsed.concurrency, maxMinutes: parsed.maxMinutes, maxUsd: parsed.maxUsd, maxFailures: parsed.maxFailures, autoMerge: parsed.autoMerge },
      tickets,
      status: "running",
      halt: null,
      startedAt: now,
      deadlineAt: now + parsed.maxMinutes * 60_000,
      endedAt: null,
      failStreak: 0,
      spentUsd: 0
    };
    this.save(shift);
    this.going.add(projectId);
    this.kick(0);
    return this.view(shift);
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
        return upstream && upstream.status !== "done" && upstream.status !== "cancelled" ? [{ itemId: id, key: upstream.key }] : [];
      });
      const parked = ticket.threadId ? this.home.agent.parked(projectId, ticket.threadId) : null;
      const interrupted = !!ticket.threadId && !!this.home.agent.store.interruptedRun(projectId, ticket.threadId);
      // A limit past its time has lifted, whether or not its timer has said so yet.
      return { status: item?.status ?? null, blockers, session: this.sessionFacts(shift, ticket), parkedUntil: parked && parked.until > now ? parked.until : null, interrupted };
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
    return latest ? { state: latest.state, headless: latest.mode === "headless", blocked: !!latest.blocked, asks: !!latest.ask, summary: latest.summary, lastEventAt: latest.lastEventAt } : null;
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
    const shift = this.running(projectId);
    if (!shift) {
      this.going.delete(projectId);
      return;
    }
    const spent = this.home.agent.spentOn(projectId, shift.tickets.map((t) => t.itemId), shift.startedAt);
    const { shift: next, actions } = advance({ ...shift, spentUsd: spent.usd }, this.factsOf(shift, now), now);
    if (JSON.stringify(next) !== JSON.stringify(shift)) this.save(next);
    let current = next;
    for (const action of actions) current = await this.act(current, action, now);
    if (current !== next) this.save(current);
    if (current.status === "ended") {
      this.going.delete(projectId);
      this.home.emit("nightShift/ended", this.view(current));
    } else if (current !== next) this.kick(0);
  }

  private async act(shift: NightShift, action: Action, now: number): Promise<NightShift> {
    const ticket = shift.tickets.find((t) => t.itemId === action.itemId)!;
    if (action.kind === "merge") return this.merge(shift, ticket, now);
    const { mode, engine, options, permissionMode } = shift.settings;
    const opts: StartOptions = { mode, ...(engine ? { engine } : {}), ...(options ? { options } : {}), ...(permissionMode ? { permissionMode } : {}) };
    const patch = (fields: Partial<ShiftTicket>): NightShift => ({ ...shift, tickets: shift.tickets.map((t) => (t.itemId === ticket.itemId ? { ...t, ...fields } : t)) });
    try {
      const result = await this.home.codeLink.start(shift.projectId, ticket.itemId, opts);
      if (result.ok) return patch({ threadId: result.threadId ?? ticket.threadId, branch: result.branch || ticket.branch });
      // Something filed a dependency since the look: it waits like any other blocked ticket.
      if (result.gate === "blocked") return patch({ state: "queued", startedAt: null, nudgedAt: null });
      return failTicket(shift, ticket.itemId, { kind: "gate", text: result.message });
    } catch (err) {
      return failTicket(shift, ticket.itemId, { kind: "gate", text: errorMessage(err) });
    }
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
      return refuse({ kind: merged.cause === "conflict" ? "merge-conflict" : "merge-refused", text: merged.message });
    } catch (err) {
      return refuse({ kind: "merge-refused", text: errorMessage(err) });
    }
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
        name: "start_night_shift",
        kit: "night-shift",
        title: "Start a night shift",
        description:
          "Only on the user's word: works through these tickets unattended, each with its own coding agent on its own branch, in dependency order, within the limits given, and returns at once. A ticket starts only when nothing it waits on is open. Upstream tickets must merge before what depends on them can start, so a chain runs only with autoMerge; without it the dependants are left waiting, not failed. autoMerge merges a delivery only once its pull request's checks pass.",
        input: z.object({
          keys: z.array(z.string().min(1)).min(1).max(50).describe('Ticket keys in the order to try them, e.g. ["TOM-42", "TOM-43"]'),
          where: z.enum(["terminal", "session"]).optional().describe("terminal: each agent in a pane of the Terminal window. session: background sessions in the assistant panel. Absent goes as Start last went. Ask the user when you do not know which they want."),
          engine: z.string().min(1).optional().describe("The coding agent's engine id; absent goes as Start last went"),
          permissionMode: z.string().min(1).optional().describe("Sessions only. A mode that asks before acting stalls the ticket until morning."),
          concurrency: z.number().int().min(1).max(8).optional().describe("Tickets at work at once; 2 by default"),
          maxHours: z.number().min(0.1).max(24).optional().describe("No new ticket starts after this long; 8 by default"),
          maxUsd: z.number().positive().optional().describe("No new ticket starts past this spend. Terminal agents report no cost, so it cannot hold them."),
          maxFailures: z.number().int().min(1).max(20).optional().describe("Failures in a row before no new ticket starts; 3 by default"),
          autoMerge: z.boolean().optional().describe("Only when the user said so: merge each delivery once its checks pass"),
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
            ...(args.autoMerge ? { autoMerge: true } : {})
          };
          if (inv.ask) {
            const w = NIGHT_SHIFT_WORDS(this.locale());
            const parsed = NightShiftInput.parse(input);
            const mode = parsed.mode ?? ctx.codeLink.startDefaults()?.mode ?? "run";
            const question = w("askStart", { n: parsed.itemIds.length, where: w(mode === "terminal" ? "whereTerminal" : "whereRun"), at: parsed.concurrency, hours: Math.round((parsed.maxMinutes / 60) * 10) / 10, merge: parsed.autoMerge ? w("mergeOn") : "" });
            if ((await inv.ask(question, [w("askYes"), w("askNo")])) !== w("askYes")) return { started: false };
          }
          return { started: true, shift: this.start(projectId, input) };
        }
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
