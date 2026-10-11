import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import enginePi from "@tomradex/engine-pi";

/** Opt-in: spawns the real `pi` CLI with the user's own credentials and default model. TOMRADE_LIVE_PI=1 pnpm test */
describe.skipIf(!process.env.TOMRADE_LIVE_PI)("live Pi", () => {
  it("conducts one real turn, calling tomrade tools over MCP", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-pi-${Date.now()}.json`);
    const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], enginePi] });
    await settle();
    items.create({ projectId: project.id, boardId: board.id, title: "Ship the water reminder", by: "human" });

    const thread = ctx.agent.newThread(project.id, "pi");
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
    expect(run.status, run.error ?? "").toBe("done");
    expect(blocks.some((b) => b.type === "trace" && b.tool === "list_items" && b.ok)).toBe(true);
    expect(run.changes).toBe(0);
    expect(ctx.agent.store.external(project.id, thread.id).pi).toBeTruthy();
  }, 180_000);
});
