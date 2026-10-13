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
      return { stop: "end", costUsd, usage: { inputTokens: 1000, outputTokens: 100 } };
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
    expect(usage.today).toEqual(usage.week);
  } finally {
    await ctx.fiber.dispose();
  }
});
