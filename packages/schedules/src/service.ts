import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { Author, Priority } from "@tomradex/domain";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/code-link";
import type {} from "@tomradex/db";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type {} from "@tomradex/settings";
import { defineTool, requireProjectId } from "@tomradex/tools";
import { Cadence, localDate, nextRun } from "./cadence.js";
import { suggestions, type Suggestion } from "./suggestions.js";
import { TemplateInput, fillTemplate } from "./template.js";

export interface Template extends z.output<typeof TemplateInput> {
  id: string;
  projectId: string;
  /** The suggestion it was added from, if any. */
  suggestion: string | null;
  createdAt: number;
  updatedAt: number;
}

export const ScheduleInput = z.object({
  templateId: z.string().min(1),
  cadence: Cadence,
  enabled: z.boolean().default(true),
  /** A time missed while Tomrade was closed or asleep runs once when it is back; off skips it. */
  catchUp: z.boolean().default(true)
});
export type ScheduleInput = z.input<typeof ScheduleInput>;

export interface Schedule extends z.output<typeof ScheduleInput> {
  id: string;
  projectId: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
}

export type RunTrigger = "schedule" | "catch-up" | "manual";

export interface TemplateRun {
  id: string;
  templateId: string;
  scheduleId: string | null;
  at: number;
  trigger: RunTrigger;
  ok: boolean;
  itemIds: string[];
  threadId: string | null;
  error: string | null;
}

declare module "cordis" {
  interface Context {
    schedules: Schedules;
  }
  interface Events {
    /** A project's templates, schedules or runs changed. */
    "schedules/changed"(projectId: string): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "schedules.templates": (projectId: string) => Template[];
    "schedules.createTemplate": (projectId: string, input: TemplateInput) => Template;
    "schedules.updateTemplate": (projectId: string, id: string, input: TemplateInput) => Template;
    "schedules.removeTemplate": (projectId: string, id: string) => void;
    "schedules.run": (projectId: string, templateId: string) => TemplateRun;
    "schedules.list": (projectId: string) => Schedule[];
    "schedules.create": (projectId: string, input: ScheduleInput) => Schedule;
    "schedules.update": (projectId: string, id: string, input: ScheduleInput) => Schedule;
    "schedules.remove": (projectId: string, id: string) => void;
    "schedules.runs": (projectId: string, templateId: string, limit?: number) => TemplateRun[];
    "schedules.suggestions": () => Suggestion[];
    "schedules.addSuggestion": (projectId: string, suggestionId: string, withSchedule: boolean) => { template: Template; schedule: Schedule | null };
  }
  interface Broadcasts {
    "schedules.changed": (projectId: string) => void;
  }
}

export const MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS plugin_schedules_templates (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  spec_json   TEXT NOT NULL,
  suggestion  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_schedules_automations (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  template_id TEXT NOT NULL,
  spec_json   TEXT NOT NULL,
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_schedules_runs (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL,
  schedule_id   TEXT,
  at            INTEGER NOT NULL,
  trigger       TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  item_ids_json TEXT NOT NULL,
  thread_id     TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_plugin_schedules_runs_template ON plugin_schedules_runs(template_id, at);
`
  }
];

/**
 * Templates are the person's writing and travel with the project. Schedules
 * and their runs stay on this machine: its clock fires them, and a project open
 * on two machines would otherwise run every one twice.
 */
export const TABLES = {
  plugin_schedules_templates: { project: "project_id", export: { order: "id" } },
  plugin_schedules_automations: { project: "project_id", export: false },
  plugin_schedules_runs: { project: { via: "template_id", table: "plugin_schedules_templates" }, export: false }
} as const;

export const SchedulesConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** How often due schedules are looked for. */
    tickMs: z.number().int().min(50).default(30_000),
    /** A run this much past its time was missed — the app was closed or asleep — and follows `catchUp`. */
    lateMs: z.number().int().min(0).default(5 * 60_000)
  })
);
export type SchedulesConfig = z.output<typeof SchedulesConfig>;

interface TemplateRow {
  id: string;
  project_id: string;
  spec_json: string;
  suggestion: string | null;
  created_at: number;
  updated_at: number;
}

interface ScheduleRow {
  id: string;
  project_id: string;
  template_id: string;
  spec_json: string;
  next_run_at: number | null;
  last_run_at: number | null;
  created_at: number;
}

interface RunRow {
  id: string;
  template_id: string;
  schedule_id: string | null;
  at: number;
  trigger: RunTrigger;
  ok: number;
  item_ids_json: string;
  thread_id: string | null;
  error: string | null;
}

const AUTHOR: Author = "ai:automation";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Templates and the schedules that run them. A template is what to do — one or
 * more tickets (a day's to-do, a week's chores, a release checklist) or a
 * prompt for the assistant — and runs whenever the person says, or on any
 * number of schedules. Schedules run on this machine while Tomrade is open; a
 * time missed while it was closed or asleep runs once when it is back, unless
 * the schedule says to skip it.
 */
export class Schedules extends Service {
  static provide = "schedules";
  static inject = ["db", "items", "boards", "agent"];
  static Config = SchedulesConfig;

  private readonly home: Context;
  private ticking = false;

  constructor(
    ctx: Context,
    public readonly config: SchedulesConfig
  ) {
    super(ctx, "schedules");
    this.home = ctx;
  }

  [Service.init]() {
    this.home.db.migrate("schedules", MIGRATIONS, { tables: TABLES });
    const timer = setInterval(() => void this.tick(), this.config.tickMs);
    this.home.effect(() => () => clearInterval(timer), "schedules tick");
    this.home.on("db/opened", () => void this.tick());
    void this.tick();
    this.home.inject(["ipc"], (ctx) => {
      const s = () => ctx.schedules;
      ctx.ipc.handle("schedules.templates", (projectId) => s().templates(projectId));
      ctx.ipc.handle("schedules.createTemplate", (projectId, input) => s().createTemplate(projectId, input));
      ctx.ipc.handle("schedules.updateTemplate", (projectId, id, input) => s().updateTemplate(projectId, id, input));
      ctx.ipc.handle("schedules.removeTemplate", (projectId, id) => s().removeTemplate(projectId, id));
      ctx.ipc.handle("schedules.run", (projectId, templateId) => s().runTemplate(projectId, templateId));
      ctx.ipc.handle("schedules.list", (projectId) => s().schedules(projectId));
      ctx.ipc.handle("schedules.create", (projectId, input) => s().createSchedule(projectId, input));
      ctx.ipc.handle("schedules.update", (projectId, id, input) => s().updateSchedule(projectId, id, input));
      ctx.ipc.handle("schedules.remove", (projectId, id) => s().removeSchedule(projectId, id));
      ctx.ipc.handle("schedules.runs", (projectId, templateId, limit) => s().runs(projectId, templateId, limit));
      ctx.ipc.handle("schedules.suggestions", () => s().suggestions());
      ctx.ipc.handle("schedules.addSuggestion", (projectId, suggestionId, withSchedule) => s().addSuggestion(projectId, suggestionId, withSchedule));
      ctx.on("schedules/changed", (projectId) => ctx.ipc.send("schedules.changed", projectId));
    });
    this.home.inject(["tools"], (ctx) => this.registerTools(ctx));
  }

  private locale(): "en" | "zh" {
    return (this.home.get("settings") as { locale?: () => "en" | "zh" } | undefined)?.locale?.() ?? "en";
  }

  private db(projectId: string) {
    if (!this.home.db.has(projectId)) throw new Error("That project is not open on this machine");
    return this.home.db.for(projectId);
  }

  // ── templates ──────────────────────────────────────────────────────────────

  templates(projectId: string): Template[] {
    if (!this.home.db.has(projectId)) return [];
    const rows = this.home.db.for(projectId).prepare("SELECT * FROM plugin_schedules_templates WHERE project_id = ? ORDER BY created_at ASC").all(projectId) as TemplateRow[];
    return rows.flatMap((r) => {
      const view = this.templateView(r);
      return view ? [view] : [];
    });
  }

  template(projectId: string, id: string): Template | null {
    if (!this.home.db.has(projectId)) return null;
    const row = this.home.db.for(projectId).prepare("SELECT * FROM plugin_schedules_templates WHERE id = ? AND project_id = ?").get(id, projectId) as TemplateRow | undefined;
    return row ? this.templateView(row) : null;
  }

  createTemplate(projectId: string, input: TemplateInput, opts: { suggestion?: string; now?: number } = {}): Template {
    const spec = TemplateInput.parse(input);
    this.checkTemplate(projectId, spec);
    const id = randomUUID();
    const now = opts.now ?? Date.now();
    this.db(projectId)
      .prepare("INSERT INTO plugin_schedules_templates (id, project_id, spec_json, suggestion, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, projectId, JSON.stringify(spec), opts.suggestion ?? null, now, now);
    this.changed(projectId);
    return this.template(projectId, id)!;
  }

  updateTemplate(projectId: string, id: string, input: TemplateInput): Template {
    if (!this.template(projectId, id)) throw new Error("No such template");
    const spec = TemplateInput.parse(input);
    this.checkTemplate(projectId, spec);
    this.db(projectId).prepare("UPDATE plugin_schedules_templates SET spec_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(spec), Date.now(), id);
    this.changed(projectId);
    return this.template(projectId, id)!;
  }

  /** With its schedules and their history: a schedule of nothing has nothing to run. */
  removeTemplate(projectId: string, id: string): void {
    const db = this.db(projectId);
    db.transaction(() => {
      db.prepare("DELETE FROM plugin_schedules_runs WHERE template_id = ?").run(id);
      db.prepare("DELETE FROM plugin_schedules_automations WHERE template_id = ? AND project_id = ?").run(id, projectId);
      db.prepare("DELETE FROM plugin_schedules_templates WHERE id = ? AND project_id = ?").run(id, projectId);
    });
    this.changed(projectId);
  }

  suggestions(): Suggestion[] {
    return suggestions(this.locale());
  }

  /** A suggestion becomes the project's own template, and its schedule too when asked. */
  addSuggestion(projectId: string, suggestionId: string, withSchedule: boolean, now = Date.now()): { template: Template; schedule: Schedule | null } {
    const suggestion = this.suggestions().find((s) => s.id === suggestionId);
    if (!suggestion) throw new Error("No such suggestion");
    const template = this.createTemplate(projectId, suggestion.template, { suggestion: suggestionId, now });
    const schedule = withSchedule && suggestion.cadence ? this.createSchedule(projectId, { templateId: template.id, cadence: suggestion.cadence }, now) : null;
    return { template, schedule };
  }

  // ── schedules ──────────────────────────────────────────────────────────────

  schedules(projectId: string, templateId?: string): Schedule[] {
    if (!this.home.db.has(projectId)) return [];
    const db = this.home.db.for(projectId);
    const rows = (templateId
      ? db.prepare("SELECT * FROM plugin_schedules_automations WHERE project_id = ? AND template_id = ? ORDER BY created_at ASC").all(projectId, templateId)
      : db.prepare("SELECT * FROM plugin_schedules_automations WHERE project_id = ? ORDER BY created_at ASC").all(projectId)) as ScheduleRow[];
    return rows.flatMap((r) => {
      const view = this.scheduleView(r);
      return view ? [view] : [];
    });
  }

  schedule(projectId: string, id: string): Schedule | null {
    if (!this.home.db.has(projectId)) return null;
    const row = this.home.db.for(projectId).prepare("SELECT * FROM plugin_schedules_automations WHERE id = ? AND project_id = ?").get(id, projectId) as ScheduleRow | undefined;
    return row ? this.scheduleView(row) : null;
  }

  createSchedule(projectId: string, input: ScheduleInput, now = Date.now()): Schedule {
    const spec = this.anchored(ScheduleInput.parse(input), now);
    if (!this.template(projectId, spec.templateId)) throw new Error("No such template");
    const id = randomUUID();
    this.db(projectId)
      .prepare("INSERT INTO plugin_schedules_automations (id, project_id, template_id, spec_json, next_run_at, last_run_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)")
      .run(id, projectId, spec.templateId, JSON.stringify(spec), spec.enabled ? nextRun(spec.cadence, now) : null, now);
    this.changed(projectId);
    return this.schedule(projectId, id)!;
  }

  updateSchedule(projectId: string, id: string, input: ScheduleInput, now = Date.now()): Schedule {
    const current = this.schedule(projectId, id);
    if (!current) throw new Error("No such schedule");
    const spec = this.anchored(ScheduleInput.parse(input), now);
    if (!this.template(projectId, spec.templateId)) throw new Error("No such template");
    // a changed cadence, or one switched back on, counts from now — never from a time it already missed
    const same = JSON.stringify(spec.cadence) === JSON.stringify(current.cadence) && current.enabled && current.nextRunAt !== null;
    const next = spec.enabled ? (same ? current.nextRunAt : nextRun(spec.cadence, now)) : null;
    this.db(projectId).prepare("UPDATE plugin_schedules_automations SET template_id = ?, spec_json = ?, next_run_at = ? WHERE id = ?").run(spec.templateId, JSON.stringify(spec), next, id);
    this.changed(projectId);
    return this.schedule(projectId, id)!;
  }

  removeSchedule(projectId: string, id: string): void {
    this.db(projectId).prepare("DELETE FROM plugin_schedules_automations WHERE id = ? AND project_id = ?").run(id, projectId);
    this.changed(projectId);
  }

  // ── running ────────────────────────────────────────────────────────────────

  runs(projectId: string, templateId: string, limit = 10): TemplateRun[] {
    if (!this.home.db.has(projectId)) return [];
    const rows = this.home.db.for(projectId).prepare("SELECT * FROM plugin_schedules_runs WHERE template_id = ? ORDER BY at DESC LIMIT ?").all(templateId, limit) as RunRow[];
    return rows.map((r) => ({ id: r.id, templateId: r.template_id, scheduleId: r.schedule_id, at: r.at, trigger: r.trigger, ok: !!r.ok, itemIds: JSON.parse(r.item_ids_json) as string[], threadId: r.thread_id, error: r.error }));
  }

  /** Runs it now. A failure is recorded and returned, never thrown: whatever was made before it stays. */
  async runTemplate(projectId: string, templateId: string, opts: { trigger?: RunTrigger; scheduleId?: string | null; now?: number } = {}): Promise<TemplateRun> {
    const template = this.template(projectId, templateId);
    if (!template) throw new Error("No such template");
    const now = opts.now ?? Date.now();
    const locale = this.locale();
    const run: TemplateRun = { id: randomUUID(), templateId, scheduleId: opts.scheduleId ?? null, at: now, trigger: opts.trigger ?? "manual", ok: true, itemIds: [], threadId: null, error: null };
    try {
      const action = template.action;
      if (action.kind === "tickets") {
        for (const spec of action.items) {
          const boardId = spec.boardId ?? this.home.boards.defaultFor(projectId).id;
          const item = this.home.items.create({
            projectId,
            boardId,
            title: fillTemplate(spec.title, now, locale),
            body: fillTemplate(spec.body, now, locale) || null,
            kind: "ticket",
            workType: spec.workType,
            status: spec.status,
            priority: spec.priority as Priority,
            labels: spec.labels,
            by: AUTHOR
          });
          run.itemIds.push(item.id);
          if (!spec.start) continue;
          if (spec.workType === "general") {
            run.threadId = (await this.home.agent.startGeneral(projectId, item.id, {})).threadId;
          } else {
            const codeLink = this.home.get("codeLink");
            if (!codeLink) throw new Error(`Made "${item.title}", but starting coding work needs the Code link plugin`);
            const started = await codeLink.start(projectId, item.id, { mode: "run" });
            if (!started.ok) throw new Error(`Made "${item.title}", but it could not start: ${started.message}`);
            run.threadId = started.threadId;
          }
        }
      } else {
        const thread = this.home.agent.newThread(projectId, action.engine ?? undefined, null, { title: template.name, ...(action.options ? { options: action.options } : {}) });
        run.threadId = thread.id;
        this.home.agent.send(projectId, thread.id, { kind: "text", text: fillTemplate(action.prompt, now, locale) });
      }
    } catch (err) {
      run.ok = false;
      run.error = message(err);
    }
    this.db(projectId)
      .prepare("INSERT INTO plugin_schedules_runs (id, template_id, schedule_id, at, trigger, ok, item_ids_json, thread_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.id, run.templateId, run.scheduleId, run.at, run.trigger, run.ok ? 1 : 0, JSON.stringify(run.itemIds), run.threadId, run.error);
    if (run.scheduleId) this.db(projectId).prepare("UPDATE plugin_schedules_automations SET last_run_at = ? WHERE id = ?").run(now, run.scheduleId);
    this.changed(projectId);
    return run;
  }

  /** Whatever is due in every open project. Missed ones follow their `catchUp`; each is then set to its next time from now. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const projectId of this.home.db.openIds()) {
        for (const s of this.schedules(projectId)) {
          if (!s.enabled || s.nextRunAt === null || s.nextRunAt > now) continue;
          const missed = now - s.nextRunAt > this.config.lateMs;
          this.home.db.for(projectId).prepare("UPDATE plugin_schedules_automations SET next_run_at = ? WHERE id = ?").run(nextRun(s.cadence, now), s.id);
          if (missed && !s.catchUp) continue;
          await this.runTemplate(projectId, s.templateId, { trigger: missed ? "catch-up" : "schedule", scheduleId: s.id, now });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private changed(projectId: string): void {
    this.home.emit("schedules/changed", projectId);
  }

  /** "Every N days" counts from the day it was set up unless it names one. */
  private anchored<T extends { cadence: Cadence }>(spec: T, now: number): T {
    return spec.cadence.kind === "days" && !spec.cadence.from ? { ...spec, cadence: { ...spec.cadence, from: localDate(now) } } : spec;
  }

  /** What would fail at run time is refused when it is saved. */
  private checkTemplate(projectId: string, spec: z.output<typeof TemplateInput>): void {
    if (!this.home.db.has(projectId)) throw new Error("That project is not open on this machine");
    if (spec.action.kind !== "tickets") return;
    const boards = new Set(this.home.boards.list(projectId).map((b) => b.id));
    for (const item of spec.action.items) if (item.boardId && !boards.has(item.boardId)) throw new Error("No such workstream in this project");
  }

  private templateView(r: TemplateRow): Template | null {
    const spec = TemplateInput.safeParse(JSON.parse(r.spec_json));
    if (!spec.success) return null;
    return { ...spec.data, id: r.id, projectId: r.project_id, suggestion: r.suggestion, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  private scheduleView(r: ScheduleRow): Schedule | null {
    const spec = ScheduleInput.safeParse(JSON.parse(r.spec_json));
    if (!spec.success) return null;
    return { ...spec.data, id: r.id, projectId: r.project_id, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, createdAt: r.created_at };
  }

  private registerTools(ctx: Context): void {
    const ask = async (inv: { ask?(text: string, options: string[]): Promise<string | null> }, question: string): Promise<boolean> => {
      if (!inv.ask) throw new Error("Nobody here can confirm this. Tell the user they can do it under Templates in the sidebar.");
      const w = ASK_WORDS[this.locale()];
      return (await inv.ask(question, [w.yes, w.no])) === w.yes;
    };
    ctx.tools.register(
      defineTool({
        name: "list_templates",
        title: "List templates",
        description: "The project's templates — reusable tickets (a daily to-do, weekly chores, a checklist) or prompts for the assistant — with the schedules that run them and how their last runs went.",
        input: z.object({}),
        execute: (_args, inv) => {
          const projectId = requireProjectId("list_templates", undefined, inv);
          return this.templates(projectId).map((t) => ({ ...t, schedules: this.schedules(projectId, t.id), lastRuns: this.runs(projectId, t.id, 3) }));
        }
      })
    );
    ctx.tools.register(
      defineTool({
        name: "create_template",
        title: "Create a template",
        description:
          "Save something the user does again and again as a template: one or more tickets (titles may use {date}, {weekday}, {week}, {month}, {year}; bodies may hold - [ ] checklists; General and To Do by default) or a prompt for the assistant. Optionally with a schedule (`cadence`) so it runs on its own on this machine while Tomrade is open. The user confirms before anything is saved.",
        input: TemplateInput.extend({ cadence: Cadence.optional() }),
        execute: async ({ cadence, ...input }, inv) => {
          const projectId = requireProjectId("create_template", undefined, inv);
          const w = ASK_WORDS[this.locale()];
          if (!(await ask(inv, cadence ? w.saveScheduled(input.name, describeCadence(cadence, this.locale())) : w.save(input.name)))) return { created: false, note: "The user did not save it." };
          const template = this.createTemplate(projectId, input);
          const schedule = cadence ? this.createSchedule(projectId, { templateId: template.id, cadence }) : null;
          return { created: true, template, schedule };
        }
      })
    );
    ctx.tools.register(
      defineTool({
        name: "run_template",
        title: "Run a template",
        description: "Run one of the project's templates now, by id: it makes its tickets or sends its prompt, as if the user pressed Run.",
        input: z.object({ id: z.string() }),
        execute: async ({ id }, inv) => this.runTemplate(requireProjectId("run_template", undefined, inv), id)
      })
    );
    ctx.tools.register(
      defineTool({
        name: "schedule_template",
        title: "Schedule a template",
        description: "Make one of the project's templates run on its own, on a cadence, on this machine while Tomrade is open. The user confirms first.",
        input: z.object({ id: z.string(), cadence: Cadence }),
        execute: async ({ id, cadence }, inv) => {
          const projectId = requireProjectId("schedule_template", undefined, inv);
          const template = this.template(projectId, id);
          if (!template) throw new Error("No such template");
          const w = ASK_WORDS[this.locale()];
          if (!(await ask(inv, w.saveScheduled(template.name, describeCadence(cadence, this.locale()))))) return { scheduled: false, note: "The user did not schedule it." };
          return { scheduled: true, schedule: this.createSchedule(projectId, { templateId: id, cadence }) };
        }
      })
    );
    ctx.tools.register(
      defineTool({
        name: "delete_template",
        title: "Delete a template",
        description: "Remove one of the project's templates by id, with its schedules. Only when the user asked for it.",
        input: z.object({ id: z.string() }),
        execute: ({ id }, inv) => {
          const projectId = requireProjectId("delete_template", undefined, inv);
          if (!this.template(projectId, id)) throw new Error("No such template");
          this.removeTemplate(projectId, id);
          return { deleted: true };
        }
      })
    );
  }
}

const ASK_WORDS = {
  en: {
    save: (name: string) => `Save "${name}" as a template?`,
    saveScheduled: (name: string, when: string) => `Save "${name}" as a template that runs ${when}? It runs on this machine while Tomrade is open.`,
    yes: "Save it",
    no: "Don't"
  },
  zh: {
    save: (name: string) => `把「${name}」存成模板吗？`,
    saveScheduled: (name: string, when: string) => `把「${name}」存成模板，并且${when}自动运行吗？它会在这台电脑上、Tomrade 打开时运行。`,
    yes: "保存",
    no: "不要"
  }
} as const;

const DAY_NAMES = {
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  zh: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
} as const;

/** A cadence in a few words, for confirmations and tool results. */
export function describeCadence(c: z.input<typeof Cadence>, locale: "en" | "zh"): string {
  const days = (list: number[]) => [...list].sort().map((d) => DAY_NAMES[locale][d - 1]).join(locale === "zh" ? "、" : ", ");
  if (locale === "zh") {
    switch (c.kind) {
      case "daily": return `每天 ${c.at}`;
      case "weekdays": return `工作日 ${c.at}`;
      case "weekly": return `每${days(c.days)} ${c.at}`;
      case "monthly": return `每月 ${c.day} 号 ${c.at}`;
      case "days": return `每 ${c.every} 天 ${c.at}`;
      case "hourly": return c.every === 1 ? "每小时" : `每 ${c.every} 小时`;
    }
  }
  switch (c.kind) {
    case "daily": return `every day at ${c.at}`;
    case "weekdays": return `on weekdays at ${c.at}`;
    case "weekly": return `every ${days(c.days)} at ${c.at}`;
    case "monthly": return `on day ${c.day} of every month at ${c.at}`;
    case "days": return `every ${c.every} days at ${c.at}`;
    case "hourly": return c.every === 1 ? "every hour" : `every ${c.every} hours`;
  }
}

export default Schedules;
