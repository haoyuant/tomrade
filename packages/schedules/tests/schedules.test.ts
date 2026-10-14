import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent } from "@tomradex/agent";
import { Schedules, fillTemplate } from "@tomradex/schedules";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

async function boot(language: "en" | "zh" = "en") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-schedules-"));
  // a long tick: the tests drive the clock themselves
  const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent, [Schedules, { tickMs: 3_600_000 }]] });
  await settle();
  f.ctx.settings.set({ ...f.ctx.settings.get(), language });
  const heard: string[] = [];
  f.ctx.agent.engine({ id: "echo", title: "Echo", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input) {
      heard.push(input.input.kind === "text" ? input.input.text : "");
      return { stop: "end" };
    } });
  return { ...f, heard, s: f.ctx.schedules };
}

const todo = { name: "Daily to-do", action: { kind: "tickets", items: [{ title: "To-do · {weekday} {date}", body: "- [ ] The one thing\n- [ ] ", labels: ["daily"] }] } } as const;

it("fills the date words in the person's language", () => {
  expect(fillTemplate("{weekday} {date} · {week} · {month} · {year}", at(2026, 10, 12, 9))).toBe("Monday 2026-10-12 · 2026-W42 · 2026-10 · 2026");
  expect(fillTemplate("{date} {weekday}", at(2026, 10, 18, 9), "zh")).toBe("2026-10-18 周日");
});

it("runs a template by hand: its tickets land on To Do as General work, nothing scheduled", async () => {
  const t = await boot();
  try {
    const chores = t.s.createTemplate(t.project.id, { name: "Chores", action: { kind: "tickets", items: [{ title: "Laundry" }, { title: "Groceries", priority: 3 }] } });
    expect(chores.action).toMatchObject({ kind: "tickets", items: [{ workType: "general", status: "todo", start: false }, { priority: 3 }] });
    const run = await t.s.runTemplate(t.project.id, chores.id, { now: at(2026, 10, 12, 9) });
    expect(run).toMatchObject({ trigger: "manual", ok: true, scheduleId: null });
    expect(run.itemIds.map((id) => t.items.get(t.project.id, id))).toMatchObject([
      { title: "Laundry", status: "todo", workType: "general", updatedBy: "ai:automation" },
      { title: "Groceries", priority: 3 }
    ]);
    expect(t.s.schedules(t.project.id)).toEqual([]);
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("runs on each of its schedules when they come due, and counts on from then", async () => {
  const t = await boot();
  try {
    const tpl = t.s.createTemplate(t.project.id, todo);
    // Monday 2026-10-12, 07:00
    const daily = t.s.createSchedule(t.project.id, { templateId: tpl.id, cadence: { kind: "daily", at: "08:00" } }, at(2026, 10, 12, 7));
    const weekly = t.s.createSchedule(t.project.id, { templateId: tpl.id, cadence: { kind: "weekly", at: "20:00", days: [1] } }, at(2026, 10, 12, 7));
    expect([daily.nextRunAt, weekly.nextRunAt]).toEqual([at(2026, 10, 12, 8), at(2026, 10, 12, 20)]);
    await t.s.tick(at(2026, 10, 12, 8));
    const [run] = t.s.runs(t.project.id, tpl.id);
    expect(run).toMatchObject({ trigger: "schedule", ok: true, scheduleId: daily.id });
    expect(t.items.get(t.project.id, run!.itemIds[0]!)).toMatchObject({ title: "To-do · Monday 2026-10-12", body: "- [ ] The one thing\n- [ ] ", labels: ["daily"] });
    expect(t.s.schedule(t.project.id, daily.id)).toMatchObject({ lastRunAt: at(2026, 10, 12, 8), nextRunAt: at(2026, 10, 13, 8) });
    await t.s.tick(at(2026, 10, 12, 20));
    expect(t.s.runs(t.project.id, tpl.id).map((r) => r.scheduleId)).toEqual([weekly.id, daily.id]);
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("waters the plants every three days from the day it was set up", async () => {
  const t = await boot();
  try {
    const tpl = t.s.createTemplate(t.project.id, { name: "Water", action: { kind: "tickets", items: [{ title: "Water the plants" }] } });
    const s = t.s.createSchedule(t.project.id, { templateId: tpl.id, cadence: { kind: "days", at: "09:00", every: 3 } }, at(2026, 10, 12, 10));
    expect(s.cadence).toMatchObject({ from: "2026-10-12" });
    expect(s.nextRunAt).toBe(at(2026, 10, 15, 9));
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("runs a missed time once when it is back, or skips it when told to", async () => {
  const t = await boot();
  try {
    const tpl = t.s.createTemplate(t.project.id, { name: "Standup", action: { kind: "tickets", items: [{ title: "Standup {date}" }] } });
    const caught = t.s.createSchedule(t.project.id, { templateId: tpl.id, cadence: { kind: "daily", at: "09:00" } }, at(2026, 10, 10, 8));
    const skipped = t.s.createSchedule(t.project.id, { templateId: tpl.id, cadence: { kind: "daily", at: "09:00" }, catchUp: false }, at(2026, 10, 10, 8));
    // closed for two and a half days
    await t.s.tick(at(2026, 10, 12, 20));
    expect(t.s.runs(t.project.id, tpl.id).map((r) => [r.trigger, r.scheduleId])).toEqual([["catch-up", caught.id]]);
    expect(t.s.schedule(t.project.id, skipped.id)!.nextRunAt).toBe(at(2026, 10, 13, 9));
    expect(t.items.list({ projectId: t.project.id }).filter((i) => i.title.startsWith("Standup"))).toHaveLength(1);
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("asks the assistant in a conversation of its own", async () => {
  const t = await boot();
  t.ctx.settings.set({ ...t.ctx.settings.get(), agent: { ...(t.ctx.settings.get().agent as object), defaultEngine: "echo" } });
  try {
    const tpl = t.s.createTemplate(t.project.id, { name: "Plan my day", action: { kind: "assistant", prompt: "Plan {weekday} {date}", engine: "echo" } });
    const run = await t.s.runTemplate(t.project.id, tpl.id, { now: at(2026, 10, 12, 8) });
    expect(run).toMatchObject({ ok: true, itemIds: [] });
    for (let i = 0; i < 200 && !t.heard.length; i++) await new Promise((r) => setImmediate(r));
    expect(t.heard).toEqual(["Plan Monday 2026-10-12"]);
    expect(t.ctx.agent.store.thread(t.project.id, run.threadId!)).toMatchObject({ title: "Plan my day", engine: "echo" });
    // The thread list says a routine opened it; a conversation the person opened says nothing.
    const plain = t.ctx.agent.newThread(t.project.id, "echo");
    const listed = t.ctx.agent.withOrigins(t.project.id, t.ctx.agent.store.threads(t.project.id));
    expect(listed.find((th) => th.id === run.threadId)?.origins).toEqual(["Routine"]);
    expect(listed.find((th) => th.id === plain.id)?.origins).toBeUndefined();
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("offers ready-made templates in the person's language, added with or without their schedule", async () => {
  const t = await boot("zh");
  try {
    const gallery = t.s.suggestions();
    expect(gallery.map((g) => g.id)).toEqual(expect.arrayContaining(["daily-todo", "weekly-chores", "monthly-bills", "water-plants", "morning-plan", "weekly-review", "weekly-report", "release-checklist"]));
    expect(gallery.filter((g) => g.group === "everyday").length).toBeGreaterThanOrEqual(4);
    const { template, schedule } = t.s.addSuggestion(t.project.id, "weekly-chores", true, at(2026, 10, 12, 9));
    expect(template).toMatchObject({ name: "每周家务", suggestion: "weekly-chores", action: { kind: "tickets", items: [{ title: "洗衣服" }, { title: "买菜" }, { title: "打扫厨房" }] } });
    expect(schedule).toMatchObject({ templateId: template.id, cadence: { kind: "weekly", days: [6] }, nextRunAt: at(2026, 10, 17, 10) });
    const plain = t.s.addSuggestion(t.project.id, "release-checklist", false);
    expect(plain.schedule).toBeNull();
    // once added it is the project's own: editing it changes nothing in the gallery
    t.s.updateTemplate(t.project.id, template.id, { ...template, name: "周六家务" });
    expect(t.s.suggestions().find((g) => g.id === "weekly-chores")!.template.name).toBe("每周家务");
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("adds every suggestion, in both languages, with its schedule", async () => {
  for (const language of ["en", "zh"] as const) {
    const t = await boot(language);
    try {
      const gallery = t.s.suggestions();
      expect(gallery.map((g) => g.id)).toEqual(expect.arrayContaining(["daily-words", "on-this-day", "daily-why", "film-pick", "call-family", "checkup-prep", "ai-news", "interview-prep", "meeting-prep"]));
      for (const g of gallery) {
        const { template, schedule } = t.s.addSuggestion(t.project.id, g.id, true, at(2026, 10, 12, 9));
        expect(template.name).toBe(g.template.name);
        expect(schedule === null).toBe(!g.cadence);
      }
    } finally {
      await t.ctx.fiber.dispose();
    }
  }
});

it("does nothing while off, counts from the moment it is on again, and goes with its template", async () => {
  const t = await boot();
  try {
    const tpl = t.s.createTemplate(t.project.id, todo);
    const s = t.s.createSchedule(t.project.id, { templateId: tpl.id, cadence: { kind: "daily", at: "08:00" }, enabled: false }, at(2026, 10, 12, 7));
    expect(s.nextRunAt).toBeNull();
    await t.s.tick(at(2026, 10, 20));
    expect(t.s.runs(t.project.id, tpl.id)).toEqual([]);
    expect(t.s.updateSchedule(t.project.id, s.id, { templateId: tpl.id, cadence: s.cadence }, at(2026, 10, 20, 12)).nextRunAt).toBe(at(2026, 10, 21, 8));
    await t.s.runTemplate(t.project.id, tpl.id);
    t.s.removeTemplate(t.project.id, tpl.id);
    expect([t.s.templates(t.project.id), t.s.schedules(t.project.id), t.s.runs(t.project.id, tpl.id)]).toEqual([[], [], []]);
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("keeps what it made and says why when it cannot start it", async () => {
  const t = await boot();
  try {
    const tpl = t.s.createTemplate(t.project.id, { name: "Nightly", action: { kind: "tickets", items: [{ title: "Nightly fix", workType: "coding", start: true }] } });
    const run = await t.s.runTemplate(t.project.id, tpl.id);
    expect(run).toMatchObject({ ok: false, error: expect.stringMatching(/Code link/) });
    expect(t.items.get(t.project.id, run.itemIds[0]!)).toMatchObject({ title: "Nightly fix", workType: "coding" });
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("lets an agent save a template, or schedule one, only with the person's yes", async () => {
  const t = await boot();
  try {
    const call = (args: object, ask?: () => Promise<string | null>) => t.ctx.tools.execute("create_template", args, { by: "ai:test", projectId: t.project.id, ...(ask ? { ask } : {}) });
    await expect(call(todo)).rejects.toThrow(/Routines in the sidebar/);
    expect(await call(todo, async () => "Don't")).toMatchObject({ created: false });
    expect(t.s.templates(t.project.id)).toEqual([]);
    const made = (await call({ ...todo, cadence: { kind: "daily", at: "08:00" } }, async () => "Save it")) as { template: { id: string }; schedule: { cadence: object } };
    expect(made.schedule.cadence).toEqual({ kind: "daily", at: "08:00" });
    const run = await t.ctx.tools.execute("run_template", { id: made.template.id }, { by: "ai:test", projectId: t.project.id });
    expect(run).toMatchObject({ ok: true });
    expect(await t.ctx.tools.execute("list_templates", {}, { by: "ai:test", projectId: t.project.id })).toMatchObject([{ name: "Daily to-do", schedules: [{}], lastRuns: [{ trigger: "manual" }] }]);
  } finally {
    await t.ctx.fiber.dispose();
  }
});
