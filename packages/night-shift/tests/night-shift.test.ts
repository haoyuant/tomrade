import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service, type Context } from "cordis";
import { expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent } from "@tomradex/agent";
import { NightShifts } from "@tomradex/night-shift";

interface FakeSession { itemIds: string[]; state: string; mode: string; startedAt: number; threadId: string | null; blocked: null; ask: null; summary: string | null; lastEventAt?: number | null }

/** Stands for code link: the night shift reads sessions and asks it to start and merge, and these tests play the agents. */
class FakeCodeLink extends Service {
  static provide = "codeLink";
  static inject = ["items"];
  sessionsList: FakeSession[] = [];
  starts: { itemId: string; opts: Record<string, unknown> }[] = [];
  merges: string[] = [];
  checks = "passed";
  refuse: { gate: string; message: string } | null = null;
  defaults: Record<string, unknown> | null = null;
  store = { sessions: (_: string, q: { itemId: string }) => this.sessionsList.filter((s) => s.itemIds.includes(q.itemId)) };
  constructor(ctx: Context) {
    super(ctx, "codeLink");
  }
  startDefaults() {
    return this.defaults;
  }
  async start(_projectId: string, itemId: string, opts: Record<string, unknown>) {
    this.starts.push({ itemId, opts });
    if (this.refuse) return { ok: false, ...this.refuse };
    this.sessionsList.push({ itemIds: [itemId], state: "running", mode: opts.mode === "terminal" ? "terminal" : "headless", startedAt: Date.now() + 1, threadId: `th-${itemId}`, blocked: null, ask: null, summary: null });
    return { ok: true, threadId: `th-${itemId}`, branch: `b/${itemId}` };
  }
  async prChecks() {
    return this.checks;
  }
  async merge(projectId: string, itemId: string) {
    this.merges.push(itemId);
    (this.ctx as Context).items.update(projectId, itemId, { status: "done" }, "human");
    return { merged: true, sha: null, message: "merged" };
  }
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-night-shift-"));
  // the tests drive the clock themselves
  const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent, FakeCodeLink, [NightShifts, { tickMs: 3_600_000, settleMs: 3_600_000 }]] });
  await settle();
  const code = f.ctx.codeLink as unknown as FakeCodeLink;
  const make = (title: string, blocks: string[] = []) => {
    const item = f.items.create({ projectId: f.project.id, boardId: f.ctx.boards.list(f.project.id)[0]!.id, title, status: "todo", workType: "coding", by: "human" });
    return blocks.length ? f.items.update(f.project.id, item.id, { blocks }, "human") : item;
  };
  return { ...f, code, s: f.ctx.nightShift, make };
}

it("runs in the place the person chose, in order, and remembers it through a save", async () => {
  const t = await boot();
  try {
    const a = t.make("A");
    const b = t.make("B");
    const shift = t.s.start(t.project.id, { itemIds: [a.id, b.id], mode: "terminal", engine: "claude-code", concurrency: 1 });
    expect(shift.settings).toMatchObject({ mode: "terminal", engine: "claude-code", concurrency: 1 });
    await t.s.tick();
    expect(t.code.starts).toEqual([{ itemId: a.id, opts: { mode: "terminal", engine: "claude-code" } }]);
    expect(t.s.current(t.project.id)?.tickets[0]).toMatchObject({ state: "running", threadId: `th-${a.id}`, branch: `b/${a.id}` });
    t.items.update(t.project.id, a.id, { status: "verifying" }, "human");
    t.code.sessionsList[0]!.state = "waiting";
    await t.s.tick();
    expect(t.code.starts.map((s) => s.itemId)).toEqual([a.id, b.id]);
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("takes Start's last choice when none is given; a background shift keeps its permission mode, a terminal one has none to keep", async () => {
  const t = await boot();
  try {
    t.code.defaults = { mode: "run", engine: "codex", permissionMode: "full-access" };
    const a = t.make("A");
    expect(t.s.start(t.project.id, { itemIds: [a.id] }).settings).toMatchObject({ mode: "run", engine: "codex", permissionMode: "full-access" });
    t.s.stop(t.project.id, t.s.current(t.project.id)!.id);
    await t.s.tick();
    expect(t.s.current(t.project.id)).toBeNull();
    expect(t.s.start(t.project.id, { itemIds: [t.make("B").id], mode: "terminal", permissionMode: "full-access" }).settings.permissionMode).toBeUndefined();
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("refuses a second shift, an epic and a finished ticket", async () => {
  const t = await boot();
  try {
    const done = t.make("Done");
    t.items.update(t.project.id, done.id, { status: "done" }, "human");
    expect(() => t.s.start(t.project.id, { itemIds: [done.id] })).toThrow(/is done/);
    const a = t.make("A");
    t.s.start(t.project.id, { itemIds: [a.id] });
    expect(() => t.s.start(t.project.id, { itemIds: [t.make("B").id] })).toThrow(/already going/);
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("leaves alone a ticket an agent is already on", async () => {
  const t = await boot();
  try {
    const a = t.make("A");
    t.code.sessionsList.push({ itemIds: [a.id], state: "running", mode: "terminal", startedAt: Date.now(), threadId: null, blocked: null, ask: null, summary: null });
    expect(() => t.s.start(t.project.id, { itemIds: [a.id] })).toThrow(/agent on it already/);
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("a gate that stops a ticket counts as a failure and the shift says why, in the person's language", async () => {
  const t = await boot();
  try {
    t.ctx.settings.set({ ...t.ctx.settings.get(), language: "zh" });
    t.code.refuse = { gate: "engine", message: "no agent is ready" };
    const ended: string[] = [];
    t.ctx.on("nightShift/ended", (shift) => ended.push(shift.id));
    const shift = t.s.start(t.project.id, { itemIds: [t.make("A").id, t.make("B").id], concurrency: 1, maxFailures: 2 });
    await t.s.tick();
    await t.s.tick();
    await t.s.tick();
    const last = t.s.list(t.project.id, 1)[0]!;
    expect(last).toMatchObject({ status: "ended", halt: "failures", counts: { failed: 2 } });
    expect(last.tickets[0]!.note).toBe("没能开工：no agent is ready");
    expect(ended).toEqual([shift.id]);
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("a chain with automatic merging: the merge waits for green checks, then the dependant starts", async () => {
  const t = await boot();
  try {
    const b = t.make("B");
    const a = t.make("A", [b.id]);
    t.s.start(t.project.id, { itemIds: [a.id, b.id], autoMerge: true });
    await t.s.tick();
    expect(t.code.starts.map((s) => s.itemId)).toEqual([a.id]);
    t.items.update(t.project.id, a.id, { status: "verifying" }, "human");
    t.code.sessionsList[0]!.state = "idle";
    t.code.checks = "pending";
    await t.s.tick();
    expect(t.code.merges).toEqual([]);
    expect(t.s.current(t.project.id)?.tickets[0]).toMatchObject({ state: "delivered", merge: "waiting", mergeWaits: 1 });
    t.code.checks = "passed";
    await t.s.tick(Date.now() + 3 * 60_000);
    expect(t.code.merges).toEqual([a.id]);
    // a pass already going takes this one's place, so look until the dependant is in
    await vi.waitFor(async () => {
      await t.s.tick(Date.now() + 3 * 60_000);
      expect(t.code.starts.map((s) => s.itemId)).toEqual([a.id, b.id]);
    });
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("red checks are never merged", async () => {
  const t = await boot();
  try {
    const a = t.make("A");
    t.s.start(t.project.id, { itemIds: [a.id], autoMerge: true });
    await t.s.tick();
    t.items.update(t.project.id, a.id, { status: "verifying" }, "human");
    t.code.sessionsList[0]!.state = "idle";
    t.code.checks = "failed";
    await t.s.tick();
    await t.s.tick();
    expect(t.code.merges).toEqual([]);
    expect(t.s.list(t.project.id, 1)[0]).toMatchObject({ status: "ended", tickets: [{ state: "delivered", merge: "refused", why: { kind: "checks-failed" } }] });
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("a restart picks the shift up from what was saved, and starts nothing twice", async () => {
  const t = await boot();
  try {
    const a = t.make("A");
    t.s.start(t.project.id, { itemIds: [a.id, t.make("B").id], concurrency: 1 });
    await t.s.tick();
    expect(t.code.starts).toHaveLength(1);
    // what a boot does: the project opens, and the shift it finds saved goes on
    (t.s as unknown as { going: Set<string> }).going.clear();
    t.ctx.emit("db/opened", t.project.id);
    await t.s.tick();
    expect(t.code.starts).toHaveLength(1);
    expect(t.s.current(t.project.id)?.counts).toMatchObject({ running: 1, queued: 1 });
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("the tools start, read and stop a shift", async () => {
  const t = await boot();
  try {
    const a = t.make("A");
    const by = "ai:test" as const;
    const started = (await t.ctx.tools.execute("start_night_shift", { keys: [a.key], where: "terminal", maxHours: 2 }, { by, projectId: t.project.id })) as { started: boolean; shift: { id: string; settings: { mode: string; maxMinutes: number } } };
    expect(started).toMatchObject({ started: true, shift: { settings: { mode: "terminal", maxMinutes: 120 } } });
    expect(await t.ctx.tools.execute("night_shift_status", {}, { by, projectId: t.project.id })).toMatchObject({ id: started.shift.id, status: "running" });
    expect(await t.ctx.tools.execute("stop_night_shift", {}, { by, projectId: t.project.id })).toMatchObject({ halt: "stopped" });
  } finally {
    await t.ctx.fiber.dispose();
  }
});
