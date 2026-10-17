import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent } from "@tomradex/agent";
import { Llm } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import engineTerminal from "@tomradex/engine-terminal";

/** Opt-in: spawns the real `gemini` CLI with the person's own sign-in (Google account, or GEMINI_API_KEY). TOMRADE_LIVE_GEMINI=1 pnpm test */
describe.skipIf(!process.env.TOMRADE_LIVE_GEMINI)("live Gemini CLI", () => {
  it("answers worker calls as the signed-in Gemini CLI when no key is set in Tomrade", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-gemini-lent-${Date.now()}.json`);
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], Llm, engineTerminal] });
    await settle();
    const command = process.env.TOMRADE_LIVE_GEMINI_COMMAND;
    if (command) ctx.settings.set({ ...ctx.settings.get(), agent: { ...(ctx.settings.get().agent as object), engines: { gemini: { command } } } });
    try {
      let t0 = Date.now();
      expect(await ctx.llm.worker()).toEqual({ ok: true, via: "lent", title: "Gemini CLI" });
      console.log(`sign-in check: ${Date.now() - t0} ms`);
      const schema = z.object({ duplicates: z.array(z.string()), reason: z.string() });
      t0 = Date.now();
      const out = await ctx.llm.completeJson(schema, {
        system: "You judge duplicate tickets. Reply with one JSON object: {\"duplicates\": [keys of tickets that mean the same work], \"reason\": one sentence}.",
        user: "New: \"Remind me to drink water every hour\".\nExisting: AL-1 \"Hourly water reminder\", AL-2 \"Dark mode for settings\"."
      });
      console.log(`worker call: ${Date.now() - t0} ms`, out);
      expect(out.duplicates).toEqual(["AL-1"]);
    } finally {
      await ctx.fiber.dispose();
    }
  }, 300_000);
});
