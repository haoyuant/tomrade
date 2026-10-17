import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import engineOpencode from "@tomradex/engine-opencode";

/** Opt-in: spawns the real `opencode acp` with the user's own providers. TOMRADE_LIVE_OPENCODE=1 pnpm test; TOMRADE_LIVE_OPENCODE_MODEL picks the model. */
describe.skipIf(!process.env.TOMRADE_LIVE_OPENCODE)("live OpenCode", () => {
  it("conducts two real turns, calling tomrade tools over MCP, each counting its own tokens", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-opencode-${Date.now()}.json`);
    const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineOpencode] });
    await settle();
    items.create({ projectId: project.id, boardId: board.id, title: "Ship the water reminder", by: "human" });
    const model = process.env.TOMRADE_LIVE_OPENCODE_MODEL;
    const thread = ctx.agent.newThread(project.id, "opencode", null, model ? { options: { model } } : {});
    const turn = async (text: string) => {
      const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text });
      const t0 = Date.now();
      for (;;) {
        const run = ctx.agent.store.run(project.id, runId);
        if (run && run.status !== "running") return run;
        if (Date.now() - t0 > 240_000) throw new Error("live run did not settle");
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    try {
      const first = await turn("Use the tomrade list_items tool once, then reply with only the number of items you saw. Create nothing.");
      expect(first.status, first.error ?? "").toBe("done");
      const blocks = ctx.agent.store.messages(project.id, thread.id).map((m) => m.block);
      expect(blocks.some((b) => b.type === "trace" && b.tool === "list_items" && b.ok)).toBe(true);
      expect(first.changes).toBe(0);
      expect(ctx.agent.store.external(project.id, thread.id).opencode).toBeTruthy();
      const second = await turn("Reply with the single word ok.");
      expect(second.status, second.error ?? "").toBe("done");
      console.log("live opencode usage", JSON.stringify({ first: first.usage, second: second.usage }));
    } finally { await ctx.fiber.dispose(); }
  }, 600_000);
});
