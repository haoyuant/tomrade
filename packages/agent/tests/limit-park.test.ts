import { afterEach, expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent, type TurnResult } from "@tomradex/agent";

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
};

// Local noon by default: the lift time it prints then never crosses midnight.
async function boot(results: ((n: number) => TurnResult), fake = true, now = new Date(2026, 9, 18, 12, 0)) {
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: `/tmp/tomrade-limit-${Date.now()}-${Math.random()}.json` }], Agent] });
  await settle();
  if (fake) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(now);
  }
  const said: string[] = [];
  ctx.agent.engine({ id: "limited", title: "Limited", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input) {
      said.push(input.input.kind === "text" ? input.input.text : "");
      return results(said.length);
    } });
  const lifted: string[] = [];
  ctx.on("agent/limit-lifted", (park) => lifted.push(park.threadId));
  const thread = ctx.agent.newThread(project.id, "limited");
  const runs = () => ctx.agent.store.runs(project.id, thread.id);
  const settled = (n: number) => until(() => runs().length === n && runs().every((r) => r.status !== "running"));
  const notes = () => ctx.agent.store.messages(project.id, thread.id).flatMap((m) => (m.block.type === "note" ? [m.block.text] : []));
  return { ctx, project, thread, said, lifted, runs, settled, notes };
}

afterEach(() => vi.useRealTimers());

it.each([
  { at: new Date(2026, 9, 18, 12, 0), lifts: "13:00" },
  { at: new Date(2026, 9, 18, 23, 30), lifts: "tomorrow 00:30" }
])("parks a run stopped by a usage limit and continues the conversation once it lifts (at $lifts)", async ({ at, lifts }) => {
  let resetAt = 0;
  const t = await boot((n) => (n === 1 ? { stop: "error", error: "You've hit your limit", limit: { until: (resetAt = Date.now() + 60 * 60_000) } } : { stop: "end" }), true, at);
  try {
    t.ctx.agent.send(t.project.id, t.thread.id, { kind: "text", text: "build it" });
    await t.settled(1);
    expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toMatchObject({ until: resetAt, known: true, resume: true, attempt: 1 });
    expect(t.notes().at(-1)).toBe(`Hit a usage limit; it lifts at ${lifts}. Tomrade continues this conversation then.`);

    vi.advanceTimersByTime(59 * 60_000);
    await t.settled(1);
    vi.advanceTimersByTime(2 * 60_000);
    await t.settled(2);
    expect(t.said).toEqual(["build it", "The usage limit has lifted. Continue where you left off."]);
    expect(t.runs().map((r) => r.status)).toEqual(["error", "done"]);
    expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toBeNull();
    expect(t.lifted).toEqual([]);
  } finally { await t.ctx.fiber.dispose(); }
});

it("reads the limit from an error's words when the engine does not flag it, and guesses when they give no time", async () => {
  const t = await boot((n) => (n === 1 ? { stop: "error", error: "LLM request failed 429 Too Many Requests: try again in 2 minutes" } : n === 2 ? { stop: "error", error: "rate limited" } : { stop: "end" }));
  try {
    const start = Date.now();
    t.ctx.agent.send(t.project.id, t.thread.id, { kind: "text", text: "go" });
    await t.settled(1);
    expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toMatchObject({ until: start + 2 * 60_000, known: true, attempt: 1 });
    vi.advanceTimersByTime(3 * 60_000);
    await t.settled(2);
    const park = t.ctx.agent.parked(t.project.id, t.thread.id)!;
    expect(park).toMatchObject({ known: false, resume: true, attempt: 2 });
    expect(park.until - Date.now()).toBe(15 * 60_000);
    expect(t.notes().at(-1)).toMatch(/did not say when it lifts, so the next try is at/);
  } finally { await t.ctx.fiber.dispose(); }
});

it("stops trying after three limited runs in a row, and tells whoever listens that it can go on", async () => {
  const t = await boot(() => ({ stop: "error", error: "usage limit reached", limit: { until: null } }));
  try {
    t.ctx.agent.send(t.project.id, t.thread.id, { kind: "text", text: "go" });
    for (let n = 1; n <= 3; n++) {
      await t.settled(n);
      expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toMatchObject({ attempt: n, resume: true });
      vi.advanceTimersByTime(16 * 60_000);
    }
    await t.settled(4);
    expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toMatchObject({ attempt: 4, resume: false });
    expect(t.notes().at(-1)).toBe("Still limited after 3 tries in a row, so Tomrade stops trying on its own. Continue it once the limit has lifted.");
    vi.advanceTimersByTime(16 * 60_000);
    await until(() => t.lifted.length === 1);
    expect(t.runs()).toHaveLength(4);
    expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toBeNull();
  } finally { await t.ctx.fiber.dispose(); }
});

it("forgets the wait when the person continues first, and counts from one again", async () => {
  const t = await boot((n) => (n <= 2 ? { stop: "error", error: "rate limited", limit: { until: Date.now() + 60_000 } } : { stop: "end" }));
  try {
    t.ctx.agent.send(t.project.id, t.thread.id, { kind: "text", text: "go" });
    await t.settled(1);
    t.ctx.agent.send(t.project.id, t.thread.id, { kind: "text", text: "try now" });
    await t.settled(2);
    expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toMatchObject({ attempt: 1 });
    t.ctx.agent.send(t.project.id, t.thread.id, { kind: "text", text: "and again" });
    await t.settled(3);
    expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    await t.settled(3);
    expect(t.said).toEqual(["go", "try now", "and again"]);
  } finally { await t.ctx.fiber.dispose(); }
});

it("with the setting off, only says it can go on", async () => {
  const t = await boot(() => ({ stop: "error", error: "rate limited", limit: { until: Date.now() + 60_000 } }));
  try {
    const settings = t.ctx.settings.get();
    t.ctx.settings.set({ ...settings, agent: { ...(settings.agent as object), resumeAfterLimit: false } });
    t.ctx.agent.send(t.project.id, t.thread.id, { kind: "text", text: "go" });
    await t.settled(1);
    expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toMatchObject({ resume: false });
    expect(t.notes().at(-1)).toMatch(/Continue it then\.$/);
    vi.advanceTimersByTime(2 * 60_000);
    await until(() => t.lifted.length === 1);
    expect(t.runs()).toHaveLength(1);
  } finally { await t.ctx.fiber.dispose(); }
});

it("does not take an ordinary failure for a limit", async () => {
  const t = await boot(() => ({ stop: "error", error: "LLM request failed 401: invalid api key" }), false);
  try {
    t.ctx.agent.send(t.project.id, t.thread.id, { kind: "text", text: "go" });
    await t.settled(1);
    expect(t.ctx.agent.parked(t.project.id, t.thread.id)).toBeNull();
    expect(t.notes()).toEqual([]);
  } finally { await t.ctx.fiber.dispose(); }
});
