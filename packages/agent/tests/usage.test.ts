import { expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent } from "@tomradex/agent";

it("adds up runs per engine for today and the week, and a ticket's spend as its Cost field", async () => {
  const { ctx, project, items, board } = await fresh({ plugins: [Tools, [Settings, { path: `/tmp/tomrade-usage-${Date.now()}.json` }], Agent] });
  await settle();
  const costs = [0.2, 0.05, 0.1, 0.4];
  let n = 0;
  ctx.agent.engine({ id: "spend", title: "Spender", author: "ai:test", available: async () => ({ ok: true }),
    async turn() {
      const costUsd = costs[n++];
      return { stop: "end", costUsd, usage: { inputTokens: 1000, outputTokens: 100 }, metrics: { transport: "rpc", runtime: "warm", providerModel: "spend-model" } };
    } });
  ctx.agent.engine({ id: "free", title: "Tokens only", author: "ai:test", available: async () => ({ ok: true }),
    async turn() {
      return { stop: "end", usage: { inputTokens: 50, outputTokens: 5 } };
    } });
  ctx.agent.engine({ id: "cached", title: "Cached", author: "ai:test", available: async () => ({ ok: true }),
    async turn() {
      return { stop: "end", usage: { inputTokens: 10_000, outputTokens: 40 }, metrics: { transport: "rpc", runtime: "warm", uncachedInputTokens: 1_000, cacheReadTokens: 8_500, cacheWriteTokens: 500 } };
    } });
  const settled = async (threadId: string, count: number) => {
    for (let i = 0; i < 500; i++) {
      const runs = ctx.agent.store.runs(project.id, threadId);
      if (runs.length === count && runs.every((r) => r.status !== "running")) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error("runs never settled");
  };
  try {
    const ticket = items.create({ projectId: project.id, boardId: board.id, title: "Export", by: "human" });
    // a ticket's own thread needs a repository to run in; the spend only cares which ticket a thread stands for
    const coding = ctx.agent.newThread(project.id, "spend");
    ctx.agent.send(project.id, coding.id, { kind: "text", text: "one" });
    await settled(coding.id, 1);
    ctx.agent.send(project.id, coding.id, { kind: "text", text: "two" });
    await settled(coding.id, 2);
    ctx.db.for(project.id).prepare("UPDATE plugin_agent_threads SET item_id = ? WHERE id = ?").run(ticket.id, coding.id);
    const chat = ctx.agent.newThread(project.id, "spend");
    ctx.agent.send(project.id, chat.id, { kind: "text", text: "three" });
    await settled(chat.id, 1);
    const old = ctx.agent.newThread(project.id, "spend");
    ctx.agent.send(project.id, old.id, { kind: "text", text: "last month" });
    await settled(old.id, 1);
    ctx.db.for(project.id).prepare("UPDATE plugin_agent_runs SET started_at = ? WHERE thread_id = ?").run(Date.now() - 9 * 86_400_000, old.id);
    const free = ctx.agent.newThread(project.id, "free");
    ctx.agent.send(project.id, free.id, { kind: "text", text: "four" });
    await settled(free.id, 1);
    const cached = ctx.agent.newThread(project.id, "cached");
    ctx.agent.send(project.id, cached.id, { kind: "text", text: "five" });
    await settled(cached.id, 1);
    ctx.agent.send(project.id, cached.id, { kind: "text", text: "six" });
    await settled(cached.id, 2);

    expect(ctx.fields.get(project.id, "cost")).toMatchObject({ name: "Cost", derived: true, unit: "usd", readonly: true });
    expect(ctx.fields.derivedValues(project.id).get(ticket.id)?.cost).toBeCloseTo(0.25);
    expect(ctx.items.query({ projectId: project.id, filter: [{ field: "cost", op: "gte", values: [0.2] }], sortBy: [] }).map((i) => i.id)).toEqual([ticket.id]);

    const usage = ctx.agent.usage();
    expect(usage.week.map((u) => [u.engine, u.runs, u.inputTokens, u.outputTokens])).toEqual([["spend", 3, 3000, 300], ["cached", 2, 20_000, 80], ["free", 1, 50, 5]]);
    // a conversation's runs show the same split the pane adds up
    const runs = ctx.agent.store.runs(project.id, cached.id);
    expect(runs[0].tokens).toEqual({ inputTokens: 10_000, uncachedInputTokens: 1_000, cacheReadTokens: 8_500, cacheWriteTokens: 500, outputTokens: 40 });
    const pane = usage.week.find((u) => u.engine === "cached")!;
    for (const part of ["inputTokens", "uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"] as const) {
      expect(pane[part]).toBe(runs.reduce((sum, r) => sum + r.tokens![part], 0));
    }
    expect(usage.week.find((u) => u.engine === "free")).toMatchObject({ uncachedInputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(usage.week[0].costUsd).toBeCloseTo(0.35);
    expect(usage.week[0].title).toBe("Spender");
    expect(usage.week[2].costUsd).toBeNull();
    expect(usage.today).toMatchObject(usage.week);

    // The pane's own range: every local day present, including empty ones, and the old run still inside 30 days.
    const report = ctx.agent.usage(Date.now(), 30).range;
    expect(report.days).toHaveLength(30);
    expect(report.days.reduce((sum, d) => sum + d.runs, 0)).toBe(7);
    expect(report.days.reduce((sum, d) => sum + (d.costUsd ?? 0), 0)).toBe(0.75);
    expect(report.totals).toMatchObject({ runs: 7, failedRuns: 0, costKnownRuns: 4, costUnknownRuns: 3 });
    expect(report.totals.duration?.samples).toBe(7);
    // the ticket's runs are the ones its Cost field sums, named for the pane; the rest stay counted as no ticket
    expect(report.tickets).toMatchObject([{ itemId: ticket.id, key: ticket.key, title: "Export", runs: 2, costUsd: 0.25 }]);
    expect(report.noTicket.runs).toBe(5);
    const spend = ctx.agent.ticketUsage(project.id, ticket.id);
    expect(spend.totals).toMatchObject({ runs: 2, costUsd: 0.25, costUnknownRuns: 0 });
    expect(spend.engines).toMatchObject([{ engine: "spend", title: "Spender", runs: 2 }]);
    expect(spend.deliveries).toMatchObject([{ sequence: null, runs: 2 }]);
    const shift = ctx.agent.spendByTicket(project.id, [ticket.id], 0);
    expect(shift.tickets.get(ticket.id)?.totals.costUsd).toBe(0.25);
    expect(shift.engines).toMatchObject([{ title: "Spender", runs: 2, costUsd: 0.25 }]);
    expect(report.engines.find((e) => e.engine === "spend")).toMatchObject({ runs: 4, costUsd: 0.75, costKnownRuns: 4, costUnknownRuns: 0 });
    // Money adds in micro-dollars: 0.2 + 0.05 + 0.1 + 0.4 is exactly 0.75, not 0.7500000000000001.
    expect(report.engines.find((e) => e.engine === "spend")!.costUsd).toBe(0.75);
    expect(report.engines.find((e) => e.engine === "cached")).toMatchObject({ cacheHitRate: 0.85, runs: 2 });
    expect(report.engines.find((e) => e.engine === "free")).toMatchObject({ costUsd: null, costKnownRuns: 0, costUnknownRuns: 1 });
    // The provider model the engine actually served with, kept apart inside the engine.
    expect(report.engines.find((e) => e.engine === "spend")!.models).toMatchObject([{ model: "spend-model", runs: 4, costUsd: 0.75 }]);

    // A one-day range still ends today and knows where the week starts.
    const oneDay = ctx.agent.usage(Date.now(), 1).range;
    expect(oneDay.days).toHaveLength(1);
    expect(oneDay.totals.runs).toBe(6);
  } finally {
    await ctx.fiber.dispose();
  }
});

it("splits a ticket's runs by agent and by delivery, and the pane's window by ticket", async () => {
  const { ticketSpend, aggregateUsage } = await import("@tomradex/agent");
  const run = (engine: string, startedAt: number, costUsd: number | null, extra: { itemId?: string | null; deliveryId?: string | null } = {}) =>
    ({ engine, status: "done" as const, startedAt, endedAt: startedAt + 10, usage: { inputTokens: 100, outputTokens: 10 }, metrics: null, costUsd, projectId: "p", ...extra });
  const deliveries = [
    { id: "d1", sequence: 1, state: "completed", startedAt: 100, completedAt: 200 },
    { id: "d2", sequence: 2, state: "active", startedAt: 300, completedAt: null }
  ];
  const spend = ticketSpend(
    [run("claude", 50, 0.1), run("claude", 150, 0.2), run("codex", 250, null), run("codex", 350, 0.3), run("claude", 120, 0.05, { deliveryId: "d2" })],
    deliveries,
    new Map([["claude", "Claude Code"]])
  );
  expect(spend.totals).toMatchObject({ runs: 5, costUsd: 0.65, costKnownRuns: 4, costUnknownRuns: 1 });
  expect(spend.engines.map((e) => [e.title, e.runs, e.costUsd])).toEqual([["Claude Code", 3, 0.35], ["codex", 2, 0.3]]);
  // before any delivery; the first; a run between deliveries stays with the one it followed; a General run's pin wins over time
  expect(spend.deliveries.map((d) => [d.sequence, d.state, d.runs, d.costUsd])).toEqual([[null, null, 1, 0.1], [1, "completed", 2, 0.2], [2, "active", 2, 0.35]]);

  const report = aggregateUsage([run("claude", 1000, 0.5, { itemId: "a" }), run("claude", 1001, 0.1, { itemId: "a" }), run("codex", 1002, 0.9, { itemId: "b" }), run("codex", 1003, null), run("claude", 1004, null, { itemId: "c" })], { from: 0, to: 2000, dayCount: 1 });
  expect(report.tickets.map((t) => [t.itemId, t.runs, t.costUsd])).toEqual([["b", 1, 0.9], ["a", 2, 0.6], ["c", 1, null]]);
  expect(report.noTicket).toMatchObject({ runs: 1, costUsd: null });
  expect(report.totals.runs).toBe(5);
});
