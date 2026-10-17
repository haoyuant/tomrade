import { expect, it } from "vitest";
import { Context } from "cordis";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import { createDshEngine, dsh, dshDesktopApps } from "../src/index.js";

it("boots dsh's acp profile and offers its reasoning efforts before a session has listed them", async () => {
  expect(dsh.args({} as never, { command: "dsh" })).toEqual(["--profile", "acp"]);
  expect(dsh.mode).toBeUndefined();
  expect(dsh.cli.name).toBe("dsh");
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  try {
    const engine = createDshEngine(ctx);
    expect(engine).toMatchObject({ id: "dsh", title: "DeepSeek Harness", author: "ai:dsh" });
    expect(engine.permissionModes!.choices.map((choice) => choice.value)).toEqual(["full-access", "local"]);
    expect(engine.picks!()[1]).toEqual({ key: "effort", title: "Effort", choices: ["off", "low", "high", "max"].map((value) => ({ value })) });
  } finally { await ctx.fiber.dispose(); }
});

const noInstalls = async () => [];

it("goes by DeepSeek Harness, still as the dsh engine, and points at the official page", () => {
  expect(dsh).toMatchObject({ id: "dsh", title: "DeepSeek Harness" });
  expect(dsh.setup).toMatchObject({ install: ["npm install -g @deepseek-ai/dsh"], signIn: "dsh web", docs: "https://www.deepseek.com/en/harness/" });
  expect(dsh.install).toContain("desktop app");
  expect(dsh.signIn).toContain("DEEPSEEK_API_KEY");
});

it("knows where the DeepSeek Harness desktop app keeps its dsh launcher", async () => {
  expect(await dshDesktopApps({ platform: "darwin", env: {}, home: "/Users/a", installs: noInstalls })).toEqual([
    { file: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" },
    { file: "/Users/a/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" }
  ]);
  const win = await dshDesktopApps({ platform: "win32", env: { LocalAppData: "C:\\Users\\a\\AppData\\Local", ProgramFiles: "C:\\Program Files" }, home: "C:\\Users\\a",
    installs: async (name) => (name.test("DeepSeek Harness") ? ["D:\\Apps\\DSH"] : []) });
  expect(win.map((app) => app.file)).toEqual([
    "D:\\Apps\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd",
    "C:\\Users\\a\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd",
    "C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd"
  ]);
  // The launcher runs itself with the app's runtime: no separate binary to hand it to.
  expect(win.every((app) => app.runtime === undefined)).toBe(true);
  expect(await dshDesktopApps({ platform: "linux", env: {}, home: "/home/a", installs: noInstalls })).toEqual([]);
});
