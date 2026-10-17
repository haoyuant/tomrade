import { expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent, type TurnInput } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import engineTerminal, { gemini, geminiCallName } from "@tomradex/engine-terminal";

it("registers Gemini CLI as an in-app agent that also takes a ticket in a terminal", async () => {
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: `/tmp/tomrade-engine-terminal-${Date.now()}.json` }], Agent, [Mcp, { port: 0 }], engineTerminal] });
  await settle();
  try {
    const views = await ctx.agent.engineViews();
    const view = views.find((v) => v.id === "gemini");
    expect(view).toMatchObject({ capabilities: ["backlog", "code", "general"], permissionModes: { default: "full-access", mainDefault: "ask" } });
    expect(view?.terminalOnly).toBeUndefined();
    expect(view?.terminal).toBeUndefined();
    expect(view?.permissionModes?.choices.map((c) => c.value)).toEqual(["full-access", "ask", "read-only"]);
    expect(ctx.agent.codeEngines().map((e) => e.id)).toEqual(["gemini"]);
  } finally {
    await ctx.fiber.dispose();
  }
});

it("starts Gemini CLI's ACP server asking before it acts, in a folder it trusts, and names its calls from their ids", () => {
  const input = {} as TurnInput;
  expect(gemini.args(input, { command: "gemini" })).toEqual(["--acp", "--approval-mode", "default"]);
  expect(gemini.env?.(input, { command: "gemini" })).toEqual({ GEMINI_CLI_TRUST_WORKSPACE: "true" });
  expect(geminiCallName("mcp_tomrade_list_items__a1b2")).toBe("mcp_tomrade_list_items");
  expect(geminiCallName("run_shell_command__run_shell_command_1792_0")).toBe("run_shell_command");
  expect(geminiCallName("opaque-id")).toBeUndefined();
});
