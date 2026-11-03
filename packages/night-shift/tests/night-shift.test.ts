import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service, type Context } from "cordis";
import { describe, expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent } from "@tomradex/agent";
import { Contributions } from "@tomradex/contributions";
import { NightShifts, PlanReply, applyEdit, insertGate } from "@tomradex/night-shift";

interface FakeSession { id?: string; itemIds: string[]; state: string; mode: string; startedAt: number; threadId: string | null; blocked: null; ask: null; summary: string | null; lastEventAt?: number | null }

/** Stands for code link: the night shift reads sessions and asks it to start and merge, and these tests play the agents. */
class FakeCodeLink extends Service {
  static provide = "codeLink";
  static inject = ["items"];
  sessionsList: FakeSession[] = [];
  starts: { itemId: string; opts: Record<string, unknown> }[] = [];
  merges: string[] = [];
  checks = "passed";
  refuse: { gate: string; message: string } | null = null;
  conflicts = 0;
  resolves: { itemId: string; how: Record<string, unknown> }[] = [];
  resolveFails = false;
  defaults: Record<string, unknown> | null = null;
  store = { sessions: (_: string, q: { itemId: string }) => this.sessionsList.filter((s) => s.itemIds.includes(q.itemId)), links: () => [{ prUrl: "https://example.com/pr/1" }] };
  constructor(ctx: Context) {
    super(ctx, "codeLink");
  }
  startDefaults() {
    return this.defaults;
  }
  async nextEngine() {
    return null;
  }
  async start(_projectId: string, itemId: string, opts: Record<string, unknown>) {
    this.starts.push({ itemId, opts });
    if (this.refuse) return { ok: false, ...this.refuse };
    this.sessionsList.push({ id: `s-${itemId}`, itemIds: [itemId], state: "running", mode: opts.mode === "terminal" ? "terminal" : "headless", startedAt: Date.now() + 1, threadId: `th-${itemId}`, blocked: null, ask: null, summary: null });
    return { ok: true, threadId: `th-${itemId}`, branch: `b/${itemId}` };
  }
  stopped: string[] = [];
  async stopSession(_projectId: string, id: string) {
    this.stopped.push(id);
    const session = this.sessionsList.find((s) => s.id === id);
    if (session) session.state = "ended";
    return true;
  }
  async prChecks() {
    return this.checks;
  }
  async deliveryDiff() {
    return { stat: " a.ts | 2 +-", patch: "+code", lines: 2 };
  }
  async resolveMerge(projectId: string, itemId: string, _requestedBy: string | null, how: Record<string, unknown>) {
    this.resolves.push({ itemId, how });
    if (this.resolveFails) return { itemId, ok: false, message: "no agent" };
    (this.ctx as Context).items.update(projectId, itemId, { status: "doing" }, "human");
    return { itemId, ok: true, threadId: `th-${itemId}` };
  }
  async merge(projectId: string, itemId: string) {
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      return { merged: false, sha: null, message: "not mergeable", cause: "conflict" };
    }
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
    expect(t.code.starts).toMatchObject([{ itemId: a.id, opts: { mode: "terminal", engine: "claude-code" } }]);
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

describe("a conflict at the merge", () => {
  const delivered = async (t: Awaited<ReturnType<typeof boot>>, id: string) => {
    t.items.update(t.project.id, id, { status: "verifying" }, "human");
    t.code.sessionsList.at(-1)!.state = "idle";
    await t.s.tick(Date.now() + 3 * 60_000);
  };

  it("goes back to its agent once, in the place the shift runs, and the merge is tried again", async () => {
    const t = await boot();
    try {
      const b = t.make("B");
      const a = t.make("A", [b.id]);
      t.s.start(t.project.id, { itemIds: [a.id, b.id], mode: "terminal", engine: "claude-code", autoMerge: true });
      await t.s.tick();
      t.code.conflicts = 1;
      await delivered(t, a.id);
      expect(t.code.resolves).toEqual([{ itemId: a.id, how: { mode: "terminal", engine: "claude-code" } }]);
      expect(t.s.current(t.project.id)?.tickets[0]).toMatchObject({ state: "running", merge: "none", conflictRetried: true });
      expect(t.code.starts.map((s) => s.itemId)).toEqual([a.id]);
      await delivered(t, a.id);
      expect(t.code.merges).toEqual([a.id]);
      await vi.waitFor(async () => {
        await t.s.tick(Date.now() + 3 * 60_000);
        expect(t.code.starts.map((s) => s.itemId)).toEqual([a.id, b.id]);
      });
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("a second conflict is the person's: no third try, a failure counted, and the dependant does not start", async () => {
    const t = await boot();
    try {
      const b = t.make("B");
      const a = t.make("A", [b.id]);
      t.s.start(t.project.id, { itemIds: [a.id, b.id], autoMerge: true });
      await t.s.tick();
      t.code.conflicts = 2;
      await delivered(t, a.id);
      await delivered(t, a.id);
      await vi.waitFor(async () => {
        await t.s.tick(Date.now() + 3 * 60_000);
        expect(t.s.current(t.project.id)).toBeNull();
      });
      expect(t.code.resolves).toHaveLength(1);
      expect(t.s.list(t.project.id, 1)[0]).toMatchObject({ failStreak: 1, tickets: [{ state: "needs-you", note: "Its agent could not resolve the conflict" }, { state: "skipped" }] });
      expect(t.code.starts.map((s) => s.itemId)).toEqual([a.id]);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("an agent that cannot be sent back leaves it with the person", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      t.s.start(t.project.id, { itemIds: [a.id], autoMerge: true });
      await t.s.tick();
      t.code.conflicts = 1;
      t.code.resolveFails = true;
      await delivered(t, a.id);
      expect(t.s.list(t.project.id, 1)[0]?.tickets[0]).toMatchObject({ state: "needs-you", merge: "refused", why: { kind: "conflict-unresolved" } });
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("a shift past its limits spends nothing more on it", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      t.s.start(t.project.id, { itemIds: [a.id], autoMerge: true, maxMinutes: 5 });
      await t.s.tick();
      t.code.conflicts = 1;
      t.items.update(t.project.id, a.id, { status: "verifying" }, "human");
      t.code.sessionsList.at(-1)!.state = "idle";
      await t.s.tick(Date.now() + 6 * 60_000);
      expect(t.code.resolves).toEqual([]);
      expect(t.s.list(t.project.id, 1)[0]?.tickets[0]).toMatchObject({ state: "delivered", merge: "refused", why: { kind: "merge-conflict" } });
    } finally {
      await t.ctx.fiber.dispose();
    }
  });
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

it("offers itself in the palette and shows on the status bar while it goes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-night-shift-"));
  const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Contributions, Agent, FakeCodeLink, [NightShifts, { tickMs: 3_600_000, settleMs: 3_600_000 }]] });
  await settle();
  try {
    const shiftOf = (title: string) => f.items.create({ projectId: f.project.id, boardId: f.ctx.boards.list(f.project.id)[0]!.id, title, status: "todo", workType: "coding", by: "human" });
    expect(await f.ctx.contributions.run("nightShift.open", {})).toEqual({ opens: "night-shift" });
    expect((await f.ctx.contributions.statusItems({ projectId: f.project.id })).find((s) => s.id === "night-shift")).toBeUndefined();
    const a = shiftOf("A");
    f.ctx.nightShift.start(f.project.id, { itemIds: [a.id, shiftOf("B").id], concurrency: 1 });
    await f.ctx.nightShift.tick();
    f.items.update(f.project.id, a.id, { status: "verifying" }, "human");
    await f.ctx.nightShift.tick();
    expect((await f.ctx.contributions.statusItems({ projectId: f.project.id })).find((s) => s.id === "night-shift")).toMatchObject({ text: "Auto run 1/2", opens: "night-shift" });
  } finally {
    await f.ctx.fiber.dispose();
  }
});

it("wants the computer awake only while a shift goes, and only if asked", async () => {
  const t = await boot();
  try {
    expect(t.s.wantsAwake()).toBe(false);
    const a = t.make("A");
    t.s.start(t.project.id, { itemIds: [a.id] });
    expect(t.s.wantsAwake()).toBe(true);
    const heard: boolean[] = [];
    t.ctx.on("nightShift/changed", () => heard.push(t.s.wantsAwake()));
    t.s.stop(t.project.id, t.s.current(t.project.id)!.id);
    await t.s.tick();
    expect(t.s.current(t.project.id)).toBeNull();
    expect(heard.at(-1)).toBe(false);
    t.s.start(t.project.id, { itemIds: [t.make("B").id], keepAwake: false });
    expect(t.s.wantsAwake()).toBe(false);
  } finally {
    await t.ctx.fiber.dispose();
  }
});

/** Stands for the model and for Files, so a report can be read back and its model calls counted. */
class FakeLlm extends Service {
  static provide = "llm";
  calls = 0;
  working = true;
  constructor(ctx: Context) {
    super(ctx, "llm");
  }
  async worker() {
    return this.working ? { ok: true } : { ok: false, reason: "no model" };
  }
  planReply: unknown = null;
  triageReply: unknown = null;
  seen: string[] = [];
  asked: { preferEngine?: string; signal?: AbortSignal }[] = [];
  refusal = "the model fell over";
  async completeJson(_schema: unknown, opts: { system: string; user: string; preferEngine?: string; signal?: AbortSignal }) {
    this.calls += 1;
    this.asked.push(opts);
    if (opts.system.startsWith("You decide")) {
      this.seen.push(opts.user);
      if (!this.triageReply) throw new Error("the model fell over");
      return this.triageReply;
    }
    if (opts.system.startsWith("You plan")) {
      if (!this.planReply) throw new Error(this.refusal);
      return PlanReply.parse(this.planReply);
    }
    return { criteria: [{ text: "It works", met: "yes", evidence: "a.ts" }], outOfScope: [], unverified: [], risk: "low" };
  }
}
class FakeFiles extends Service {
  static provide = "files";
  written = new Map<string, string>();
  constructor(ctx: Context) {
    super(ctx, "files");
  }
  async write(_projectId: string, file: string, body: string) {
    this.written.set(file, body);
  }
}

async function bootWithReport(judge = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-night-shift-"));
  const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent, FakeCodeLink, FakeLlm, FakeFiles, [NightShifts, { tickMs: 3_600_000, settleMs: 3_600_000 }]] });
  await settle();
  const llm = f.ctx.llm as unknown as FakeLlm;
  const files = f.ctx.files as unknown as FakeFiles;
  const run = async () => {
    const item = f.items.create({ projectId: f.project.id, boardId: f.ctx.boards.list(f.project.id)[0]!.id, title: "A", status: "todo", workType: "coding", by: "human" });
    f.ctx.nightShift.start(f.project.id, { itemIds: [item.id], judge });
    await f.ctx.nightShift.tick();
    f.items.update(f.project.id, item.id, { status: "verifying" }, "human");
    (f.ctx.codeLink as unknown as FakeCodeLink).sessionsList.at(-1)!.state = "idle";
    await vi.waitFor(async () => {
      await f.ctx.nightShift.tick();
      expect(f.ctx.nightShift.list(f.project.id, 1)[0]?.briefPath).toBeTruthy();
    });
    return [...files.written.values()][0]!;
  };
  return { f, llm, run };
}

it("writes the report into Files when the shift ends, and the shift remembers where", async () => {
  const { f, llm, run } = await bootWithReport();
  try {
    const body = await run();
    expect(llm.calls).toBe(1);
    expect(llm.asked.at(-1)!.signal).toBeInstanceOf(AbortSignal);
    expect(body).toContain("https://example.com/pr/1");
    expect(body).toContain("✓ It works: a.ts");
    expect(f.ctx.nightShift.list(f.project.id, 1)[0]!.briefPath).toMatch(/^Auto runs\/\d{4}-\d\d-\d\d \d\d-\d\d\.md$/);
  } finally {
    await f.ctx.fiber.dispose();
  }
});

it("switched off, the report asks no model", async () => {
  const { f, llm, run } = await bootWithReport(false);
  try {
    expect(await run()).toContain("Not judged");
    expect(llm.calls).toBe(0);
  } finally {
    await f.ctx.fiber.dispose();
  }
});

it("with no model to ask, the report still comes, with the facts", async () => {
  const { f, llm, run } = await bootWithReport();
  try {
    llm.working = false;
    expect(await run()).toContain("Not judged");
    expect(llm.calls).toBe(0);
  } finally {
    await f.ctx.fiber.dispose();
  }
});

it("the tools start, read and stop a shift", async () => {
  const t = await boot();
  try {
    const a = t.make("A");
    const by = "ai:test" as const;
    const asked = await t.ctx.tools.execute("start_night_shift", { keys: [a.key], where: "terminal", maxHours: 2 }, { by, projectId: t.project.id });
    expect(asked).toMatchObject({ started: false, awaiting: "the person" });
    const shift = t.s.decide(t.project.id, t.s.proposal(t.project.id)!.id, true)!;
    expect(shift).toMatchObject({ settings: { mode: "terminal", maxMinutes: 120 } });
    expect(await t.ctx.tools.execute("night_shift_status", {}, { by, projectId: t.project.id })).toMatchObject({ id: shift.id, status: "running" });
    expect(await t.ctx.tools.execute("stop_night_shift", {}, { by, projectId: t.project.id })).toMatchObject({ halt: "stopped" });
  } finally {
    await t.ctx.fiber.dispose();
  }
});

describe("planning a run", () => {
  it("asks the model, and shows it the project", async () => {
    const { f, llm } = await bootWithReport();
    try {
      const board = f.ctx.boards.list(f.project.id)[0]!.id;
      const a = f.items.create({ projectId: f.project.id, boardId: board, title: "A", status: "todo", workType: "coding", by: "human" });
      llm.planReply = { summary: "Do A.", suggested: [a.key], excluded: [], dependencies: [] };
      const plan = await f.ctx.nightShift.plan(f.project.id);
      expect(plan).toMatchObject({ analyzed: true, why: null, summary: "Do A.", nodes: [{ key: a.key, suggested: true }] });
      expect(llm.asked.at(-1)).toMatchObject({ preferEngine: f.ctx.agent.answering(f.ctx.agent.settingsOf().defaultEngine) });
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("asks the model again only when what it would be shown changed, or when told to", async () => {
    const { f, llm } = await bootWithReport();
    try {
      const board = f.ctx.boards.list(f.project.id)[0]!.id;
      const a = f.items.create({ projectId: f.project.id, boardId: board, title: "A", status: "todo", workType: "coding", by: "human" });
      llm.planReply = { summary: "Do A.", suggested: [a.key], excluded: [], dependencies: [] };
      const calls = llm.calls;
      const plan = () => f.ctx.nightShift.plan(f.project.id);
      await Promise.all([plan(), plan()]);
      expect(llm.calls).toBe(calls + 1);
      expect(await plan()).toMatchObject({ analyzed: true, summary: "Do A." });
      expect(llm.calls).toBe(calls + 1);
      await f.ctx.nightShift.plan(f.project.id, true);
      expect(llm.calls).toBe(calls + 2);
      f.items.update(f.project.id, a.id, { title: "A, renamed" }, "human");
      await plan();
      expect(llm.calls).toBe(calls + 3);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("keeps no failed plan, and applies today's rules to a kept one", async () => {
    const { f, llm } = await bootWithReport();
    try {
      const a = f.items.create({ projectId: f.project.id, boardId: f.ctx.boards.list(f.project.id)[0]!.id, title: "A", status: "todo", workType: "coding", by: "human" });
      llm.refusal = "the model fell over";
      expect(await f.ctx.nightShift.plan(f.project.id)).toMatchObject({ analyzed: false });
      llm.planReply = { summary: "Do A.", suggested: [a.key], excluded: [], dependencies: [] };
      expect(await f.ctx.nightShift.plan(f.project.id)).toMatchObject({ analyzed: true, nodes: [{ suggested: true }] });
      const calls = llm.calls;
      f.ctx.nightShift.setRules(f.project.id, [{ id: "r1", name: "Not this", when: { titleHas: "A" }, then: { skip: true } }]);
      expect(await f.ctx.nightShift.plan(f.project.id)).toMatchObject({ nodes: [{ suggested: false, why: "Left out by the rule “Not this”" }] });
      expect(llm.calls).toBe(calls);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("falls back to the tickets when the model fails, and when there is none", async () => {
    const { f, llm } = await bootWithReport();
    try {
      f.items.create({ projectId: f.project.id, boardId: f.ctx.boards.list(f.project.id)[0]!.id, title: "A", status: "todo", workType: "coding", by: "human" });
      llm.refusal = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}';
      expect(await f.ctx.nightShift.plan(f.project.id)).toMatchObject({ analyzed: false, why: expect.stringMatching(/: Your credit balance is too low$/), nodes: [{ suggested: true }] });
      llm.working = false;
      const calls = llm.calls;
      expect(await f.ctx.nightShift.plan(f.project.id)).toMatchObject({ analyzed: false, why: expect.stringMatching(/^No agent or model/) });
      expect(llm.calls).toBe(calls);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("writes the dependencies the person took as it starts, and only those", async () => {
    const f = await bootWithReport();
    try {
      const board = f.f.ctx.boards.list(f.f.project.id)[0]!.id;
      const make = (title: string) => f.f.items.create({ projectId: f.f.project.id, boardId: board, title, status: "todo", workType: "coding", by: "human" });
      const a = make("A");
      const b = make("B");
      const c = make("C");
      f.f.ctx.nightShift.start(f.f.project.id, { itemIds: [a.id, b.id, c.id], dependencies: [{ from: a.id, to: b.id }] });
      expect(f.f.items.get(f.f.project.id, a.id)!.blocks).toEqual([b.id]);
      expect(f.f.items.get(f.f.project.id, c.id)!.blockedBy).toEqual([]);
    } finally {
      await f.f.ctx.fiber.dispose();
    }
  });

  it("refuses a run past three days", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      expect(() => t.s.start(t.project.id, { itemIds: [a.id], maxMinutes: 72 * 60 + 1 })).toThrow();
      expect(t.s.start(t.project.id, { itemIds: [a.id], maxMinutes: 72 * 60 }).settings.maxMinutes).toBe(72 * 60);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });
});

describe("nodes and work rules", () => {
  const docs = { id: "r1", name: "Docs", when: { label: "docs" }, then: { engine: "fake", autoMerge: true } };
  const labelled = (t: Awaited<ReturnType<typeof boot>>, title: string) => {
    const item = t.make(title);
    return t.items.update(t.project.id, item.id, { labels: ["docs"] }, "human");
  };
  const fakeEngine = (ok: boolean) => ({ id: "fake", title: "Fake", author: "ai:fake" as const, capabilities: ["code" as const], available: async () => ({ ok }), async turn() { return { stop: "end" as const }; } });

  it("keeps rules with the project, in order, and says which ticket falls under which", async () => {
    const t = await boot();
    try {
      const a = labelled(t, "A");
      const b = t.make("B");
      t.s.setRules(t.project.id, [docs]);
      expect(t.s.rules(t.project.id)).toEqual([docs]);
      expect(t.s.ruleMatches(t.project.id)).toEqual({ [a.id]: "r1" });
      expect(t.s.ruleMatches(t.project.id)[b.id]).toBeUndefined();
      expect(() => t.s.setRules(t.project.id, [{ ...docs, name: "" }])).toThrow();
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("the person's hand beats a rule, a rule beats the run, field by field", async () => {
    const t = await boot();
    try {
      t.ctx.agent.engine(fakeEngine(true));
      t.s.setRules(t.project.id, [docs]);
      const ruled = labelled(t, "Ruled");
      const manual = labelled(t, "Manual");
      const plain = t.make("Plain");
      const shift = t.s.start(t.project.id, { itemIds: [ruled.id, manual.id, plain.id], engine: "default-engine", mode: "run", concurrency: 3, nodes: { [manual.id]: { autoMerge: false } } });
      const of = (id: string) => shift.tickets.find((x) => x.itemId === id)!;
      expect(of(ruled.id)).toMatchObject({ config: { engine: "fake", autoMerge: true }, configFrom: { kind: "rule", name: "Docs" } });
      expect(of(manual.id)).toMatchObject({ config: { engine: "fake", autoMerge: false }, configFrom: { kind: "manual" } });
      expect(of(plain.id).config).toBeUndefined();
      await t.s.tick();
      expect(t.code.starts.find((s) => s.itemId === ruled.id)!.opts).toMatchObject({ engine: "fake" });
      expect(t.code.starts.find((s) => s.itemId === plain.id)!.opts).toMatchObject({ engine: "default-engine" });
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("an agent that cannot run costs the node its config, not the ticket", async () => {
    const t = await boot();
    try {
      t.ctx.agent.engine(fakeEngine(false));
      const a = t.make("A");
      t.s.start(t.project.id, { itemIds: [a.id], engine: "default-engine", mode: "run", nodes: { [a.id]: { engine: "fake", permissionMode: "yolo", autoMerge: true } } });
      await t.s.tick();
      expect(t.code.starts[0]!.opts).toMatchObject({ engine: "default-engine" });
      expect(t.code.starts[0]!.opts.permissionMode).toBeUndefined();
      const ticket = t.s.current(t.project.id)!.tickets[0]!;
      expect(ticket.state).toBe("running");
      expect(ticket.note).toContain("fake could not run");
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("a conflict goes back to the agent the node named", async () => {
    const t = await boot();
    try {
      t.ctx.agent.engine(fakeEngine(true));
      t.code.conflicts = 1;
      const a = t.make("A");
      t.s.start(t.project.id, { itemIds: [a.id], engine: "default-engine", mode: "run", nodes: { [a.id]: { engine: "fake", autoMerge: true } } });
      await t.s.tick();
      t.items.update(t.project.id, a.id, { status: "verifying" }, "human");
      t.code.sessionsList.at(-1)!.state = "idle";
      await t.s.tick();
      await t.s.tick();
      expect(t.code.resolves[0]?.how).toMatchObject({ engine: "fake" });
    } finally {
      await t.ctx.fiber.dispose();
    }
  });
});

describe("a rule that leaves work out", () => {
  it("takes it off the plan, whatever the model said, and the person can still run it", async () => {
    const { f, llm } = await bootWithReport();
    try {
      const a = f.items.create({ projectId: f.project.id, boardId: f.ctx.boards.list(f.project.id)[0]!.id, title: "Risky", status: "todo", workType: "coding", by: "human" });
      f.ctx.nightShift.setRules(f.project.id, [{ id: "r", name: "Not this", when: { titleHas: "risky" }, then: { skip: true } }]);
      llm.planReply = { summary: "", suggested: [a.key], excluded: [], dependencies: [] };
      const plan = await f.ctx.nightShift.plan(f.project.id);
      expect(plan.nodes[0]).toMatchObject({ suggested: false, why: "Left out by the rule “Not this”" });
      expect(f.ctx.nightShift.start(f.project.id, { itemIds: [a.id] }).tickets).toHaveLength(1);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });
});

describe("telling the person", () => {
  type Told = { notices: { key: string; title: string; body: string }[]; stuck: { title: string; body: string } | null };
  const listen = (t: Awaited<ReturnType<typeof boot>>) => {
    const told: Told[] = [];
    t.ctx.on("nightShift/step", (_shift, notices, stuck) => told.push({ notices, stuck }));
    return told;
  };
  const deliver = (t: Awaited<ReturnType<typeof boot>>, id: string) => {
    t.items.update(t.project.id, id, { status: "verifying" }, "human");
    t.code.sessionsList.find((s) => s.itemIds.includes(id))!.state = "idle";
  };

  it("keeps every step with the run, and says each one once, naming the ticket", async () => {
    const t = await boot();
    try {
      const told = listen(t);
      const a = t.make("Alpha");
      t.s.start(t.project.id, { itemIds: [a.id, t.make("Beta").id], concurrency: 1 });
      await t.s.tick();
      await t.s.tick();
      expect(told).toHaveLength(1);
      expect(told[0]!.notices).toEqual([{ key: expect.stringContaining(":started:"), title: `${a.key} Alpha`, body: "Started" }]);
      expect(told[0]!.stuck).toBeNull();
      deliver(t, a.id);
      await t.s.tick();
      await t.s.tick();
      const steps = t.s.list(t.project.id, 1)[0]!.steps.map((s) => [s.key, s.kind]);
      expect(steps).toEqual([[a.key, "started"], [a.key, "delivered"], [expect.any(String), "started"]]);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("gives a phone numbers alone when a ticket stops", async () => {
    const t = await boot();
    try {
      const told = listen(t);
      const a = t.make("Secret title");
      t.s.start(t.project.id, { itemIds: [a.id] });
      await t.s.tick();
      t.code.sessionsList.at(-1)!.state = "error";
      await t.s.tick();
      const stuck = told.at(-1)!.stuck!;
      expect(stuck).toEqual({ title: "Your auto run needs you", body: "1 need you, 0 of 1 delivered" });
      expect(JSON.stringify(stuck)).not.toContain("Secret");
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("can tell only what stops a ticket", async () => {
    const t = await boot();
    try {
      const told = listen(t);
      const a = t.make("A");
      const b = t.make("B");
      t.s.start(t.project.id, { itemIds: [a.id, b.id], notify: "stuck" });
      await t.s.tick();
      expect(told.flatMap((x) => x.notices)).toEqual([]);
      t.code.sessionsList.find((s) => s.itemIds.includes(a.id))!.state = "error";
      await t.s.tick();
      expect(told.flatMap((x) => x.notices).map((n) => n.title)).toEqual([`${a.key} A`]);
      expect(t.s.current(t.project.id)!.steps.map((s) => s.kind)).toEqual(["started", "started", "failed"]);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("writes the tickets it never reached down, without a message each", async () => {
    const t = await boot();
    try {
      const told = listen(t);
      const a = t.make("A");
      const shift = t.s.start(t.project.id, { itemIds: [a.id, t.make("B").id], concurrency: 1 });
      await t.s.tick();
      t.s.stop(t.project.id, shift.id);
      t.code.sessionsList.at(-1)!.state = "error";
      await t.s.tick();
      const last = t.s.list(t.project.id, 1)[0]!;
      expect(last.steps.map((s) => s.kind)).toContain("skipped");
      expect(told.flatMap((x) => x.notices).some((n) => n.body.startsWith("Not started"))).toBe(false);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });
});

describe("a run an agent asks for", () => {
  const by = "ai:test" as const;
  const ask = (t: Awaited<ReturnType<typeof boot>>, keys: string[], more: Record<string, unknown> = {}) => t.ctx.tools.execute("start_night_shift", { keys, ...more }, { by, projectId: t.project.id });

  it("starts nothing, and shows the person every ticket and setting", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      await ask(t, [a.key], { where: "terminal", maxUsd: 5, autoMerge: true, concurrency: 3 });
      expect(t.s.current(t.project.id)).toBeNull();
      expect(t.code.starts).toEqual([]);
      const proposal = t.s.proposal(t.project.id)!;
      expect(proposal.tickets).toMatchObject([{ key: a.key, title: "A" }]);
      expect(proposal.text).toContain(a.key);
      expect(proposal.config.join(" | ")).toMatch(/terminal panes.*up to 3 at a time.*merges each one.*\$5/);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("leaves no tool that answers for the person", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      await ask(t, [a.key]);
      const names = t.ctx.tools.list().map((tool) => tool.name).filter((name) => /night_shift/.test(name));
      expect(names.sort()).toEqual(["night_shift_status", "plan_night_shift", "start_night_shift", "stop_night_shift"]);
      // asking again is only asking
      await ask(t, [a.key]);
      expect(t.s.current(t.project.id)).toBeNull();
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("takes the person's yes to what they were shown, and starts nothing on their no", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      await ask(t, [a.key]);
      expect(t.s.decide(t.project.id, t.s.proposal(t.project.id)!.id, false)).toBeNull();
      expect(t.s.proposal(t.project.id)).toBeNull();
      expect(t.s.current(t.project.id)).toBeNull();
      await ask(t, [a.key]);
      expect(t.s.decide(t.project.id, t.s.proposal(t.project.id)!.id, true)).toMatchObject({ status: "running" });
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("does not let a yes to an earlier ask start a changed one", async () => {
    const t = await boot();
    try {
      const [a, b] = [t.make("A"), t.make("B")];
      await ask(t, [a.key]);
      const earlier = t.s.proposal(t.project.id)!.id;
      await ask(t, [a.key, b.key], { autoMerge: true });
      expect(() => t.s.decide(t.project.id, earlier, true)).toThrow(/lapsed or been replaced/);
      expect(t.s.current(t.project.id)).toBeNull();
      expect(t.s.proposal(t.project.id)?.tickets).toHaveLength(2);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("lapses unanswered, and a late yes starts nothing", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      await ask(t, [a.key]);
      const proposal = t.s.proposal(t.project.id)!;
      expect(() => t.s.decide(t.project.id, proposal.id, true, proposal.expiresAt)).toThrow(/lapsed/);
      expect(t.s.current(t.project.id)).toBeNull();
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("refuses at once what could not run, and checks again on the yes", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      t.items.update(t.project.id, a.id, { status: "done" }, "human");
      await expect(ask(t, [a.key])).rejects.toThrow(/is done/);
      const b = t.make("B");
      await ask(t, [b.key]);
      t.items.update(t.project.id, b.id, { status: "done" }, "human");
      expect(() => t.s.decide(t.project.id, t.s.proposal(t.project.id)!.id, true)).toThrow(/is done/);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("puts it to the person in the conversation where a run can ask, and starts only on their word", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      const questions: string[] = [];
      const inRun = (said: string | null) => ({ by, projectId: t.project.id, ask: async (text: string) => (questions.push(text), said) });
      expect(await t.ctx.tools.execute("start_night_shift", { keys: [a.key] }, inRun("Don't"))).toMatchObject({ started: false });
      expect(await t.ctx.tools.execute("start_night_shift", { keys: [a.key] }, inRun(null))).toMatchObject({ started: false });
      expect(t.s.current(t.project.id)).toBeNull();
      expect(t.s.proposal(t.project.id)).toBeNull();
      expect(questions[0]).toContain(a.key);
      expect(await t.ctx.tools.execute("start_night_shift", { keys: [a.key] }, inRun("Start it"))).toMatchObject({ started: true });
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("offers the plan as a tool, read-only", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      expect(await t.ctx.tools.execute("plan_night_shift", {}, { by, projectId: t.project.id })).toMatchObject({ suggested: [a.key], concurrency: null });
      expect(t.ctx.tools.get("plan_night_shift")?.readOnly).toBe(true);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });
});

describe("changing a run while it goes", () => {
  const keys = (t: Awaited<ReturnType<typeof boot>>) => t.s.current(t.project.id)?.tickets.map((x) => x.key) ?? [];
  const stepsOf = (t: Awaited<ReturnType<typeof boot>>, kind: string) => (t.s.current(t.project.id)?.steps ?? []).filter((step) => step.kind === kind);

  it("takes a ticket in and leaves one out at the next pass, and starts what fits", async () => {
    const t = await boot();
    try {
      const [a, b, c] = [t.make("A"), t.make("B"), t.make("C")];
      const shift = t.s.start(t.project.id, { itemIds: [a.id, b.id], concurrency: 1 });
      await t.s.tick();
      t.s.edit(t.project.id, shift.id, { add: [c.id], remove: [{ itemId: b.id }] });
      expect(keys(t)).toEqual([a.key, b.key]);
      await t.s.tick();
      expect(keys(t)).toEqual([a.key, c.key]);
      expect(t.s.current(t.project.id)?.tickets[1]?.joinedAt).toBeGreaterThan(0);
      expect(stepsOf(t, "joined").map((step) => step.key)).toEqual([c.key]);
      expect(stepsOf(t, "removed").map((step) => step.key)).toEqual([b.key]);
      expect(t.code.starts.map((x) => x.itemId)).toEqual([a.id]);
      expect(t.s.current(t.project.id)?.counts).toMatchObject({ running: 1, queued: 1 });
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("refuses all of a change when any of it cannot be, and says why", async () => {
    const t = await boot();
    try {
      const [a, b, done, busy] = [t.make("A"), t.make("B"), t.make("Done"), t.make("Busy")];
      t.items.update(t.project.id, done.id, { status: "done" }, "human");
      t.code.sessionsList.push({ id: "other", itemIds: [busy.id], state: "running", mode: "terminal", startedAt: 0, threadId: null, blocked: null, ask: null, summary: null } as never);
      const shift = t.s.start(t.project.id, { itemIds: [a.id, b.id], concurrency: 1 });
      await t.s.tick();
      expect(() => t.s.edit(t.project.id, shift.id, { add: [done.id], remove: [{ itemId: b.id }] })).toThrow(/is done/);
      expect(() => t.s.edit(t.project.id, shift.id, { add: [busy.id] })).toThrow(/has an agent on it/);
      expect(() => t.s.edit(t.project.id, shift.id, { add: [a.id] })).toThrow(/already in this run/);
      expect(() => t.s.edit(t.project.id, shift.id, { remove: [{ itemId: a.id }] })).toThrow(/has an agent at work/);
      await t.s.tick();
      expect(keys(t)).toEqual([a.key, b.key]);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("stops an agent only on the word, keeps the ticket as history, and lets the next one start", async () => {
    const t = await boot();
    try {
      const [a, b] = [t.make("A"), t.make("B")];
      const shift = t.s.start(t.project.id, { itemIds: [a.id, b.id], concurrency: 1 });
      await t.s.tick();
      t.s.edit(t.project.id, shift.id, { remove: [{ itemId: a.id, stop: true }] });
      await t.s.tick();
      await settle();
      expect(t.code.stopped).toEqual([`s-${a.id}`]);
      const ticket = t.s.current(t.project.id)?.tickets.find((x) => x.itemId === a.id);
      expect(ticket).toMatchObject({ state: "skipped", why: { kind: "removed" } });
      expect(ticket?.note).toMatch(/stays on its branch/);
      expect(t.code.starts.map((x) => x.itemId)).toEqual([a.id, b.id]);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("does not let a stopped ticket go on by itself when its limit lifts", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      const shift = t.s.start(t.project.id, { itemIds: [a.id], concurrency: 1 });
      await t.s.tick();
      const unpark = vi.spyOn(t.ctx.agent, "unpark");
      t.s.edit(t.project.id, shift.id, { remove: [{ itemId: a.id, stop: true }] });
      await t.s.tick();
      expect(unpark).toHaveBeenCalledWith(t.project.id, `th-${a.id}`);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("will not stop a ticket that started after the change was asked for", async () => {
    const t = await boot();
    try {
      const [a, b] = [t.make("A"), t.make("B")];
      t.s.start(t.project.id, { itemIds: [a.id, b.id], concurrency: 1 });
      await t.s.tick();
      // the scheduler reached it first, in the moment between the check and the pass
      const stored = t.s.current(t.project.id)!;
      const moved = { ...stored, tickets: stored.tickets.map((x) => (x.itemId === b.id ? { ...x, state: "running" as const } : x)) };
      const applied = applyEdit(moved, { add: [], remove: [{ itemId: b.id, stop: false }], nodes: {} }, 5);
      expect(applied.stopping).toEqual([]);
      expect(applied.shift.tickets.map((x) => x.key)).toEqual([a.key, b.key]);
      expect(applied.steps).toMatchObject([{ kind: "edit-refused", why: { kind: "edit-late" } }]);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("leaves a ticket waiting, not failed, when what it waits on is taken off", async () => {
    const t = await boot();
    try {
      const b = t.make("B");
      const a = t.make("A", [b.id]);
      const c = t.make("C");
      const shift = t.s.start(t.project.id, { itemIds: [c.id, a.id, b.id], concurrency: 1 });
      await t.s.tick();
      t.s.edit(t.project.id, shift.id, { remove: [{ itemId: a.id }] });
      await t.s.tick();
      expect(t.s.current(t.project.id)?.tickets.find((x) => x.itemId === b.id)).toMatchObject({ state: "queued", why: { kind: "waits-outside", keys: [a.key] } });
      expect(t.s.current(t.project.id)?.failStreak).toBe(0);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("changes a node not begun, and refuses one at work", async () => {
    const t = await boot();
    try {
      const [a, b] = [t.make("A"), t.make("B")];
      const shift = t.s.start(t.project.id, { itemIds: [a.id, b.id], concurrency: 1 });
      await t.s.tick();
      expect(() => t.s.edit(t.project.id, shift.id, { nodes: { [a.id]: { mode: "terminal" } } })).toThrow(/already started/);
      t.s.edit(t.project.id, shift.id, { nodes: { [b.id]: { mode: "terminal" } } });
      await t.s.tick();
      expect(t.s.current(t.project.id)?.tickets[1]).toMatchObject({ config: { mode: "terminal" }, configFrom: { kind: "manual" } });
      t.s.edit(t.project.id, shift.id, { nodes: { [b.id]: null } });
      await t.s.tick();
      expect(t.s.current(t.project.id)?.tickets[1]?.config).toBeUndefined();
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("takes no change once it is stopping, and none once it has ended", async () => {
    const t = await boot();
    try {
      const [a, b] = [t.make("A"), t.make("B")];
      const shift = t.s.start(t.project.id, { itemIds: [a.id, b.id], concurrency: 1 });
      await t.s.tick();
      t.s.stop(t.project.id, shift.id);
      expect(() => t.s.edit(t.project.id, shift.id, { remove: [{ itemId: b.id }] })).toThrow(/finishing/);
      expect(() => t.s.edit(t.project.id, "another", { remove: [{ itemId: b.id }] })).toThrow(/has ended/);
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("ends the run as usual when every ticket is taken off", async () => {
    const t = await boot();
    try {
      const a = t.make("A");
      const shift = t.s.start(t.project.id, { itemIds: [a.id], concurrency: 1 });
      t.s.edit(t.project.id, shift.id, { remove: [{ itemId: a.id }] });
      await t.s.tick();
      expect(t.s.current(t.project.id)).toBeNull();
      expect(t.code.starts).toEqual([]);
      expect(t.s.list(t.project.id, 1)[0]).toMatchObject({ status: "ended", halt: null, tickets: [] });
    } finally {
      await t.ctx.fiber.dispose();
    }
  });

  it("does not count what the person added against the agent's inserts", async () => {
    const t = await boot();
    try {
      const [a, b] = [t.make("A"), t.make("B")];
      const shift = t.s.start(t.project.id, { itemIds: [a.id], concurrency: 1, maxInserts: 1 });
      await t.s.tick();
      t.s.edit(t.project.id, shift.id, { add: [b.id] });
      await t.s.tick();
      const stored = t.s.current(t.project.id)!;
      expect(insertGate(stored, {}, "coding", 0)).toBeNull();
    } finally {
      await t.ctx.fiber.dispose();
    }
  });
});

describe("what an agent finds along the way", () => {
  const scene = async (maxInserts = 3) => {
    const { f, llm } = await bootWithReport();
    const code = f.ctx.codeLink as unknown as FakeCodeLink;
    const boardId = f.ctx.boards.list(f.project.id)[0]!.id;
    const make = (title: string) => f.items.create({ projectId: f.project.id, boardId, title, status: "todo", workType: "coding", by: "human" });
    const a = make("Build the export");
    const shift = f.ctx.nightShift.start(f.project.id, { itemIds: [a.id], maxInserts, concurrency: 2 });
    await f.ctx.nightShift.tick();
    return { f, llm, code, a, shift, s: f.ctx.nightShift, make };
  };
  const finding = { title: "Saving crashes on empty names", body: "src/save.ts throws" };

  it("tells each agent how to report when it starts", async () => {
    const t = await scene();
    try {
      expect(t.code.starts[0]!.opts.message).toContain(`from: "${t.a.key}"`);
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("files it, and a clear yes joins the run with where it came from", async () => {
    const t = await scene();
    try {
      t.llm.triageReply = { decision: "now", why: "It stops the export working" };
      const told = await t.s.report(t.f.project.id, t.a.key, finding);
      expect(told.outcome).toBe("inserted");
      await t.s.tick();
      const view = t.s.current(t.f.project.id)!;
      const added = view.tickets.find((x) => x.key === told.key)!;
      expect(added.origin).toEqual({ fromId: t.a.id, fromKey: t.a.key, why: "It stops the export working" });
      expect(t.code.starts.map((s) => s.itemId)).toContain(added.itemId);
      expect(view.steps.find((s) => s.kind === "inserted")).toMatchObject({ key: told.key, note: `Found in ${t.a.key}: It stops the export working` });
      expect(t.f.items.get(t.f.project.id, added.itemId)).toMatchObject({ title: finding.title, status: expect.any(String) });
      expect(t.f.items.get(t.f.project.id, t.a.id)!.title).toBe("Build the export");
      expect(t.llm.seen[0]).toContain(finding.title);
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("files it and leaves it when the model says later, keeps the reason, and starts nothing", async () => {
    const t = await scene();
    try {
      t.llm.triageReply = { decision: "later", why: "A cleanup" };
      const told = await t.s.report(t.f.project.id, t.a.key, finding);
      expect(told).toMatchObject({ outcome: "later", why: "A cleanup" });
      await t.s.tick();
      const view = t.s.current(t.f.project.id)!;
      expect(view.tickets).toHaveLength(1);
      expect(view.found).toMatchObject([{ key: told.key, fromKey: t.a.key, why: "A cleanup", duplicate: false }]);
      expect(t.f.items.get(t.f.project.id, view.found[0]!.itemId)!.status).toBe("backlog");
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("files it and inserts nothing when no model can judge, or the model fails", async () => {
    const t = await scene();
    try {
      expect((await t.s.report(t.f.project.id, t.a.key, finding)).outcome).toBe("later");
      t.llm.working = false;
      expect((await t.s.report(t.f.project.id, t.a.key, { ...finding, title: "Another problem entirely" })).outcome).toBe("later");
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("does not ask the model when the limit already says no", async () => {
    const t = await scene(0);
    try {
      t.llm.triageReply = { decision: "now", why: "x" };
      expect((await t.s.report(t.f.project.id, t.a.key, finding)).outcome).toBe("later");
      expect(t.llm.seen).toEqual([]);
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("holds the limit when two reports race the model", async () => {
    const t = await scene(1);
    try {
      t.llm.triageReply = { decision: "now", why: "x" };
      const both = await Promise.all([t.s.report(t.f.project.id, t.a.key, finding), t.s.report(t.f.project.id, t.a.key, { title: "A different failure on load", body: "elsewhere" })]);
      expect(both.map((b) => b.outcome).sort()).toEqual(["inserted", "later"]);
      await t.s.tick();
      expect(t.s.current(t.f.project.id)!.tickets.filter((x) => x.origin)).toHaveLength(1);
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("files nothing new for what the backlog already has", async () => {
    const t = await scene();
    try {
      const known = t.make("Saving crashes on empty names");
      const before = t.f.items.listAll(t.f.project.id).length;
      expect(await t.s.report(t.f.project.id, t.a.key, finding)).toMatchObject({ outcome: "duplicate", key: known.key });
      await t.s.tick();
      expect(t.f.items.listAll(t.f.project.id)).toHaveLength(before);
      expect(t.s.current(t.f.project.id)!.steps.at(-1)).toMatchObject({ kind: "duplicate", key: known.key });
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("one level deep: what an added ticket finds stays in the backlog", async () => {
    const t = await scene();
    try {
      t.llm.triageReply = { decision: "now", why: "x" };
      const first = await t.s.report(t.f.project.id, t.a.key, finding);
      await t.s.tick();
      const nested = await t.s.report(t.f.project.id, first.key, { title: "A second, deeper problem", body: "found by the added ticket" });
      expect(nested.outcome).toBe("later");
      expect(t.llm.seen).toHaveLength(1);
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("takes nothing on once the run is stopping", async () => {
    const t = await scene();
    try {
      t.llm.triageReply = { decision: "now", why: "x" };
      t.s.stop(t.f.project.id, t.shift.id);
      expect((await t.s.report(t.f.project.id, t.a.key, finding)).outcome).toBe("later");
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("an added ticket counts against the run's failures", async () => {
    const t = await scene();
    try {
      t.llm.triageReply = { decision: "now", why: "x" };
      const told = await t.s.report(t.f.project.id, t.a.key, finding);
      await t.s.tick();
      const session = t.code.sessionsList.find((s) => s.itemIds.includes(t.s.current(t.f.project.id)!.tickets.find((x) => x.key === told.key)!.itemId))!;
      session.state = "error";
      await t.s.tick();
      expect(t.s.current(t.f.project.id)!.failStreak).toBe(1);
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("refuses a ticket that is not on the run", async () => {
    const t = await scene();
    try {
      await expect(t.s.report(t.f.project.id, "NOPE-1", finding)).rejects.toThrow("No auto run");
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });

  it("the report lists what joined and what was left", async () => {
    const t = await scene();
    try {
      t.llm.triageReply = { decision: "now", why: "It matters" };
      const added = await t.s.report(t.f.project.id, t.a.key, finding);
      t.llm.triageReply = { decision: "later", why: "It can wait" };
      const left = await t.s.report(t.f.project.id, t.a.key, { title: "Tidy the export names", body: "cosmetic" });
      await t.f.ctx.nightShift.tick();
      const files = t.f.ctx.files as unknown as FakeFiles;
      for (const ticket of t.s.current(t.f.project.id)!.tickets) t.f.items.update(t.f.project.id, ticket.itemId, { status: "verifying" }, "human");
      for (const session of t.code.sessionsList) session.state = "idle";
      await vi.waitFor(async () => {
        await t.s.tick();
        expect(t.s.list(t.f.project.id, 1)[0]?.briefPath).toBeTruthy();
      });
      const body = [...files.written.values()][0]!;
      expect(body).toContain("## Added along the way");
      expect(body).toContain(`- ${added.key} ${finding.title}: Found in ${t.a.key}: It matters`);
      expect(body).toContain("## Found and left for you");
      expect(body).toContain(`- ${left.key} Tidy the export names: Found in ${t.a.key}: It can wait`);
    } finally {
      await t.f.ctx.fiber.dispose();
    }
  });
});
