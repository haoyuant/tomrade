import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import engineClaudeCode, { claudeProjectServerApproval } from "@tomradex/engine-claude-code";

const saved = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  delete process.env.FAKE_MCP_FAIL;
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-claude-link-"));
  const config = path.join(dir, "config");
  fs.mkdirSync(config);
  process.env.CLAUDE_CONFIG_DIR = config;
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-claude-code/tests/fake-claude-mcp.mjs")}' "$@"\n`, { mode: 0o700 });
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ agent: { engines: { "claude-code": { command: bin } } } }));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
  await settle();
  const file = path.join(config, ".claude.json");
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  return { ctx, dir, file, read, link: ctx.agent.engineOf("claude-code")!.mcpLink! };
}

describe("connecting Claude Code's own sessions to Tomrade", () => {
  it("adds, keeps, updates and removes a user-scope tomrade server, leaving the rest of .claude.json alone", async () => {
    const { ctx, file, read, link } = await setup();
    fs.writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { other: { type: "stdio", command: "x" } } }));
    const url = ctx.mcp.url!;
    expect(await link.status()).toMatchObject({ state: "missing", url, configuredUrl: null, file });

    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });
    expect(read()).toMatchObject({ numStartups: 3, mcpServers: { other: { command: "x" }, tomrade: { type: "http", url } } });
    expect(await link.connect()).toMatchObject({ state: "connected" });

    // An old port: the stale entry goes first, since adding an existing name fails.
    fs.writeFileSync(file, JSON.stringify({ ...read(), mcpServers: { ...read().mcpServers, tomrade: { type: "http", url: "http://127.0.0.1:1/mcp" } } }));
    const stale = await link.status();
    expect(stale).toMatchObject({ state: "stale", configuredUrl: "http://127.0.0.1:1/mcp" });
    expect(stale.manual.connect).toBe(`claude mcp remove --scope user tomrade; claude mcp add --scope user --transport http tomrade ${url}`);
    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });

    expect(await link.disconnect()).toMatchObject({ state: "missing", configuredUrl: null });
    expect(read()).toMatchObject({ numStartups: 3, mcpServers: { other: { command: "x" } } });
    expect(read().mcpServers.tomrade).toBeUndefined();
    await ctx.fiber.dispose();
  });

  it("reports why the CLI could not do it, with the command to run by hand", async () => {
    const { ctx, link } = await setup();
    process.env.FAKE_MCP_FAIL = "1";
    const result = await link.connect();
    expect(result).toMatchObject({ state: "missing", error: "fake failure" });
    expect(result.manual.connect).toBe(`claude mcp add --scope user --transport http tomrade ${ctx.mcp.url}`);
    await ctx.fiber.dispose();
  });

  it("says Tomrade's server is not running rather than writing no address", async () => {
    const { ctx, link } = await setup();
    ctx.mcp.url = null;
    expect(await link.connect()).toMatchObject({ state: "unavailable", error: "Tomrade's MCP server is not running" });
    await ctx.fiber.dispose();
  });
});

describe("whether Claude Code loads a repository's .mcp.json server", () => {
  it("is pending until approved or rejected, in .claude.json or a settings file", () => {
    const config = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-claude-approval-"));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-claude-repo-"));
    const env = { CLAUDE_CONFIG_DIR: config };
    const user = (value: unknown) => fs.writeFileSync(path.join(config, ".claude.json"), JSON.stringify(value));
    expect(claudeProjectServerApproval(repo, "tomrade", env)).toBe("pending");
    user({ projects: { [repo]: { enabledMcpjsonServers: [], disabledMcpjsonServers: [] } } });
    expect(claudeProjectServerApproval(repo, "tomrade", env)).toBe("pending");
    user({ projects: { [repo]: { enabledMcpjsonServers: ["tomrade"] } } });
    expect(claudeProjectServerApproval(repo, "tomrade", env)).toBe("approved");
    user({ projects: { [repo]: { enabledMcpjsonServers: ["tomrade"], disabledMcpjsonServers: ["tomrade"] } } });
    expect(claudeProjectServerApproval(repo, "tomrade", env)).toBe("rejected");
    user({});
    fs.mkdirSync(path.join(repo, ".claude"));
    fs.writeFileSync(path.join(repo, ".claude", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
    expect(claudeProjectServerApproval(repo, "tomrade", env)).toBe("approved");
  });
});
