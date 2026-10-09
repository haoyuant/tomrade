import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fresh } from "@tomrade/testkit";
import { Settings } from "@tomrade/settings";
import { Tools, defineTool } from "@tomrade/tools";
import { Mcp } from "@tomrade/mcp";
import { McpClient, TOOL_NAME_MAX, inputSchemaOf, parseClientConfig, toolName } from "@tomrade/mcp-client";

const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-mcp-client-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const stdio = (id: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => ({
  id,
  transport: { type: "stdio", command: process.execPath, args: [FIXTURE], env },
  ...extra
});

let n = 0;
const open: { dispose(): Promise<unknown> }[] = [];
afterEach(async () => {
  // Clients before the servers they hold streams open to, or a server's close waits out keep-alive.
  for (const fiber of open.splice(0).reverse()) await fiber.dispose();
});

/** Retries are off unless a test asks for them, so a failure stays put while it is looked at. */
async function boot(extra: unknown[] = [], config: Record<string, unknown> = { retryDelaysMs: [] }) {
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, `settings-${n++}.json`) }], ...(extra as never[])] });
  open.push(ctx.fiber);
  const plugin = await ctx.plugin(McpClient, config);
  const configure = async (servers: unknown[]) => {
    ctx.settings.set({ ...ctx.settings.get(), mcpServers: { servers } } as never);
    await ctx.mcpClient.settled();
  };
  const view = (id: string) => ctx.mcpClient.servers().find((s) => s.id === id);
  const call = (name: string, args: unknown = {}) => ctx.tools.execute(name, args, { by: "ai:test" });
  return { ctx, plugin, configure, view, call };
}

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("names and schemas", () => {
  it("prefixes, sanitises and bounds tool names", () => {
    expect(toolName("github", "create_issue")).toBe("github__create_issue");
    expect(toolName("fx", "files.read")).toBe("fx__files_read");
    const long = toolName("server", "x".repeat(80));
    expect(long.length).toBe(TOOL_NAME_MAX);
    expect(long).not.toBe(toolName("server", `${"x".repeat(79)}y`));
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("reads draft-07 refs and implied objects, and falls back to a loose object", () => {
    const refs = inputSchemaOf({ type: "object", properties: { p: { $ref: "#/definitions/P" } }, required: ["p"], definitions: { P: { type: "string" } } });
    expect(refs.exact).toBe(true);
    expect(refs.schema.safeParse({ p: "a" }).success).toBe(true);
    expect(refs.schema.safeParse({ p: 1 }).success).toBe(false);
    expect(inputSchemaOf({ properties: { q: { type: "string" } } }).exact).toBe(true);
    const loose = inputSchemaOf({ type: "object", properties: { x: { $ref: "#/nowhere" } } });
    expect(loose.exact).toBe(false);
    expect(loose.schema.safeParse({ anything: 1 }).success).toBe(true);
  });
});

describe("importing another client's config", () => {
  it("reads the mcpServers block, commands and URLs alike, without reusing an id", () => {
    const { servers, errors } = parseClientConfig(
      JSON.stringify({
        mcpServers: {
          GitHub: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "t" } },
          "Remote Docs": { type: "sse", url: "https://example.com/sse", headers: { Authorization: "Bearer x" } },
          sleepy: { command: "uvx", args: ["sleepy"], disabled: true },
          broken: { args: ["no command"] }
        }
      }),
      ["github"]
    );
    expect(servers.map((s) => s.id)).toEqual(["github-2", "remote-docs", "sleepy"]);
    expect(servers[0]!.transport).toEqual({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "t" } });
    expect(servers[1]!.transport).toEqual({ type: "http", url: "https://example.com/sse", headers: { Authorization: "Bearer x" } });
    expect(servers[2]!.enabled).toBe(false);
    expect(errors).toEqual(["broken: needs a command or a url"]);
  });

  it("takes VS Code's servers block, a bare map or one server, and says when it is not JSON", () => {
    expect(parseClientConfig(JSON.stringify({ servers: { fs: { command: "fs-server" } } })).servers[0]!.id).toBe("fs");
    expect(parseClientConfig(JSON.stringify({ fs: { command: "fs-server" } })).servers[0]!.id).toBe("fs");
    expect(parseClientConfig(JSON.stringify({ url: "http://localhost:3000/mcp" })).servers[0]!.id).toBe("server");
    expect(parseClientConfig("{ nope").errors[0]).toMatch(/^not JSON/);
  });
});

describe("a stdio server", () => {
  it("registers its tools under the server's prefix and proxies calls", async () => {
    const { ctx, configure, view, call } = await boot();
    await configure([stdio("fx", {}, { FIXTURE_TOKEN: "s3cret" })]);
    const fx = view("fx")!;
    expect(fx.state).toBe("connected");
    expect(fx.server).toEqual({ name: "fixture", version: "1.2.3" });
    expect(fx.tools.map((t) => t.name)).toEqual(["fx__echo", "fx__add", "fx__fail", "fx__files_read", "fx__env", "fx__pid", "fx__grow", "fx__exit", "fx__sleep"]);
    expect(fx.tools.every((t) => !t.skipped && !t.approximate)).toBe(true);

    expect(await call("fx__echo", { text: "hi" })).toBe("hi");
    expect(await call("fx__add", { a: 2, b: 3 })).toEqual({ sum: 5 });
    await expect(call("fx__fail")).rejects.toThrow("nope");
    expect(await call("fx__files_read", { path: "a.md" })).toBe("read a.md");
    await expect(call("fx__files_read", { path: 1 })).rejects.toThrow(/invalid arguments/);
    expect(await call("fx__env", { name: "FIXTURE_TOKEN" })).toBe("s3cret");
    // Only a safe subset of Tomrade's own environment reaches the server.
    expect(await call("fx__env", { name: "VITEST" })).toBe("");
    expect(ctx.tools.get("fx__echo")?.description).toContain('MCP server "fx"');
  });

  it("exposes only the allowed tools, and says which allowed ones the server lacks", async () => {
    const { ctx, configure, view } = await boot();
    await configure([stdio("fx", { tools: ["echo", "missing"] })]);
    expect(ctx.tools.list().filter((t) => t.name.startsWith("fx__")).map((t) => t.name)).toEqual(["fx__echo"]);
    expect(view("fx")!.tools.find((t) => t.remote === "missing")?.skipped).toMatch(/does not offer/);
  });

  it("skips a name another plugin already holds instead of failing", async () => {
    const { ctx, configure, view, call } = await boot();
    ctx.tools.register(defineTool({ name: "fx__echo", title: "Mine", description: "taken", input: z.object({}), execute: () => "mine" }));
    await configure([stdio("fx")]);
    expect(view("fx")!.state).toBe("connected");
    expect(view("fx")!.tools.find((t) => t.name === "fx__echo")?.skipped).toMatch(/already taken/);
    expect(await call("fx__echo")).toBe("mine");
    expect(await call("fx__add", { a: 1, b: 1 })).toEqual({ sum: 2 });
  });

  it("follows the settings: other changes leave it alone, disabling and removing take its tools away", async () => {
    const { ctx, configure, view, call } = await boot();
    await configure([stdio("fx")]);
    const pid = await call("fx__pid");
    ctx.settings.set({ ...ctx.settings.get(), theme: "dark" });
    await ctx.mcpClient.settled();
    expect(await call("fx__pid")).toBe(pid);

    await configure([stdio("fx", { enabled: false })]);
    expect(view("fx")!.state).toBe("off");
    expect(ctx.tools.has("fx__echo")).toBe(false);

    await configure([stdio("fx")]);
    expect(await call("fx__pid")).not.toBe(pid);
    await configure([]);
    expect(view("fx")).toBeUndefined();
    expect(ctx.tools.list().some((t) => t.name.startsWith("fx__"))).toBe(false);
  });

  it("picks up tools the server announces later", async () => {
    const { ctx, configure, call } = await boot();
    await configure([stdio("fx")]);
    expect(ctx.tools.has("fx__grown")).toBe(false);
    await call("fx__grow");
    await until(() => ctx.tools.has("fx__grown"));
  });

  it("marks a server that exits as failed, with what it printed, and reconnects on request", async () => {
    const { ctx, configure, view, call } = await boot();
    await configure([stdio("fx")]);
    await call("fx__exit");
    await until(() => view("fx")!.state === "failed");
    expect(view("fx")!.error).toMatch(/exited[\s\S]*fixture: bye/);
    expect(view("fx")!.retry).toBeUndefined();
    expect(ctx.tools.has("fx__echo")).toBe(false);

    await ctx.mcpClient.reconnect("fx");
    expect(view("fx")!.state).toBe("connected");
    expect(await call("fx__echo", { text: "back" })).toBe("back");
  });

  it("reconnects on its own after the server exits", async () => {
    const { ctx, configure, view, call } = await boot([], { retryDelaysMs: [50] });
    await configure([stdio("fx")]);
    const pid = await call("fx__pid");
    await call("fx__exit");
    await until(() => view("fx")!.state !== "connected");
    expect(view("fx")!.retry).toEqual({ attempt: 1, of: 1 });
    await until(() => view("fx")!.state === "connected");
    expect(view("fx")!.retry).toBeUndefined();
    expect(await call("fx__pid")).not.toBe(pid);
    expect(ctx.tools.has("fx__echo")).toBe(true);
  });

  it("gives up on a server that keeps dying, after the configured attempts", async () => {
    const log = path.join(dir, `log-${n}.txt`);
    const { configure, view } = await boot([], { retryDelaysMs: [20, 20] });
    await configure([stdio("fx", {}, { FIXTURE_EXIT_AFTER_MS: "80", FIXTURE_LOG: log })]);
    const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l === "start").length : 0);
    await until(() => view("fx")!.state === "failed" && !view("fx")!.retry && starts() === 3);
    await new Promise((r) => setTimeout(r, 300));
    expect(starts()).toBe(3);
    expect(view("fx")!.state).toBe("failed");
  });

  it("gives a connection that stayed up a fresh set of retries", async () => {
    const log = path.join(dir, `log-${n}.txt`);
    const { configure } = await boot([], { retryDelaysMs: [20], stableMs: 0 });
    await configure([stdio("fx", {}, { FIXTURE_EXIT_AFTER_MS: "60", FIXTURE_LOG: log })]);
    const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l === "start").length : 0);
    await until(() => starts() >= 4);
    await configure([]);
  });

  it("cancels a call on the server when the caller stops waiting", async () => {
    const log = path.join(dir, `log-${n}.txt`);
    const { ctx, configure } = await boot();
    await configure([stdio("fx", {}, { FIXTURE_LOG: log })]);
    const abort = new AbortController();
    const started = Date.now();
    const call = ctx.tools.execute("fx__sleep", { ms: 10_000 }, { by: "ai:test", signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    await expect(call).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    await until(() => fs.readFileSync(log, "utf8").includes("cancelled"));
  });

  it("keeps a failing server from holding up the others", async () => {
    const { configure, view, call } = await boot();
    await configure([
      stdio("crash", {}, { FIXTURE_CRASH: "1" }),
      { id: "nothere", transport: { type: "stdio", command: "tomrade-no-such-command" } },
      stdio("fx")
    ]);
    expect(view("crash")!.state).toBe("failed");
    expect(view("crash")!.error).toMatch(/exited before it was ready\nfixture: missing API key/);
    expect(view("nothere")!.error).toMatch(/command not found: tomrade-no-such-command/);
    expect(view("fx")!.state).toBe("connected");
    expect(await call("fx__echo", { text: "ok" })).toBe("ok");
  });

  it("tests a configuration without saving it", async () => {
    const { ctx } = await boot();
    const ok = await ctx.mcpClient.test(stdio("probe"));
    expect(ok).toMatchObject({ ok: true, server: { name: "fixture" } });
    expect(ok.ok && ok.tools).toContain("files.read");
    expect(ctx.tools.has("probe__echo")).toBe(false);
    expect(await ctx.mcpClient.test({ id: "Bad Id", transport: { type: "stdio", command: "x" } })).toMatchObject({ ok: false, error: expect.stringMatching(/^id:/) });
  });

  it("takes its tools away when the plugin unloads", async () => {
    const { ctx, plugin, configure } = await boot();
    await configure([stdio("fx")]);
    expect(ctx.tools.has("fx__echo")).toBe(true);
    await plugin.dispose();
    expect(ctx.tools.list().some((t) => t.name.startsWith("fx__"))).toBe(false);
  });
});

describe("an HTTP server", () => {
  it("connects over Streamable HTTP, and its tools reach Tomrade's own MCP surface", async () => {
    const remote = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    open.push(remote.ctx.fiber);
    remote.ctx.tools.register(defineTool({ name: "shout", title: "Shout", description: "Upper-case it", input: z.object({ text: z.string() }), execute: ({ text }) => text.toUpperCase() }));

    const { ctx, configure, view, call } = await boot([[Mcp, { port: 0 }]]);
    await configure([{ id: "remote", transport: { type: "http", url: remote.ctx.mcp.url } }]);
    expect(view("remote")!.state).toBe("connected");
    expect(await call("remote__shout", { text: "hey" })).toBe("HEY");

    const client = new Client({ name: "t", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!)));
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain("remote__shout");
      const result = await client.callTool({ name: "remote__shout", arguments: { text: "via tomrade" } });
      expect(JSON.stringify(result.content)).toContain("VIA TOMRADE");
    } finally {
      await client.close();
    }
  });

  it("reports an unreachable URL as a failure", async () => {
    const { configure, view } = await boot();
    await configure([{ id: "down", transport: { type: "http", url: "http://127.0.0.1:9/mcp" } }]);
    expect(view("down")!.state).toBe("failed");
    expect(view("down")!.error).toBeTruthy();
  });
});
