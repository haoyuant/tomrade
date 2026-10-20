import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "@tomradex/agent";
import { localCli } from "@tomradex/engine-claude-code";
import { collect, userMessage } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { cursorLentModel } from "@tomradex/engine-cursor";

/** Opt-in: runs the real, signed-in cursor-agent. TOMRADE_LIVE_CURSOR=1 pnpm test. */
describe.skipIf(!process.env.TOMRADE_LIVE_CURSOR)("live Cursor", () => {
  it("answers a worker call with its usage", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-cursor-${Date.now()}.json`);
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }]] });
    await settle();
    try {
      const lent = cursorLentModel(ctx, { cli: localCli("cursor-agent"), found: async () => true, options: () => ({}) });
      const answer = await collect(lent.model.chat({ system: "Reply with one word.", messages: [userMessage("Say pong.")] }));
      expect(answer.text.toLowerCase()).toContain("pong");
      expect(answer.usage.inputTokens).toBeGreaterThan(0);
      console.log("live cursor worker usage", JSON.stringify(answer.usage));
    } finally {
      await ctx.fiber.dispose();
    }
  }, 600_000);
});
