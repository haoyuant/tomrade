/**
 * The fast path for a developer's own terminal: a repository connected to
 * Tomrade (Claude, Codex, WorkBuddy and Pi MCP config, agent instructions, hooks) as a pull request, tokenless hooks that
 * still find their session by cwd, claim_ticket from such a session, and a
 * branch nobody's ticket names becoming a ticket.
 */
import { parse as parseToml } from "smol-toml";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Agent, type Engine } from "@tomradex/agent";
import { CodeLink, hookCommand, posixHookCommand, writeConnectFiles as writeWith, type ConnectAgent, type ConnectFileWriter, type ConnectInput, type LocalConnect } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import { Mcp } from "@tomradex/mcp";
import { Repos } from "@tomradex/repos";
import GitHubAccount from "@tomradex/github";
import { Settings } from "@tomradex/settings";
import { Storage, digestState, exportState } from "@tomradex/storage";
import { FakeGh, FakeHerdr, fresh, settle } from "@tomradex/testkit";
import { Herdr } from "@tomradex/herdr";
import { claudeRecord } from "@tomradex/engine-kit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Tools, defineTool } from "@tomradex/tools";
import { z } from "zod";

/** Pi's engine registers the real writer (see engine-pi); this one names the same endpoints the same way. */
const piConnector: ConnectFileWriter = {
  file: ".pi/extensions/tomrade.ts",
  title: "Pi",
  write: (mcpUrl, eventUrl) => `// pi extension\nconst server = ${JSON.stringify({ url: mcpUrl })};\nconst eventUrl = ${JSON.stringify(eventUrl)};\n`,
  url: (text) => {
    const line = /^const server = (\{.*\});$/m.exec(text)?.[1];
    return line ? (JSON.parse(line) as { url: string }).url : null;
  },
  tracks: (text, eventUrl) => text.includes(eventUrl)
};
const writeConnectFiles = (root: string, input: ConnectInput, agents?: readonly ConnectAgent[], local?: LocalConnect) => writeWith(root, input, agents, local, () => piConnector);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-connect-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Connecting opens its pull request with gh: this one answers here, signed out unless a test says otherwise, and never asks GitHub.
const gh = new FakeGh(path.join(root, "gh"));
vi.stubEnv("PATH", `${gh.dir}${path.delimiter}${process.env.PATH}`);

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
/** Built once with git, then copied: every spawn costs, and a fresh repository is the same bytes each time. */
let template: { remote: string; checkout: string } | null = null;
async function until(check: () => boolean, timeout = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function codeRepo(): { remote: string; checkout: string } {
  if (!template) {
    const remote = path.join(root, "template-remote.git");
    fs.mkdirSync(remote, { recursive: true });
    git(["init", "--bare", "-b", "main", "."], remote);
    const checkout = path.join(root, "template-checkout");
    fs.mkdirSync(checkout, { recursive: true });
    git(["init", "-q", "-b", "main"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    git(["config", "user.email", "dev@localhost"], checkout);
    git(["config", "user.name", "Dev"], checkout);
    fs.writeFileSync(path.join(checkout, "package.json"), '{ "name": "app" }\n');
    fs.writeFileSync(path.join(checkout, "CLAUDE.md"), "# app\n\nRun `pnpm test`.\n\n## Layout\n\nsrc/ holds it.\n");
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "initial"], checkout);
    git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);
    template = { remote, checkout };
  }
  const remote = path.join(root, `remote-${n++}.git`);
  const checkout = path.join(root, `checkout-${n++}`);
  fs.cpSync(template.remote, remote, { recursive: true });
  fs.cpSync(template.checkout, checkout, { recursive: true });
  git(["remote", "set-url", "origin", remote], checkout);
  return { remote, checkout };
}

/** An engine this machine has installed: what auto-connecting looks for, and nothing else. */
function installed(id: string): Engine {
  return {
    id,
    title: id,
    author: `ai:${id}`,
    capabilities: ["code"],
    available: async () => ({ ok: true }),
    async turn() {
      return { stop: "end" };
    }
  };
}

async function machine(codeLinkConfig: Record<string, unknown> = {}) {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const repo = codeRepo();
  const bag = await fresh({
    hubDir,
    plugins: [
      Tools,
      [Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount,
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      Repos,
      Contributions,
      Agent,
      [Mcp, { port: 0 }],
      [CodeLink, { scanMs: 0, ...codeLinkConfig }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  const row = bag.ctx.repos.create({ projectId: bag.project.id, remote: repo.remote });
  bag.boards.update(bag.project.id, bag.board.id, { repoId: row.id });
  await bag.ctx.repos.setCheckout(repo.remote, repo.checkout);
  // GitHub is never asked from a test; one that needs its answer sets its own.
  bag.ctx.codeLink.pulls = async () => null;
  bag.ctx.codeLink.registerConnector("pi", piConnector);
  return { ...bag, codeLink: bag.ctx.codeLink, repo: row, checkout: repo.checkout, remote: repo.remote };
}

describe("connecting a repository", () => {
  it("writes a plugin agent's own file when its engine registers a connector", () => {
    const dir = path.join(root, `plugin-${n++}`);
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    const writer: ConnectFileWriter = {
      file: ".acme/tomrade.json",
      title: "Acme",
      write: (mcpUrl, eventUrl) => JSON.stringify({ mcpUrl, eventUrl }),
      url: (text) => (JSON.parse(text) as { mcpUrl: string }).mcpUrl,
      tracks: () => true
    };
    const connectors = Object.assign((agent: string) => (agent === "acme" ? writer : undefined), { agents: () => ["acme"] });
    const { files, skipped } = writeWith(dir, input, ["acme"], undefined, connectors);
    expect(files.sort()).toEqual([".acme/tomrade.json", "AGENTS.md"]);
    expect(skipped).toEqual([]);
    expect(fs.readFileSync(path.join(dir, ".acme/tomrade.json"), "utf8")).toContain(input.mcpUrl);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain('claim_ticket("APP-42")');
  });

  it("writes agent configuration without disturbing what is there", () => {
    const dir = path.join(root, `files-${n++}`);
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x" } } }));
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".codex", "config.toml"), '[mcp_servers.other]\ncommand = "x"\n');
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# app\n\n## Tomrade\n\nold words\n\n## Layout\n\nkeep me\n");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agents\n\nKeep this.\n");
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(pnpm test)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };

    expect(writeConnectFiles(dir, input).files.sort()).toEqual([".agents/skills/tomrade-sync/SKILL.md", ".claude/settings.json", ".codebuddy/settings.json", ".codex/config.toml", ".cursor/hooks.json", ".cursor/hooks/tomrade", ".cursor/hooks/tomrade.ps1", ".cursor/mcp.json", ".gemini/settings.json", ".mcp.json", ".opencode/plugins/tomrade.js", ".pi/extensions/tomrade.ts", "AGENTS.md", "CLAUDE.md", "opencode.json"]);
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["other", "tomrade"]);
    const codex = fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
    expect(codex).toContain('[mcp_servers.other]\ncommand = "x"');
    expect(codex).toContain('[mcp_servers.tomrade]\nurl = "http://127.0.0.1:19090/mcp/p1"');
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).not.toContain("old words");
    expect(claude).toContain('claim_ticket("APP-42")');
    expect(claude).toContain("Work without a ticket is fine");
    expect(claude).toContain("A session that claimed a ticket owns only that ticket");
    expect(claude).toContain("`/tomrade:sync`");
    expect(claude).toContain("2. Match the work to tickets.");
    expect(claude).toContain("inspect the complete diff");
    expect(claude).toContain("## Layout\n\nkeep me");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain('claim_ticket("APP-42")');
    // Codex takes MCP instructions for tool notes, so AGENTS.md has it fetch the rules; Claude Code reads them from the instructions.
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain("When the `tomrade` MCP server is available, call its tool `get_project_rules` before your first reply in every session");
    expect(claude).not.toContain("get_project_rules");
    // The file is committed while Tomrade is one developer's: a clone without it is told to carry on as usual.
    expect(claude).toContain("This section applies only when the `tomrade` MCP server is available in your session.");
    expect(claude).toContain("and the `tomrade` server is available");
    const skill = fs.readFileSync(path.join(dir, ".agents", "skills", "tomrade-sync", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: tomrade-sync\ndescription: "Bring .*\(project \\"App\\"\).*"\n---\n/);
    expect(skill).toContain("ticket keys look like APP-42");
    const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")) as { permissions: unknown; hooks: Record<string, unknown[]> };
    expect(settings.permissions).toEqual({ allow: ["Bash(pnpm test)"] });
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.SessionStart).toHaveLength(1);

    // Idempotent: a second pass changes nothing.
    expect(writeConnectFiles(dir, input).files).toEqual([]);
  });

  it("touches only the Tomrade section, marking one written before the markers", () => {
    const dir = path.join(root, `section-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
    // Headings that merely start with "Tomrade" are the person's own.
    const own = "# app\n\n## Setup\n\n### Tomrade tips\n\nRun it first.\n\n### Testing\n\npnpm test\n\n## Tomrade setup\n\nInstall it.\n\n# Appendix\n\nThe end.\n";
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), own);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# app\n\nIntro.\n\n## Tomrade\n\nold words\n\n### Syncing back\n\nold steps\n\n# Appendix\n\nThe end.\n");
    writeConnectFiles(dir, input);

    const claude = read("CLAUDE.md");
    expect(claude.startsWith(`${own}\n<!-- BEGIN TOMRADE -->\n## Tomrade\n\n`)).toBe(true);
    expect(claude.endsWith("declines.\n<!-- END TOMRADE -->\n")).toBe(true);
    const agents = read("AGENTS.md");
    expect(agents).not.toContain("old words");
    expect(agents).not.toContain("old steps");
    expect(agents.startsWith("# app\n\nIntro.\n\n<!-- BEGIN TOMRADE -->\n## Tomrade\n\n")).toBe(true);
    expect(agents.endsWith("<!-- END TOMRADE -->\n\n# Appendix\n\nThe end.\n")).toBe(true);
    expect(writeConnectFiles(dir, input).files).toEqual([]);

    // Reconnecting rewrites what lies between the markers and nothing else.
    const moved = { ...input, mcpUrl: "http://127.0.0.1:19091/mcp/p1" };
    expect(writeConnectFiles(dir, moved).files).toEqual(expect.arrayContaining(["CLAUDE.md", "AGENTS.md"]));
    const again = read("CLAUDE.md");
    expect(again).toContain(moved.mcpUrl);
    expect(again).not.toContain(input.mcpUrl);
    expect(again.startsWith(`${own}\n<!-- BEGIN TOMRADE -->\n`)).toBe(true);
    expect(again.split("## Tomrade\n")).toHaveLength(2);
    expect(read("AGENTS.md").endsWith("<!-- END TOMRADE -->\n\n# Appendix\n\nThe end.\n")).toBe(true);
  });

  it("keeps everything after a BEGIN marker that lost its END", () => {
    const dir = path.join(root, `orphan-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    const own = "# app\n\nBefore.\n\n<!-- BEGIN TOMRADE -->\n\nBetween.\n\n## Notes\n\nAfter.\n";
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), own);
    writeConnectFiles(dir, input);
    expect(writeConnectFiles(dir, input).files).toEqual([]);
    const moved = { ...input, mcpUrl: "http://127.0.0.1:19091/mcp/p1" };
    writeConnectFiles(dir, moved);
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude.startsWith(`${own}\n<!-- BEGIN TOMRADE -->\n## Tomrade\n\n`)).toBe(true);
    expect(claude).toContain(moved.mcpUrl);
    expect(claude).not.toContain(input.mcpUrl);
  });

  it("creates Claude hooks from nothing and merges WorkBuddy/Cursor/Gemini settings", () => {
    const dir = path.join(root, `agents-${n++}`);
    fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".gemini"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".codebuddy"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".codebuddy/settings.json"), JSON.stringify({ model: "hy3", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
    fs.writeFileSync(path.join(dir, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { existing: { command: "custom" } } }));
    fs.writeFileSync(path.join(dir, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "say done" }], afterFileEdit: [{ command: "prettier" }] } }));
    fs.writeFileSync(path.join(dir, ".gemini/settings.json"), JSON.stringify({ theme: "dark", mcpServers: { existing: { command: "custom" } } }));
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(dir, input);
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    expect(read(".claude/settings.json").hooks.SessionStart[0].hooks[0].command).toContain(input.eventUrl);
    expect(read(".claude/settings.json").hooks.SessionStart[0].hooks[0].command).not.toContain("X-Tomrade-Agent");
    expect(read(".claude/settings.json").hooks.SessionStart[0].hooks[0].command).toContain(`-H "X-Tomrade-Herdr-Pane: $HERDR_PANE_ID"`);
    // WorkBuddy takes Claude Code's hook format in its own file; its hooks name it.
    const codebuddy = read(".codebuddy/settings.json");
    expect(codebuddy.model).toBe("hy3");
    expect(codebuddy.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "echo mine" }] }, { hooks: [{ type: "command", command: expect.stringContaining("X-Tomrade-Agent: workbuddy") }] }]);
    expect(codebuddy.hooks.SessionStart[0].hooks[0].command).toContain(input.eventUrl);
    expect(read(".cursor/mcp.json")).toMatchObject({ mcpServers: { existing: { command: "custom" }, tomrade: { url: input.mcpUrl } } });
    // Cursor's hooks name it, on each event it reports, after the person's own.
    const cursorHooks = read(".cursor/hooks.json");
    // The bare path: Cursor on Windows runs the .ps1 beside it, everything else the POSIX script itself.
    expect(cursorHooks.hooks.stop).toEqual([{ command: "say done" }, { command: ".cursor/hooks/tomrade" }]);
    expect(cursorHooks.hooks.afterFileEdit).toEqual([{ command: "prettier" }]);
    const script = path.join(dir, ".cursor/hooks/tomrade");
    expect(fs.readFileSync(script, "utf8")).toContain(`-H 'X-Tomrade-Agent: cursor' --data-binary @- '${input.eventUrl}'`);
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(`${script}.ps1`, "utf8")).toContain(`$headers = @{ 'X-Tomrade-Agent' = 'cursor' }`);
    expect(fs.readFileSync(`${script}.ps1`, "utf8")).toContain(`-Uri '${input.eventUrl}'`);
    expect(read(".gemini/settings.json")).toMatchObject({ theme: "dark", mcpServers: { existing: { command: "custom" }, tomrade: { httpUrl: input.mcpUrl } } });
    expect(writeConnectFiles(dir, input).files).toEqual([]);
  });

  it("leaves Codex hooks written as inline arrays alone, keeping every comment, and says so", () => {
    const dir = path.join(root, `codex-inline-${n++}`);
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    const file = path.join(dir, ".codex/config.toml");
    const own = '# my settings\nnotify = ["notify-me"]\n[hooks]\n# keep me\nSessionStart = [{ hooks = [{ type = "command", command = "echo custom" }] }]\n';
    fs.writeFileSync(file, own);
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    const { files, skipped } = writeConnectFiles(dir, input, ["codex"]);
    expect(skipped).toEqual([{ agent: "codex", file: ".codex/config.toml", reason: "codex-hooks" }]);
    expect(files.sort()).toEqual([".agents/skills/tomrade-sync/SKILL.md", ".codex/config.toml", "AGENTS.md"]);
    // Its MCP server still goes in, between Tomrade's markers; nothing of the person's is rewritten.
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith(own.trimEnd())).toBe(true);
    expect(text).toContain('# BEGIN TOMRADE MCP\n[mcp_servers.tomrade]\nurl = "http://127.0.0.1:19090/mcp/p1"\nenv_http_headers = { "X-Tomrade-Herdr-Pane" = "HERDR_PANE_ID" }\n# END TOMRADE MCP');
    expect(text).not.toContain("X-Tomrade-Agent");
    expect(parseToml(text)).toMatchObject({ hooks: { SessionStart: [{ hooks: [{ command: "echo custom" }] }] } });
    // Its instructions name the server, and no hooks that are not there.
    const instructions = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(instructions).toContain("(`.codex/config.toml` for Codex)");
    expect(instructions).not.toContain("session lifecycle");
    expect(instructions).not.toContain("/hooks");
    expect(writeConnectFiles(dir, input, ["codex"]).files).toEqual([]);
  });

  it("keeps Tomrade's Codex hooks an older Tomrade wrote outside the markers while they are current, and never rewrites them", () => {
    const dir = path.join(root, `codex-serialised-${n++}`);
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    const file = path.join(dir, ".codex/config.toml");
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(dir, input, ["codex"]);
    const unmarked = fs.readFileSync(file, "utf8").replace("# BEGIN TOMRADE HOOKS\n", "").replace("# END TOMRADE HOOKS\n", "");
    fs.writeFileSync(file, unmarked);
    expect(writeConnectFiles(dir, input, ["codex"])).toEqual({ files: [], skipped: [] });
    const moved = { ...input, eventUrl: input.eventUrl.replace("19090", "19091") };
    expect(writeConnectFiles(dir, moved, ["codex"]).skipped).toEqual([{ agent: "codex", file: ".codex/config.toml", reason: "codex-hooks" }]);
    expect(fs.readFileSync(file, "utf8")).toBe(unmarked);
  });

  it("preserves existing Codex hooks, notify and settings", () => {
    const dir = path.join(root, `codex-${n++}`);
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    const file = path.join(dir, ".codex/config.toml");
    fs.writeFileSync(file, 'notify = ["notify-me"]\nmodel = "example"\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo custom"\n');
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(dir, input);
    const config = parseToml(fs.readFileSync(file, "utf8"));
    expect(config).toMatchObject({ notify: ["notify-me"], model: "example", hooks: { SessionStart: [{ hooks: [{ command: "echo custom" }] }, { hooks: [{ command: expect.stringContaining("X-Tomrade-Agent: codex") }] }] } });
    expect(writeConnectFiles(dir, input).files).toEqual([]);
    writeConnectFiles(dir, { ...input, eventUrl: input.eventUrl.replace("19090", "19091") });
    const reconnected = fs.readFileSync(file, "utf8");
    expect(reconnected).toContain("19091/sessions/event");
    expect(reconnected).not.toContain("19090/sessions/event");
    expect(parseToml(reconnected).notify).toEqual(["notify-me"]);
  });

  it("reports committed default-branch connection, pending work, another instance and retries", async () => {
    const { codeLink, ctx, project, repo, checkout, board, boards } = await machine();
    expect(await codeLink.connection(project.id, repo.id)).toMatchObject({ state: "unconnected", mcpUrl: ctx.mcp.urlFor(project.id) });
    // No selected ticket, no workstream binding, and run-in-checkout do not prevent connecting.
    boards.update(project.id, board.id, { repoId: null });
    ctx.repos.setRunInCheckout(repo.remote, true);
    const first = await codeLink.connect(project.id, repo.id);
    expect(first).toMatchObject({ committed: true, pushed: true });
    expect(await codeLink.connection(project.id, repo.id)).toMatchObject({ state: "pending" });
    const retry = await codeLink.connect(project.id, repo.id);
    expect(retry).toMatchObject({ committed: false, pushed: true });
    expect(retry.message).not.toContain("already connected");
    git(["merge", "--ff-only", "tomrade/connect"], checkout);
    expect(await codeLink.connection(project.id, repo.id)).toMatchObject({ state: "connected" });
    // Claude Code asks once per folder before it loads a committed .mcp.json server.
    const asked: string[] = [];
    const missing = { state: "missing", url: null, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" } } as const;
    ctx.agent.engine({ id: "claude-code", title: "Claude Code", author: "ai:claude-code", available: async () => ({ ok: true }), turn: async () => ({ stop: "end" }),
      mcpLink: { status: async () => missing, connect: async () => missing, disconnect: async () => missing, projectApproval: (dir) => { asked.push(dir); return "pending"; },
        projectApprovals: () => [{ profile: "/h/.claude-tom", state: "approved", command: "CLAUDE_CONFIG_DIR=~/.claude-tom claude" }] } });
    expect(await codeLink.connection(project.id, repo.id)).toMatchObject({ state: "connected", claudeApproval: "pending", claudeApprovals: [{ profile: "/h/.claude-tom", state: "approved" }] });
    expect(asked).toEqual([checkout]);
    ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
    expect(await codeLink.connect(project.id, repo.id)).toMatchObject({ committed: false, message: "已连接" });

    const otherUrl = "http://127.0.0.1:19091/mcp/other";
    writeConnectFiles(checkout, { projectName: "App", mcpUrl: otherUrl, eventUrl: "http://127.0.0.1:19091/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" });
    git(["add", "-A"], checkout);
    git(["commit", "-m", "connect elsewhere"], checkout);
    git(["branch", "-D", "tomrade/connect"], checkout);
    git(["update-ref", "-d", "refs/remotes/origin/tomrade/connect"], checkout);
    expect(await codeLink.connection(project.id, repo.id)).toMatchObject({ state: "other-instance", configuredUrl: otherUrl });
  });

  it("gives Pi the project extension its engine writes, and only the instructions, naming no extension, while no engine has registered one", () => {
    const dir = path.join(root, `pi-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    expect(writeWith(dir, input, ["pi"])).toEqual({ files: ["AGENTS.md"], skipped: [{ agent: "pi", file: ".pi/extensions/tomrade.ts", reason: "no-connector" }] });
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).not.toContain("Pi");
    writeConnectFiles(dir, input);
    expect(fs.readFileSync(path.join(dir, ".pi/extensions/tomrade.ts"), "utf8")).toBe(piConnector.write(input.mcpUrl, input.eventUrl));
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain("`.pi/extensions/tomrade.ts` for Pi");
    expect(writeConnectFiles(dir, input).files).toEqual([]);
    expect(writeConnectFiles(dir, { ...input, mcpUrl: "http://127.0.0.1:19091/mcp/p1", eventUrl: "http://127.0.0.1:19091/sessions/event" }).files).toContain(".pi/extensions/tomrade.ts");
  });

  it("names in the agent instructions only what the folder connects: no agent left out, and every agent once all are written", () => {
    const dir = path.join(root, `named-${n++}`);
    fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cursor/mcp.json"), "{ nope");
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    // Pi's engine is off, OpenCode is not chosen, and Cursor's server file cannot be read.
    expect(writeWith(dir, input, ["claude-code", "codex", "workbuddy", "pi", "cursor", "gemini"]).skipped.map((skip) => skip.agent)).toEqual(["pi", "cursor"]);
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      for (const absent of ["Pi", ".pi/", "OpenCode", "opencode", "Cursor", ".cursor/"]) expect(text).not.toContain(absent);
      expect(text).toContain("MCP server (`.mcp.json` for Claude Code and WorkBuddy, `.codex/config.toml` for Codex).");
      expect(text).toContain("\nClaude Code, Codex and WorkBuddy report session lifecycle through repository hooks. The hooks also carry Tomrade's answer: ");
      expect(text).toContain("\nGemini CLI uses `.gemini/settings.json`");
    }
    fs.rmSync(path.join(dir, ".cursor/mcp.json"));
    writeConnectFiles(dir, input);
    const all = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    for (const file of [".mcp.json", ".codex/config.toml", ".pi/extensions/tomrade.ts", "opencode.json", ".opencode/plugins/tomrade.js", ".cursor/mcp.json", ".cursor/hooks.json", ".cursor/hooks/tomrade", ".cursor/hooks/tomrade.ps1", ".gemini/settings.json"]) expect(all).toContain(`\`${file}\``);
    expect(all).toContain("\nClaude Code, Codex, WorkBuddy and Cursor report session lifecycle through repository hooks, Pi through that extension and OpenCode through `.opencode/plugins/tomrade.js`. ");
    // A later write for one agent, as a machine fills in what it lacks, still names the others.
    fs.rmSync(path.join(dir, ".cursor/hooks.json"));
    expect(writeConnectFiles(dir, input, ["cursor"]).files).toEqual([".cursor/hooks.json"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(all);
  });

  it("gives OpenCode a tomrade server in opencode.json and a reporting plugin, keeping the project's own config", () => {
    const dir = path.join(root, `opencode-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "deepseek/deepseek-flash" }));
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    expect(writeConnectFiles(dir, input).files).toEqual(expect.arrayContaining(["opencode.json", ".opencode/plugins/tomrade.js"]));
    expect(JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"))).toEqual({ $schema: "https://opencode.ai/config.json", model: "deepseek/deepseek-flash",
      mcp: { tomrade: { type: "remote", url: input.mcpUrl, enabled: true, headers: { "X-Tomrade-Run": "{env:TOMRADE_MCP_TOKEN}", "X-Tomrade-Herdr-Pane": "{env:HERDR_PANE_ID}" } } } });
    const plugin = fs.readFileSync(path.join(dir, ".opencode/plugins/tomrade.js"), "utf8");
    expect(plugin).toContain(`const eventUrl = "${input.eventUrl}";`);
    expect(plugin).toContain('"x-tomrade-agent": "opencode"');
    expect(writeConnectFiles(dir, input).files).toEqual([]);
    // One it cannot read leaves OpenCode out and the file as it was, and the instructions stop naming it.
    fs.writeFileSync(path.join(dir, "opencode.json"), "{ not json");
    expect(writeConnectFiles(dir, input)).toEqual({ files: ["CLAUDE.md", "AGENTS.md"], skipped: [{ agent: "opencode", file: "opencode.json", reason: "invalid" }] });
    expect(fs.readFileSync(path.join(dir, "opencode.json"), "utf8")).toBe("{ not json");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).not.toContain("OpenCode");
  });

  it("reads JSON with comments, writes only for the chosen agents, and skips one whose file it cannot change safely", () => {
    const dir = path.join(root, `jsonc-${n++}`);
    fs.mkdirSync(path.join(dir, ".gemini"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    // Already as it should be, comments and all: nothing to write.
    const gemini = `{\n  // mine\n  "theme": "dark", /* "x": "//" */\n  "mcpServers": { "tomrade": { "httpUrl": "${input.mcpUrl}" }, },\n}\n`;
    fs.writeFileSync(path.join(dir, ".gemini/settings.json"), gemini);
    fs.writeFileSync(path.join(dir, ".cursor/mcp.json"), "{ nope");
    const { files, skipped } = writeConnectFiles(dir, input, ["claude-code", "cursor", "gemini"]);
    expect(skipped).toEqual([{ agent: "cursor", file: ".cursor/mcp.json", reason: "invalid" }]);
    expect(files.sort()).toEqual([".claude/settings.json", ".mcp.json", "CLAUDE.md"]);
    expect(fs.readFileSync(path.join(dir, ".gemini/settings.json"), "utf8")).toBe(gemini);
    expect(fs.readFileSync(path.join(dir, ".cursor/mcp.json"), "utf8")).toBe("{ nope");
    expect(fs.existsSync(path.join(dir, ".cursor/hooks.json"))).toBe(false);
    // One that needs a change would lose its comments: left alone and reported.
    const moved = { ...input, mcpUrl: input.mcpUrl.replace("19090", "19091") };
    expect(writeConnectFiles(dir, moved, ["gemini"])).toEqual({ files: [], skipped: [{ agent: "gemini", file: ".gemini/settings.json", reason: "comments" }] });
    expect(fs.readFileSync(path.join(dir, ".gemini/settings.json"), "utf8")).toBe(gemini);
  });

  it("asks a repository connected before WorkBuddy's hooks existed to connect again", async () => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    writeConnectFiles(checkout, { projectName: project.name, mcpUrl: ctx.mcp.urlFor(project.id)!, eventUrl: ctx.mcp.eventUrl!, prefix: "TOM", branchTemplate: "{key}/{slug}" });
    fs.rmSync(path.join(checkout, ".codebuddy"), { recursive: true });
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "connect, as before"], checkout);
    const view = await codeLink.connection(project.id, repo.id);
    expect(view.state).toBe("unconnected");
    expect(view.agents.find((agent) => agent.id === "workbuddy")).toMatchObject({ title: "WorkBuddy", tools: true, tracking: "none", instructions: true });
    expect(view.agents.find((agent) => agent.id === "claude-code")).toMatchObject({ tools: true, tracking: "hooks" });
    expect(view.agents.find((agent) => agent.id === "pi")).toMatchObject({ title: "Pi", tools: true, tracking: "hooks", instructions: true });
    expect(view.agents.find((agent) => agent.id === "opencode")).toMatchObject({ title: "OpenCode", tools: true, tracking: "hooks", instructions: true });
    expect(view.agents.find((agent) => agent.id === "cursor")).toMatchObject({ title: "Cursor", tools: true, tracking: "hooks", instructions: true });
  });

  it.each([true, false])("still reads a repository connected before hooks ran on Windows as tracked (pane header: %s)", async (pane) => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    const input = { projectName: project.name, mcpUrl: ctx.mcp.urlFor(project.id)!, eventUrl: ctx.mcp.eventUrl!, prefix: "TOM", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(checkout, input);
    // As older Tomrades wrote them: POSIX-only commands, from before or after hooks named their herdr pane, and Cursor's script run by sh.
    for (const [file, agent] of [[".claude/settings.json", undefined], [".codebuddy/settings.json", "workbuddy"], [".codex/config.toml", "codex"]] as const) {
      const quoted = (command: string) => JSON.stringify(command).slice(1, -1);
      const text = fs.readFileSync(path.join(checkout, file), "utf8");
      expect(text).toContain(quoted(hookCommand(input.eventUrl, agent, { reply: true })));
      fs.writeFileSync(path.join(checkout, file), text.split(quoted(hookCommand(input.eventUrl, agent, { reply: true }))).join(quoted(posixHookCommand(input.eventUrl, agent, { pane }))));
    }
    fs.rmSync(path.join(checkout, ".cursor/hooks"), { recursive: true });
    fs.mkdirSync(path.join(checkout, ".cursor/hooks"));
    fs.writeFileSync(path.join(checkout, ".cursor/hooks/tomrade.sh"), `#!/bin/sh\n${posixHookCommand(input.eventUrl, "cursor", { pane })}\n`);
    const cursorHooks = path.join(checkout, ".cursor/hooks.json");
    fs.writeFileSync(cursorHooks, fs.readFileSync(cursorHooks, "utf8").split('".cursor/hooks/tomrade"').join('"sh .cursor/hooks/tomrade.sh"'));
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "connected before"], checkout);
    const view = await codeLink.connection(project.id, repo.id);
    expect(view.state).toBe("connected");
    for (const id of ["claude-code", "codex", "workbuddy", "cursor"]) expect(view.agents.find((agent) => agent.id === id)).toMatchObject({ tools: true, tracking: "hooks" });
    // Connecting again moves them all to today's commands, Cursor's onto its pair of scripts.
    writeConnectFiles(checkout, input);
    expect(fs.readFileSync(path.join(checkout, ".claude/settings.json"), "utf8")).toContain(JSON.stringify(hookCommand(input.eventUrl, undefined, { reply: true })).slice(1, -1));
    expect(fs.readFileSync(path.join(checkout, ".codex/config.toml"), "utf8")).not.toContain(JSON.stringify(posixHookCommand(input.eventUrl, "codex", { pane })).slice(1, -1));
    expect(fs.readFileSync(cursorHooks, "utf8")).not.toContain("tomrade.sh");
    expect(fs.existsSync(path.join(checkout, ".cursor/hooks/tomrade.ps1"))).toBe(true);
  });

  it.each([{ terminal: false }, { wt: false }])("still reads hooks from before they named their terminal or Windows Terminal as tracked (%o)", async (older) => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    const input = { projectName: project.name, mcpUrl: ctx.mcp.urlFor(project.id)!, eventUrl: ctx.mcp.eventUrl!, prefix: "TOM", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(checkout, input);
    for (const [file, agent] of [[".claude/settings.json", undefined], [".codebuddy/settings.json", "workbuddy"], [".codex/config.toml", "codex"]] as const) {
      const quoted = (command: string) => JSON.stringify(command).slice(1, -1);
      const text = fs.readFileSync(path.join(checkout, file), "utf8");
      expect(text).toContain("X-Tomrade-Terminal: $TERM_PROGRAM");
      fs.writeFileSync(path.join(checkout, file), text.split(quoted(hookCommand(input.eventUrl, agent, { reply: true }))).join(quoted(hookCommand(input.eventUrl, agent, older))));
    }
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "connected before terminals"], checkout);
    const view = await codeLink.connection(project.id, repo.id);
    expect(view.state).toBe("connected");
    for (const id of ["claude-code", "codex", "workbuddy"]) expect(view.agents.find((agent) => agent.id === id)).toMatchObject({ tools: true, tracking: "hooks" });
  });

  it("asks a repository connected before Cursor's hooks existed to connect again", async () => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    writeConnectFiles(checkout, { projectName: project.name, mcpUrl: ctx.mcp.urlFor(project.id)!, eventUrl: ctx.mcp.eventUrl!, prefix: "TOM", branchTemplate: "{key}/{slug}" });
    fs.rmSync(path.join(checkout, ".cursor", "hooks.json"));
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "connect, as before"], checkout);
    const view = await codeLink.connection(project.id, repo.id);
    expect(view.state).toBe("unconnected");
    expect(view.agents.find((agent) => agent.id === "cursor")).toMatchObject({ title: "Cursor", tools: true, tracking: "none" });
  });

  it("judges the connection by the chosen agents alone, so a missing opencode.json does not matter when only Claude Code and Codex are chosen", async () => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    writeConnectFiles(checkout, { projectName: project.name, mcpUrl: ctx.mcp.urlFor(project.id)!, eventUrl: ctx.mcp.eventUrl!, prefix: "TOM", branchTemplate: "{key}/{slug}" });
    fs.rmSync(path.join(checkout, "opencode.json"));
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "connect, without OpenCode's server"], checkout);
    // Nothing chosen and no agent found here: every agent counts, as before.
    expect((await codeLink.connection(project.id, repo.id)).state).toBe("unconnected");
    codeLink.setRepoPolicy(project.id, repo.id, { connectAgents: ["codex", "claude-code"] });
    const view = await codeLink.connection(project.id, repo.id);
    expect(view.state).toBe("connected");
    expect(view.agents.filter((agent) => agent.chosen).map((agent) => agent.id)).toEqual(["claude-code", "codex"]);
    expect(view.agents.find((agent) => agent.id === "opencode")).toMatchObject({ chosen: false, tools: false });
    expect(await codeLink.connect(project.id, repo.id)).toMatchObject({ committed: false, files: [], message: "Connected" });
    // Choosing OpenCode as well asks for it again; choosing none goes back to every agent.
    codeLink.setRepoPolicy(project.id, repo.id, { connectAgents: ["claude-code", "codex", "opencode"] });
    expect((await codeLink.connection(project.id, repo.id)).state).toBe("unconnected");
    expect(codeLink.setRepoPolicy(project.id, repo.id, { connectAgents: [] }).connectAgents).toBeNull();
  });

  it("chooses the agents installed here until someone chooses, and keeps what it connected for", async () => {
    const { codeLink, ctx, project, repo } = await machine();
    const engine = (id: string, available: () => Promise<{ ok: boolean; cli?: never }>) =>
      ctx.agent.engine({ id, title: id, author: `ai:${id}`, available, turn: async () => ({ stop: "end" }) });
    engine("claude-code", async () => ({ ok: true }));
    // Installed but not signed in is still found: the repository's files do not need the sign-in.
    engine("gemini", async () => ({ ok: false, cli: { state: "ready" } as never }));
    engine("pi", async () => ({ ok: false, cli: { state: "missing" } as never }));
    const view = await codeLink.connection(project.id, repo.id);
    expect(view.agents.filter((agent) => agent.chosen).map((agent) => agent.id)).toEqual(["claude-code", "gemini"]);
    const result = await codeLink.connect(project.id, repo.id);
    expect(result.files.sort()).toEqual([".claude/settings.json", ".gemini/settings.json", ".mcp.json", "CLAUDE.md"]);
    expect(result.skipped).toEqual([]);
    expect(ctx.codeLink.store.repoState(project.id, repo.id)?.connectAgents).toEqual(["claude-code", "gemini"]);
    engine("codex", async () => ({ ok: true }));
    expect((await codeLink.connection(project.id, repo.id)).state).toBe("pending");
  });

  it("connects Claude Code when opencode.json has a comment, and says OpenCode was skipped", async () => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    const own = '{\n  // the model we use\n  "model": "deepseek/deepseek-flash",\n}\n';
    fs.writeFileSync(path.join(checkout, "opencode.json"), own);
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "opencode settings"], checkout);
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], checkout);
    const result = await codeLink.connect(project.id, repo.id);
    expect(result.skipped).toEqual([{ agent: "opencode", file: "opencode.json", reason: "comments" }]);
    expect(result.files).toEqual(expect.arrayContaining([".mcp.json", ".claude/settings.json", "CLAUDE.md"]));
    expect(result.files).not.toContain("opencode.json");
    expect(result.files).not.toContain(".opencode/plugins/tomrade.js");
    git(["merge", "--ff-only", "tomrade/connect"], checkout);
    expect(fs.readFileSync(path.join(checkout, "opencode.json"), "utf8")).toBe(own);
    const view = await codeLink.connection(project.id, repo.id);
    expect(view.agents.find((agent) => agent.id === "claude-code")).toMatchObject({ tools: true, tracking: "hooks" });
    expect(view.agents.find((agent) => agent.id === "opencode")).toMatchObject({ tools: false });
    // Once the person adds the server by hand, comments and all, OpenCode counts as configured.
    fs.writeFileSync(path.join(checkout, "opencode.json"), own.replace('"model"', `"mcp": { "tomrade": { "type": "remote", "url": ${JSON.stringify(ctx.mcp.urlFor(project.id))}, }, },\n  "model"`));
    git(["commit", "-q", "-am", "tomrade by hand"], checkout);
    expect((await codeLink.connection(project.id, repo.id)).agents.find((agent) => agent.id === "opencode")).toMatchObject({ tools: true });
  });

  it("finds agent instructions in a section from before the markers, not under a heading that only starts with Tomrade", async () => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    writeConnectFiles(checkout, { projectName: project.name, mcpUrl: ctx.mcp.urlFor(project.id)!, eventUrl: ctx.mcp.eventUrl!, prefix: "TOM", branchTemplate: "{key}/{slug}" });
    fs.writeFileSync(path.join(checkout, "CLAUDE.md"), "# app\n\n### Tomrade tips\n\n## Tomrade setup\n");
    fs.writeFileSync(path.join(checkout, "AGENTS.md"), "# app\n\n## Tomrade\n\nold words\n");
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "connect, as before"], checkout);
    const view = await codeLink.connection(project.id, repo.id);
    expect(view.agents.find((agent) => agent.id === "claude-code")).toMatchObject({ instructions: false });
    expect(view.agents.find((agent) => agent.id === "codex")).toMatchObject({ instructions: true });
  });

  it("keeps the branch and explains push-off, push failure and local merge", async () => {
    const { codeLink, project, repo, checkout } = await machine();
    codeLink.setRepoPolicy(project.id, repo.id, { agentPush: false });
    expect(await codeLink.connect(project.id, repo.id)).toMatchObject({ pushed: false, committed: true, message: expect.stringContaining("Pushing is off") });
    codeLink.setRepoPolicy(project.id, repo.id, { agentPush: true });
    git(["remote", "set-url", "origin", path.join(root, "missing.git")], checkout);
    expect(await codeLink.connect(project.id, repo.id)).toMatchObject({ pushed: false, committed: false, message: expect.stringContaining("pushing failed") });
    git(["remote", "remove", "origin"], checkout);
    expect(await codeLink.connect(project.id, repo.id)).toMatchObject({ pushed: false, message: expect.stringContaining("merge it into main locally") });
    expect(git(["branch", "--show-current"], checkout)).toBe("main");
  });

  it("refuses to connect while another program holds its port, and writes nothing", async () => {
    const { codeLink, ctx, project, repo, checkout, remote } = await machine();
    // As if 19090 was taken at startup: this instance listens on a random port that the next restart changes.
    ctx.mcp.clash = { port: 19090, heldBy: { app: "tomrade", kind: "packaged", version: "1.2.3", pid: 4242 } };
    expect(await codeLink.connection(project.id, repo.id)).toMatchObject({ state: "unconnected", clash: { port: 19090, heldBy: { kind: "packaged" } } });
    await expect(codeLink.connect(project.id, repo.id)).rejects.toThrow("port 19090 is held by the installed Tomrade 1.2.3 (pid 4242)");
    ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
    await expect(codeLink.connect(project.id, repo.id)).rejects.toThrow("19090 端口被正式版 1.2.3（进程 4242）占用");
    // A port Windows reserves: no one to quit, only another port.
    ctx.mcp.clash = { port: 19090, heldBy: null, reserved: true };
    await expect(codeLink.connect(project.id, repo.id)).rejects.toThrow("Windows 保留了 19090 端口");
    ctx.settings.set({ ...ctx.settings.get(), language: "en" });
    await expect(codeLink.connect(project.id, repo.id)).rejects.toThrow(/Windows reserves port 19090 .*TOMRADE_MCP_PORT to a port outside the reserved ranges/);
    expect(git(["branch", "--list", "tomrade/connect"], checkout)).toBe("");
    expect(git(["ls-remote", "--heads", remote, "tomrade/connect"], checkout)).toBe("");
    expect(git(["worktree", "list"], checkout).split("\n")).toHaveLength(1);
    expect(fs.existsSync(path.join(checkout, ".mcp.json"))).toBe(false);
    expect(git(["status", "--porcelain"], checkout)).toBe("");
  });

  it("says why Pi's extension was left out while Pi's engine is off", async () => {
    const { codeLink, project, repo } = await machine();
    // Registered again and let go: no writer for Pi, as with its engine turned off.
    codeLink.registerConnector("pi", piConnector)();
    codeLink.setRepoPolicy(project.id, repo.id, { connectAgents: ["claude-code", "pi"] });
    const result = await codeLink.connect(project.id, repo.id, "local");
    expect(result.skipped).toEqual([{ agent: "pi", file: ".pi/extensions/tomrade.ts", reason: "no-connector", message: ".pi/extensions/tomrade.ts skipped: Pi's engine writes it, and that engine is turned off. Turn it on and connect again." }]);
    expect(result.files).not.toContain(".pi/extensions/tomrade.ts");
  });

  it("connects for this machine only: files in the checkout kept out of git, a tracked file untouched and its agent skipped, and sessions report with no pull request", async () => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    // A Cursor server the team committed: a machine-only connection cannot change it.
    fs.mkdirSync(path.join(checkout, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(checkout, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { team: { command: "x" } } }));
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "the team's cursor server"], checkout);
    codeLink.setRepoPolicy(project.id, repo.id, { connectAgents: ["claude-code", "codex", "cursor"] });
    const result = await codeLink.connect(project.id, repo.id, "local");
    expect(result).toMatchObject({ local: true, committed: false, pushed: false, url: null, branch: "" });
    expect(result.files.sort()).toEqual([".agents/skills/tomrade-sync/SKILL.md", ".claude/settings.local.json", ".codex/config.toml", ".mcp.json", "AGENTS.md"]);
    expect(result.skipped).toEqual([{ agent: "cursor", file: ".cursor/mcp.json", reason: "tracked" }]);
    expect(result.message).toContain("this machine only");
    // Nothing for git to see: the files are excluded in this clone; the tracked one, the instructions and the team's settings file are untouched.
    expect(git(["status", "--porcelain"], checkout)).toBe("");
    expect(fs.readFileSync(path.join(checkout, ".git/info/exclude"), "utf8")).toContain("# Tomrade: agent connection files for this machine only\n/.mcp.json\n/.codex/config.toml\n");
    // Ignored either by Tomrade's exclude or already by this machine's global git excludes (Claude Code adds one when it writes the file).
    expect(git(["check-ignore", ".claude/settings.local.json"], checkout)).toBe(".claude/settings.local.json");
    expect(fs.readFileSync(path.join(checkout, ".cursor/mcp.json"), "utf8")).not.toContain("tomrade");
    // The team's CLAUDE.md is tracked, so it stays theirs; AGENTS.md is new, untracked and excluded, so the agent reads the rules.
    expect(fs.readFileSync(path.join(checkout, "CLAUDE.md"), "utf8")).not.toContain("Tomrade");
    expect(fs.readFileSync(path.join(checkout, "AGENTS.md"), "utf8")).toContain("call `work_without_ticket` with their words");
    expect(fs.existsSync(path.join(checkout, ".claude/settings.json"))).toBe(false);
    expect(git(["branch", "--list", "tomrade/connect"], checkout)).toBe("");
    // Claude Code loads the server without asking, and its hooks post from its personal settings file.
    const settings = JSON.parse(fs.readFileSync(path.join(checkout, ".claude/settings.local.json"), "utf8")) as { enabledMcpjsonServers: string[]; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.enabledMcpjsonServers).toEqual(["tomrade"]);
    expect(settings.hooks.SessionStart[0]!.hooks[0]!.command).toContain(ctx.mcp.eventUrl);
    // Cursor was skipped, so with it chosen the repository is not connected; without it, it is — on this machine alone.
    expect((await codeLink.connection(project.id, repo.id)).state).toBe("unconnected");
    codeLink.setRepoPolicy(project.id, repo.id, { connectAgents: ["claude-code", "codex"] });
    const view = await codeLink.connection(project.id, repo.id);
    expect(view).toMatchObject({ state: "connected", local: true, configuredUrl: ctx.mcp.urlFor(project.id) });
    expect(view.agents.find((agent) => agent.id === "claude-code")).toMatchObject({ tools: true, tracking: "hooks", instructions: false });
    expect(view.agents.find((agent) => agent.id === "codex")).toMatchObject({ tools: true, tracking: "hooks" });
    // Connecting again is how an earlier connection gains the files a newer Tomrade writes; nothing changes in git.
    expect(await codeLink.connect(project.id, repo.id, "local")).toMatchObject({ local: true, branch: "", committed: false, pushed: false });
    expect(git(["status", "--porcelain"], checkout)).toBe("");
    // A Codex session in the checkout reports through the excluded hooks, with no pull request anywhere.
    await fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-Agent": "codex" }, body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "codex-1", cwd: checkout }) });
    expect(codeLink.sessionsOf(project.id)).toEqual([expect.objectContaining({ agent: "codex", externalId: "codex-1", repoId: repo.id, state: "running" })]);
    // The team's connection is still open from a machine-only one, on its own branch as ever.
    expect(await codeLink.connect(project.id, repo.id)).toMatchObject({ committed: true, pushed: true, branch: "tomrade/connect" });
    expect(git(["status", "--porcelain"], checkout)).toBe("");
  });

  it("takes the same project committed on another port as connected to that Tomrade, never a reason to reconnect", async () => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    const mcpUrl = ctx.mcp.urlFor(project.id)!;
    const port = new URL(mcpUrl).port;
    const other = (url: string) => url.replace(`:${port}/`, `:${Number(port) + 1}/`);
    writeConnectFiles(checkout, { projectName: project.name, mcpUrl: other(mcpUrl), eventUrl: other(ctx.mcp.eventUrl!), prefix: "TOM", branchTemplate: "{key}/{slug}" });
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "connected to the development build"], checkout);
    const view = await codeLink.connection(project.id, repo.id);
    expect(view).toMatchObject({ state: "connected", configuredUrl: other(mcpUrl) });
    expect(view.local).toBeUndefined();
    expect(view.agents.filter((agent) => agent.chosen).map((agent) => [agent.tools, agent.tracking === "hooks" || agent.id === "gemini"])).toEqual(Array(7).fill([true, true]));
    expect(await codeLink.connect(project.id, repo.id)).toMatchObject({ committed: false, files: [], message: "Connected" });
    expect(git(["branch", "--list", "tomrade/connect"], checkout)).toBe("");
  });

  it("updates all Tomrade hooks when connecting to another instance", () => {
    const dir = path.join(root, `reconnect-${n++}`);
    fs.mkdirSync(dir);
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(dir, input);
    const next = { ...input, mcpUrl: input.mcpUrl.replace("19090", "19091"), eventUrl: input.eventUrl.replace("19090", "19091") };
    expect(writeConnectFiles(dir, next).files).toContain(".claude/settings.json");
    const hooks = fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8");
    expect(hooks).not.toContain("19090");
    expect(hooks).toContain(next.eventUrl);
    // Cursor's command moves to the new address in place.
    for (const script of [".cursor/hooks/tomrade", ".cursor/hooks/tomrade.ps1"]) {
      const cursor = fs.readFileSync(path.join(dir, script), "utf8");
      expect(cursor).toContain(next.eventUrl);
      expect(cursor).not.toContain("19090");
    }
    expect(writeConnectFiles(dir, next).files).toEqual([]);
  });

  it("commits them on a branch of their own and pushes it, leaving the checkout alone", async () => {
    const { codeLink, project, repo, checkout, remote } = await machine();
    // As on Windows, where git records no executable bit from the disk.
    git(["config", "core.fileMode", "false"], checkout);
    const result = await codeLink.connect(project.id, repo.id);
    // gh is signed out here, so no pull request: the branch is pushed for the person to open one.
    expect(result).toMatchObject({ branch: "tomrade/connect", committed: true, pushed: true, url: null });
    expect(result.files.sort()).toEqual([".agents/skills/tomrade-sync/SKILL.md", ".claude/settings.json", ".codebuddy/settings.json", ".codex/config.toml", ".cursor/hooks.json", ".cursor/hooks/tomrade", ".cursor/hooks/tomrade.ps1", ".cursor/mcp.json", ".gemini/settings.json", ".mcp.json", ".opencode/plugins/tomrade.js", ".pi/extensions/tomrade.ts", "AGENTS.md", "CLAUDE.md", "opencode.json"]);
    // The remote has the branch with the files; the user's checkout was never touched.
    expect(git(["ls-remote", "--heads", remote, "tomrade/connect"], checkout)).toMatch(/tomrade\/connect/);
    git(["fetch", "-q", "origin"], checkout);
    expect(git(["show", "origin/tomrade/connect:.mcp.json"], checkout)).toContain("/mcp/");
    expect(git(["show", "origin/tomrade/connect:.codex/config.toml"], checkout)).toContain("mcp_servers.tomrade");
    // Cursor runs the POSIX script by its path, so it is committed executable even so.
    expect(git(["ls-tree", "origin/tomrade/connect", "--", ".cursor/hooks/tomrade"], checkout)).toMatch(/^100755 /);
    expect(fs.existsSync(path.join(checkout, ".mcp.json"))).toBe(false);
    expect(git(["status", "--porcelain"], checkout)).toBe("");
  });

  it("fills in an installed agent's hooks as soon as it and the checkout are both known, with nobody pressing Connect", async () => {
    const { ctx, project, repo, checkout } = await machine();
    // No coding agent is installed here yet, so the checkout alone writes nothing.
    await settle();
    expect(fs.existsSync(path.join(checkout, ".codebuddy/settings.json"))).toBe(false);
    await ctx.plugin({ name: "fake-workbuddy", inject: ["agent"], apply: (c: Context) => void c.agent.engine(installed("workbuddy")) });
    const file = path.join(checkout, ".codebuddy/settings.json");
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true), { timeout: 5000 });
    const command = (JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks.PreToolUse![0]!.hooks[0]!.command;
    expect(command).toContain("/sessions/event");
    expect(command).toContain("X-Tomrade-Agent: workbuddy");
    // A file for this machine only: git does not see it, and nothing else in the checkout changed.
    const exclude = path.join(checkout, ".git/info/exclude");
    await vi.waitFor(() => expect(fs.readFileSync(exclude, "utf8")).toContain("/.codebuddy/settings.json"), { timeout: 5000 });
    expect(git(["status", "--porcelain"], checkout)).toBe("");
    expect(project.id).toBeTruthy();
    expect(repo.remote).toBeTruthy();
  });

  it("commits a file a machine-only connection had excluded, once the team's connection is asked for", async () => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    await ctx.plugin({ name: "fake-workbuddy-team", inject: ["agent"], apply: (c: Context) => void c.agent.engine(installed("workbuddy")) });
    await vi.waitFor(() => expect(fs.existsSync(path.join(checkout, ".codebuddy/settings.json"))).toBe(true), { timeout: 5000 });
    const result = await codeLink.connect(project.id, repo.id);
    expect(result.files).toContain(".codebuddy/settings.json");
    git(["fetch", "-q", "origin"], checkout);
    expect(git(["show", "origin/tomrade/connect:.codebuddy/settings.json"], checkout)).toContain("/sessions/event");
  });

  it("opens the pull request with gh, and leaves the branch pushed when gh is rate-limited or offline", async () => {
    const { codeLink, project, repo } = await machine();
    onTestFinished(() => gh.reset());
    const pull = "https://github.com/example/app/pull/7";
    gh.answer("pr create", { stdout: pull });
    expect(await codeLink.connect(project.id, repo.id)).toMatchObject({ pushed: true, url: pull, message: expect.stringContaining("Pull request opened") });
    expect(gh.calls.at(-1)).toEqual(["pr", "create", "--head", "tomrade/connect", "--base", "main", "--title", "Connect this repository to Tomrade", "--body", expect.stringContaining(".mcp.json")]);
    gh.answer("pr create", "rate-limited");
    gh.answer("pr view", "offline");
    // A remote GitHub does not host has no compare page either.
    expect(await codeLink.connect(project.id, repo.id)).toMatchObject({ pushed: true, url: null, message: expect.stringContaining("tomrade/connect pushed") });
    expect(gh.calls.slice(-2).map((call) => call.slice(0, 2).join(" "))).toEqual(["pr create", "pr view"]);
  });

  it("says in its commit and pull request only what it connected, never an agent it left out", async () => {
    const { codeLink, project, repo, checkout } = await machine();
    onTestFinished(() => gh.reset());
    gh.answer("pr create", { stdout: "https://github.com/example/app/pull/8" });
    // Pi's engine is off: its extension is left out.
    codeLink.registerConnector("pi", piConnector)();
    codeLink.setRepoPolicy(project.id, repo.id, { connectAgents: ["claude-code", "codex", "pi"] });
    const result = await codeLink.connect(project.id, repo.id);
    expect(result.skipped.map((skip) => skip.agent)).toEqual(["pi"]);
    const said = "Project config lets Claude Code and Codex reach Tomrade's MCP server. Claude Code and Codex report session lifecycle back. Agent instructions describe the ticket conventions.";
    git(["fetch", "-q", "origin"], checkout);
    expect(git(["log", "-1", "--format=%B", "origin/tomrade/connect"], checkout)).toBe(`Connect this repository to Tomrade\n\n${said}`);
    expect(gh.calls.at(-1)!.at(-1)).toBe(`Adds ${result.files.join(", ")}. ${said} Review Codex hooks with /hooks after merging.`);
    expect(git(["show", "origin/tomrade/connect:AGENTS.md"], checkout)).not.toContain("Pi");
  });
});

describe("an agent's own connection", () => {
  /** A stand-in agent whose user-level configuration is the only way it reaches Tomrade (Cursor, Antigravity, Hermes). */
  const agent = (ctx: Awaited<ReturnType<typeof machine>>["ctx"], state: { value: "unavailable" | "missing" | "stale" | "connected"; connects: number }) => {
    const configuredUrl = () => (state.value === "connected" ? ctx.mcp.url : state.value === "stale" ? "http://127.0.0.1:19090/mcp" : null);
    const view = () => ({ state: state.value, url: ctx.mcp.url, configuredUrl: configuredUrl(), file: "/home/dev/.agent.json", manual: { connect: "connect", disconnect: "disconnect" } });
    return {
      available: async () => ({ ok: true }),
      turn: async () => ({ stop: "end" as const }),
      mcpLink: {
        status: async () => view(),
        connect: async () => { state.connects += 1; state.value = "connected"; return view(); },
        disconnect: async () => view()
      }
    };
  };

  it("is made as soon as the engine registers, without anyone pressing Connect", async () => {
    const { ctx } = await machine();
    const state = { value: "missing" as const, connects: 0 };
    ctx.agent.engine({ id: "linked-agent", title: "Linked Agent", author: "ai:linked-agent", capabilities: ["code"], ...agent(ctx, state) });
    await until(() => state.connects === 1);
    expect(state.value).toBe("connected");
  });

  it("is left alone by a run told not to link agents (a UI check), whatever the agent says", async () => {
    // As tomrade.yml hands it over: a string.
    const { ctx } = await machine({ linkAgents: "false" });
    const state = { value: "missing" as const, connects: 0 };
    ctx.agent.engine({ id: "linked-agent", title: "Linked Agent", author: "ai:linked-agent", capabilities: ["code"], ...agent(ctx, state) });
    ctx.emit("agent/engine-tried", "linked-agent", { ok: true, ms: 12, at: Date.now() });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state).toEqual({ value: "missing", connects: 0 });
  });

  it("is written again over a stale one by default, as the installed app repairs its own", async () => {
    const { ctx } = await machine();
    const state: { value: "stale" | "connected"; connects: number } = { value: "stale", connects: 0 };
    ctx.agent.engine({ id: "linked-agent", title: "Linked Agent", author: "ai:linked-agent", capabilities: ["code"], ...agent(ctx, state) });
    await until(() => state.connects === 1);
    expect(state.value).toBe("connected");
  });

  it("is only filled in, never taken over, by a run linking missing ones (a checkout beside the installed app)", async () => {
    const { ctx } = await machine({ linkAgents: "missing" });
    // Linked to the installed app: left as it is.
    const taken = { value: "stale" as const, connects: 0 };
    ctx.agent.engine({ id: "linked-agent", title: "Linked Agent", author: "ai:linked-agent", capabilities: ["code"], ...agent(ctx, taken) });
    // Linked to nothing: this run fills it in.
    const free: { value: "missing" | "connected"; connects: number } = { value: "missing", connects: 0 };
    ctx.agent.engine({ id: "free-agent", title: "Free Agent", author: "ai:free-agent", capabilities: ["code"], ...agent(ctx, free) });
    await until(() => free.connects === 1);
    ctx.emit("agent/engine-tried", "linked-agent", { ok: true, ms: 12, at: Date.now() });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(taken).toEqual({ value: "stale", connects: 0 });
    expect(free.value).toBe("connected");
  });

  it("is made once a test message says the agent works, when its first attempt was too early", async () => {
    const { ctx } = await machine();
    const state: { value: "unavailable" | "missing" | "connected"; connects: number } = { value: "unavailable", connects: 0 };
    ctx.agent.engine({ id: "late-agent", title: "Late Agent", author: "ai:late-agent", capabilities: ["code"], ...agent(ctx, state) });
    await settle();
    expect(state.connects).toBe(0);
    // The MCP server is up now and a test message came back: link it.
    state.value = "missing";
    ctx.emit("agent/engine-tried", "late-agent", { ok: true, ms: 12, at: Date.now() });
    await until(() => state.connects === 1);
    expect(state.value).toBe("connected");
  });
});

describe("a ticket an agent files for itself", () => {
  // A hook is posted and those it creates are waited for: the same conversation may have rows already.
  const start = async (ctx: Awaited<ReturnType<typeof machine>>["ctx"], projectId: string, cwd: string, id: string, rows = 1) => {
    await fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd }) });
    await until(() => ctx.codeLink.sessionsOf(projectId).length >= rows);
  };

  it("joins the one terminal session that holds nothing, so the sidebar names it and its calls land there", async () => {
    const { ctx, codeLink, project, checkout } = await machine();
    await start(ctx, project.id, checkout, "cli-1");
    const [session] = codeLink.sessionsOf(project.id);
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-a" };
    const filed = (await ctx.tools.execute("create_item", { title: "Write the README" }, inv)) as { id: string; key: string };
    // The row reads the ticket's key and title from the session's ticket, so the sidebar shows them at once.
    expect(codeLink.sessionsOf(project.id, filed.id).map((s) => s.id)).toEqual([session!.id]);
    expect(await ctx.tools.execute("note_progress", { key: filed.key, text: "written" }, inv)).toMatchObject({ ok: true });
  });

  it("leaves an epic it files alone, and a ticket it only filed does not stop it claiming another", async () => {
    const { ctx, codeLink, project, checkout } = await machine();
    await start(ctx, project.id, checkout, "cli-1");
    const [session] = codeLink.sessionsOf(project.id);
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-a" };
    const epic = (await ctx.tools.execute("create_item", { title: "Session records", kind: "epic" }, inv)) as { id: string };
    expect(codeLink.sessionsOf(project.id, epic.id)).toEqual([]);
    // Planning: the first ticket filed joins the session, the next ones do not.
    const filed = (await ctx.tools.execute("create_item", { title: "Readers as plugins", parentId: epic.id }, inv)) as { id: string; key: string };
    const later = (await ctx.tools.execute("create_item", { title: "Whole records", parentId: epic.id }, inv)) as { id: string; key: string };
    expect(codeLink.sessionsOf(project.id, filed.id).map((s) => s.id)).toEqual([session!.id]);
    // Its hooks say it is the one claiming, as Claude Code's PreToolUse does.
    const claiming = (key: string) =>
      fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "cli-1", cwd: checkout, tool_name: "mcp__tomrade__claim_ticket", tool_input: { key } }) });
    // Claiming another of them moves the session there, no parallel needed; the one only filed stays in the backlog.
    await claiming(later.key);
    expect(await ctx.tools.execute("claim_ticket", { key: later.key }, inv)).toMatchObject({ key: later.key, status: "doing", tracking: { tracked: true, sessionId: session!.id } });
    expect(codeLink.sessionsOf(project.id, filed.id)).toEqual([]);
    expect(ctx.items.get(project.id, filed.id)?.status).toBe("backlog");
    // A ticket it claimed is still owed its wrap-up.
    const next = (await ctx.tools.execute("create_item", { title: "Snapshots", parentId: epic.id }, inv)) as { key: string };
    await claiming(next.key);
    await expect(ctx.tools.execute("claim_ticket", { key: next.key }, inv)).rejects.toThrow(`this session still owns ${later.key}, which is doing`);
  });

  it("leaves two free sessions alone: nothing says whose ticket it is, and the agent's own claim decides", async () => {
    const { ctx, codeLink, project, checkout } = await machine();
    await start(ctx, project.id, checkout, "cli-1");
    await start(ctx, project.id, checkout, "cli-2");
    expect(codeLink.sessionsOf(project.id)).toHaveLength(2);
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-a" };
    const filed = (await ctx.tools.execute("create_item", { title: "Write the README" }, inv)) as { id: string };
    expect(codeLink.sessionsOf(project.id, filed.id)).toEqual([]);
  });

  it("gives a ticket filed by a conversation already working one to nobody, though another session on the repository holds nothing", async () => {
    const { ctx, codeLink, project, board, items, checkout } = await machine();
    await start(ctx, project.id, checkout, "cli-1");
    await start(ctx, project.id, checkout, "cli-2", 2);
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const claiming = (key: string) => post({ hook_event_name: "PreToolUse", session_id: "cli-1", cwd: checkout, tool_name: "mcp__tomrade__claim_ticket", tool_input: { key } });
    const working = items.create({ projectId: project.id, boardId: board.id, title: "Earlier work", by: "human" });
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-a" };
    await claiming(working.key);
    await ctx.tools.execute("claim_ticket", { key: working.key }, inv);
    // Filed by cli-1, which works a ticket: a follow-up of its own, not cli-2's next ticket.
    const filed = (await ctx.tools.execute("create_item", { title: "Follow-up found on the way" }, inv)) as { id: string; key: string };
    expect(codeLink.sessionsOf(project.id, filed.id)).toEqual([]);
    // Its own claim, alongside the ticket it works, is not refused as someone else's.
    await claiming(filed.key);
    const claimed = await ctx.tools.execute("claim_ticket", { key: filed.key, parallel: true }, inv);
    expect(claimed).toMatchObject({ key: filed.key, status: "doing" });
    expect(codeLink.sessionsOf(project.id, filed.id).map((s) => s.externalId)).toEqual(["cli-1"]);
  });

  it("takes the filer from its hooks when its connection has claimed nothing yet", async () => {
    const { ctx, codeLink, project, checkout } = await machine();
    await start(ctx, project.id, checkout, "cli-1");
    await start(ctx, project.id, checkout, "cli-2", 2);
    const second = codeLink.sessionsOf(project.id).find((s) => s.externalId === "cli-2")!;
    // As Claude Code's PreToolUse announces the call before it reaches the MCP server.
    await fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "cli-2", cwd: checkout, tool_name: "mcp__tomrade__create_item", tool_input: { title: "Write the README" } }) });
    const filed = (await ctx.tools.execute("create_item", { title: "Write the README" }, { by: "ai:mcp" as const, projectId: project.id, connection: "conn-b" })) as { id: string };
    expect(codeLink.sessionsOf(project.id, filed.id).map((s) => s.id)).toEqual([second.id]);
  });

  it("claims the row its conversation opened last, not the one the connection was bound to before", async () => {
    const { ctx, codeLink, project, board, items, checkout } = await machine();
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await post({ hook_event_name: "SessionStart", session_id: "cli-1", cwd: checkout });
    await until(() => codeLink.sessionsOf(project.id).length === 1);
    const older = codeLink.sessionsOf(project.id)[0]!;
    const first = items.create({ projectId: project.id, boardId: board.id, title: "Earlier work", by: "human" });
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-a" };
    // The connection is bound to that row; then the CLI comes back under the same id in a new row — what a restart
    // leaves behind — and Start's row for the next ticket is the one the person is looking at.
    expect(await ctx.tools.execute("claim_ticket", { key: first.key }, inv)).toMatchObject({ tracking: { sessionId: older.id } });
    codeLink.store.createSession(project.id, { repoId: older.repoId, branch: "", itemIds: [], mode: "terminal", agent: older.agent, threadId: null, device: older.device, externalId: "cli-1" });
    const newer = codeLink.sessionsOf(project.id).find((s) => s.id !== older.id)!;
    const second = items.create({ projectId: project.id, boardId: board.id, title: "New work", by: "human" });
    const claimed = (await ctx.tools.execute("claim_ticket", { key: second.key }, inv)) as { tracking: { tracked: boolean; sessionId: string } };
    expect(claimed.tracking).toMatchObject({ tracked: true, sessionId: newer.id });
    // The older row keeps the ticket it had: nothing was taken from it, the new claim simply went to the new row.
    expect(codeLink.sessionsOf(project.id, first.id).map((s) => s.id)).toEqual([older.id]);
    // And the calls that name it land there, not on the row it left behind.
    expect(await ctx.tools.execute("note_progress", { key: second.key, text: "started" }, inv)).toMatchObject({ ok: true });
    expect(codeLink.sessionsOf(project.id, second.id).map((s) => [s.id, s.summary])).toEqual([[newer.id, "started"]]);
  });
});

describe("an outside session before it claims", () => {
  it("hears at start that it holds no ticket, is held at its first code change, and goes on after a claim or the person's word", async () => {
    const { ctx, codeLink, items, project, board, checkout } = await machine();
    const post = async (payload: Record<string, unknown>) =>
      (await fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-Agent": "codex" }, body: JSON.stringify({ session_id: "cx-1", cwd: checkout, ...payload }) })).json() as Promise<Record<string, unknown>>;
    expect(await post({ hook_event_name: "SessionStart" })).toMatchObject({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: expect.stringContaining("holds no ticket") } });
    await until(() => codeLink.sessionsOf(project.id).length === 1);
    // Reading is free; the first edit, and a commit, are held with both ways on in the reason.
    expect(await post({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(checkout, "README.md") } })).toEqual({});
    const held = (await post({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch" } })) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(held.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(held.hookSpecificOutput.permissionDecisionReason).toContain("claim_ticket");
    expect(held.hookSpecificOutput.permissionDecisionReason).toContain("work_without_ticket");
    expect(await post({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -am x" } })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    // A file outside the checkout is not the repository's code.
    expect(await post({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(os.tmpdir(), "scratch.txt") } })).toEqual({});
    // The person's word: the call, announced by the hook before it, lands on this session and lets it go on.
    await post({ hook_event_name: "PreToolUse", tool_name: "mcp__tomrade__work_without_ticket", tool_input: { reason: "just try it here" } });
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-x" };
    expect(await ctx.tools.execute("work_without_ticket", { reason: "just try it here" }, inv)).toMatchObject({ recorded: true });
    expect(codeLink.sessionsOf(project.id)[0]).toMatchObject({ withoutTicket: "just try it here" });
    expect(await post({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(checkout, "README.md") } })).toEqual({});
    // A claim takes the word back: the session is on a ticket now, and says nothing more at start.
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Real work", by: "human" });
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, inv)).toMatchObject({ tracking: { tracked: true } });
    expect(codeLink.sessionsOf(project.id)[0]).toMatchObject({ withoutTicket: null, itemIds: [item.id] });
    expect(await post({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(checkout, "README.md") } })).toEqual({});
    expect(await post({ hook_event_name: "SessionStart" })).toEqual({});
  });

  it("guesses its ticket once, from what the person first said, and takes the person's answer: that ticket, or none", async () => {
    const { ctx, codeLink, items, project, board, checkout } = await machine();
    const archive = items.create({ projectId: project.id, boardId: board.id, title: "Filter the archive by agent", by: "human" });
    const search = items.create({ projectId: project.id, boardId: board.id, title: "Search the archive's conversations", by: "human" });
    // find_similar's own answer shape; what it finds is this test's, so the guess is what is under test.
    const asked: string[] = [];
    ctx.tools.register(
      defineTool({
        name: "find_similar",
        title: "Find similar items",
        description: "stub",
        input: z.object({ title: z.string().optional(), body: z.string().optional(), titles: z.array(z.string()).optional(), limit: z.number().optional() }),
        execute: ({ title }) => {
          asked.push(title ?? "");
          const hit = /filter/i.test(title ?? "") ? archive : /search/i.test(title ?? "") ? search : null;
          return hit ? { verdict: "related", matches: [{ id: hit.id, key: hit.key, title: hit.title, kind: "ticket", status: hit.status, score: 0.5, reason: "similar title" }] } : { verdict: "none", matches: [] };
        }
      })
    );
    const post = async (id: string, payload: Record<string, unknown>) =>
      (await fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-Agent": "codex" }, body: JSON.stringify({ session_id: id, cwd: checkout, ...payload }) })).json() as Promise<Record<string, unknown>>;
    const sessionOf = (id: string) => codeLink.sessionsOf(project.id).find((s) => s.externalId === id)!;

    // Its first words sound like a ticket: that one is offered, from the first sentence or two only, and asked once.
    await post("cx-1", { hook_event_name: "SessionStart" });
    await post("cx-1", { hook_event_name: "UserPromptSubmit", prompt: "Let the archive filter by agent. Codex and Claude apart. And more after that, which is not read." });
    await until(() => !!codeLink.guessOf(project.id, sessionOf("cx-1").id));
    expect(codeLink.guessOf(project.id, sessionOf("cx-1").id)).toMatchObject({ itemId: archive.id, key: archive.key });
    expect(asked).toEqual(["Let the archive filter by agent. Codex and Claude apart."]);
    await post("cx-1", { hook_event_name: "UserPromptSubmit", prompt: "filter it, I said" });
    await settle();
    expect(asked).toHaveLength(1);

    // Nothing like it, or a slash command: nothing offered.
    await post("cx-2", { hook_event_name: "SessionStart" });
    await post("cx-2", { hook_event_name: "UserPromptSubmit", prompt: "What does this repository do?" });
    await until(() => asked.length === 2);
    await settle();
    expect(codeLink.guessOf(project.id, sessionOf("cx-2").id)).toBeNull();
    await post("cx-4", { hook_event_name: "SessionStart" });
    await post("cx-4", { hook_event_name: "UserPromptSubmit", prompt: "/clear" });
    await settle();
    expect(asked).toHaveLength(2);

    // Taken: the session works the ticket now, which is Doing; its agent hears at its next step to claim it, and the claim lands there.
    const first = sessionOf("cx-1");
    expect(codeLink.takeGuess(project.id, first.id)).toEqual({ key: archive.key });
    expect(sessionOf("cx-1").itemIds).toEqual([archive.id]);
    expect(items.get(project.id, archive.id)?.status).toBe("doing");
    expect(codeLink.guessOf(project.id, first.id)).toBeNull();
    expect(codeLink.takeGuess(project.id, first.id)).toBeNull();
    expect(await post("cx-1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(checkout, "README.md") } })).toEqual({});
    const told = await post("cx-1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_output: "ok" });
    expect(told).toMatchObject({ additionalContext: expect.stringContaining(`claim_ticket("${archive.key}")`) });
    expect(await post("cx-1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_output: "ok" })).toEqual({});
    await post("cx-1", { hook_event_name: "PreToolUse", tool_name: "mcp__tomrade__claim_ticket", tool_input: { key: archive.key } });
    const claimed = (await ctx.tools.execute("claim_ticket", { key: archive.key }, { by: "ai:mcp", projectId: project.id, connection: "conn-g" })) as { tracking: { sessionId: string }; branch: string };
    expect(claimed.tracking.sessionId).toBe(first.id);
    expect(sessionOf("cx-1").branch).toBe(claimed.branch);

    // Gone without: recorded as the person's word, so its edits are not held; no guess is left to offer.
    await post("cx-3", { hook_event_name: "SessionStart" });
    await post("cx-3", { hook_event_name: "UserPromptSubmit", prompt: "Search the archive for what was said" });
    await until(() => !!codeLink.guessOf(project.id, sessionOf("cx-3").id));
    expect(codeLink.goWithoutTicket(project.id, sessionOf("cx-3").id, "no ticket, said in the Terminal window")).toBe(true);
    expect(sessionOf("cx-3")).toMatchObject({ withoutTicket: "no ticket, said in the Terminal window", itemIds: [] });
    expect(codeLink.guessOf(project.id, sessionOf("cx-3").id)).toBeNull();
    expect(await post("cx-3", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(checkout, "README.md") } })).toEqual({});
  });

  it("names the other live session in the same folder when a ticket is claimed there", async () => {
    const { ctx, codeLink, items, project, board, checkout } = await machine();
    const post = (id: string, payload: Record<string, unknown>) =>
      fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: id, cwd: checkout, ...payload }) });
    await post("cli-1", { hook_event_name: "SessionStart" });
    await post("cli-2", { hook_event_name: "SessionStart" });
    await until(() => codeLink.sessionsOf(project.id).length === 2);
    const first = items.create({ projectId: project.id, boardId: board.id, title: "First", by: "human" });
    const second = items.create({ projectId: project.id, boardId: board.id, title: "Second", by: "human" });
    await post("cli-1", { hook_event_name: "PreToolUse", tool_name: "mcp__tomrade__claim_ticket", tool_input: { key: first.key } });
    const one = (await ctx.tools.execute("claim_ticket", { key: first.key }, { by: "ai:mcp", projectId: project.id, connection: "conn-1" })) as { sharedCheckout?: unknown[]; conventions: string[] };
    expect(one.sharedCheckout).toHaveLength(1);
    expect(one.conventions[0]).toContain("git worktree add");
    await post("cli-2", { hook_event_name: "PreToolUse", tool_name: "mcp__tomrade__claim_ticket", tool_input: { key: second.key } });
    const two = (await ctx.tools.execute("claim_ticket", { key: second.key }, { by: "ai:mcp", projectId: project.id, connection: "conn-2" })) as { sharedCheckout?: { tickets: string[] }[] };
    expect(two.sharedCheckout?.map((s) => s.tickets)).toEqual([[first.key]]);
  });
});

describe("an MCP client that names its pane", () => {
  it("writes the pane header into every agent's server entry, and a claim over such a connection lands on that pane", async () => {
    const { ctx, codeLink, items, project, board, checkout } = await machine();
    const input = { projectName: project.name, mcpUrl: ctx.mcp.urlFor(project.id)!, eventUrl: ctx.mcp.eventUrl!, prefix: "TOM", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(checkout, input);
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(checkout, name), "utf8")) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
    expect(read(".mcp.json").mcpServers.tomrade!.headers).toEqual({ "X-Tomrade-Herdr-Pane": "${HERDR_PANE_ID}" });
    expect(read(".gemini/settings.json").mcpServers.tomrade!.headers).toEqual({ "X-Tomrade-Herdr-Pane": "${HERDR_PANE_ID}" });
    expect(read(".cursor/mcp.json").mcpServers.tomrade!.headers).toEqual({ "X-Tomrade-Herdr-Pane": "${env:HERDR_PANE_ID}" });
    expect(fs.readFileSync(path.join(checkout, ".codex/config.toml"), "utf8")).toContain('env_http_headers = { "X-Tomrade-Herdr-Pane" = "HERDR_PANE_ID" }');
    // Gemini CLI has no hooks: its claim is followed through its connection, and the pane its headers named is the session's.
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Gemini work", by: "human" });
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-gemini", pane: "w2:p4", terminal: "Apple_Terminal" };
    const claimed = (await ctx.tools.execute("claim_ticket", { key: item.key }, inv)) as { tracking: { tracked: boolean; sessionId: string } };
    expect(claimed.tracking.tracked).toBe(true);
    expect(codeLink.store.session(project.id, claimed.tracking.sessionId)).toMatchObject({ agent: "mcp", herdrPane: "w2:p4", terminal: "Apple_Terminal", itemIds: [item.id] });
    // A session whose hooks already placed it keeps its own pane.
    await fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-Herdr-Pane": "w2:p9" }, body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cli-h", cwd: checkout }) });
    await until(() => codeLink.sessionsOf(project.id).length === 2);
    const other = items.create({ projectId: project.id, boardId: board.id, title: "Hooked work", by: "human" });
    const hooked = (await ctx.tools.execute("claim_ticket", { key: other.key }, { by: "ai:mcp", projectId: project.id, connection: "conn-h", pane: "w2:p1" })) as { tracking: { sessionId: string } };
    expect(codeLink.store.session(project.id, hooked.tracking.sessionId)).toMatchObject({ herdrPane: "w2:p9" });
  });
});

describe("untracked terminal sessions", () => {
  it.each(["en", "zh"] as const)("explains missing tracking and recovery in %s", async (language) => {
    const { ctx, items, project, board, codeLink } = await machine();
    ctx.settings.set({ ...ctx.settings.get(), language });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Untracked work", by: "human" });
    const inv = { by: "ai:mcp", projectId: project.id };
    const claimed = await ctx.tools.execute("claim_ticket", { key: item.key }, inv) as { tracking: { tracked: boolean; message: string }; conventions: string[] };
    expect(claimed.tracking).toMatchObject({ tracked: false });
    expect(claimed.tracking.message).toContain(".mcp.json");
    expect(claimed.tracking.message).toContain(".claude/settings.json");
    expect(claimed.tracking.message).toContain(".codex/config.toml");
    expect(claimed.tracking.message).toContain(".codebuddy/settings.json");
    expect(claimed.tracking.message).toContain(".pi/extensions/tomrade.ts");
    expect(claimed.tracking.message).toContain(".opencode/plugins/tomrade.js");
    expect(claimed.tracking.message).toContain(".cursor/hooks.json");
    expect(claimed.tracking.message).toContain(language === "zh" ? "未被 Tomrade 跟踪" : "not tracked by Tomrade");
    expect(claimed.conventions).not.toContain("call note_progress with one line at milestones");
    expect(items.get(project.id, item.id)?.status).toBe("doing");
    expect(codeLink.sessionsOf(project.id, item.id)).toEqual([]);
    // Nothing recorded, and said so: never a quiet success, never a stop for a lost note.
    expect(await ctx.tools.execute("note_progress", { key: item.key, text: "working" }, inv)).toMatchObject({ ok: false, warning: expect.stringContaining(claimed.tracking.message) });
    const blocked = (await ctx.tools.execute("report_merge_blocked", { key: item.key, reason: "checks failed" }, inv)) as { ok: boolean; next: string; warning: string };
    expect(blocked).toMatchObject({ ok: false, next: "stop" });
    expect(blocked.warning).toContain("Tell the user directly that the pull request needs a human to merge it");
    expect(blocked.warning).toContain("checks failed");
  });
});

describe("outside clients, told apart by their connection", () => {
  it("never hands one terminal's claim to another terminal's session", async () => {
    const { codeLink, ctx, items, project, board, checkout } = await machine();
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    // One terminal's hooks reach Tomrade; the other's (a worktree elsewhere, or no hooks at all) do not.
    await post({ hook_event_name: "SessionStart", session_id: "cli-1", cwd: checkout });
    const [hooked] = codeLink.sessionsOf(project.id);
    const first = items.create({ projectId: project.id, boardId: board.id, title: "First", status: "todo", by: "human" });
    const second = items.create({ projectId: project.id, boardId: board.id, title: "Second", status: "todo", by: "human" });
    const a = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-a" };
    const b = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-b" };

    expect(await ctx.tools.execute("claim_ticket", { key: first.key }, a)).toMatchObject({ tracking: { tracked: true, sessionId: hooked.id } });
    const claimed = (await ctx.tools.execute("claim_ticket", { key: second.key }, b)) as { tracking: { tracked: boolean; sessionId: string }; conventions: string[] };
    expect(claimed.tracking.tracked).toBe(true);
    expect(claimed.tracking.sessionId).not.toBe(hooked.id);
    expect(claimed.conventions).toContain("call note_progress with one line at milestones");

    expect(await ctx.tools.execute("note_progress", { text: "first going" }, a)).toMatchObject({ key: first.key });
    expect(await ctx.tools.execute("note_progress", { text: "second going" }, b)).toMatchObject({ key: second.key });
    expect(codeLink.sessionsOf(project.id, first.id).map((s) => [s.id, s.summary])).toEqual([[hooked.id, "first going"]]);
    expect(codeLink.sessionsOf(project.id, second.id).map((s) => s.summary)).toEqual(["second going"]);
    // The other terminal's ticket is not this one's to take; a free one waits until its own is finished.
    expect(await ctx.tools.execute("claim_ticket", { key: second.key }, a)).toMatchObject({ claimed: false, heldBy: [{ sessionId: claimed.tracking.sessionId }] });
    const third = items.create({ projectId: project.id, boardId: board.id, title: "Third", status: "todo", by: "human" });
    await expect(ctx.tools.execute("claim_ticket", { key: third.key }, a)).rejects.toThrow(`this session still owns ${first.key}, which is doing`);
    items.update(project.id, first.id, { status: "verifying" }, "human");
    await expect(ctx.tools.execute("claim_ticket", { key: third.key }, a)).rejects.toThrow(`this session still owns ${first.key}, which is verifying`);
  });

  it("finds the herdr pane of a session whose hooks name none, and a resumed conversation goes on in the session it had", async () => {
    const { codeLink, ctx, items, project, board, checkout } = await machine();
    const fake = new FakeHerdr();
    onTestFinished(() => fake.close());
    await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
    await settle();
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    // Hooks committed before they sent X-Tomrade-Herdr-Pane; herdr has detected the agent's session in a pane.
    const pane = Object.assign(fake.createPane(checkout), { agent: "claude", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "cli-9" } });
    fake.createPane(checkout);
    await post({ hook_event_name: "SessionStart", session_id: "cli-9", cwd: checkout });
    const [hooked] = codeLink.sessionsOf(project.id);
    await until(() => codeLink.store.session(project.id, hooked!.id)?.herdrPane === pane.pane_id);
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Work", status: "todo", by: "human" });
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, { by: "ai:mcp", projectId: project.id, connection: "conn-9" })).toMatchObject({ tracking: { sessionId: hooked!.id } });

    // herdr's server went away with the agent; after it restarts it resumes the conversation in the same pane.
    await post({ hook_event_name: "SessionEnd", session_id: "cli-9", cwd: checkout });
    expect(codeLink.store.session(project.id, hooked!.id)?.state).toBe("ended");
    await post({ hook_event_name: "SessionStart", source: "resume", session_id: "cli-9", cwd: checkout });
    expect(codeLink.sessionsOf(project.id).map((s) => s.id)).toEqual([hooked!.id]);
    expect(codeLink.store.session(project.id, hooked!.id)).toMatchObject({ state: "running", endedAt: null, itemIds: [item.id], herdrPane: pane.pane_id });

    // A conversation whose ticket is finished starts afresh.
    items.update(project.id, item.id, { status: "done" }, "human");
    await post({ hook_event_name: "SessionEnd", session_id: "cli-9", cwd: checkout });
    await post({ hook_event_name: "SessionStart", source: "resume", session_id: "cli-9", cwd: checkout });
    expect(codeLink.store.session(project.id, hooked!.id)?.state).toBe("ended");
    expect(codeLink.sessionsOf(project.id).filter((s) => s.state !== "ended").map((s) => s.itemIds)).toEqual([[]]);
  });

  it("keeps the session working its ticket when another process of its conversation ends in another pane (claude --continue)", async () => {
    const { codeLink, ctx, items, project, board, checkout } = await machine();
    const fake = new FakeHerdr();
    onTestFinished(() => fake.close());
    await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
    await settle();
    const working = fake.createPane(checkout);
    const other = fake.createPane(checkout);
    const post = (pane: string, payload: Record<string, unknown>) =>
      fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-Herdr-Pane": pane }, body: JSON.stringify({ session_id: "cli-two", cwd: checkout, ...payload }) });
    await post(working.pane_id, { hook_event_name: "SessionStart" });
    const [hooked] = codeLink.sessionsOf(project.id);
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Work", status: "todo", by: "human" });
    const conn = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-two" };
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, conn)).toMatchObject({ tracking: { tracked: true, sessionId: hooked!.id } });

    // The person goes on with the same conversation in another pane for a moment, and leaves it.
    await post(other.pane_id, { hook_event_name: "SessionStart", source: "resume" });
    await post(other.pane_id, { hook_event_name: "UserPromptSubmit", prompt: "看一眼进度" });
    await post(other.pane_id, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    expect(codeLink.store.session(project.id, hooked!.id)).toMatchObject({ state: "running", endedAt: null, itemIds: [item.id], herdrPane: working.pane_id });
    expect(await ctx.tools.execute("note_progress", { text: "still going" }, conn)).toMatchObject({ ok: true, key: item.key });
    expect(codeLink.sessionsOf(project.id).map((s) => s.id)).toEqual([hooked!.id]);

    // Its own process ending ends it.
    await post(working.pane_id, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    expect(codeLink.store.session(project.id, hooked!.id)?.state).toBe("ended");
  });

  it("brings back a session, ticket and all, when its conversation goes on after another process of it ended, for hooks that name no pane", async () => {
    const { codeLink, ctx, items, project, board, checkout } = await machine();
    const post = (payload: Record<string, unknown>) =>
      fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "cli-old", cwd: checkout, ...payload }) });
    await post({ hook_event_name: "SessionStart" });
    const [hooked] = codeLink.sessionsOf(project.id);
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Work", status: "todo", by: "human" });
    const conn = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-old" };
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, conn)).toMatchObject({ tracking: { tracked: true, sessionId: hooked!.id } });

    // Another process of the conversation ends; without a pane its end cannot be told from this one's.
    await post({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    expect(codeLink.store.session(project.id, hooked!.id)?.state).toBe("ended");
    // This one goes on: the hook before its next call brings the session back, rather than a new one without the ticket.
    await post({ hook_event_name: "PreToolUse", tool_name: "mcp__tomrade__note_progress", tool_input: { text: "still going" } });
    expect(codeLink.store.session(project.id, hooked!.id)).toMatchObject({ state: "running", endedAt: null, itemIds: [item.id] });
    expect(await ctx.tools.execute("note_progress", { text: "still going" }, conn)).toMatchObject({ ok: true, key: item.key });
    expect(await ctx.tools.execute("note_progress", { text: "by key", key: item.key }, { ...conn, connection: "conn-after-reconnect" })).toMatchObject({ ok: true, key: item.key });
    expect(codeLink.sessionsOf(project.id).map((s) => s.id)).toEqual([hooked!.id]);
  });

  it("keeps a conversation's folder, prompt and title from its hooks, and finds an older one's title by its transcript", async () => {
    const { codeLink, ctx, project, checkout } = await machine();
    // Claude Code's engine says how its transcripts are read; not installed here, so nothing connects.
    ctx.agent.engine({ ...installed("claude-code"), available: async () => ({ ok: false }), local: { record: claudeRecord({ variable: "CLAUDE_CONFIG_DIR", dir: ".claude" }) } });
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const transcript = path.join(root, `talk-${n++}.jsonl`);
    fs.writeFileSync(transcript, "");
    await post({ hook_event_name: "SessionStart", session_id: "talk-1", cwd: checkout, transcript_path: transcript });
    const [talk] = codeLink.sessionsOf(project.id);
    expect(codeLink.store.session(project.id, talk!.id)).toMatchObject({ cwd: checkout, transcript, prompted: false, title: null });
    // Spoken to: the first thing said names it until the agent names it itself.
    await post({ hook_event_name: "UserPromptSubmit", session_id: "talk-1", cwd: checkout, prompt: "我们来聊聊终端侧栏的设计" });
    expect(codeLink.store.session(project.id, talk!.id)).toMatchObject({ prompted: true, title: "我们来聊聊终端侧栏的设计" });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "ai-title", aiTitle: "终端侧栏设计" })}\n`);
    await post({ hook_event_name: "Stop", session_id: "talk-1", cwd: checkout, transcript_path: transcript });
    expect(codeLink.store.session(project.id, talk!.id)?.title).toBe("终端侧栏设计");

    // An agent that names the conversation itself, before any transcript exists (OpenCode, Pi).
    await post({ hook_event_name: "SessionStart", session_id: "talk-named", cwd: checkout });
    const named = codeLink.sessionsOf(project.id).find((s) => s.externalId === "talk-named")!;
    await post({ hook_event_name: "TitleUpdate", session_id: "talk-named", cwd: checkout, title: "OpenCode 的标题" });
    expect(codeLink.store.session(project.id, named.id)?.title).toBe("OpenCode 的标题");
    await post({ hook_event_name: "UserPromptSubmit", session_id: "talk-named", cwd: checkout, prompt: "一段很长的话", title: "agent 自己起的名字" });
    expect(codeLink.store.session(project.id, named.id)?.title).toBe("agent 自己起的名字");

    // One that ended before titles were kept: found by its agent's session id under the accounts' folders.
    const older = codeLink.store.createSession(project.id, { repoId: talk!.repoId, branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, externalId: "old-talk" });
    codeLink.store.patchSession(project.id, older.id, { state: "ended", endedAt: Date.now() });
    const accounts = fs.mkdtempSync(path.join(root, "claude-"));
    fs.mkdirSync(path.join(accounts, "projects", "-repo"), { recursive: true });
    fs.writeFileSync(path.join(accounts, "projects", "-repo", "old-talk.jsonl"), `${JSON.stringify({ type: "ai-title", aiTitle: "上周的方案讨论" })}\n`);
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = accounts;
    onTestFinished(() => {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    });
    expect(codeLink.findTitles(project.id)).toBe(true);
    expect(codeLink.store.session(project.id, older.id)).toMatchObject({ title: "上周的方案讨论", prompted: true });
    // Looked for once.
    expect(codeLink.findTitles(project.id)).toBe(false);
  });

  it("saves a ticket session's conversation on this machine as it ends, and reads it back once the agent's own is gone", async () => {
    const { codeLink, ctx, items, project, board, checkout, repo } = await machine();
    ctx.agent.engine({ ...installed("claude-code"), available: async () => ({ ok: false }), local: { record: claudeRecord({ variable: "CLAUDE_CONFIG_DIR", dir: ".claude" }) } });
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Snapshot work", by: "human" });
    const transcript = path.join(root, `snap-${n++}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "把侧栏改成两组" } })}\n`);
    const ticketSession = codeLink.store.createSession(project.id, { repoId: repo.id, branch: "tom-1/x", itemIds: [item.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, externalId: "snap-1" });
    codeLink.store.patchSession(project.id, ticketSession.id, { transcript, cwd: checkout });
    await post({ hook_event_name: "SessionEnd", session_id: "snap-1", cwd: checkout, transcript_path: transcript, reason: "exit" });
    await vi.waitFor(() => expect(codeLink.store.session(project.id, ticketSession.id)?.recordSavedAt).not.toBeNull());
    expect(codeLink.store.session(project.id, ticketSession.id)).toMatchObject({ state: "ended", recordCut: false });
    // The agent cleans its records up: the archive still shows the conversation.
    fs.rmSync(transcript);
    expect(codeLink.conversation(project.id, ticketSession.id)?.lines).toEqual([{ who: "person", text: "把侧栏改成两组" }]);

    // A conversation without a ticket keeps only the pointer.
    const talkFile = path.join(root, `snap-${n++}.jsonl`);
    fs.writeFileSync(talkFile, `${JSON.stringify({ type: "user", message: { content: "随便聊聊" } })}\n`);
    const talk = codeLink.store.createSession(project.id, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, externalId: "talk-2" });
    codeLink.store.patchSession(project.id, talk.id, { transcript: talkFile, cwd: checkout });
    await post({ hook_event_name: "SessionEnd", session_id: "talk-2", cwd: checkout, transcript_path: talkFile, reason: "exit" });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(codeLink.store.session(project.id, talk.id)).toMatchObject({ state: "ended", recordSavedAt: null });
    fs.rmSync(talkFile);
    expect(codeLink.conversation(project.id, talk.id)).toBeNull();
  });

  it("counts a terminal session's tokens from its agent's record, going on from where the last count stopped", async () => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    const claude = claudeRecord({ variable: "CLAUDE_CONFIG_DIR", dir: ".claude" });
    const counted: unknown[] = [];
    ctx.agent.engine({ ...installed("claude-code"), available: async () => ({ ok: false }), local: { record: { ...claude, usage: (file, from) => (counted.push(from ?? null), claude.usage!(file, from)) } } });
    const transcript = path.join(root, `usage-${n++}.jsonl`);
    const reply = (id: string, output: number) => `${JSON.stringify({ type: "assistant", message: { id, content: [], usage: { input_tokens: 3, output_tokens: output, cache_read_input_tokens: 100 } } })}\n`;
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "开始" } })}\n` + reply("m1", 5) + reply("m1", 5));
    const s = codeLink.store.createSession(project.id, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, externalId: "usage-1" });
    codeLink.store.patchSession(project.id, s.id, { transcript, cwd: checkout });
    expect(codeLink.usage(project.id, s.id)).toMatchObject({ total: { inputTokens: 103, outputTokens: 5 }, turn: { tokens: { outputTokens: 5 } } });
    fs.appendFileSync(transcript, reply("m2", 7));
    expect(codeLink.usage(project.id, s.id)).toMatchObject({ total: { inputTokens: 206, cacheReadTokens: 200, outputTokens: 12 } });
    // the second count went on from the first, never from nothing
    expect(counted[0]).toBeNull();
    expect(counted[1]).not.toBeNull();
    // no record: nothing to count
    fs.rmSync(transcript);
    expect(codeLink.usage(project.id, s.id)).toBeNull();
  });

  it("gives a tokenless claim to the session whose hooks announced it, not the newest idle one", async () => {
    const { codeLink, ctx, items, project, board, checkout } = await machine();
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    // Two Claude Code sessions in one checkout; the one that claims is not the one heard from last.
    await post({ hook_event_name: "SessionStart", session_id: "worker", cwd: checkout });
    await post({ hook_event_name: "SessionStart", session_id: "coordinator", cwd: checkout });
    await post({ hook_event_name: "Stop", session_id: "coordinator", cwd: checkout, last_assistant_message: "waiting on the subagents" });
    const byExternal = (id: string) => codeLink.sessionsOf(project.id).find((s) => s.externalId === id)!;
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Work", status: "todo", by: "human" });
    const other = items.create({ projectId: project.id, boardId: board.id, title: "Other", status: "todo", by: "human" });

    // An announcement for another ticket vouches for nothing.
    await post({ hook_event_name: "PreToolUse", session_id: "coordinator", cwd: checkout, tool_name: "mcp__tomrade__claim_ticket", tool_input: { key: other.key } });
    await post({ hook_event_name: "PreToolUse", session_id: "worker", cwd: checkout, tool_name: "mcp__tomrade__claim_ticket", tool_input: { key: item.key.toLowerCase() } });
    const claimed = (await ctx.tools.execute("claim_ticket", { key: item.key }, { by: "ai:mcp", projectId: project.id, connection: "conn-w" })) as { tracking: { sessionId: string } };
    expect(claimed.tracking.sessionId).toBe(byExternal("worker").id);

    await post({ hook_event_name: "Stop", session_id: "coordinator", cwd: checkout, last_assistant_message: "still waiting" });
    expect(codeLink.sessionsOf(project.id, item.id).map((s) => s.externalId)).toEqual(["worker"]);
    expect(byExternal("coordinator").itemIds).toEqual([]);
  });

  it("lets an outside session take the next ticket once its last one is done, from a fresh branch", async () => {
    const { codeLink, ctx, items, project, board } = await machine();
    const first = items.create({ projectId: project.id, boardId: board.id, title: "First", status: "todo", by: "human" });
    const next = items.create({ projectId: project.id, boardId: board.id, title: "Next", status: "todo", by: "human" });
    const a = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-a" };
    const { tracking, branch: firstBranch } = (await ctx.tools.execute("claim_ticket", { key: first.key }, a)) as { tracking: { sessionId: string }; branch: string };
    items.update(project.id, first.id, { status: "done" }, "human");
    // Done as far as the ticket goes, while the terminal is still open.
    codeLink.store.patchSession(project.id, tracking.sessionId, { state: "running", endedAt: null });
    const claimed = (await ctx.tools.execute("claim_ticket", { key: next.key }, a)) as { branch: string; tracking: { sessionId: string }; conventions: string[] };
    expect(claimed.tracking.sessionId).toBe(tracking.sessionId);
    expect(claimed.branch).not.toBe(firstBranch);
    expect(claimed.branch.startsWith(next.key.toLowerCase())).toBe(true);
    expect(claimed.conventions.some((c) => c.includes("from the latest") && c.includes("previous ticket"))).toBe(true);
    expect(codeLink.store.session(project.id, tracking.sessionId)).toMatchObject({ itemIds: [next.id], branch: claimed.branch });
    expect(await ctx.tools.execute("note_progress", { text: "on the next one" }, a)).toMatchObject({ ok: true, key: next.key });
  });

  it("keeps a session on the ticket it moved on from, as history its page opens, while only the new ticket counts it as working", async () => {
    const { codeLink, ctx, items, project, board } = await machine();
    const first = items.create({ projectId: project.id, boardId: board.id, title: "First", status: "todo", by: "human" });
    const next = items.create({ projectId: project.id, boardId: board.id, title: "Next", status: "todo", by: "human" });
    const a = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-a" };
    const { tracking } = (await ctx.tools.execute("claim_ticket", { key: first.key }, a)) as { tracking: { sessionId: string } };
    const delivery = codeLink.store.activeDelivery(project.id, first.id)!.sequence;
    items.update(project.id, first.id, { status: "done" }, "human");
    codeLink.store.patchSession(project.id, tracking.sessionId, { state: "running", endedAt: null, title: "Build the first one" });
    await ctx.tools.execute("claim_ticket", { key: next.key }, a);

    expect(codeLink.store.session(project.id, tracking.sessionId)).toMatchObject({ itemIds: [next.id], worked: [{ itemId: first.id, delivery }] });
    // Judging, holding and Continue read the current ticket only.
    expect(codeLink.sessionsOf(project.id, first.id)).toEqual([]);
    expect(codeLink.store.sessions(project.id, { itemId: next.id, live: true }).map((s) => s.id)).toEqual([tracking.sessionId]);
    expect(codeLink.store.movedOn(project.id, first.id, delivery).map((s) => s.id)).toEqual([tracking.sessionId]);
    expect(codeLink.store.movedOn(project.id, first.id, delivery + 1)).toEqual([]);
    expect(codeLink.store.movedOn(project.id, next.id)).toEqual([]);

    const section = (await ctx.contributions.sectionsFor(project.id, first.id)).find((x) => x.id === "code")!;
    const row = section.rows!.find((r) => r.command === "code-link.open-earlier")!;
    expect(row.value).toContain("Build the first one");
    expect(row.value).toContain(next.key);
    expect(section.rows!.some((r) => r.command === "code-link.start-terminal")).toBe(false);

    const shown: string[] = [];
    ctx.on("codeLink/show-session", (_projectId, sessionId) => {
      shown.push(sessionId);
      return true;
    });
    expect(await ctx.contributions.run("code-link.open-earlier", { projectId: project.id, itemId: first.id })).toEqual({});
    expect(shown).toEqual([tracking.sessionId]);
  });

  it("asks GitHub before refusing the next ticket, so a pull request merged a moment ago lets it through", async () => {
    const { codeLink, ctx, items, project, board, checkout } = await machine();
    const first = items.create({ projectId: project.id, boardId: board.id, title: "First", status: "todo", by: "human" });
    const next = items.create({ projectId: project.id, boardId: board.id, title: "Next", status: "todo", by: "human" });
    const a = { by: "ai:claude-code" as const, projectId: project.id, connection: "conn-m" };
    const { branch } = (await ctx.tools.execute("claim_ticket", { key: first.key }, a)) as { branch: string };
    git(["checkout", "-q", "-b", branch], checkout);
    fs.writeFileSync(path.join(checkout, "work.ts"), "x\n");
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", `${first.key}: the work`], checkout);
    git(["push", "-q", "origin", branch], checkout);
    git(["checkout", "-q", "main"], checkout);
    await ctx.tools.execute("link_code", { prUrl: "https://github.com/acme/app/pull/41", scopeChecked: true }, a);
    await codeLink.scan(project.id);
    const asked: string[] = [];
    codeLink.pulls = async (repo, number) => {
      asked.push(`${repo}#${number}`);
      return { merged: false, state: "open", mergeSha: null, base: "main" };
    };

    // Not merged: still refused, and the refusal reads as before.
    await expect(ctx.tools.execute("claim_ticket", { key: next.key }, a)).rejects.toThrow(`this session still owns ${first.key}, which is verifying — merge its pull request once the checks pass, or if the merge is refused call report_merge_blocked`);
    expect(asked).toEqual(["acme/app#41"]);

    // Squash-merged under a title naming neither: only GitHub can say so, and the claim asks it there and then.
    git(["merge", "-q", "--squash", branch], checkout);
    git(["commit", "-q", "-m", "Tidy things up"], checkout);
    git(["push", "-q", "origin", "main"], checkout);
    git(["reset", "-q", "--hard", "HEAD~1"], checkout);
    const squash = git(["rev-parse", "origin/main"], checkout);
    codeLink.pulls = async () => ({ merged: true, state: "closed", mergeSha: squash, base: "main" });
    // GitHub alone answers: no fetch and no pass over every repository while the agent waits.
    const scans = (codeLink as unknown as { scans: { scan(projectId: string): Promise<unknown> } }).scans;
    const scan = scans.scan.bind(scans);
    let passes = 0;
    scans.scan = (projectId) => { passes += 1; return scan(projectId); };
    const claimed = (await ctx.tools.execute("claim_ticket", { key: next.key }, a)) as { key: string };
    expect(passes).toBe(0);
    scans.scan = scan;
    expect(claimed.key).toBe(next.key);
    expect(items.get(project.id, first.id)!.status).toBe("done");
    expect(items.get(project.id, next.id)!.status).toBe("doing");
  });

  it("takes the next ticket as a new session once it handed the last one's merge to the person, which keeps waiting on them", async () => {
    const { codeLink, ctx, items, project, board, checkout } = await machine();
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await post({ hook_event_name: "SessionStart", session_id: "cli-7", cwd: checkout });
    const first = items.create({ projectId: project.id, boardId: board.id, title: "First", status: "todo", by: "human" });
    const next = items.create({ projectId: project.id, boardId: board.id, title: "Next", status: "todo", by: "human" });
    const a = { by: "ai:claude-code" as const, projectId: project.id, connection: "conn-a" };
    const { tracking } = (await ctx.tools.execute("claim_ticket", { key: first.key }, a)) as { tracking: { sessionId: string } };
    await ctx.tools.execute("link_code", { prUrl: "https://github.com/acme/app/pull/31", scopeChecked: true }, a);
    // Verifying with an open pull request is still owed: merging it, or saying the merge was refused.
    await expect(ctx.tools.execute("claim_ticket", { key: next.key }, a)).rejects.toThrow(`this session still owns ${first.key}, which is verifying — merge its pull request once the checks pass, or if the merge is refused call report_merge_blocked`);
    await ctx.tools.execute("report_merge_blocked", { reason: "the merge was refused" }, a);

    const claimed = (await ctx.tools.execute("claim_ticket", { key: next.key }, a)) as { branch: string; tracking: { sessionId: string } };
    expect(claimed.tracking.sessionId).not.toBe(tracking.sessionId);
    expect(codeLink.store.session(project.id, tracking.sessionId)).toMatchObject({ itemIds: [first.id], blocked: "merge" });
    expect(codeLink.summary(project.id, first.id).session).toMatchObject({ id: tracking.sessionId, blocked: "merge" });
    expect(codeLink.store.session(project.id, claimed.tracking.sessionId)).toMatchObject({ itemIds: [next.id], branch: claimed.branch, blocked: null, externalId: "cli-7" });
    expect(items.get(project.id, first.id)!.status).toBe("verifying");

    // Its notes and hooks belong to the new ticket now.
    expect(await ctx.tools.execute("note_progress", { text: "on the next one" }, a)).toMatchObject({ ok: true, key: next.key });
    await post({ hook_event_name: "UserPromptSubmit", session_id: "cli-7", cwd: checkout });
    expect(codeLink.store.session(project.id, claimed.tracking.sessionId)).toMatchObject({ summary: "on the next one", state: "running" });
    expect(codeLink.store.session(project.id, tracking.sessionId)).toMatchObject({ state: "error", blocked: "merge" });

    // Once the person merges, the session left behind is over; the ticket is done as usual.
    await ctx.tools.execute("link_code", { key: first.key, prUrl: "https://github.com/acme/app/pull/31", prState: "merged" }, { by: "human", projectId: project.id });
    await codeLink.scan(project.id);
    expect(codeLink.store.session(project.id, tracking.sessionId)?.state).toBe("ended");
    expect(codeLink.store.session(project.id, claimed.tracking.sessionId)?.state).toBe("running");
  });

  it("hangs each pull request on the repository its URL names, and is done only once both are merged", async () => {
    const { codeLink, ctx, items, project, board, repo } = await machine();
    const plugins = ctx.repos.create({ projectId: project.id, remote: "git@github.com-work:Acme/plugins.git" });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Across two repositories", status: "doing", by: "human" });
    const branch = `tom-${item.keyNum}/both`;
    const human = { by: "human" as const, projectId: project.id };
    const link = (prUrl: string, prState?: "merged") => ctx.tools.execute("link_code", { key: item.key, branch, prUrl, ...(prState ? { prState } : {}) }, human);
    const byRepo = () => Object.fromEntries(codeLink.links(project.id, item.id).map((l) => [l.repoId, [l.prUrl, l.prState]]));

    // This workstream's repository has no GitHub remote, so its pull request stays where the ticket stands.
    await link("https://github.com/acme/app/pull/24");
    await link("https://github.com/acme/plugins/pull/8");
    expect(byRepo()).toEqual({ [repo.id]: ["https://github.com/acme/app/pull/24", "open"], [plugins.id]: ["https://github.com/acme/plugins/pull/8", "open"] });

    await link("https://github.com/acme/app/pull/24", "merged");
    expect(items.get(project.id, item.id)!.status).toBe("verifying");
    await link("https://github.com/acme/plugins/pull/8", "merged");
    expect(items.get(project.id, item.id)!.status).toBe("done");
  });

  it("waits on another repository's uncommitted work after one repository merged, and links its pull request to the same delivery", async () => {
    const { codeLink, ctx, items, project, board, checkout } = await machine();
    const plugins = ctx.repos.create({ projectId: project.id, remote: "git@github.com:acme/plugins.git" });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Spans two repositories", status: "doing", by: "human" });
    const branch = `tom-${item.keyNum}/both`;
    const human = { by: "human" as const, projectId: project.id };
    // Work under way here, nothing committed yet; a helper worktree's branch with nothing on it beside it.
    git(["checkout", "-q", "-b", branch, "main"], checkout);
    fs.writeFileSync(path.join(checkout, "half.ts"), "second half\n");
    git(["branch", `${branch}-a`, "main"], checkout);
    await codeLink.scan(project.id);

    await ctx.tools.execute("link_code", { key: item.key, branch, prUrl: "https://github.com/acme/plugins/pull/8" }, human);
    await ctx.tools.execute("link_code", { key: item.key, branch, prUrl: "https://github.com/acme/plugins/pull/8", prState: "merged" }, human);
    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)?.status).toBe("verifying");
    expect(codeLink.links(project.id, item.id).find((l) => l.repoId === plugins.id)?.prState).toBe("merged");

    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", `${item.key}: second half`], checkout);
    git(["push", "-q", "origin", branch], checkout);
    await codeLink.scan(project.id);
    expect(await ctx.tools.execute("link_code", { key: item.key, branch, prUrl: "https://github.com/acme/app/pull/9" }, human)).toMatchObject({ status: "verifying", prState: "open" });
    expect(codeLink.proposals(project.id, item.id).filter((p) => p.reason.includes("reopen"))).toEqual([]);

    git(["checkout", "-q", "main"], checkout);
    git(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch], checkout);
    git(["push", "-q", "origin", "main"], checkout);
    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)?.status).toBe("done");
  });

  it("follows a client with no hooks through its connection until it closes", async () => {
    const { codeLink, ctx, items, project, board, repo } = await machine();
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Cursor work", status: "todo", by: "human" });
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-cursor" };
    const claimed = (await ctx.tools.execute("claim_ticket", { key: item.key }, inv)) as { tracking: { tracked: boolean }; branch: string };
    expect(claimed.tracking.tracked).toBe(true);
    const [session] = codeLink.sessionsOf(project.id, item.id);
    expect(session).toMatchObject({ agent: "mcp", mode: "terminal", threadId: null, repoId: repo.id, branch: claimed.branch, state: "running" });

    expect(await ctx.tools.execute("note_progress", { text: "half way" }, inv)).toMatchObject({ ok: true, key: item.key });
    expect(await ctx.tools.execute("link_code", { prUrl: "https://github.com/acme/app/pull/12", scopeChecked: true }, inv)).toMatchObject({ key: item.key });
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ branch: claimed.branch, prNumber: 12 });
    expect(await ctx.tools.execute("report_merge_blocked", { reason: "checks failed" }, inv)).toMatchObject({ ok: true, key: item.key });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ blocked: "merge" });

    ctx.emit("mcp/closed", "conn-cursor");
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("ended");
  });

  it("finds its session again when a client comes back on a new connection and names its ticket", async () => {
    const { codeLink, ctx, items, project, board } = await machine();
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Long work", status: "todo", by: "human" });
    await ctx.tools.execute("claim_ticket", { key: item.key }, { by: "ai:mcp", projectId: project.id, connection: "before" });
    const [session] = codeLink.sessionsOf(project.id, item.id);
    // Tomrade restarted, or the client reconnected: the new connection has claimed nothing yet.
    const after = { by: "ai:mcp" as const, projectId: project.id, connection: "after" };
    await expect(ctx.tools.execute("note_progress", { text: "x" }, after)).rejects.toThrow("pass key");
    expect(await ctx.tools.execute("note_progress", { key: item.key, text: "back" }, after)).toMatchObject({ ok: true });
    expect(await ctx.tools.execute("note_progress", { text: "and on" }, after)).toMatchObject({ ok: true, key: item.key });
    expect(codeLink.sessionsOf(project.id, item.id)).toMatchObject([{ id: session.id, summary: "and on", state: "running" }]);
    // the old connection closing later does not end what the new one holds
    ctx.emit("mcp/closed", "before");
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("running");
  });

  it("works end to end over MCP: a claim, then a note without the key", async () => {
    const { codeLink, ctx, items, project, board } = await machine();
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Over the wire", status: "todo", by: "human" });
    const client = new Client({ name: "any-agent", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.urlFor(project.id)!)));
      expect((await client.callTool({ name: "claim_ticket", arguments: { key: item.key } })).isError).toBeFalsy();
      const noted = await client.callTool({ name: "note_progress", arguments: { text: "wired" } });
      expect(noted.isError).toBeFalsy();
      expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ agent: "mcp", summary: "wired" });
    } finally {
      await client.close();
    }
  });
});

describe("a ticket another session is working", () => {
  type Claimed = { branch: string; tracking: { sessionId: string } };
  const setup = async () => {
    const world = await machine();
    const { ctx, items, project, board } = world;
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Taken", status: "todo", by: "human" });
    const a = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-holder" };
    const b = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-late" };
    const held = (await ctx.tools.execute("claim_ticket", { key: item.key, worktree: path.join(root, "wt-holder") }, a)) as Claimed;
    await ctx.tools.execute("note_progress", { text: "half way" }, a);
    return { ...world, item, a, b, held };
  };

  it("is not claimed from under it: the claim says who holds it and changes nothing, unless told to take it over", async () => {
    const { codeLink, ctx, items, project, item, b, held } = await setup();
    const refused = await ctx.tools.execute("claim_ticket", { key: item.key }, b);
    expect(refused).toMatchObject({
      claimed: false,
      key: item.key,
      status: "doing",
      heldBy: [{ sessionId: held.tracking.sessionId, agent: "mcp", worktree: path.join(root, "wt-holder"), state: "running", summary: "half way" }],
      next: expect.stringContaining("takeOver: true")
    });
    expect(codeLink.sessionsOf(project.id, item.id).map((s) => s.id)).toEqual([held.tracking.sessionId]);
    await expect(ctx.tools.execute("note_progress", { text: "x" }, b)).rejects.toThrow("pass key");

    const taken = (await ctx.tools.execute("claim_ticket", { key: item.key, takeOver: true }, b)) as Claimed;
    expect(taken.tracking.sessionId).not.toBe(held.tracking.sessionId);
    expect(taken.branch).toBe(held.branch);
    expect(items.get(project.id, item.id)!.status).toBe("doing");
  });

  it("counts a session's own repeat claim and its parallel tickets as its own, and no one who handed the merge over or went quiet", async () => {
    const { codeLink, ctx, items, project, board, item, a, b, held } = await setup();
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, a)).toMatchObject({ tracking: { sessionId: held.tracking.sessionId } });
    const other = items.create({ projectId: project.id, boardId: board.id, title: "Beside", status: "todo", by: "human" });
    const beside = (await ctx.tools.execute("claim_ticket", { key: other.key, parallel: true }, a)) as Claimed;
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, a)).toMatchObject({ key: item.key, tracking: { sessionId: held.tracking.sessionId } });
    expect(await ctx.tools.execute("claim_ticket", { key: other.key }, a)).toMatchObject({ key: other.key, tracking: { sessionId: beside.tracking.sessionId } });

    codeLink.store.patchSession(project.id, held.tracking.sessionId, { lastEventAt: Date.now() - 2 * 60 * 60 * 1000 });
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, b)).not.toHaveProperty("claimed");
    codeLink.store.patchSession(project.id, beside.tracking.sessionId, { blocked: "merge" });
    expect(await ctx.tools.execute("claim_ticket", { key: other.key, parallel: true }, b)).not.toHaveProperty("claimed");
  });

  it("lets a session give back a ticket it claimed: a session made for the claim ends, the agent's own hooks session stays", async () => {
    const { codeLink, ctx, items, project, board, checkout, item, a, b, held } = await setup();
    expect(await ctx.tools.execute("release_ticket", { key: item.key }, b)).toMatchObject({ released: false, key: item.key });

    // Released by the one holding it: its connection-only session ends, and the ticket's status stays.
    expect(await ctx.tools.execute("release_ticket", { key: item.key }, a)).toEqual({ released: true, key: item.key, status: "doing", note: `${item.key} stays doing; change its status only if the person says so` });
    expect(codeLink.store.session(project.id, held.tracking.sessionId)).toMatchObject({ itemIds: [], state: "ended" });
    expect(items.get(project.id, item.id)!.status).toBe("doing");
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, b)).not.toHaveProperty("claimed");

    // An agent with hooks gives back the ticket it took alongside its own: the parallel session ends and its
    // hooks reach the session it holds again; the hooks session itself stays when it drops its last ticket.
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await post({ hook_event_name: "SessionStart", session_id: "cli-give", cwd: checkout });
    const c = { by: "ai:claude-code" as const, projectId: project.id, connection: "conn-give" };
    const mine = items.create({ projectId: project.id, boardId: board.id, title: "Mine", status: "todo", by: "human" });
    const wrong = items.create({ projectId: project.id, boardId: board.id, title: "Wrong", status: "todo", by: "human" });
    const own = (await ctx.tools.execute("claim_ticket", { key: mine.key }, c)) as Claimed;
    const extra = (await ctx.tools.execute("claim_ticket", { key: wrong.key, parallel: true }, c)) as Claimed;
    expect(await ctx.tools.execute("release_ticket", { key: wrong.key }, c)).toMatchObject({ released: true });
    expect(codeLink.store.session(project.id, extra.tracking.sessionId)).toMatchObject({ itemIds: [], state: "ended" });
    expect(await ctx.tools.execute("note_progress", { text: "back on mine" }, c)).toMatchObject({ ok: true, key: mine.key });
    await post({ hook_event_name: "UserPromptSubmit", session_id: "cli-give", cwd: checkout });
    expect(codeLink.store.session(project.id, own.tracking.sessionId)).toMatchObject({ itemIds: [mine.id], state: "running" });

    expect(await ctx.tools.execute("release_ticket", { key: mine.key }, c)).toMatchObject({ released: true });
    expect(codeLink.store.session(project.id, own.tracking.sessionId)).toMatchObject({ itemIds: [], state: "running" });
  });
});

describe("one outside session working tickets in parallel", () => {
  type Claimed = { branch: string; tracking: { sessionId: string }; conventions: string[] };
  const setup = async () => {
    const world = await machine();
    const { ctx, items, project, board, checkout } = world;
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await post({ hook_event_name: "SessionStart", session_id: "cli-par", cwd: checkout });
    const ticket = (title: string) => items.create({ projectId: project.id, boardId: board.id, title, status: "todo", by: "human" });
    const inv = { by: "ai:claude-code" as const, projectId: project.id, connection: "conn-par" };
    const worktree = () => {
      const dir = path.join(root, `wt-${n++}`);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    return { ...world, post, ticket, inv, worktree };
  };

  it("claims, links and notes each ticket on its own session, and each is done once its own pull request merges", async () => {
    const { codeLink, ctx, items, project, ticket, inv } = await setup();
    const a = ticket("Alpha");
    const b = ticket("Beta");
    const first = (await ctx.tools.execute("claim_ticket", { key: a.key }, inv)) as Claimed;
    const before = codeLink.store.session(project.id, first.tracking.sessionId)!;

    // Without parallel, the wrap-up of the first is still owed, and the error says how to work alongside it.
    await expect(ctx.tools.execute("claim_ticket", { key: b.key }, inv)).rejects.toThrow(`this session still owns ${a.key}, which is doing`);
    await expect(ctx.tools.execute("claim_ticket", { key: b.key }, inv)).rejects.toThrow(`claim ${b.key} with parallel: true`);

    const second = (await ctx.tools.execute("claim_ticket", { key: b.key, parallel: true }, inv)) as Claimed;
    expect(second.tracking.sessionId).not.toBe(first.tracking.sessionId);
    expect(second.branch).toBe(`tom-${b.keyNum}/beta`);
    expect(second.conventions.some((c) => c.includes(`pass key ${b.key}`))).toBe(true);
    expect(codeLink.store.session(project.id, second.tracking.sessionId)).toMatchObject({ itemIds: [b.id], branch: second.branch, externalId: "cli-par", agent: before.agent });
    expect(codeLink.store.session(project.id, first.tracking.sessionId)).toMatchObject({ itemIds: [a.id], branch: first.branch, state: before.state, blocked: null });
    // Claiming it again on this connection is the same session, not another.
    expect(await ctx.tools.execute("claim_ticket", { key: b.key, parallel: true }, inv)).toMatchObject({ branch: second.branch, tracking: { sessionId: second.tracking.sessionId } });
    expect(codeLink.sessionsOf(project.id, b.id)).toHaveLength(1);

    // A key says which session a call is about; no key means the ticket claimed last.
    expect(await ctx.tools.execute("note_progress", { key: a.key, text: "alpha tests green" }, inv)).toMatchObject({ ok: true, key: a.key });
    expect(await ctx.tools.execute("note_progress", { key: b.key, text: "beta wired" }, inv)).toMatchObject({ ok: true, key: b.key });
    expect(await ctx.tools.execute("note_progress", { text: "beta still" }, inv)).toMatchObject({ ok: true, key: b.key });
    expect(codeLink.store.session(project.id, first.tracking.sessionId)!.summary).toBe("alpha tests green");
    expect(codeLink.store.session(project.id, second.tracking.sessionId)!.summary).toBe("beta still");

    expect(await ctx.tools.execute("link_code", { key: a.key, prUrl: "https://github.com/acme/app/pull/41", scopeChecked: true }, inv)).toMatchObject({ key: a.key, status: "verifying", branch: first.branch });
    expect(await ctx.tools.execute("link_code", { key: b.key, prUrl: "https://github.com/acme/app/pull/42", scopeChecked: true }, inv)).toMatchObject({ key: b.key, status: "verifying", branch: second.branch });
    expect(codeLink.links(project.id, a.id)).toMatchObject([{ branch: first.branch, prNumber: 41 }]);
    expect(codeLink.links(project.id, b.id)).toMatchObject([{ branch: second.branch, prNumber: 42 }]);
    expect(await ctx.tools.execute("report_merge_blocked", { key: a.key, reason: "a review is required" }, inv)).toMatchObject({ ok: true, key: a.key });
    expect(codeLink.store.session(project.id, first.tracking.sessionId)!.blocked).toBe("merge");
    expect(codeLink.store.session(project.id, second.tracking.sessionId)!.blocked).toBeNull();

    // A ticket never claimed on this connection is refused, never written onto the one claimed last.
    const c = ticket("Gamma");
    await expect(ctx.tools.execute("link_code", { key: c.key, prUrl: "https://github.com/acme/app/pull/43", scopeChecked: true }, inv)).rejects.toThrow(`this connection has not claimed ${c.key}`);
    await expect(ctx.tools.execute("note_progress", { key: c.key, text: "x" }, inv)).rejects.toThrow("parallel: true");
    expect(codeLink.links(project.id, c.id)).toEqual([]);

    const human = { by: "human" as const, projectId: project.id };
    await ctx.tools.execute("link_code", { key: b.key, prUrl: "https://github.com/acme/app/pull/42", prState: "merged" }, human);
    expect(items.get(project.id, b.id)!.status).toBe("done");
    expect(items.get(project.id, a.id)!.status).toBe("verifying");
    await ctx.tools.execute("link_code", { key: a.key, prUrl: "https://github.com/acme/app/pull/41", prState: "merged" }, human);
    await codeLink.scan(project.id);
    expect(items.get(project.id, a.id)!.status).toBe("done");
    expect(items.get(project.id, b.id)!.status).toBe("done");
  });

  it("claims a ticket its conversation already holds into that row again after Tomrade restarts, not into a new one beside it", async () => {
    const { codeLink, ctx, project, ticket, inv } = await setup();
    const a = ticket("Alpha");
    const b = ticket("Beta");
    const c = ticket("Gamma");
    const claim = async (key: string, on: typeof inv, extra: Record<string, unknown> = {}) =>
      (await ctx.tools.execute("claim_ticket", { key, parallel: true, ...extra }, on)) as Claimed & { claimed?: boolean; sharedCheckout?: unknown[] };
    const alpha = await claim(a.key, inv);
    const beta = await claim(b.key, inv);
    // Tomrade restarted: the agent's MCP connection is a new one, found again on its conversation's row by its hooks;
    // it claims another ticket alongside, then Beta again.
    const again = { ...inv, connection: "conn-par-after-restart" };
    codeLink.bindConnection(project.id, again.connection, alpha.tracking.sessionId);
    const gamma = await claim(c.key, again);
    expect(codeLink.store.session(project.id, gamma.tracking.sessionId)).toMatchObject({ externalId: "cli-par", itemIds: [c.id] });
    const back = await claim(b.key, again);
    expect(back.claimed).not.toBe(false);
    expect(back.tracking.sessionId).toBe(beta.tracking.sessionId);
    expect(back.branch).toBe(beta.branch);
    expect(codeLink.sessionsOf(project.id, b.id).filter((s) => s.state !== "ended")).toHaveLength(1);
    // The conversation's other rows are not "another session in this folder".
    expect(back.sharedCheckout ?? []).toEqual([]);
    // Told to take it over from yet another connection, the same.
    const third = { ...inv, connection: "conn-par-third" };
    codeLink.bindConnection(project.id, third.connection, gamma.tracking.sessionId);
    expect((await claim(b.key, third, { takeOver: true })).tracking.sessionId).toBe(beta.tracking.sessionId);
    expect(codeLink.sessionsOf(project.id, b.id).filter((s) => s.state !== "ended")).toHaveLength(1);
  });

  it("folds a ticket one conversation holds in two live rows into the earliest when the project opens", async () => {
    const { codeLink, ctx, project, ticket, inv, post } = await setup();
    const a = ticket("Alpha");
    const b = ticket("Beta");
    await ctx.tools.execute("claim_ticket", { key: a.key }, inv);
    const first = codeLink.store.session(project.id, ((await ctx.tools.execute("claim_ticket", { key: b.key, parallel: true }, inv)) as Claimed).tracking.sessionId)!;
    // What an older version left: a second row of the same conversation holding Beta too.
    const twin = codeLink.store.createSession(project.id, { repoId: first.repoId, branch: first.branch, itemIds: [b.id], mode: first.mode, agent: first.agent, threadId: null, device: first.device, externalId: first.externalId });
    await post({ hook_event_name: "PostToolUse", session_id: "cli-par", tool_name: "Read", tool_input: {} });
    ctx.emit("db/opened", project.id);
    expect(codeLink.store.session(project.id, first.id)).toMatchObject({ itemIds: [b.id] });
    expect(codeLink.store.session(project.id, twin.id)).toMatchObject({ itemIds: [], state: "ended" });
    expect(codeLink.sessionsOf(project.id, b.id).filter((s) => s.state !== "ended").map((s) => s.id)).toEqual([first.id]);
  });

  it("tells sessions with worktrees of their own apart by where their hooks fire, and keeps both live", async () => {
    const { codeLink, ctx, items, project, repo, ticket, inv, post, worktree, checkout } = await setup();
    const a = ticket("Alpha");
    const b = ticket("Beta");
    const [wa, wb] = [worktree(), worktree()];
    const first = (await ctx.tools.execute("claim_ticket", { key: a.key, worktree: wa }, inv)) as Claimed;
    const second = (await ctx.tools.execute("claim_ticket", { key: b.key, parallel: true, worktree: wb }, inv)) as Claimed;
    const [sa, sb] = [first.tracking.sessionId, second.tracking.sessionId];
    expect(codeLink.store.session(project.id, sa)!.worktree).toBe(wa);
    expect(codeLink.store.session(project.id, sb)!.worktree).toBe(wb);
    expect(codeLink.summary(project.id, b.id).session).toMatchObject({ id: sb, worktree: wb });

    await post({ hook_event_name: "Stop", session_id: "cli-par", cwd: path.join(wa, "src"), last_assistant_message: "alpha paused" });
    expect(codeLink.store.session(project.id, sa)).toMatchObject({ state: "waiting", summary: "alpha paused" });
    expect(codeLink.store.session(project.id, sb)!.state).toBe("running");
    await post({ hook_event_name: "Stop", session_id: "cli-par", cwd: wb, last_assistant_message: "beta paused" });
    expect(codeLink.store.session(project.id, sb)).toMatchObject({ state: "waiting", summary: "beta paused" });
    expect(codeLink.store.session(project.id, sa)!.summary).toBe("alpha paused");
    // Elsewhere in the checkout, the newest of them.
    await post({ hook_event_name: "UserPromptSubmit", session_id: "cli-par", cwd: checkout });
    expect(codeLink.store.session(project.id, sb)!.state).toBe("running");
    expect(codeLink.store.session(project.id, sa)!.state).toBe("waiting");

    // The older one's merge lands (Done is left to the person here): it was not taken over by the newer one, so it stays live for the agent.
    codeLink.setRepoPolicy(project.id, repo.id, { autoDone: false });
    await ctx.tools.execute("link_code", { key: a.key, prUrl: "https://github.com/acme/app/pull/51", scopeChecked: true }, inv);
    await ctx.tools.execute("report_merge_blocked", { key: a.key, reason: "checks failed" }, inv);
    await ctx.tools.execute("link_code", { key: a.key, prUrl: "https://github.com/acme/app/pull/51", prState: "merged" }, { by: "human", projectId: project.id });
    await codeLink.scan(project.id);
    expect(items.get(project.id, a.id)!.status).toBe("verifying");
    expect(codeLink.store.session(project.id, sa)).toMatchObject({ state: "idle", blocked: null });
    expect(codeLink.store.session(project.id, sb)!.state).toBe("running");
    items.update(project.id, a.id, { status: "done" }, "human");

    // The agent exits: every session it had ends; the tickets and their links stay as they were.
    await ctx.tools.execute("link_code", { key: b.key, prUrl: "https://github.com/acme/app/pull/52", scopeChecked: true }, inv);
    const body = items.get(project.id, b.id)!.body;
    await post({ hook_event_name: "SessionEnd", session_id: "cli-par", cwd: wb, reason: "exit" });
    expect(codeLink.store.session(project.id, sa)!.state).toBe("ended");
    expect(codeLink.store.session(project.id, sb)!.state).toBe("ended");
    await codeLink.scan(project.id);
    expect(items.get(project.id, a.id)!.status).toBe("done");
    expect(items.get(project.id, b.id)).toMatchObject({ status: "verifying", body });
    expect(codeLink.links(project.id, b.id)).toMatchObject([{ branch: second.branch, prNumber: 52, prState: "open" }]);
  });

  it("never stands in the person's way: tickets with parallel sessions are moved by hand, and other terminals claim and finish other tickets", async () => {
    const { codeLink, ctx, items, project, ticket, inv } = await setup();
    const a = ticket("Alpha");
    const b = ticket("Beta");
    const first = (await ctx.tools.execute("claim_ticket", { key: a.key }, inv)) as Claimed;
    const second = (await ctx.tools.execute("claim_ticket", { key: b.key, parallel: true }, inv)) as Claimed;
    await ctx.tools.execute("link_code", { key: a.key, prUrl: "https://github.com/acme/app/pull/61", scopeChecked: true }, inv);

    items.update(project.id, a.id, { status: "done" }, "human");
    items.update(project.id, b.id, { status: "cancelled" }, "human");
    await codeLink.scan(project.id);
    expect(items.get(project.id, a.id)!.status).toBe("done");
    expect(items.get(project.id, b.id)!.status).toBe("cancelled");
    expect(codeLink.links(project.id, a.id)).toMatchObject([{ branch: first.branch, prNumber: 61 }]);

    // Another terminal, on its own connection, goes through a whole ticket meanwhile.
    const c = ticket("Gamma");
    const other = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-other" };
    const claimed = (await ctx.tools.execute("claim_ticket", { key: c.key }, other)) as Claimed;
    expect([first.tracking.sessionId, second.tracking.sessionId]).not.toContain(claimed.tracking.sessionId);
    expect(await ctx.tools.execute("link_code", { prUrl: "https://github.com/acme/app/pull/63", scopeChecked: true }, other)).toMatchObject({ key: c.key, status: "verifying" });
    await ctx.tools.execute("link_code", { key: c.key, prUrl: "https://github.com/acme/app/pull/63", prState: "merged" }, { by: "human", projectId: project.id });
    expect(items.get(project.id, c.id)!.status).toBe("done");
    // The parallel connection's keys still reach only its own tickets.
    await expect(ctx.tools.execute("note_progress", { key: c.key, text: "x" }, inv)).rejects.toThrow(`this connection has not claimed ${c.key}`);
  });

  it("works four tickets at once over MCP, each claimed, linked and noted, each done once its own pull request merges", async () => {
    const { codeLink, ctx, items, project, ticket, worktree } = await setup();
    const tickets = ["Plugin one", "Plugin two", "Plugin three", "Plugin four"].map(ticket);
    const client = new Client({ name: "claude-code", version: "0" });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      if (result.isError) throw new Error(result.content[0]?.text);
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    };
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.urlFor(project.id)!)));
      const claims = [];
      for (const [i, t] of tickets.entries()) claims.push(await call("claim_ticket", { key: t.key, worktree: worktree(), ...(i ? { parallel: true } : {}) }));
      for (const [i, t] of tickets.entries()) {
        await call("note_progress", { key: t.key, text: `${t.key} green` });
        expect(await call("link_code", { key: t.key, prUrl: `https://github.com/acme/plugins/pull/${i + 3}`, scopeChecked: true })).toMatchObject({ status: "verifying", branch: claims[i].branch });
      }
      expect(new Set(tickets.map((t) => codeLink.sessionsOf(project.id, t.id)[0].id)).size).toBe(4);
      for (const t of tickets) expect(codeLink.sessionsOf(project.id, t.id)).toMatchObject([{ itemIds: [t.id], summary: `${t.key} green` }]);
      for (const [i, t] of tickets.entries()) {
        await ctx.tools.execute("link_code", { key: t.key, prUrl: `https://github.com/acme/plugins/pull/${i + 3}`, prState: "merged" }, { by: "human", projectId: project.id });
        expect(items.get(project.id, t.id)!.status).toBe("done");
        expect(tickets.slice(i + 1).every((rest) => items.get(project.id, rest.id)!.status === "verifying")).toBe(true);
      }
    } finally {
      await client.close();
    }
  });

  it("follows a client with no hooks through every ticket it claimed in parallel, until its connection closes", async () => {
    const { codeLink, ctx, items, project, board } = await machine();
    const a = items.create({ projectId: project.id, boardId: board.id, title: "Alpha", status: "todo", by: "human" });
    const b = items.create({ projectId: project.id, boardId: board.id, title: "Beta", status: "todo", by: "human" });
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-cursor-par" };
    const first = (await ctx.tools.execute("claim_ticket", { key: a.key }, inv)) as Claimed;
    const second = (await ctx.tools.execute("claim_ticket", { key: b.key, parallel: true }, inv)) as Claimed;
    expect(codeLink.store.session(project.id, second.tracking.sessionId)).toMatchObject({ agent: "mcp", itemIds: [b.id] });
    expect(await ctx.tools.execute("note_progress", { key: a.key, text: "alpha" }, inv)).toMatchObject({ ok: true, key: a.key });
    expect(codeLink.store.session(project.id, first.tracking.sessionId)!.summary).toBe("alpha");
    // Another client's connection is told the ticket is held; taking it over, it claims on its own, untouched by these.
    expect(await ctx.tools.execute("claim_ticket", { key: b.key }, { ...inv, connection: "conn-else" })).toMatchObject({ claimed: false, heldBy: [{ sessionId: second.tracking.sessionId }] });
    const elsewhere = (await ctx.tools.execute("claim_ticket", { key: b.key, takeOver: true }, { ...inv, connection: "conn-else" })) as Claimed;
    expect([first.tracking.sessionId, second.tracking.sessionId]).not.toContain(elsewhere.tracking.sessionId);
    ctx.emit("mcp/closed", "conn-cursor-par");
    expect(codeLink.store.session(project.id, first.tracking.sessionId)!.state).toBe("ended");
  });
});

describe("the branch a claim suggested, when the work went elsewhere", () => {
  type Claimed = { branch: string; tracking: { sessionId: string } };
  const setup = async () => {
    const world = await machine();
    const { items, project, board, checkout } = world;
    const ticket = (title: string) => items.create({ projectId: project.id, boardId: board.id, title, status: "todo", by: "human" });
    const push = (branch: string, file: string, message: string) => {
      git(["checkout", "-q", "-B", branch, "main"], checkout);
      fs.writeFileSync(path.join(checkout, file), `${message}\n`);
      git(["add", "-A"], checkout);
      git(["commit", "-q", "-m", message], checkout);
      git(["push", "-q", "origin", branch], checkout);
    };
    const squash = (branch: string, message: string) => {
      git(["checkout", "-q", "main"], checkout);
      git(["merge", "-q", "--squash", branch], checkout);
      git(["commit", "-q", "-m", message], checkout);
      git(["push", "-q", "origin", "main"], checkout);
    };
    return { ...world, ticket, push, squash };
  };
  const branches = (codeLink: CodeLink, projectId: string, itemId: string) => codeLink.links(projectId, itemId).map((l) => l.branch);

  it("drops the empty suggested branch once link_code names another, and finishes on the squash merge", async () => {
    const { codeLink, ctx, items, project, ticket, push, squash } = await setup();
    const item = ticket("Worked elsewhere");
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-elsewhere" };
    const claimed = (await ctx.tools.execute("claim_ticket", { key: item.key }, inv)) as Claimed;
    expect(branches(codeLink, project.id, item.id)).toEqual([claimed.branch]);

    const branch = `tom-${item.keyNum}/actual-work`;
    push(branch, "work.ts", `${item.key}: the work`);
    expect(await ctx.tools.execute("link_code", { branch, prUrl: "https://github.com/acme/app/pull/7", scopeChecked: true }, inv)).toMatchObject({ status: "verifying", branch });
    expect(branches(codeLink, project.id, item.id)).toEqual([branch]);
    expect(codeLink.store.session(project.id, claimed.tracking.sessionId)?.branch).toBe(branch);

    squash(branch, `${item.key}: the work (#7)`);
    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)?.status).toBe("done");
  });

  it("keeps a suggested branch that holds commits or a pull request", async () => {
    const { codeLink, ctx, project, ticket, push } = await setup();
    const committed = ticket("Commits on the suggestion");
    const a = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-commits" };
    const first = (await ctx.tools.execute("claim_ticket", { key: committed.key }, a)) as Claimed;
    push(first.branch, "first.ts", `${committed.key}: started here`);
    await codeLink.scan(project.id);
    await ctx.tools.execute("link_code", { branch: `tom-${committed.keyNum}/second`, scopeChecked: true }, a);
    expect(branches(codeLink, project.id, committed.id)).toEqual([first.branch, `tom-${committed.keyNum}/second`]);
    expect(codeLink.store.session(project.id, first.tracking.sessionId)?.branch).toBe(first.branch);

    const opened = ticket("Pull request on the suggestion");
    const b = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-pr" };
    const second = (await ctx.tools.execute("claim_ticket", { key: opened.key }, b)) as Claimed;
    await ctx.tools.execute("link_code", { prUrl: "https://github.com/acme/app/pull/8", scopeChecked: true }, b);
    await ctx.tools.execute("link_code", { branch: `tom-${opened.keyNum}/follow-up`, prUrl: "https://github.com/acme/app/pull/9", scopeChecked: true }, b);
    expect(branches(codeLink, project.id, opened.id)).toEqual([second.branch, `tom-${opened.keyNum}/follow-up`]);
  });

  it("changes nothing when link_code names the suggested branch itself", async () => {
    const { codeLink, ctx, project, ticket } = await setup();
    const item = ticket("Worked as suggested");
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-as-suggested" };
    const claimed = (await ctx.tools.execute("claim_ticket", { key: item.key }, inv)) as Claimed;
    await ctx.tools.execute("link_code", { branch: claimed.branch, prUrl: "https://github.com/acme/app/pull/10", scopeChecked: true }, inv);
    expect(codeLink.links(project.id, item.id)).toEqual([expect.objectContaining({ branch: claimed.branch, prNumber: 10 })]);
    expect(codeLink.store.session(project.id, claimed.tracking.sessionId)?.branch).toBe(claimed.branch);
  });

  it("clears a suggested branch an earlier version left beside the pull request, and finishes the ticket", async () => {
    const { codeLink, ctx, items, project, repo, ticket, push, squash } = await setup();
    const item = ticket("Linked before the fix");
    const inv = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-before" };
    const claimed = (await ctx.tools.execute("claim_ticket", { key: item.key }, inv)) as Claimed;
    const branch = `tom-${item.keyNum}/actual-work`;
    push(branch, "work.ts", `${item.key}: the work`);
    // What link_code used to leave: the pull request's branch beside the claim's, the session still on the claim's.
    codeLink.store.upsertLink(project.id, { itemId: item.id, repoId: repo.id, branch, delivery: 1 }, { prNumber: 5, prUrl: "https://github.com/acme/app/pull/5", prState: "open", source: "mcp" });
    squash(branch, `${item.key}: the work (#5)`);

    await codeLink.scan(project.id);
    expect(branches(codeLink, project.id, item.id)).toEqual([branch]);
    expect(codeLink.store.session(project.id, claimed.tracking.sessionId)?.branch).toBe(branch);
    expect(items.get(project.id, item.id)?.status).toBe("done");
  });
});

describe("a developer's own Codex session", () => {
  it("uses generated hooks to report start, claim, progress and end with its source", async () => {
    const { codeLink, ctx, items, project, board, repo, checkout } = await machine();
    writeConnectFiles(checkout, { projectName: project.name, mcpUrl: ctx.mcp.urlFor(project.id)!, eventUrl: ctx.mcp.eventUrl!, prefix: "TOM", branchTemplate: "{key}/{slug}" });
    const config = parseToml(fs.readFileSync(path.join(checkout, ".codex/config.toml"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    // Execute the generated shell hook asynchronously so this process can serve HTTP.
    const { execFile } = await import("node:child_process");
    const post = (event: string) => new Promise<void>((resolve, reject) => {
      const child = execFile("sh", ["-c", config.hooks[event][0].hooks[0].command], { cwd: checkout }, (err) => err ? reject(err) : resolve());
      child.stdin!.end(JSON.stringify({ hook_event_name: event, session_id: "codex-cli-1", cwd: checkout }));
    });
    await post("SessionStart");
    const [session] = codeLink.sessionsOf(project.id);
    expect(session).toMatchObject({ agent: "codex", repoId: repo.id, externalId: "codex-cli-1", state: "running" });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Codex work", by: "human" });
    const inv = { by: "ai:mcp", projectId: project.id };
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, inv)).toMatchObject({ tracking: { tracked: true, sessionId: session.id } });
    expect(await ctx.tools.execute("note_progress", { key: item.key, text: "Codex tests green" }, inv)).toMatchObject({ ok: true });
    await post("Stop");
    expect(codeLink.sessionsOf(project.id)[0].state).toBe("waiting");
    await post("SessionEnd");
    expect(codeLink.sessionsOf(project.id)[0].state).toBe("ended");
  });
});

describe("a developer's own WorkBuddy session", () => {
  it("is followed through its own hooks and claims a ticket as WorkBuddy", async () => {
    const { codeLink, ctx, items, project, board, repo, checkout } = await machine();
    writeConnectFiles(checkout, { projectName: project.name, mcpUrl: ctx.mcp.urlFor(project.id)!, eventUrl: ctx.mcp.eventUrl!, prefix: "TOM", branchTemplate: "{key}/{slug}" });
    const settings = JSON.parse(fs.readFileSync(path.join(checkout, ".codebuddy/settings.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const { execFile } = await import("node:child_process");
    // As CodeBuddy 2.155 posts them: SessionStart names no cwd, so the session is first heard at the prompt.
    const post = (event: string) => new Promise<void>((resolve, reject) => {
      const child = execFile("sh", ["-c", settings.hooks[event][0].hooks[0].command], { cwd: checkout }, (err) => err ? reject(err) : resolve());
      child.stdin!.end(JSON.stringify({ hook_event_name: event, session_id: "codebuddy-1", ...(event === "SessionStart" ? { source: "startup" } : { cwd: checkout }) }));
    });
    await post("SessionStart");
    expect(codeLink.sessionsOf(project.id)).toEqual([]);
    await post("UserPromptSubmit");
    const [session] = codeLink.sessionsOf(project.id);
    expect(session).toMatchObject({ agent: "workbuddy", repoId: repo.id, externalId: "codebuddy-1", state: "running" });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "WorkBuddy work", by: "human" });
    const inv = { by: "ai:mcp", projectId: project.id };
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, inv)).toMatchObject({ tracking: { tracked: true, sessionId: session.id } });
    await post("Stop");
    expect(codeLink.sessionsOf(project.id)[0].state).toBe("waiting");
    await post("SessionEnd");
    expect(codeLink.sessionsOf(project.id)[0].state).toBe("ended");
  });
});

describe("a developer's own Pi session", () => {
  it("is followed through the project extension's reports and claims a ticket as Pi", async () => {
    const { codeLink, ctx, items, project, board, repo, checkout } = await machine();
    // What .pi/extensions/tomrade.ts posts, as pi 1.3 runs it.
    const post = (event: string) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "content-type": "application/json", "x-tomrade-agent": "pi" },
      body: JSON.stringify({ session_id: "pi-1", cwd: checkout, hook_event_name: event }) });
    await post("SessionStart");
    const [session] = codeLink.sessionsOf(project.id);
    expect(session).toMatchObject({ agent: "pi", repoId: repo.id, externalId: "pi-1", state: "running" });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Pi work", by: "human" });
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, { by: "ai:mcp", projectId: project.id })).toMatchObject({ tracking: { tracked: true, sessionId: session.id } });
    await post("Stop");
    expect(codeLink.sessionsOf(project.id)[0].state).toBe("waiting");
    await post("SessionEnd");
    expect(codeLink.sessionsOf(project.id)[0].state).toBe("ended");
  });
});

describe("a developer's own OpenCode session", () => {
  it("is followed through the plugin's reports and claims a ticket as OpenCode", async () => {
    const { codeLink, ctx, items, project, board, repo, checkout } = await machine();
    // What .opencode/plugins/tomrade.js posts, as OpenCode 1.19 runs it.
    const post = (event: string) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "content-type": "application/json", "x-tomrade-agent": "opencode" },
      body: JSON.stringify({ session_id: "ses_oc1", cwd: checkout, hook_event_name: event }) });
    await post("SessionStart");
    const [session] = codeLink.sessionsOf(project.id);
    expect(session).toMatchObject({ agent: "opencode", repoId: repo.id, externalId: "ses_oc1", state: "running" });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "OpenCode work", by: "human" });
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, { by: "ai:mcp", projectId: project.id })).toMatchObject({ tracking: { tracked: true, sessionId: session.id } });
    await post("Stop");
    expect(codeLink.sessionsOf(project.id)[0].state).toBe("waiting");
  });
});

describe("a developer's own Cursor session", () => {
  it("is followed through .cursor/hooks.json in Cursor's own event names, and its last reply becomes the summary", async () => {
    const { codeLink, ctx, items, project, board, repo, checkout } = await machine();
    // What cursor-agent 2026.10.16 pipes to each hook, trimmed.
    const post = (payload: Record<string, unknown>) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "content-type": "application/json", "x-tomrade-agent": "cursor" },
      body: JSON.stringify({ conversation_id: "conv-1", generation_id: "gen-1", session_id: "conv-1", cursor_version: "2026.10.16-e3cb207", workspace_roots: [checkout], transcript_path: null, ...payload }) });
    await post({ hook_event_name: "beforeSubmitPrompt", prompt: "fix it" });
    const [session] = codeLink.sessionsOf(project.id);
    expect(session).toMatchObject({ agent: "cursor", repoId: repo.id, externalId: "conv-1", state: "running" });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Cursor work", by: "human" });
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, { by: "ai:mcp", projectId: project.id })).toMatchObject({ tracking: { tracked: true, sessionId: session.id } });
    await post({ hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: "pnpm test" } });
    expect(codeLink.sessionsOf(project.id)[0]).toMatchObject({ state: "running", activity: "Bash · pnpm test" });
    await post({ hook_event_name: "afterAgentResponse", text: "Tests pass now.\nDetails follow." });
    expect(codeLink.sessionsOf(project.id)[0].state).toBe("running");
    await post({ hook_event_name: "stop", status: "completed", loop_count: 0 });
    expect(codeLink.sessionsOf(project.id)[0]).toMatchObject({ state: "waiting", summary: "Tests pass now." });
    await post({ hook_event_name: "sessionEnd", reason: "completed", final_status: "completed" });
    expect(codeLink.sessionsOf(project.id)[0].state).toBe("ended");
  });

  it("hears Tomrade's answer in its own fields: held at its first change without a ticket, let through on a claim, and always told a decision", async () => {
    const { codeLink, ctx, items, project, board, checkout } = await machine();
    const post = async (payload: Record<string, unknown>) =>
      (await fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "content-type": "application/json", "x-tomrade-agent": "cursor" },
        body: JSON.stringify({ conversation_id: "conv-2", session_id: "conv-2", cursor_version: "2026.10.16-e3cb207", workspace_roots: [checkout], ...payload }) })).json() as Promise<Record<string, unknown>>;
    expect(await post({ hook_event_name: "sessionStart" })).toEqual({ additional_context: expect.stringContaining("holds no ticket") });
    await until(() => codeLink.sessionsOf(project.id).length === 1);
    expect(await post({ hook_event_name: "preToolUse", tool_name: "Read", tool_input: { file_path: path.join(checkout, "README.md") } })).toEqual({ permission: "allow" });
    const held = await post({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { file_path: path.join(checkout, "README.md") } });
    expect(held).toMatchObject({ permission: "deny", agent_message: expect.stringContaining("work_without_ticket"), user_message: expect.any(String) });
    expect(await post({ hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: "git commit -am x" } })).toMatchObject({ permission: "deny" });
    // An event Cursor reads no answer on, and one from nowhere Tomrade knows, both get an empty object — never a stray field.
    expect(await post({ hook_event_name: "afterAgentResponse", text: "Working." })).toEqual({});
    expect(await post({ hook_event_name: "preToolUse", workspace_roots: [os.tmpdir()], tool_name: "Write", tool_input: { file_path: path.join(os.tmpdir(), "x") } })).toEqual({ permission: "allow" });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Cursor change", by: "human" });
    expect(await ctx.tools.execute("claim_ticket", { key: item.key }, { by: "ai:mcp", projectId: project.id, connection: "conn-cursor" })).toMatchObject({ tracking: { tracked: true } });
    expect(await post({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { file_path: path.join(checkout, "README.md") } })).toEqual({ permission: "allow" });
    expect(await post({ hook_event_name: "sessionStart" })).toEqual({});
  });
});

describe("a developer's own Claude Code session", () => {
  it("is followed through tokenless hooks, claims a ticket, and hands it the branch to use", async () => {
    const { codeLink, ctx, items, project, board, repo, checkout } = await machine();
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Offline work", status: "todo", by: "human" });
    const post = async (payload: unknown) => (await fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).status;

    expect(await post({ hook_event_name: "SessionStart", session_id: "cli-9", cwd: path.join(checkout, "src") })).toBe(200);
    const [session] = codeLink.sessionsOf(project.id);
    expect(session).toMatchObject({ mode: "terminal", threadId: null, repoId: repo.id, externalId: "cli-9", state: "running", itemIds: [] });

    const inv = { by: "ai:claude-code" as const, projectId: project.id, connection: "conn-cli-9" };
    const claimed = (await ctx.tools.execute("claim_ticket", { key: item.key }, inv)) as { branch: string; status: string; repository: { name: string } };
    expect(claimed.status).toBe("doing");
    expect(claimed).toMatchObject({ tracking: { tracked: true } });
    expect(claimed.branch).toBe(`tom-${item.keyNum}/offline-work`);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ id: session.id, itemIds: [item.id], branch: claimed.branch });
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ branch: claimed.branch, source: "mcp" });

    // No token: the connection that claimed says whose the note is, with or without the key.
    expect(await ctx.tools.execute("note_progress", { text: "parser done" }, inv)).toMatchObject({ ok: true, key: item.key });
    expect(codeLink.sessionsOf(project.id, item.id)[0].summary).toBe("parser done");
    expect(await ctx.tools.execute("note_progress", { key: item.key, text: "lexer done" }, inv)).toMatchObject({ ok: true });

    const other = items.create({ projectId: project.id, boardId: board.id, title: "Separate work", status: "todo", by: "human" });
    await expect(ctx.tools.execute("claim_ticket", { key: other.key }, inv)).rejects.toThrow(`this session still owns ${item.key}`);
    expect(items.get(project.id, other.id)!.status).toBe("todo");
    expect(await ctx.tools.execute("note_progress", { key: other.key, text: "x" }, { by: "ai:claude-code", projectId: project.id })).toMatchObject({
      ok: false,
      warning: expect.stringContaining(`Tomrade is not tracking a session on ${other.key}`)
    });

    await post({ hook_event_name: "Stop", session_id: "cli-9", cwd: checkout });
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("waiting");
    await post({ hook_event_name: "SessionEnd", session_id: "cli-9", cwd: checkout });
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("ended");
    // A hook from somewhere Tomrade does not know is ignored.
    expect(await post({ hook_event_name: "SessionStart", session_id: "x", cwd: os.tmpdir() })).toBe(200);
    expect(codeLink.sessionsOf(project.id)).toHaveLength(1);
  });

  it("tells Claude Code which config folder a session ran under, from its transcript", async () => {
    const { ctx, checkout } = await machine();
    const seen: string[] = [];
    const missing = { state: "missing", url: null, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" } } as const;
    ctx.agent.engine({ id: "claude-code", title: "Claude Code", author: "ai:claude-code", available: async () => ({ ok: true }), turn: async () => ({ stop: "end" }),
      mcpLink: { status: async () => missing, connect: async () => missing, disconnect: async () => missing, sawTranscript: (file) => seen.push(file) } });
    const transcript = "/Users/a/.claude-tom/projects/-repo/cli-7.jsonl";
    await fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cli-7", cwd: checkout, transcript_path: transcript }) });
    expect(seen).toEqual([transcript]);
  });

  it("turns a branch nobody's ticket names into a ticket, linked from the start", async () => {
    const { codeLink, ctx, project, repo, checkout } = await machine();
    git(["checkout", "-q", "-b", "tom-777/dark-mode-toggle", "main"], checkout);
    fs.writeFileSync(path.join(checkout, "dark.ts"), "export {};\n");
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "dark mode"], checkout);
    await codeLink.scan(project.id);
    expect(codeLink.unlinked(project.id)).toMatchObject([{ branch: "tom-777/dark-mode-toggle", keyNum: 777 }]);

    const item = codeLink.adoptBranch(project.id, repo.id, "tom-777/dark-mode-toggle");
    expect(item.title).toBe("Dark mode toggle");
    expect(codeLink.unlinked(project.id)).toEqual([]);
    await codeLink.scan(project.id);
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ branch: "tom-777/dark-mode-toggle", source: "manual", ahead: 1 });
    expect(ctx.items.get(project.id, item.id)!.status).toBe("doing");
  });
});

describe("the last hook event this machine heard from each agent", () => {
  it("shows on the connection, never in the project's export, and reaches the database once a minute", async () => {
    const { codeLink, ctx, db, project, repo, checkout } = await machine();
    writeConnectFiles(checkout, { projectName: project.name, mcpUrl: ctx.mcp.urlFor(project.id)!, eventUrl: ctx.mcp.eventUrl!, prefix: "TOM", branchTemplate: "{key}/{slug}" });
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "connect"], checkout);
    codeLink.setRepoPolicy(project.id, repo.id, { connectAgents: ["claude-code", "codex"] });
    const heard = async (agent: string) => (await codeLink.connection(project.id, repo.id)).agents.find((a) => a.id === agent)!.lastEventAt;
    expect((await codeLink.connection(project.id, repo.id)).state).toBe("connected");
    expect(await heard("claude-code")).toBeUndefined();

    const registrations = ctx.db.registrations("project");
    const digest = () => digestState(exportState(db, project.id, { registrations, exports: ["code_link"] }));
    // Setting the checkout started a scan that writes the exported repository state; joining it keeps that out of the comparison.
    await codeLink.scan(project.id);
    const exported = digest();
    const writes = vi.spyOn(codeLink.store, "noteHookHeard");
    const post = (payload: Record<string, unknown>) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "cli-h", cwd: checkout, ...payload }) });
    // The test moves the clock, so "within a minute" never depends on how busy the machine is.
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      // Claude Code posts around every tool call.
      await post({ hook_event_name: "SessionStart" });
      vi.setSystemTime(start + 30_000);
      await post({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" } });
      vi.setSystemTime(start + 59_999);
      await post({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" } });
      expect(writes).toHaveBeenCalledTimes(1);
      expect(codeLink.store.hooksHeard(project.id, repo.id)["claude-code"]).toBe(start);
      expect(await heard("claude-code")).toBe(start + 59_999);
      expect(await heard("codex")).toBeUndefined();
      expect(digest()).toBe(exported);

      // A minute on, the next one is written down again.
      vi.setSystemTime(start + 60_000);
      await post({ hook_event_name: "PreToolUse", tool_name: "Read" });
      expect(writes).toHaveBeenCalledTimes(2);
      expect(codeLink.store.hooksHeard(project.id, repo.id)["claude-code"]).toBe(start + 60_000);
      expect(digest()).toBe(exported);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a checkout learnt from a session's hooks", () => {
  it("places a repository with no checkout here at the main working tree of the worktree a session runs in", async () => {
    const { ctx, project, checkout, remote } = await machine();
    const post = (payload: unknown) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const elsewhere = codeRepo();
    ctx.repos.create({ projectId: project.id, remote: elsewhere.remote });
    const worktree = path.join(root, `worktree-${n++}`);
    git(["worktree", "add", "-q", "-b", "tom-1/work", worktree], elsewhere.checkout);
    const unrelated = codeRepo();

    await post({ hook_event_name: "SessionStart", session_id: "cli-wt", cwd: unrelated.checkout });
    await post({ hook_event_name: "SessionStart", session_id: "cli-wt", cwd: worktree });
    // The hook's answer is git asking the worktree for its main checkout; under load that takes longer than the 1 s default.
    await vi.waitFor(() => expect(ctx.repos.checkout(elsewhere.remote).checkout).not.toBeNull(), { timeout: 10_000 });
    expect(fs.realpathSync(ctx.repos.checkout(elsewhere.remote).checkout!)).toBe(fs.realpathSync(elsewhere.checkout));
    // A repository placed already keeps its checkout; a folder no project repository names places nothing.
    expect(ctx.repos.checkout(remote).checkout).toBe(checkout);
    expect(ctx.repos.checkouts()).toHaveLength(2);
  });
});

describe("syncing a session back", () => {
  it("offers /tomrade:sync for the session's project and tells every unbound client a ticket is never required", async () => {
    const { ctx, project } = await machine();
    const client = new Client({ name: "cli", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.urlFor(project.id)!)));
      expect((await client.listPrompts()).prompts).toMatchObject([{ name: "sync", title: "Sync with Tomrade" }]);
      const prompt = await client.getPrompt({ name: "sync" });
      const text = (prompt.messages[0]!.content as { text: string }).text;
      expect(text).toContain(`project "${project.name}" (ticket keys look like ${project.keyPrefix}-42)`);
      expect(text).toContain("Work that matches no ticket stays unmatched");
      expect(text).toContain("never mark a code ticket done yourself");
      expect(client.getInstructions()).toContain("ask them first");
      expect(client.getInstructions()).toContain("claim_ticket that key once");
    } finally {
      await client.close();
    }

    expect(client.getInstructions()).not.toContain("Project rules");

    const bare = new Client({ name: "bare", version: "0" });
    try {
      await bare.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!)));
      const text = ((await bare.getPrompt({ name: "sync" })).messages[0]!.content as { text: string }).text;
      expect(text).toContain("call list_projects and pass projectId");
    } finally {
      await bare.close();
    }
  });

  it("hands the project's rules to an agent Tomrade did not start, ahead of everything else", async () => {
    const { ctx, project } = await machine();
    const connect = async () => {
      const client = new Client({ name: "cli", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.urlFor(project.id)!)));
      return client;
    };
    ctx.agent.setRules(project.id, "- Write tickets in Chinese\n- Never touch billing");
    let client = await connect();
    try {
      const instructions = client.getInstructions()!;
      expect(instructions.startsWith("Project rules")).toBe(true);
      expect(instructions).toContain("- Write tickets in Chinese\n- Never touch billing");
      expect(instructions.indexOf("Never touch billing")).toBeLessThan(instructions.indexOf("Before changing code"));
      const read = await client.callTool({ name: "get_project_rules", arguments: {} });
      expect(JSON.parse((read.content as { text: string }[])[0]!.text)).toEqual({ rules: "- Write tickets in Chinese\n- Never touch billing" });
    } finally {
      await client.close();
    }

    // Too long to inline within Claude Code's 2048 characters: a pointer to the tool instead.
    ctx.agent.setRules(project.id, Array.from({ length: 40 }, (_, i) => `- Rule number ${i} about how to work here`).join("\n"));
    client = await connect();
    try {
      const instructions = client.getInstructions()!;
      expect(instructions).toContain("call get_project_rules before you start");
      expect(instructions).not.toContain("Rule number 0");
      expect(instructions.length).toBeLessThan(2048);
    } finally {
      await client.close();
    }
  });
});
