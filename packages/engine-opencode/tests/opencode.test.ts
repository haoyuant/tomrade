import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@tomradex/agent";
import { collect, userMessage } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import engineOpencode, { opencode, opencodeLentModel, opencodePlugin, opencodeUserFile, opencodeUserPlugin, withMcpEntry } from "../src/index.js";

const saved = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
});

it("starts `opencode acp`, keeps read-only turns in its plan agent, and can also take a ticket in a terminal", async () => {
  expect(opencode.args({} as never, { command: "opencode" })).toEqual(["acp"]);
  expect([opencode.mode!("full-access"), opencode.mode!("ask"), opencode.mode!("read-only")]).toEqual(["build", "build", "plan"]);
  expect(opencode).toMatchObject({ id: "opencode", title: "OpenCode", usage: "turn", cacheApart: true, terminal: true });
  expect(opencode.permissionModes).toMatchObject({ default: "full-access", mainDefault: "read-only" });
  expect(opencode.permissionModes.choices.map((c) => c.value)).toEqual(["full-access", "local", "read-only"]);
});

describe("connecting OpenCode's own sessions to Tomrade", () => {
  async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-opencode-link-"));
    process.env.XDG_CONFIG_HOME = path.join(dir, "config");
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent, [Mcp, { port: 0 }], engineOpencode] });
    await settle();
    return { ctx, link: ctx.agent.engineOf("opencode")!.mcpLink!, read: () => JSON.parse(fs.readFileSync(opencodeUserFile(), "utf8")) };
  }

  it("adds the tomrade server and the reporting plugin, keeps the rest of opencode.json, and takes both back out", async () => {
    const { ctx, link, read } = await setup();
    const url = ctx.mcp.url!;
    fs.mkdirSync(path.dirname(opencodeUserFile()), { recursive: true });
    fs.writeFileSync(opencodeUserFile(), JSON.stringify({ model: "deepseek/deepseek-flash", mcp: { other: { type: "local", command: ["x"] } } }));
    expect(await link.status()).toMatchObject({ state: "missing", url, configuredUrl: null, file: opencodeUserFile() });

    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });
    expect(read()).toEqual({ model: "deepseek/deepseek-flash", mcp: { other: { type: "local", command: ["x"] }, tomrade: { type: "remote", url, enabled: true, headers: { "X-Tomrade-Run": "{env:TOMRADE_MCP_TOKEN}" } } } });
    expect(fs.readFileSync(opencodeUserPlugin(), "utf8")).toBe(opencodePlugin(ctx.mcp.eventUrl!));

    fs.writeFileSync(opencodeUserFile(), withMcpEntry(fs.readFileSync(opencodeUserFile(), "utf8"), "http://127.0.0.1:1/mcp"));
    expect(await link.status()).toMatchObject({ state: "stale", configuredUrl: "http://127.0.0.1:1/mcp" });
    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });

    expect(await link.disconnect()).toMatchObject({ state: "missing", configuredUrl: null });
    expect(read()).toEqual({ model: "deepseek/deepseek-flash", mcp: { other: { type: "local", command: ["x"] } } });
    expect(fs.existsSync(opencodeUserPlugin())).toBe(false);
    await ctx.fiber.dispose();
  });

  it("starts a config that is not there, leaves someone else's tomrade.js alone, and reports a file it cannot read", async () => {
    const { ctx, link, read } = await setup();
    fs.mkdirSync(path.dirname(opencodeUserPlugin()), { recursive: true });
    fs.writeFileSync(opencodeUserPlugin(), "export const Mine = async () => ({});\n");
    expect(await link.connect()).toMatchObject({ state: "connected" });
    expect(read()).toMatchObject({ $schema: "https://opencode.ai/config.json", mcp: { tomrade: { url: ctx.mcp.url } } });
    await link.disconnect();
    expect(fs.readFileSync(opencodeUserPlugin(), "utf8")).toBe("export const Mine = async () => ({});\n");
    expect(read()).toEqual({ $schema: "https://opencode.ai/config.json" });
    fs.writeFileSync(opencodeUserFile(), "{ not json");
    expect(await link.status()).toMatchObject({ state: "unavailable", error: expect.stringContaining(opencodeUserFile()) });
    await ctx.fiber.dispose();
  });
});

describe("the reporting plugin", () => {
  /** Runs the plugin module against a stand-in for OpenCode's plugin host, as 1.19.3 calls it. */
  async function load(env: Record<string, string> = {}) {
    const source = opencodePlugin("http://127.0.0.1:19090/sessions/event");
    const posted: { url: string; agent: string | null; body: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    const before = { ...process.env };
    Object.assign(process.env, env);
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      posted.push({ url, agent: init.headers["x-tomrade-agent"] ?? null, body: JSON.parse(init.body) });
      return new Response("{}");
    }) as typeof fetch;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("tomrade.opencode")];
    // vitest imports nothing outside the repository: the module's one export, run as a function.
    const plugin = new Function(source.replace("export const TomradePlugin =", "return"))() as (ctx: { directory: string }) => Promise<Record<string, (...args: unknown[]) => Promise<void>>>;
    const hooks = await plugin({ directory: "/work/app" });
    return { hooks, posted, again: () => plugin({ directory: "/work/app" }), restore: () => { globalThis.fetch = realFetch; process.env = before; } };
  }

  it("reports a session as OpenCode with its folder, in Claude Code's event names", async () => {
    const { hooks, posted, again, restore } = await load();
    try {
      await hooks.event!({ event: { type: "session.created", properties: { sessionID: "ses_1", info: { id: "ses_1" } } } });
      await hooks.event!({ event: { type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_1", role: "user" } } } });
      await hooks.event!({ event: { type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_1", role: "user" } } } });
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: { command: "ls" } });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_1", callID: "c1", args: { command: "ls" } }, { title: "ls", output: "a\n" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
      await hooks.event!({ event: { type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "rate limited" } } } } });
      await settle();
      expect(posted.map((p) => [p.url, p.agent, p.body.hook_event_name, p.body.session_id, p.body.cwd])).toEqual([
        ["http://127.0.0.1:19090/sessions/event", "opencode", "SessionStart", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "UserPromptSubmit", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "PreToolUse", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "PostToolUse", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "Stop", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "StopFailure", "ses_1", "/work/app"]
      ]);
      expect(posted[2]!.body).toMatchObject({ tool_name: "Bash", tool_input: { command: "ls" } });
      expect(posted[5]!.body).toMatchObject({ error_message: "rate limited" });
      // A second copy (the repository's, beside the global one) does nothing.
      expect(await again()).toEqual({});
    } finally {
      restore();
    }
  });

  it("reports to the session's own address when Tomrade started it", async () => {
    const { hooks, posted, restore } = await load({ TOMRADE_MCP_TOKEN: "tok-9" });
    try {
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_2" } } });
      await settle();
      expect(posted.map((p) => p.url)).toEqual(["http://127.0.0.1:19090/sessions/tok-9/event"]);
    } finally {
      restore();
    }
  });
});

describe("OpenCode answering worker calls", () => {
  function lent() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-opencode-lent-"));
    const bin = path.join(dir, "opencode");
    fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-opencode/tests/fake-opencode-lent.mjs")}' "$@"\n`, { mode: 0o700 });
    const agent = { settingsOf: () => ({ engines: { opencode: { command: bin } } }) };
    const ctx = { get: (name: string) => (name === "agent" ? agent : undefined) } as unknown as Context;
    const model = opencodeLentModel(ctx, { cli: opencode.cli, found: async () => true, options: () => ({ model: "deepseek/deepseek-flash" }) });
    return { model, ask: (user: string) => collect(model.model.chat({ system: "Reply in JSON.", messages: [userMessage(user)] })) };
  }

  it("asks as an agent of its own: the instructions as its whole prompt, every tool denied, no external plugins", async () => {
    const { model, ask } = lent();
    expect(model).toMatchObject({ id: "opencode", title: "OpenCode", rank: 70 });
    const out = await ask("plan it");
    const echoed = JSON.parse(out.text) as { args: string[]; prompt: string; system: string; permission: unknown; cwd: string };
    expect(echoed.args).toEqual(["run", "--format", "json", "--pure", "--agent", "tomrade-worker", "-m", "deepseek/deepseek-flash"]);
    expect(echoed.system).toBe("Reply in JSON.");
    expect(echoed.prompt).toBe("plan it");
    expect(echoed.permission).toEqual({ "*": "deny" });
    expect(out.usage).toEqual({ inputTokens: 57, cacheReadTokens: 40, outputTokens: 3 });
    expect(fs.existsSync(echoed.cwd)).toBe(false);
    await expect(ask("FAIL")).rejects.toThrow(/OpenCode could not answer: Unexpected server error/);
  }, 30_000);

  it("is not ready while OpenCode has no key for its model, and says how to add one", async () => {
    const { model, ask } = lent();
    await expect(ask("SIGNED_OUT")).rejects.toThrow(/OpenCode has no model it can use \(No API key found for provider anthropic\) — run `opencode auth login`/);
    expect(await model.ready()).toBe(false);
  }, 30_000);
});
