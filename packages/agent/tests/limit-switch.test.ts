import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent, type EngineRegistration, type TurnInput, type TurnResult } from "@tomradex/agent";

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
};

const BALANCE: TurnResult = { stop: "error", error: "Credit balance is too low" };
const WAIT = (minutes = 60): TurnResult => ({ stop: "error", error: "You've hit your limit", limit: { until: Date.now() + minutes * 60_000 } });

interface Boot {
  /** What the stopping engine answers, turn by turn. */
  first?: (n: number) => TurnResult;
  /** What the engine that takes over answers. */
  second?: () => TurnResult;
  /** Other engines registered between the two, or instead of the second. */
  others?: EngineRegistration[];
  noSecond?: boolean;
  capabilities?: EngineRegistration["capabilities"];
  thread?: { itemId: string; branch: string };
}

async function boot({ first = () => BALANCE, second = () => ({ stop: "end" }), others = [], noSecond, capabilities, thread: opts }: Boot = {}) {
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: `/tmp/tomrade-switch-${Date.now()}-${Math.random()}.json` }], Agent] });
  await settle();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date(2026, 9, 18, 12, 0));
  const firstTurns: TurnInput[] = [];
  const secondTurns: TurnInput[] = [];
  const secondIo: { recap: string; resume: string | undefined }[] = [];
  ctx.agent.engine({ id: "first", title: "First", author: "ai:test", capabilities, available: async () => ({ ok: true }),
    async turn(input) {
      firstTurns.push(input);
      return first(firstTurns.length);
    } });
  for (const engine of others) ctx.agent.engine(engine);
  if (!noSecond) ctx.agent.engine({ id: "second", title: "Second", author: "ai:test", capabilities, available: async () => ({ ok: true }),
    async turn(input, io) {
      secondTurns.push(input);
      secondIo.push({ recap: io.recap?.() ?? "", resume: io.resume });
      return second();
    } });
  const thread = ctx.agent.newThread(project.id, "first", null, opts);
  const runs = () => ctx.agent.store.runs(project.id, thread.id);
  const settled = (n: number) => until(() => runs().length === n && runs().every((r) => r.status !== "running"));
  const pending = () => ctx.agent.thread(project.id, thread.id).pending;
  const asked = () => until(() => !!pending());
  const answer = (value: string) => ctx.agent.send(project.id, thread.id, { kind: "answer", questionId: pending()!.question.id, value });
  const said = () => ctx.agent.store.messages(project.id, thread.id).flatMap((m) => (m.block.type === "text" ? [`${m.role}: ${m.block.text}`] : []));
  const questions = () => ctx.agent.store.messages(project.id, thread.id).flatMap((m) => (m.block.type === "question" ? [m.block.text] : []));
  const send = (text = "build it") => ctx.agent.send(project.id, thread.id, { kind: "text", text });
  return { ctx, project, thread, firstTurns, secondTurns, secondIo, runs, settled, pending, asked, answer, said, questions, send };
}

const code = (id: string, title: string, extra: Partial<EngineRegistration> = {}): EngineRegistration =>
  ({ id, title, author: "ai:test", available: async () => ({ ok: true }), turn: async () => ({ stop: "end" }), ...extra }) as EngineRegistration;

afterEach(() => vi.useRealTimers());

describe("offering the next engine", () => {
  it("asks when the balance runs out, naming the engine, the reason and where it would go", async () => {
    const t = await boot();
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      expect(t.pending()).toMatchObject({ kind: "switch", accepts: "options", question: { text: "First has run out of balance. Switch to Second and carry on?", options: ["Switch to Second", "Stay here"] } });
      expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toBeNull();
      expect(t.ctx.agent.store.thread(t.project.id, t.thread.id)?.engine).toBe("first");
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("asks about a limit that lifts and still parks the thread", async () => {
    const t = await boot({ first: () => WAIT() });
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      expect(t.pending()?.question).toMatchObject({ text: "First hit a usage limit; it lifts at 13:00. Switch to Second and carry on now?", options: ["Switch to Second", "Wait for the limit to lift"] });
      expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toMatchObject({ resume: true, attempt: 1 });
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("says nothing new when no other engine is ready", async () => {
    const t = await boot({ noSecond: true, others: [code("down", "Down", { available: async () => ({ ok: false, reason: "signed out" }) }), code("terminal", "Terminal", { terminalOnly: true }), code("doc", "Doctor", { capabilities: [] }), code("words", "Words", { literal: true })] });
    try {
      t.send();
      await t.settled(1);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(t.pending()).toBeNull();
      expect(t.ctx.agent.store.messages(t.project.id, t.thread.id).map((m) => m.block.type)).toEqual(["text", "error"]);
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("does not ask about an ordinary failure", async () => {
    const t = await boot({ first: () => ({ stop: "error", error: "LLM request failed 401: invalid api key" }) });
    try {
      t.send();
      await t.settled(1);
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      expect(t.pending()).toBeNull();
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("does not ask in a troubleshooter's thread", async () => {
    const t = await boot();
    try {
      t.ctx.agent.store.touchThread(t.project.id, t.thread.id, { surface: "doctor" });
      t.send();
      await t.settled(1);
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      expect(t.pending()).toBeNull();
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("a ticket's thread only moves to an engine that can code in the panel", async () => {
    const t = await boot({
      capabilities: ["backlog", "code"],
      thread: { itemId: "ticket", branch: "tom-1/work" },
      others: [
        code("chat", "Chat", { capabilities: ["backlog"] }),
        code("handed", "Handed", { capabilities: ["code"], terminalOnly: true }),
        code("not-now", "Not now", { capabilities: ["backlog", "code"], available: async () => ({ ok: true, capabilities: ["backlog"] }) })
      ]
    });
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      expect(t.pending()?.question.text).toBe("First has run out of balance. Switch to Second and carry on?");
      expect(await t.ctx.agent.nextEngine("first", { capability: "code", terminal: true })).toMatchObject({ id: "handed" });
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("takes engines in the order they stand, past the one that stopped and under any name it took in", async () => {
    const t = await boot({ others: [code("second-b", "Second B", { includes: ["old-name"] })] });
    try {
      expect((await t.ctx.agent.nextEngine("first"))?.id).toBe("second-b");
      expect((await t.ctx.agent.nextEngine("second-b"))?.id).toBe("first");
      expect((await t.ctx.agent.nextEngine("old-name"))?.id).toBe("first");
    } finally { await t.ctx.fiber.dispose(); }
  });
});

describe("the person agrees", () => {
  it("moves the thread and goes on, with the conversation so far", async () => {
    const t = await boot();
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      t.answer("Switch to Second");
      await t.settled(2);
      expect(t.ctx.agent.store.thread(t.project.id, t.thread.id)?.engine).toBe("second");
      expect(t.pending()).toBeNull();
      expect(t.runs().map((r) => r.engine)).toEqual(["first", "second"]);
      expect(t.secondTurns[0]?.input).toEqual({ kind: "text", text: "First stopped, so Second takes over from here. Continue where it left off." });
      expect(t.secondTurns[0]?.messages.map((m) => m.block.type)).toContain("error");
      expect(t.secondIo[0]?.recap).toContain("User: build it");
      expect(t.secondIo[0]?.resume).toBeUndefined();
      const notes = t.ctx.agent.store.messages(t.project.id, t.thread.id).flatMap((m) => (m.block.type === "note" ? [m.block.text] : []));
      expect(notes).toEqual(["Engine switched to Second."]);
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("a ticket's thread stays on its branch", async () => {
    const t = await boot({ capabilities: ["backlog", "code"], thread: { itemId: "ticket", branch: "tom-1/work" } });
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      t.answer("Switch to Second");
      await t.settled(2);
      expect(t.ctx.agent.store.thread(t.project.id, t.thread.id)).toMatchObject({ engine: "second", itemId: "ticket", branch: "tom-1/work" });
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("forgets the wait it left, and an old session of the engine it goes back to", async () => {
    const t = await boot({ first: () => WAIT() });
    try {
      t.ctx.agent.store.setExternal(t.project.id, t.thread.id, "second", "stale-session");
      t.send();
      await t.settled(1);
      await t.asked();
      t.answer("Switch to Second");
      await t.settled(2);
      expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toBeNull();
      expect(t.secondIo[0]?.resume).toBeUndefined();
      vi.advanceTimersByTime(2 * 60 * 60_000);
      await t.settled(2);
      expect(t.firstTurns).toHaveLength(1);
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("the answer's request id does not switch twice", async () => {
    const t = await boot();
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      const input = { kind: "answer", questionId: t.pending()!.question.id, value: "Switch to Second" } as const;
      const first = t.ctx.agent.send(t.project.id, t.thread.id, input, { requestId: "r1" });
      const again = t.ctx.agent.send(t.project.id, t.thread.id, input, { requestId: "r1" });
      expect(again).toEqual(first);
      await t.settled(2);
    } finally { await t.ctx.fiber.dispose(); }
  });
});

describe("the person declines", () => {
  it("out of balance, it stops where it is and is not asked again", async () => {
    const t = await boot();
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      const { runId } = t.answer("Stay here");
      expect(runId).toBe(t.runs()[0]!.id);
      expect(t.pending()).toBeNull();
      expect(t.runs()).toHaveLength(1);
      expect(t.said()).toEqual(["user: build it", "user: Stay here"]);
      expect(t.ctx.agent.store.thread(t.project.id, t.thread.id)?.engine).toBe("first");

      t.send("try again");
      await t.settled(2);
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      expect(t.pending()).toBeNull();
      expect(t.questions()).toHaveLength(1);
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("a limit stays parked, goes on at its time, and hitting it again asks nothing", async () => {
    const t = await boot({ first: (n) => (n <= 2 ? WAIT() : { stop: "end" }) });
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      t.answer("Wait for the limit to lift");
      expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toMatchObject({ attempt: 1 });

      vi.advanceTimersByTime(61 * 60_000);
      await t.settled(2);
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toMatchObject({ attempt: 2 });
      expect(t.pending()).toBeNull();
      expect(t.questions()).toHaveLength(1);

      vi.advanceTimersByTime(61 * 60_000);
      await t.settled(3);
      expect(t.secondTurns).toEqual([]);
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("asks again once the engine has worked, or the thread moved to another", async () => {
    const t = await boot({ first: (n) => (n === 2 ? { stop: "end" } : BALANCE) });
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      t.answer("Stay here");
      t.send("topped up");
      await t.settled(2);
      expect(t.ctx.agent.store.switchDeclined(t.project.id, t.thread.id)).toBeNull();
      t.send("more");
      await t.settled(3);
      await t.asked();
      expect(t.questions()).toHaveLength(2);
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("survives on the thread, and moving the thread by hand clears it", async () => {
    const t = await boot();
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      t.answer("Stay here");
      expect(t.ctx.agent.store.switchDeclined(t.project.id, t.thread.id)).toBe("first");
      t.ctx.agent.setEngine(t.project.id, t.thread.id, "second");
      expect(t.ctx.agent.store.switchDeclined(t.project.id, t.thread.id)).toBeNull();
    } finally { await t.ctx.fiber.dispose(); }
  });
});

describe("no answer", () => {
  it("the limit lifting goes on as ever and the question lapses", async () => {
    const t = await boot({ first: (n) => (n === 1 ? WAIT() : { stop: "end" }) });
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      const stale = t.pending()!.question.id;
      vi.advanceTimersByTime(61 * 60_000);
      await t.settled(2);
      expect(t.pending()).toBeNull();
      expect(t.firstTurns.at(-1)?.input).toEqual({ kind: "text", text: "The usage limit has lifted. Continue where you left off." });
      expect(t.ctx.agent.store.thread(t.project.id, t.thread.id)?.engine).toBe("first");
      expect(() => t.ctx.agent.send(t.project.id, t.thread.id, { kind: "answer", questionId: stale, value: "Switch to Second" })).toThrow("Invalid or expired question response");
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("the limit lifting with nobody continuing also ends the question", async () => {
    const t = await boot({ first: () => WAIT() });
    try {
      const settings = t.ctx.settings.get();
      t.ctx.settings.set({ ...settings, agent: { ...(settings.agent as object), resumeAfterLimit: false } });
      t.send();
      await t.settled(1);
      await t.asked();
      vi.advanceTimersByTime(61 * 60_000);
      await until(() => !t.pending());
      expect(t.runs()).toHaveLength(1);
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("anything else the person sends goes to the thread's own engine and the question lapses", async () => {
    const t = await boot({ first: (n) => (n === 1 ? BALANCE : { stop: "end" }) });
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      t.send("I topped it up, go on");
      await t.settled(2);
      expect(t.pending()).toBeNull();
      expect(t.firstTurns.at(-1)?.input).toMatchObject({ kind: "text", text: "I topped it up, go on" });
      expect(t.secondTurns).toEqual([]);
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("typing an option's words counts as picking it", async () => {
    const t = await boot();
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      t.send(" Switch to Second ");
      await t.settled(2);
      expect(t.ctx.agent.store.thread(t.project.id, t.thread.id)?.engine).toBe("second");
    } finally { await t.ctx.fiber.dispose(); }
  });

  it("out of balance, the question waits for the person however long it takes", async () => {
    const t = await boot();
    try {
      t.send();
      await t.settled(1);
      await t.asked();
      vi.advanceTimersByTime(24 * 60 * 60_000);
      expect(t.pending()?.kind).toBe("switch");
      expect(t.ctx.agent.store.pending(t.project.id, t.thread.id)?.state).toMatchObject({ to: "second" });
    } finally { await t.ctx.fiber.dispose(); }
  });
});
