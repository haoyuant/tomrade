import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fresh, settle } from "@tomrade/testkit";
import { Tools } from "@tomrade/tools";
import { Settings } from "@tomrade/settings";
import { Agent } from "@tomrade/agent";
import { Mcp } from "@tomrade/mcp";
import engineClaudeCode from "@tomrade/engine-claude-code";

/** Opt-in: spawns the real `claude` CLI with the user's own login. TOMRADE_LIVE_CC=1 pnpm test */
describe.skipIf(!process.env.TOMRADE_LIVE_CC)("live Claude Code", () => {
  it("conducts one real turn, calling tomrade tools over MCP", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-${Date.now()}.json`);
    const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();
    items.create({ projectId: project.id, boardId: board.id, title: "Ship the water reminder", by: "human" });

    const thread = ctx.agent.newThread(project.id, "claude-code");
    const { runId } = ctx.agent.send(thread.id, {
      kind: "text",
      text: "Use the tomrade list_items tool once, then reply with only the number of items you saw. Create nothing."
    });
    const t0 = Date.now();
    for (;;) {
      const run = ctx.agent.store.run(runId);
      if (run && run.status !== "running") break;
      if (Date.now() - t0 > 150_000) throw new Error("live run did not settle");
      await new Promise((r) => setTimeout(r, 250));
    }
    const run = ctx.agent.store.run(runId)!;
    const blocks = ctx.agent.store.messages(thread.id).map((m) => m.block);
    const traces = blocks.filter((b) => b.type === "trace");
    expect(run.status).toBe("done");
    expect(traces.some((t) => t.type === "trace" && t.tool === "list_items" && t.ok)).toBe(true);
    expect(run.changes).toBe(0);
    expect(ctx.agent.store.external(thread.id)["claude-code"]).toBeTruthy();
  }, 180_000);
});
