import { expect, it } from "vitest";
import { Context } from "cordis";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import { codebuddyUsage, createWorkBuddyEngine, helpModels, workbuddy, workbuddyApps } from "../src/index.js";

it("reads a model request's tokens from CodeBuddy's usage update", () => {
  // As CodeBuddy 2.155 sent it on a second turn, trimmed.
  const update = { sessionUpdate: "usage_update", used: 23574, size: 300000, _meta: { usage: {
    prompt_tokens: 23574, completion_tokens: 9, total_tokens: 23583, prompt_tokens_details: { cached_tokens: 23424 },
    prompt_cache_hit_tokens: 23424, prompt_cache_miss_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, prompt_cache_write_tokens: 0, credit: 0 } } };
  expect(codebuddyUsage(update)).toEqual({ input: 23574, output: 9, cacheRead: 23424, cacheWrite: 0 });
  // The breakdown by category that follows carries no tokens of its own.
  expect(codebuddyUsage({ sessionUpdate: "usage_update", used: 23574, size: 300000, _meta: { "codebuddy.ai/usageByCategory": { tools: 20404 } } })).toBeNull();
});

it("lists the models `codebuddy --help` names", () => {
  const help = "  --model <model>   Model for the current session. Please provide the model ID. Currently supported: (default-model, fast-model,\n    hy3, deepseek-v4.1-flash)\n  --effort <level>";
  expect(helpModels(help)).toEqual(["default-model", "fast-model", "hy3", "deepseek-v4.1-flash"]);
  expect(helpModels("Usage: codebuddy")).toEqual([]);
});

it("knows where the WorkBuddy app keeps its CLI and the binary that runs it", () => {
  const mac = workbuddyApps({ platform: "darwin", env: {}, home: "/Users/a" });
  expect(mac).toContainEqual({ file: "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy", runtime: expect.stringMatching(/^\/Applications\/WorkBuddy AI\.app\/Contents\/MacOS\//) });
  expect(mac.map((app) => app.file)).toContain("/Users/a/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy");
  const win = workbuddyApps({ platform: "win32", env: { LocalAppData: "C:\\Users\\a\\AppData\\Local" }, home: "C:\\Users\\a" });
  expect(win).toContainEqual({ file: "C:\\Users\\a\\AppData\\Local\\Programs\\WorkBuddy AI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy", runtime: "C:\\Users\\a\\AppData\\Local\\Programs\\WorkBuddy AI\\WorkBuddyAI.exe" });
  expect(workbuddyApps({ platform: "linux", env: {}, home: "/home/a" })).toEqual([]);
});

it("runs `codebuddy --acp`, bypassing its prompts only for a full-access turn, and seeds the models from its help", async () => {
  expect(workbuddy.args({} as never, { command: "codebuddy" })).toEqual(["--acp"]);
  expect([workbuddy.mode!("full-access"), workbuddy.mode!("ask"), workbuddy.mode!("read-only")]).toEqual(["bypassPermissions", "default", "default"]);
  expect(workbuddy.cli.name).toBe("codebuddy");
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  try {
    const engine = createWorkBuddyEngine(ctx);
    expect(engine).toMatchObject({ id: "workbuddy", title: "WorkBuddy", author: "ai:workbuddy" });
    expect(engine.permissionModes!.choices.map((choice) => choice.value)).toEqual(["full-access", "ask", "read-only"]);
    const catalog = { models: [], efforts: [] };
    expect(workbuddy.probe!.says("Currently supported: (hy3, gpt-5.5)", catalog)).toBeNull();
    expect(catalog.models).toEqual([{ value: "hy3" }, { value: "gpt-5.5" }]);
  } finally { await ctx.fiber.dispose(); }
});
