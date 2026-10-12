import { expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import engineTerminal from "@tomradex/engine-terminal";

it("registers Gemini CLI and OpenCode as coding agents that run only in a terminal", async () => {
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: `/tmp/tomrade-engine-terminal-${Date.now()}.json` }], Agent, [Mcp, { port: 0 }], engineTerminal] });
  await settle();
  try {
    const views = await ctx.agent.engineViews();
    for (const id of ["gemini", "opencode"]) {
      expect(views.find((v) => v.id === id)).toMatchObject({ capabilities: ["code", "general"], terminalOnly: true });
    }
    expect(ctx.agent.codeEngines().map((e) => e.id)).toEqual(expect.arrayContaining(["gemini", "opencode"]));
  } finally {
    await ctx.fiber.dispose();
  }
});
