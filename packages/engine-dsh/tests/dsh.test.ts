import { expect, it } from "vitest";
import { Context } from "cordis";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import { createDshEngine, dsh } from "../src/index.js";

it("boots dsh's acp profile and offers its reasoning efforts before a session has listed them", async () => {
  expect(dsh.args({} as never, { command: "dsh" })).toEqual(["--profile", "acp"]);
  expect(dsh.mode).toBeUndefined();
  expect(dsh.cli.name).toBe("dsh");
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  try {
    const engine = createDshEngine(ctx);
    expect(engine).toMatchObject({ id: "dsh", title: "dsh", author: "ai:dsh" });
    expect(engine.permissionModes!.choices.map((choice) => choice.value)).toEqual(["full-access", "local"]);
    expect(engine.picks!()[1]).toEqual({ key: "effort", title: "Effort", choices: ["off", "low", "high", "max"].map((value) => ({ value })) });
  } finally { await ctx.fiber.dispose(); }
});
