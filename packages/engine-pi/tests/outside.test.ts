import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Service, type Context } from "cordis";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import type { ConnectFileWriter } from "@tomradex/code-link";
import enginePi, { outsideExtension, outsideExtensionUrl, piConnector, piUserExtension } from "@tomradex/engine-pi";

const saved = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
});

/** Runs the extension against a stand-in for pi's API, as pi 1.3 calls it. */
async function load(source: string, env: Record<string, string> = {}) {
  const registered: [string, unknown][] = [];
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const pi = { registerMcpServer: (name: string, config: unknown) => registered.push([name, config]), on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, handler) };
  const posted: { url: string; agent: string | null; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  const before = { ...process.env };
  Object.assign(process.env, env);
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    posted.push({ url, agent: init.headers["x-tomrade-agent"] ?? null, body: JSON.parse(init.body) });
    return new Response("{}");
  }) as typeof fetch;
  try {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("tomrade.pi.outside")];
    // The module's one export, run as a function: vitest imports nothing outside the repository.
    const extension = new Function(source.replace("export default function", "return function"))() as (api: typeof pi) => void;
    extension(pi);
    return { registered, handlers, posted, restore: () => { globalThis.fetch = realFetch; process.env = before; } };
  } catch (error) {
    globalThis.fetch = realFetch;
    process.env = before;
    throw error;
  }
}

describe("the extension for pi sessions Tomrade did not start", () => {
  const mcpUrl = "http://127.0.0.1:19090/mcp/p1";
  const eventUrl = "http://127.0.0.1:19090/sessions/event";

  it("registers Tomrade's server and reports the session's lifecycle as pi, with its folder", async () => {
    const source = outsideExtension(mcpUrl, eventUrl);
    expect(outsideExtensionUrl(source)).toBe(mcpUrl);
    expect(outsideExtensionUrl("export default () => {}")).toBeNull();
    const { registered, handlers, posted, restore } = await load(source);
    try {
      expect(registered).toEqual([["tomrade", expect.objectContaining({ url: mcpUrl, exposure: "direct", timeout: 600 })]]);
      handlers.get("session_start")!({}, { cwd: "/work/app", sessionManager: { getSessionId: () => "s-1" } });
      handlers.get("agent_start")!({});
      handlers.get("tool_call")!({ toolName: "bash", input: { command: "ls" } });
      handlers.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }] });
      handlers.get("session_shutdown")!({ reason: "quit" });
      await settle();
      expect(posted.map((p) => [p.url, p.agent, p.body.hook_event_name, p.body.session_id, p.body.cwd])).toEqual([
        [eventUrl, "pi", "SessionStart", "s-1", "/work/app"],
        [eventUrl, "pi", "UserPromptSubmit", "s-1", "/work/app"],
        [eventUrl, "pi", "PreToolUse", "s-1", "/work/app"],
        [eventUrl, "pi", "Stop", "s-1", "/work/app"],
        [eventUrl, "pi", "SessionEnd", "s-1", "/work/app"]
      ]);
      expect(posted[2]!.body).toMatchObject({ tool_name: "Bash", tool_input: { command: "ls" } });
    } finally {
      restore();
    }
  });

  it("steps aside in a session Tomrade started, which brings its own server and token", async () => {
    const { registered, handlers, restore } = await load(outsideExtension(mcpUrl, eventUrl), { TOMRADE_MCP_TOKEN: "run-token" });
    restore();
    expect(registered).toEqual([]);
    expect(handlers.size).toBe(0);
  });
});

describe("connecting pi's own sessions to Tomrade", () => {
  async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-link-"));
    process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent, [Mcp, { port: 0 }], enginePi] });
    await settle();
    return { ctx, file: piUserExtension(), link: ctx.agent.engineOf("pi")!.local!.mcpLink! };
  }

  it("writes, keeps, updates and removes the user-level extension", async () => {
    const { ctx, file, link } = await setup();
    const url = ctx.mcp.url!;
    expect(file).toBe(path.join(process.env.PI_CODING_AGENT_DIR!, "extensions", "tomrade.ts"));
    expect(await link.status()).toMatchObject({ state: "missing", url, configuredUrl: null, file });

    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });
    expect(fs.readFileSync(file, "utf8")).toBe(outsideExtension(url, ctx.mcp.eventUrl!));
    expect(await link.connect()).toMatchObject({ state: "connected" });

    fs.writeFileSync(file, outsideExtension("http://127.0.0.1:1/mcp", "http://127.0.0.1:1/sessions/event"));
    const stale = await link.status();
    expect(stale).toMatchObject({ state: "stale", configuredUrl: "http://127.0.0.1:1/mcp" });
    // By hand: a copy Tomrade keeps, put where pi looks.
    const spare = /cp "([^"]+)"/.exec(stale.manual.connect)![1]!;
    expect(fs.readFileSync(spare, "utf8")).toBe(outsideExtension(url, ctx.mcp.eventUrl!));
    expect(stale.manual.disconnect).toBe(`rm "${file}"`);
    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });

    expect(await link.disconnect()).toMatchObject({ state: "missing", configuredUrl: null });
    expect(fs.existsSync(file)).toBe(false);
    await ctx.fiber.dispose();
  });

  it("leaves a tomrade.ts it did not write alone", async () => {
    const { ctx, file, link } = await setup();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export default function () {}\n");
    expect(await link.status()).toMatchObject({ state: "missing" });
    await link.disconnect();
    expect(fs.readFileSync(file, "utf8")).toBe("export default function () {}\n");
    await ctx.fiber.dispose();
  });
});

describe("the project extension a connected repository carries", () => {
  it.each([["before", true], ["after", false]])("is code-link's to write once code-link comes up %s the engine", async (_when, first) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-connect-"));
    const writers = new Map<string, ConnectFileWriter>();
    class FakeCodeLink extends Service {
      static provide = "codeLink";
      constructor(ctx: Context) {
        super(ctx, "codeLink");
      }
      registerConnector(agent: string, writer: ConnectFileWriter) {
        writers.set(agent, writer);
        return () => writers.delete(agent);
      }
    }
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent, [Mcp, { port: 0 }], ...(first ? [FakeCodeLink, enginePi] : [enginePi, FakeCodeLink])] });
    await settle();
    expect(writers.get("pi")).toBe(piConnector);
    const mcpUrl = "http://127.0.0.1:19090/mcp/p1";
    expect(piConnector.write(mcpUrl, "http://127.0.0.1:19090/sessions/event")).toBe(outsideExtension(mcpUrl, "http://127.0.0.1:19090/sessions/event"));
    expect(piConnector.url(piConnector.write(mcpUrl, "http://127.0.0.1:19090/sessions/event"))).toBe(mcpUrl);
    await ctx.fiber.dispose();
    expect(writers.has("pi")).toBe(false);
  });
});
