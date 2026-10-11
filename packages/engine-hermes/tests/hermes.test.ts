import { expect, it } from "vitest";
import { Context } from "cordis";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import { createHermesEngine, hermes, hermesAcpReady } from "../src/index.js";

it("reads `hermes acp --check`: ready, missing its ACP extra, or something else", () => {
  expect(hermesAcpReady("Hermes ACP check OK\n")).toBe(true);
  expect(hermesAcpReady("Traceback (most recent call last):\n  ...\nModuleNotFoundError: No module named 'acp'")).toBe(false);
  expect(hermesAcpReady("usage: hermes [-h]")).toBeNull();
});

it("starts `hermes acp`, hands it Tomrade's tools over HTTP and reopens sessions by loading them", async () => {
  expect(hermes.args({} as never, { command: "hermes" })).toEqual(["acp"]);
  expect([hermes.mode!("full-access"), hermes.mode!("ask"), hermes.mode!("read-only")]).toEqual(["dont_ask", "default", "default"]);
  expect(hermes).toMatchObject({ httpMcp: "always", reopen: "load", usage: "turn" });
  expect(hermes.cli.name).toBe("hermes");

  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  try {
    const engine = createHermesEngine(ctx);
    expect(engine).toMatchObject({ id: "hermes", title: "Hermes", author: "ai:hermes", capabilities: ["backlog", "code", "general"] });
    expect(engine.permissionModes!.choices.map((choice) => choice.value)).toEqual(["full-access", "ask"]);
    // Hermes offers no effort setting, and its models are whatever its provider lists once a session opens.
    expect(engine.picks!()).toEqual([{ key: "model", title: "Model", choices: [], freeText: true }]);
    expect(hermes.options.parse({})).toEqual({ command: "hermes" });
  } finally { await ctx.fiber.dispose(); }
});
