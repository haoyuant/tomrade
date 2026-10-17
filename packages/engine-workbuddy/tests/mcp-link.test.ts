import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import engineWorkBuddy, { codebuddyUserFile } from "../src/index.js";

const saved = process.env.CODEBUDDY_CONFIG_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
  else process.env.CODEBUDDY_CONFIG_DIR = saved;
  delete process.env.FAKE_MCP_FAIL;
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-workbuddy-link-"));
  const config = path.join(dir, "config");
  fs.mkdirSync(config);
  process.env.CODEBUDDY_CONFIG_DIR = config;
  const bin = path.join(dir, "codebuddy");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-workbuddy/tests/fake-codebuddy-mcp.mjs")}' "$@"\n`, { mode: 0o700 });
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ agent: { engines: { workbuddy: { command: bin } } } }));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineWorkBuddy] });
  await settle();
  const file = path.join(config, ".mcp.json");
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  return { ctx, file, read, link: ctx.agent.engineOf("workbuddy")!.mcpLink! };
}

describe("connecting WorkBuddy's own sessions to Tomrade", () => {
  it("finds CodeBuddy's user-scope file under CODEBUDDY_CONFIG_DIR, else ~/.codebuddy", () => {
    expect(codebuddyUserFile({ CODEBUDDY_CONFIG_DIR: "/x/cb" })).toBe(path.join("/x/cb", ".mcp.json"));
    expect(codebuddyUserFile({})).toBe(path.join(os.homedir(), ".codebuddy", ".mcp.json"));
  });

  it("adds, keeps, updates and removes a user-scope tomrade server, leaving the rest of .mcp.json alone", async () => {
    const { ctx, file, read, link } = await setup();
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x" } }, disabledMcpServers: [] }));
    const url = ctx.mcp.url!;
    expect(await link.status()).toMatchObject({ state: "missing", url, configuredUrl: null, file });

    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });
    expect(read()).toMatchObject({ mcpServers: { other: { command: "x" }, tomrade: { type: "http", url } } });
    expect(await link.connect()).toMatchObject({ state: "connected" });

    fs.writeFileSync(file, JSON.stringify({ ...read(), mcpServers: { ...read().mcpServers, tomrade: { type: "http", url: "http://127.0.0.1:1/mcp" } } }));
    const stale = await link.status();
    expect(stale).toMatchObject({ state: "stale", configuredUrl: "http://127.0.0.1:1/mcp" });
    expect(stale.manual.connect).toBe(`codebuddy mcp remove --scope user tomrade; codebuddy mcp add --scope user --transport http tomrade ${url}`);
    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });

    expect(await link.disconnect()).toMatchObject({ state: "missing", configuredUrl: null });
    expect(read()).toMatchObject({ mcpServers: { other: { command: "x" } } });
    expect(read().mcpServers.tomrade).toBeUndefined();
    await ctx.fiber.dispose();
  });

  it("says what failed and keeps the state as it was", async () => {
    const { ctx, link } = await setup();
    process.env.FAKE_MCP_FAIL = "1";
    expect(await link.connect()).toMatchObject({ state: "missing", error: expect.stringContaining("fake failure") });
    await ctx.fiber.dispose();
  });

  it("reports a file it cannot read instead of throwing", async () => {
    const { ctx, file, link } = await setup();
    fs.writeFileSync(file, "{ not json");
    expect(await link.status()).toMatchObject({ state: "unavailable", file, error: expect.stringContaining(file) });
    await ctx.fiber.dispose();
  });
});
