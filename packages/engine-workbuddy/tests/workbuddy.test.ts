import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "cordis";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import { codebuddyFailure, codebuddyUsage, createWorkBuddyEngine, helpModels, workbuddy, workbuddyApps } from "../src/index.js";

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

afterEach(() => { vi.restoreAllMocks(); });

const noInstalls = async () => [];

it("knows where the WorkBuddy app keeps its CLI and the binary that runs it", async () => {
  const mac = await workbuddyApps({ platform: "darwin", env: {}, home: "/Users/a", installs: noInstalls });
  expect(mac).toContainEqual({ file: "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy", runtime: expect.stringMatching(/^\/Applications\/WorkBuddy AI\.app\/Contents\/MacOS\//) });
  expect(mac.map((app) => app.file)).toContain("/Users/a/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy");
  const win = await workbuddyApps({ platform: "win32", env: { LocalAppData: "C:\\Users\\a\\AppData\\Local" }, home: "C:\\Users\\a", installs: noInstalls });
  expect(win).toContainEqual({ file: "C:\\Users\\a\\AppData\\Local\\Programs\\WorkBuddy AI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy", runtime: "C:\\Users\\a\\AppData\\Local\\Programs\\WorkBuddy AI\\WorkBuddyAI.exe" });
  expect(await workbuddyApps({ platform: "linux", env: {}, home: "/home/a", installs: noInstalls })).toEqual([]);
});

it("finds the WorkBuddy app on Windows wherever it was installed, whatever its exe is called", async () => {
  // The install folders below hold these files; nothing else exists.
  const folders: Record<string, string[]> = {
    "D:\\Apps\\WB": ["WorkBuddy Desktop.exe", "Uninstall WorkBuddy Desktop.exe", "resources"],
    "C:\\Program Files (x86)\\WorkBuddy": ["Uninstall WorkBuddy.exe", "wb.exe"]
  };
  vi.spyOn(fs, "readdirSync").mockImplementation(((dir: string) => {
    if (folders[dir]) return folders[dir];
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as typeof fs.readdirSync);
  const asked: RegExp[] = [];
  const apps = await workbuddyApps({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    home: "C:\\Users\\a",
    installs: async (name) => { asked.push(name); return ["D:\\Apps\\WB"]; }
  });
  expect(asked[0]!.test("WorkBuddy AI 1.4.0")).toBe(true);
  // Where the installer registered it comes first, with the exe this version ships.
  expect(apps[0]).toEqual({ file: "D:\\Apps\\WB\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy", runtime: "D:\\Apps\\WB\\WorkBuddy Desktop.exe" });
  expect(apps).toContainEqual({ file: "C:\\Program Files (x86)\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy", runtime: "C:\\Program Files (x86)\\WorkBuddy\\wb.exe" });
  expect(apps.map((app) => app.file)).toContain("C:\\Users\\a\\AppData\\Local\\WorkBuddy AI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy");
  // A failed registry read still leaves the usual folders.
  const unread = await workbuddyApps({ platform: "win32", env: {}, home: "C:\\Users\\a", installs: async () => { throw new Error("reg.exe"); } });
  expect(unread.length).toBeGreaterThan(0);
});

it("runs `codebuddy --acp`, bypassing its prompts only for a full-access turn, and seeds the models from its help", async () => {
  expect(workbuddy.args({} as never, { command: "codebuddy" })).toEqual(["--acp"]);
  expect(workbuddy.env!({} as never, { command: "codebuddy" })).toEqual({ CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1" });
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

it("a refused turn's reason comes out of CodeBuddy's _meta, upstream words first", () => {
  const meta = (error: unknown) => ({ stopReason: "refusal", _meta: { "codebuddy.ai/errorMessage": JSON.stringify(error) } });
  expect(codebuddyFailure(meta({ code: -32603, message: "Internal error", data: { details: "401 endpoint mismatch", statusCode: 401, category: "internal" } }))).toBe("401 endpoint mismatch");
  expect(codebuddyFailure(meta({ code: -32010, message: "Quota exceeded: no credits left", data: { details: "no credits left", category: "quota" } }))).toBe("Quota exceeded: no credits left");
  expect(codebuddyFailure(meta({ code: -32603, message: "Network error: ECONNRESET", data: { details: "socket closed" } }))).toBe("Network error: ECONNRESET — socket closed");
  expect(codebuddyFailure({ stopReason: "refusal", errorMessage: "This message looks sensitive" })).toBe("This message looks sensitive");
  expect(codebuddyFailure({ stopReason: "refusal", _meta: { errorMessage: "Agent did not return to idle" } })).toBe("Agent did not return to idle");
  expect(codebuddyFailure({ stopReason: "refusal" })).toBeUndefined();
});
