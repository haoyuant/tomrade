import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import engineWorkBuddy from "@tomradex/engine-workbuddy";

/** Opt-in: spawns the real `codebuddy` CLI (or WorkBuddy's own copy) with the user's account; the model defaults to one CodeBuddy lists at no credit cost. TOMRADE_LIVE_WORKBUDDY=1 pnpm test */
describe.skipIf(!process.env.TOMRADE_LIVE_WORKBUDDY)("live WorkBuddy", () => {
  it("conducts one real turn, calling tomrade tools over MCP", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-workbuddy-${Date.now()}.json`);
    const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineWorkBuddy] });
    await settle();
    items.create({ projectId: project.id, boardId: board.id, title: "Ship the water reminder", by: "human" });

    const thread = ctx.agent.newThread(project.id, "workbuddy");
    // TOMRADE_LIVE_WORKBUDDY_COMMAND may name the copy inside the WorkBuddy app.
    const command = process.env.TOMRADE_LIVE_WORKBUDDY_COMMAND;
    ctx.agent.setOptions(project.id, thread.id, { model: process.env.TOMRADE_LIVE_WORKBUDDY_MODEL ?? "deepseek-v4.1-flash", ...(command ? { command } : {}) });
    const { runId } = ctx.agent.send(project.id, thread.id, {
      kind: "text",
      text: "Use the tomrade list_items tool once, then reply with only the number of items you saw. Create nothing."
    });
    try {
      const t0 = Date.now();
      for (;;) {
        const run = ctx.agent.store.run(project.id, runId);
        if (run && run.status !== "running") break;
        if (Date.now() - t0 > 240_000) throw new Error("live run did not settle");
        await new Promise((r) => setTimeout(r, 250));
      }
      const run = ctx.agent.store.run(project.id, runId)!;
      const blocks = ctx.agent.store.messages(project.id, thread.id).map((m) => m.block);
      expect(run.status, run.error ?? "").toBe("done");
      expect(blocks.some((b) => b.type === "trace" && b.tool === "list_items" && b.ok)).toBe(true);
      expect(run.changes).toBe(0);
      expect(ctx.agent.store.external(project.id, thread.id).workbuddy).toBeTruthy();
    } finally { await ctx.fiber.dispose(); }
  }, 300_000);
});
