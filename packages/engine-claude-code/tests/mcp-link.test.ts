import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fakeProgram, fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import engineClaudeCode, { claudeConfigDirOf, claudeConfigDirs, claudeProjectServerApproval } from "@tomradex/engine-claude-code";

const saved = process.env.CLAUDE_CONFIG_DIR;
const savedHome = process.env.HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  process.env.HOME = savedHome;
  delete process.env.FAKE_MCP_FAIL;
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-claude-link-"));
  const config = path.join(dir, "config");
  fs.mkdirSync(config);
  process.env.CLAUDE_CONFIG_DIR = config;
  let bin = path.join(dir, "claude");
  bin = fakeProgram(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-claude-code/tests/fake-claude-mcp.mjs")}' "$@"\n`);
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ agent: { engines: { "claude-code": { command: bin } } } }));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
  await settle();
  const file = path.join(config, ".claude.json");
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  return { ctx, dir, file, read, link: ctx.agent.engineOf("claude-code")!.local!.mcpLink! };
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

describe("Claude Code accounts kept in separate config folders", () => {
  it("knows a session's config folder by where its transcript is", () => {
    expect(claudeConfigDirOf("/Users/a/.claude-tom/projects/-Users-a-repo/d5095123.jsonl")).toBe("/Users/a/.claude-tom");
    expect(claudeConfigDirOf("/Users/a/.claude/projects/-Users-a-repo/x.jsonl")).toBe("/Users/a/.claude");
    expect(claudeConfigDirOf("/Users/a/notes/x.jsonl")).toBeNull();
  });

  it("finds the folders beside the default one, those sessions reported, and its own first", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-claude-home-"));
    fs.writeFileSync(path.join(home, ".claude.json"), "{}");
    for (const name of [".claude-tom", ".claude-alt"]) {
      fs.mkdirSync(path.join(home, name));
      fs.writeFileSync(path.join(home, name, ".claude.json"), "{}");
    }
    // Not a config folder: no .claude.json inside.
    fs.mkdirSync(path.join(home, ".claude-backup"));
    const all = claudeConfigDirs({}, home);
    expect(all[0]).toBe(path.join(home, ".claude"));
    expect(all.slice(1).sort()).toEqual([path.join(home, ".claude-alt"), path.join(home, ".claude-tom")]);
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: path.join(home, ".claude-tom") }, home)[0]).toBe(path.join(home, ".claude-tom"));
    expect(claudeConfigDirs({}, home, ["/Volumes/work/claude"])).toContain("/Volumes/work/claude");
  });

  async function accounts() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-claude-home-"));
    process.env.HOME = home;
    for (const name of [".claude-tom", ".claude-alt"]) {
      fs.mkdirSync(path.join(home, name));
      fs.writeFileSync(path.join(home, name, ".claude.json"), JSON.stringify({ numStartups: 1 }));
    }
    const env = await setup();
    // Tomrade itself runs with neither account's CLAUDE_CONFIG_DIR, as an app opened from the Dock does.
    fs.writeFileSync(path.join(home, ".claude.json"), "{}");
    delete process.env.CLAUDE_CONFIG_DIR;
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(home, name, ".claude.json"), "utf8"));
    return { ...env, home, read };
  }

  it("connects one account without touching the others", async () => {
    const { ctx, home, read, link } = await accounts();
    const tom = path.join(home, ".claude-tom");
    const view = await link.status();
    expect(view.profile).toBe(path.join(home, ".claude"));
    expect(view.profiles!.map((p) => p.profile)).toEqual(expect.arrayContaining([tom, path.join(home, ".claude-alt")]));
    expect(view.profiles!.find((p) => p.profile === tom)).toMatchObject({ state: "missing", file: path.join(tom, ".claude.json") });
    expect(view.profiles!.find((p) => p.profile === tom)!.manual.connect).toBe(`CLAUDE_CONFIG_DIR=~/.claude-tom claude mcp add --scope user --transport http tomrade ${ctx.mcp.url}`);

    const after = await link.connect(tom);
    expect(after.profiles!.find((p) => p.profile === tom)).toMatchObject({ state: "connected" });
    expect(read(".claude-tom")).toMatchObject({ numStartups: 1, mcpServers: { tomrade: { url: ctx.mcp.url } } });
    expect(read(".claude-alt").mcpServers).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers).toBeUndefined();

    expect((await link.disconnect(tom)).profiles!.find((p) => p.profile === tom)).toMatchObject({ state: "missing" });
    expect(read(".claude-tom").mcpServers.tomrade).toBeUndefined();
    await ctx.fiber.dispose();
  });

  it("answers whether each account loads the repository's server, and learns accounts from transcripts", async () => {
    const { ctx, home, link } = await accounts();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-claude-repo-"));
    const tom = path.join(home, ".claude-tom");
    fs.writeFileSync(path.join(tom, ".claude.json"), JSON.stringify({ projects: { [repo]: { enabledMcpjsonServers: ["tomrade"] } } }));
    const approvals = link.projectApprovals!(repo);
    expect(approvals.find((a) => a.profile === tom)).toEqual({ profile: tom, state: "approved", command: "CLAUDE_CONFIG_DIR=~/.claude-tom claude" });
    expect(approvals.find((a) => a.profile === path.join(home, ".claude-alt"))).toMatchObject({ state: "pending" });
    expect(approvals.find((a) => a.profile === path.join(home, ".claude"))).toEqual({ profile: path.join(home, ".claude"), state: "pending", command: "claude" });

    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-claude-elsewhere-"));
    link.sawTranscript!(path.join(elsewhere, "projects", "-repo", "s.jsonl"));
    expect((await link.status()).profiles!.map((p) => p.profile)).toContain(elsewhere);
    await ctx.fiber.dispose();
  });
});
