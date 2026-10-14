import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import engineClaudeCode from "@tomradex/engine-claude-code";

/** Opt-in: spawns the real `claude` CLI with the user's own login. TOMRADE_LIVE_CC=1 pnpm test */
describe.skipIf(!process.env.TOMRADE_LIVE_CC)("live Claude Code", () => {
  it("conducts one real turn, calling tomrade tools over MCP", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-${Date.now()}.json`);
    const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();
    items.create({ projectId: project.id, boardId: board.id, title: "Ship the water reminder", by: "human" });

    const thread = ctx.agent.newThread(project.id, "claude-code");
    const { runId } = ctx.agent.send(project.id, thread.id, {
      kind: "text",
      text: "Use the tomrade list_items tool once, then reply with only the number of items you saw. Create nothing."
    });
    const t0 = Date.now();
    for (;;) {
      const run = ctx.agent.store.run(project.id, runId);
      if (run && run.status !== "running") break;
      if (Date.now() - t0 > 150_000) throw new Error("live run did not settle");
      await new Promise((r) => setTimeout(r, 250));
    }
    const run = ctx.agent.store.run(project.id, runId)!;
    const blocks = ctx.agent.store.messages(project.id, thread.id).map((m) => m.block);
    const traces = blocks.filter((b) => b.type === "trace");
    expect(run.status).toBe("done");
    expect(traces.some((t) => t.type === "trace" && t.tool === "list_items" && t.ok)).toBe(true);
    expect(run.changes).toBe(0);
    expect(ctx.agent.store.external(project.id, thread.id)["claude-code"]).toBeTruthy();
  }, 180_000);

  it("takes a steer into the running turn, and waits out one that lands after the reply", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-steer-${Date.now()}.json`);
    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();
    const runCase = async (prompt: string, steer: string, when: (event: { type: string; message?: { block: { type: string } } }) => boolean) => {
      const thread = ctx.agent.newThread(project.id, "claude-code", null, { options: { model: "haiku" } });
      let taken: Promise<boolean> | null = null;
      const off = ctx.on("agent/event", (id: string, event: { type: string; message?: { block: { type: string } } }) => {
        if (id === thread.id && !taken && when(event)) taken = ctx.agent.steer(project.id, thread.id, "s", steer);
      });
      const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: prompt });
      const t0 = Date.now();
      while (ctx.agent.store.run(project.id, runId)?.status === "running") {
        if (Date.now() - t0 > 150_000) throw new Error("live run did not settle");
        await new Promise((r) => setTimeout(r, 250));
      }
      off();
      const said = ctx.agent.store.messages(project.id, thread.id).map((m) => (m.block.type === "text" ? `${m.role}${m.block.steerId ? "(steer)" : ""}: ${m.block.text}` : `${m.role}: ${m.block.type}`));
      console.log(said.join("\n"));
      return { taken: await taken, run: ctx.agent.store.run(project.id, runId)!, said, runs: ctx.agent.store.runs(project.id, thread.id).length };
    };
    const during = await runCase("Call the tomrade list_items tool, then the count_items tool, then tell me in one short sentence how many items there are. Create nothing.",
      "Change of plan: answer in French and start with BONJOUR.", (e) => e.type === "message" && e.message?.block.type === "trace");
    expect(during.taken).toBe(true);
    expect(during.run.status).toBe("done");
    expect(during.runs).toBe(1);
    const at = during.said.findIndex((line) => line.startsWith("user(steer)"));
    expect(at).toBeGreaterThan(0);
    expect(during.said.slice(at + 1).some((line) => /BONJOUR/i.test(line))).toBe(true);

    const late = await runCase("In three short sentences, explain what a kanban board is. Do not use any tools.",
      "Also end with the word PINEAPPLE.", (e) => e.type === "delta");
    expect(late.taken).toBe(true);
    expect(late.run.status).toBe("done");
    expect(late.runs).toBe(1);
    const after = late.said.slice(late.said.findIndex((line) => line.startsWith("user(steer)")) + 1);
    expect(after.some((line) => /PINEAPPLE/.test(line))).toBe(true);
  }, 360_000);
});

