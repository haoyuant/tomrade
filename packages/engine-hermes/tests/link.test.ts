import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Agent } from "@tomradex/agent";
import { collect, userMessage } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import engineHermes, { hermes, hermesConfigFile, hermesLentModel, hermesPlugin, hermesPluginDir, TOKEN_HEADER } from "../src/index.js";

const saved = process.env.HERMES_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = saved;
  delete process.env.FAKE_FAIL;
});

function fakeHermes(dir: string, log?: string): string {
  const bin = path.join(dir, "hermes");
  fs.writeFileSync(bin, `#!/bin/sh\n${log ? `TOMRADE_TEST_LOG='${log}' ` : ""}exec '${process.execPath}' '${path.resolve("packages/engine-hermes/tests/fake-hermes.mjs")}' "$@"\n`, { mode: 0o700 });
  return bin;
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hermes-link-"));
  process.env.HERMES_HOME = path.join(dir, "home");
  fs.mkdirSync(process.env.HERMES_HOME);
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ agent: { engines: { hermes: { command: fakeHermes(dir) } } } }));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineHermes] });
  await settle();
  const config = () => parse(fs.readFileSync(hermesConfigFile(), "utf8"));
  return { ctx, config, link: ctx.agent.engineOf("hermes")!.mcpLink! };
}

describe("connecting Hermes' own sessions to Tomrade", () => {
  it("adds a tomrade server naming the session token, turns the reporting plugin on, and takes both back off", async () => {
    const { ctx, config, link } = await setup();
    fs.writeFileSync(hermesConfigFile(), "model:\n  default: some/model\nmcp_servers:\n  github:\n    url: https://example.com/mcp\n");
    const url = ctx.mcp.url!;
    expect(await link.status()).toMatchObject({ state: "missing", url, configuredUrl: null, file: hermesConfigFile() });

    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });
    expect(config()).toMatchObject({ model: { default: "some/model" }, mcp_servers: { github: { url: "https://example.com/mcp" }, tomrade: { url, headers: { "X-Tomrade-Run": TOKEN_HEADER }, timeout: 600 } }, plugins: { enabled: ["tomrade"] } });
    expect(fs.readFileSync(path.join(hermesPluginDir(), "__init__.py"), "utf8")).toBe(hermesPlugin(ctx.mcp.eventUrl!).source);
    expect(fs.readFileSync(path.join(hermesPluginDir(), "plugin.yaml"), "utf8")).toBe(hermesPlugin(ctx.mcp.eventUrl!).manifest);

    fs.writeFileSync(hermesConfigFile(), fs.readFileSync(hermesConfigFile(), "utf8").replace(url, "http://127.0.0.1:1/mcp"));
    const stale = await link.status();
    expect(stale).toMatchObject({ state: "stale", configuredUrl: "http://127.0.0.1:1/mcp" });
    expect(stale.manual.connect).toBe(`hermes config set mcp_servers.tomrade.url ${url} && hermes config set mcp_servers.tomrade.headers.X-Tomrade-Run '\${TOMRADE_MCP_TOKEN}' && hermes config set mcp_servers.tomrade.timeout 600`);
    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });

    expect(await link.disconnect()).toMatchObject({ state: "missing", configuredUrl: null });
    expect(config().mcp_servers).toEqual({ github: { url: "https://example.com/mcp" } });
    expect(config().plugins.enabled).toEqual([]);
    expect(fs.existsSync(hermesPluginDir())).toBe(false);
    await ctx.fiber.dispose();
  });

  it("leaves a plugin folder called tomrade that is someone else's alone", async () => {
    const { ctx, config, link } = await setup();
    fs.mkdirSync(hermesPluginDir(), { recursive: true });
    fs.writeFileSync(path.join(hermesPluginDir(), "__init__.py"), "def register(ctx): pass\n");
    expect(await link.connect()).toMatchObject({ state: "connected" });
    expect(fs.readFileSync(path.join(hermesPluginDir(), "__init__.py"), "utf8")).toBe("def register(ctx): pass\n");
    expect(config().plugins).toBeUndefined();
    await link.disconnect();
    expect(fs.existsSync(hermesPluginDir())).toBe(true);
    await ctx.fiber.dispose();
  });

  it("says what failed", async () => {
    const { ctx, link } = await setup();
    process.env.FAKE_FAIL = "1";
    expect(await link.connect()).toMatchObject({ state: "missing", error: expect.stringContaining("fake failure") });
    await ctx.fiber.dispose();
  });
});

describe("the reporting plugin", () => {
  const python = (() => { try { execFileSync("python3", ["--version"]); return true; } catch { return false; } })();

  it.skipIf(!python)("posts Claude Code's event names, tokenless outside Tomrade and to the session's address inside", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hermes-plugin-"));
    fs.writeFileSync(path.join(dir, "tomrade_plugin.py"), hermesPlugin("http://127.0.0.1:19090/sessions/event").source);
    // Hermes calls register(ctx) and then each hook with keyword arguments; urllib is replaced so nothing leaves.
    const driver = `
import json, os, sys, threading
sys.path.insert(0, ${JSON.stringify(dir)})
sent = []
import urllib.request
class Fake:
    def __init__(self, request, timeout=None): sent.append((request.full_url, request.headers, json.loads(request.data)))
    def read(self): return b"{}"
urllib.request.urlopen = Fake
threading.Thread = type("T", (), {"__init__": lambda self, target=None, daemon=None: setattr(self, "t", target), "start": lambda self: self.t()})
import tomrade_plugin
hooks = {}
tomrade_plugin.register(type("C", (), {"register_hook": lambda self, name, fn: hooks.__setitem__(name, fn)})())
hooks["on_session_start"](session_id="s1", model="m", platform="cli")
hooks["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1", task_id="t")
hooks["post_tool_call"](tool_name="read_file", args={}, result="oops", session_id="s1", status="error", error_message="no such file")
hooks["on_session_end"](session_id="s1", completed=True, failed=False)
os.environ["TOMRADE_MCP_TOKEN"] = "tok-9"
hooks["on_session_finalize"](session_id="s1", platform="cli")
print(json.dumps({"sent": [[u, {k.lower(): v for k, v in h.items()}, b] for u, h, b in sent]}))
`;
    const out = JSON.parse(execFileSync("python3", ["-c", driver], { encoding: "utf8", env: { PATH: process.env.PATH } })) as { sent: [string, Record<string, string>, Record<string, unknown>][] };
    expect(out.sent.map(([url, headers, body]) => [url, headers["x-tomrade-agent"], body.hook_event_name, body.session_id])).toEqual([
      ["http://127.0.0.1:19090/sessions/event", "hermes", "SessionStart", "s1"],
      ["http://127.0.0.1:19090/sessions/event", "hermes", "PreToolUse", "s1"],
      ["http://127.0.0.1:19090/sessions/event", "hermes", "PostToolUseFailure", "s1"],
      ["http://127.0.0.1:19090/sessions/event", "hermes", "Stop", "s1"],
      ["http://127.0.0.1:19090/sessions/tok-9/event", "hermes", "SessionEnd", "s1"]
    ]);
    expect(out.sent[1]![2]).toMatchObject({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: expect.any(String) });
    expect(out.sent[2]![2]).toMatchObject({ tool_name: "Read", tool_error: "no such file" });
  });

  it.skipIf(!python)("sets the token header's variable to none unless a session brings its own", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hermes-plugin-"));
    fs.writeFileSync(path.join(dir, "tomrade_plugin.py"), hermesPlugin("http://127.0.0.1:19090/sessions/event").source);
    const read = (env: Record<string, string>) => execFileSync("python3", ["-c", `import os, sys; sys.path.insert(0, ${JSON.stringify(dir)}); import tomrade_plugin; print(os.environ["TOMRADE_MCP_TOKEN"])`], { encoding: "utf8", env: { PATH: process.env.PATH!, ...env } }).trim();
    expect(read({})).toBe("none");
    expect(read({ TOMRADE_MCP_TOKEN: "tok-1" })).toBe("tok-1");
  });
});

describe("Hermes answering worker calls", () => {
  function lent() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-hermes-lent-"));
    const bin = fakeHermes(dir);
    const agent = { settingsOf: () => ({ engines: { hermes: { command: bin } } }) };
    const ctx = { get: (name: string) => (name === "agent" ? agent : undefined) } as unknown as Context;
    const model = hermesLentModel(ctx, { cli: hermes.cli, found: async () => true, options: () => ({ model: "openrouter:some/model" }) });
    return { model, ask: (user: string) => collect(model.model.chat({ system: "Reply in JSON.", messages: [userMessage(user)] })) };
  }

  it("asks one-shot with nothing loaded but its todo list, the instructions leading the prompt", async () => {
    const { model, ask } = lent();
    expect(model).toMatchObject({ id: "hermes", title: "Hermes", rank: 60 });
    const out = await ask("plan it");
    const echoed = JSON.parse(out.text) as { args: string[]; prompt: string; cwd: string };
    expect(echoed.args).toEqual(["-t", "todo", "--ignore-rules", "--usage-file", expect.stringMatching(/tomrade-hermes-lent-.*usage\.json$/), "-m", "openrouter:some/model"]);
    expect(echoed.prompt).toBe("Reply in JSON.\n\n---\n\nplan it");
    // titling calls count; cached prompt tokens are added back to the input
    expect(out.usage).toEqual({ inputTokens: 64, cacheReadTokens: 40, outputTokens: 5 });
    expect(fs.existsSync(echoed.cwd)).toBe(false);
    await expect(ask("FAIL")).rejects.toThrow(/Hermes could not answer: HTTP 500: upstream exploded/);
  }, 30_000);

  it("is not ready while Hermes has no model it can use, and says how to fix it", async () => {
    const { model, ask } = lent();
    await expect(ask("SIGNED_OUT")).rejects.toThrow(/Hermes has no model it can use \(.*hermes model.*\) — run `hermes setup`/);
    expect(await model.ready()).toBe(false);
  }, 30_000);
});
