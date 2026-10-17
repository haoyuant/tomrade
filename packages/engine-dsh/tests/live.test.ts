import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { Llm } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import engineDsh from "@tomradex/engine-dsh";

/** Opt-in: spawns the real `dsh --profile acp` with the user's DeepSeek key. TOMRADE_LIVE_DSH=1 pnpm test */
describe.skipIf(!process.env.TOMRADE_LIVE_DSH)("live dsh", () => {
  it("conducts one real turn, calling tomrade tools over MCP", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-dsh-${Date.now()}.json`);
    const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineDsh] });
    await settle();
    items.create({ projectId: project.id, boardId: board.id, title: "Ship the water reminder", by: "human" });

    const thread = ctx.agent.newThread(project.id, "dsh");
    // TOMRADE_LIVE_DSH_COMMAND may name a dsh that is not on PATH; TOMRADE_LIVE_DSH_EFFORT picks its reasoning effort.
    const command = process.env.TOMRADE_LIVE_DSH_COMMAND;
    const effort = process.env.TOMRADE_LIVE_DSH_EFFORT;
    ctx.agent.setOptions(project.id, thread.id, { ...(command ? { command } : {}), ...(effort ? { effort } : {}) });
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
      expect(ctx.agent.store.external(project.id, thread.id).dsh).toBeTruthy();
    } finally { await ctx.fiber.dispose(); }
  }, 300_000);
});

/** Opt-in: the real dsh (desktop app or CLI) answering a worker call with the person's own account or key. TOMRADE_LIVE_DSH=1 pnpm test */
describe.skipIf(!process.env.TOMRADE_LIVE_DSH)("live dsh lent", () => {
  it("answers worker calls as DeepSeek Harness when the worker role names it, with no tools and no session left behind", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-dsh-lent-${Date.now()}.json`);
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], Llm, engineDsh] });
    await settle();
    ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [], roles: { worker: "lent:dsh" } } });
    try {
      expect(await ctx.llm.worker()).toMatchObject({ ok: true, via: "lent", title: "DeepSeek Harness" });
      const schema = z.object({ duplicates: z.array(z.string()), reason: z.string() });
      const t0 = Date.now();
      const out = await ctx.llm.completeJson(schema, {
        system: "You judge duplicate tickets. Reply with one JSON object: {\"duplicates\": [keys of tickets that mean the same work], \"reason\": one sentence}.",
        user: "New: \"Remind me to drink water every hour\".\nExisting: AL-1 \"Hourly water reminder\", AL-2 \"Dark mode for settings\"."
      });
      console.log(`dsh worker call: ${Date.now() - t0} ms`, out);
      expect(out.duplicates).toEqual(["AL-1"]);
      expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tomrade-dsh-lent-"))).toEqual([]);
    } finally {
      await ctx.fiber.dispose();
    }
  }, 300_000);
});
