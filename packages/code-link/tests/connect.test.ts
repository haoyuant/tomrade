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
import { afterAll, describe, expect, it, vi } from "vitest";
import { Agent } from "@tomradex/agent";
import { CodeLink, hookCommand, posixHookCommand, writeConnectFiles } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import { Mcp } from "@tomradex/mcp";
import { Repos } from "@tomradex/repos";
import GitHubAccount from "@tomradex/github";
import { Settings } from "@tomradex/settings";
import { Storage, digestState, exportState } from "@tomradex/storage";
import { fresh, settle } from "@tomradex/testkit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Tools } from "@tomradex/tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-connect-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
/** Built once with git, then copied: every spawn costs, and a fresh repository is the same bytes each time. */
let template: { remote: string; checkout: string } | null = null;
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

async function machine() {
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
      [CodeLink, { scanMs: 0 }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  const row = bag.ctx.repos.create({ projectId: bag.project.id, remote: repo.remote });
  bag.boards.update(bag.project.id, bag.board.id, { repoId: row.id });
  await bag.ctx.repos.setCheckout(repo.remote, repo.checkout);
  // GitHub is never asked from a test; one that needs its answer sets its own.
  bag.ctx.codeLink.pulls = async () => null;
  return { ...bag, codeLink: bag.ctx.codeLink, repo: row, checkout: repo.checkout, remote: repo.remote };
}

describe("connecting a repository", () => {
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
    expect(text).toContain('# BEGIN TOMRADE MCP\n[mcp_servers.tomrade]\nurl = "http://127.0.0.1:19090/mcp/p1"\n# END TOMRADE MCP');
    expect(text).not.toContain("X-Tomrade-Agent");
    expect(parseToml(text)).toMatchObject({ hooks: { SessionStart: [{ hooks: [{ command: "echo custom" }] }] } });
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

  it("gives Pi a project extension that reaches this project and reports to Tomrade", () => {
    const dir = path.join(root, `pi-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(dir, input);
    const source = fs.readFileSync(path.join(dir, ".pi/extensions/tomrade.ts"), "utf8");
    expect(source).toContain(`const server = {"url":"${input.mcpUrl}"`);
    expect(source).toContain(`const eventUrl = "${input.eventUrl}";`);
    expect(source).toContain('"x-tomrade-agent": "pi"');
    expect(writeConnectFiles(dir, input).files).toEqual([]);
    expect(writeConnectFiles(dir, { ...input, mcpUrl: "http://127.0.0.1:19091/mcp/p1", eventUrl: "http://127.0.0.1:19091/sessions/event" }).files).toContain(".pi/extensions/tomrade.ts");
  });

  it("gives OpenCode a tomrade server in opencode.json and a reporting plugin, keeping the project's own config", () => {
    const dir = path.join(root, `opencode-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "deepseek/deepseek-flash" }));
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    expect(writeConnectFiles(dir, input).files).toEqual(expect.arrayContaining(["opencode.json", ".opencode/plugins/tomrade.js"]));
    expect(JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"))).toEqual({ $schema: "https://opencode.ai/config.json", model: "deepseek/deepseek-flash",
      mcp: { tomrade: { type: "remote", url: input.mcpUrl, enabled: true, headers: { "X-Tomrade-Run": "{env:TOMRADE_MCP_TOKEN}" } } } });
    const plugin = fs.readFileSync(path.join(dir, ".opencode/plugins/tomrade.js"), "utf8");
    expect(plugin).toContain(`const eventUrl = "${input.eventUrl}";`);
    expect(plugin).toContain('"x-tomrade-agent": "opencode"');
    expect(writeConnectFiles(dir, input).files).toEqual([]);
    // One it cannot read leaves OpenCode out and the file as it was.
    fs.writeFileSync(path.join(dir, "opencode.json"), "{ not json");
    expect(writeConnectFiles(dir, input)).toEqual({ files: [], skipped: [{ agent: "opencode", file: "opencode.json", reason: "invalid" }] });
    expect(fs.readFileSync(path.join(dir, "opencode.json"), "utf8")).toBe("{ not json");
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
      expect(text).toContain(quoted(hookCommand(input.eventUrl, agent)));
      fs.writeFileSync(path.join(checkout, file), text.split(quoted(hookCommand(input.eventUrl, agent))).join(quoted(posixHookCommand(input.eventUrl, agent, { pane }))));
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
    expect(fs.readFileSync(path.join(checkout, ".claude/settings.json"), "utf8")).toContain(JSON.stringify(hookCommand(input.eventUrl)).slice(1, -1));
    expect(fs.readFileSync(path.join(checkout, ".codex/config.toml"), "utf8")).not.toContain(JSON.stringify(posixHookCommand(input.eventUrl, "codex", { pane })).slice(1, -1));
    expect(fs.readFileSync(cursorHooks, "utf8")).not.toContain("tomrade.sh");
    expect(fs.existsSync(path.join(checkout, ".cursor/hooks/tomrade.ps1"))).toBe(true);
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
    expect(git(["branch", "--list", "tomrade/connect"], checkout)).toBe("");
    expect(git(["ls-remote", "--heads", remote, "tomrade/connect"], checkout)).toBe("");
    expect(git(["worktree", "list"], checkout).split("\n")).toHaveLength(1);
    expect(fs.existsSync(path.join(checkout, ".mcp.json"))).toBe(false);
    expect(git(["status", "--porcelain"], checkout)).toBe("");
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
    expect(result.files.sort()).toEqual([".agents/skills/tomrade-sync/SKILL.md", ".claude/settings.local.json", ".codex/config.toml", ".mcp.json"]);
    expect(result.skipped).toEqual([{ agent: "cursor", file: ".cursor/mcp.json", reason: "tracked" }]);
    expect(result.message).toContain("this machine only");
    // Nothing for git to see: the files are excluded in this clone; the tracked one, the instructions and the team's settings file are untouched.
    expect(git(["status", "--porcelain"], checkout)).toBe("");
    expect(fs.readFileSync(path.join(checkout, ".git/info/exclude"), "utf8")).toContain("# Tomrade: agent connection files for this machine only\n/.mcp.json\n/.codex/config.toml\n");
    // Ignored either by Tomrade's exclude or already by this machine's global git excludes (Claude Code adds one when it writes the file).
    expect(git(["check-ignore", ".claude/settings.local.json"], checkout)).toBe(".claude/settings.local.json");
    expect(fs.readFileSync(path.join(checkout, ".cursor/mcp.json"), "utf8")).not.toContain("tomrade");
    expect(fs.readFileSync(path.join(checkout, "CLAUDE.md"), "utf8")).not.toContain("Tomrade");
    expect(fs.existsSync(path.join(checkout, "AGENTS.md"))).toBe(false);
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
    expect(await codeLink.connect(project.id, repo.id, "local")).toMatchObject({ files: [], local: true, message: "Connected" });
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
    expect(result).toMatchObject({ branch: "tomrade/connect", committed: true, pushed: true });
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

  it("lets an outside session take the next ticket once its last one is done, from a fresh branch", async () => {
    const { codeLink, ctx, items, project, board } = await machine();
    const first = items.create({ projectId: project.id, boardId: board.id, title: "First", status: "todo", by: "human" });
    const next = items.create({ projectId: project.id, boardId: board.id, title: "Next", status: "todo", by: "human" });
    const a = { by: "ai:mcp" as const, projectId: project.id, connection: "conn-a" };
    const { tracking } = (await ctx.tools.execute("claim_ticket", { key: first.key }, a)) as { tracking: { sessionId: string } };
    items.update(project.id, first.id, { status: "done" }, "human");
    // Done as far as the ticket goes, while the terminal is still open.
    codeLink.store.patchSession(project.id, tracking.sessionId, { state: "running", endedAt: null });
    const claimed = (await ctx.tools.execute("claim_ticket", { key: next.key }, a)) as { branch: string; tracking: { sessionId: string }; conventions: string[] };
    expect(claimed.tracking.sessionId).toBe(tracking.sessionId);
    expect(claimed.conventions.some((c) => c.includes("from the latest") && c.includes("previous ticket"))).toBe(true);
    expect(codeLink.store.session(project.id, tracking.sessionId)).toMatchObject({ itemIds: [next.id], branch: claimed.branch });
    expect(await ctx.tools.execute("note_progress", { text: "on the next one" }, a)).toMatchObject({ ok: true, key: next.key });
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
    const claimed = (await ctx.tools.execute("claim_ticket", { key: next.key }, a)) as { key: string };
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
    const exported = digest();
    const writes = vi.spyOn(codeLink.store, "noteHookHeard");
    const post = (payload: Record<string, unknown>) => fetch(ctx.mcp.eventUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "cli-h", cwd: checkout, ...payload }) });
    const before = Date.now();
    // Claude Code posts around every tool call.
    await post({ hook_event_name: "SessionStart" });
    await post({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" } });
    await post({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" } });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await heard("claude-code")).toBeGreaterThanOrEqual(before);
    expect(await heard("codex")).toBeUndefined();
    expect(digest()).toBe(exported);

    // A minute on, the next one is written down again.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
    try {
      await post({ hook_event_name: "PreToolUse", tool_name: "Read" });
    } finally {
      vi.useRealTimers();
    }
    expect(writes).toHaveBeenCalledTimes(2);
    expect(codeLink.store.hooksHeard(project.id, repo.id)["claude-code"]).toBeGreaterThanOrEqual(before + 61_000);
    expect(digest()).toBe(exported);
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
      expect(client.getInstructions()).toContain("never ask the user to open a ticket before working");
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
      expect(instructions.indexOf("Never touch billing")).toBeLessThan(instructions.indexOf("never ask the user to open a ticket"));
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
