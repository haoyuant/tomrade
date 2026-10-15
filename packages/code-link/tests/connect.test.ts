/**
 * The fast path for a developer's own terminal: a repository connected to
 * Tomrade (Claude and Codex MCP config, agent instructions, hooks) as a pull request, tokenless hooks that
 * still find their session by cwd, claim_ticket from such a session, and a
 * branch nobody's ticket names becoming a ticket.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Agent } from "@tomradex/agent";
import { CodeLink, writeConnectFiles } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import { Mcp } from "@tomradex/mcp";
import { Repos } from "@tomradex/repos";
import GitHubAccount from "@tomradex/github";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { fresh, settle } from "@tomradex/testkit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Tools } from "@tomradex/tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-connect-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
function codeRepo(): { remote: string; checkout: string } {
  const remote = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(["init", "--bare", "-b", "main", "."], remote);
  const checkout = path.join(root, `checkout-${n++}`);
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
  return { ...bag, codeLink: bag.ctx.codeLink, repo: row, checkout: repo.checkout, remote: repo.remote };
}

describe("connecting a repository", () => {
  it("writes the three files without disturbing what is there", () => {
    const dir = path.join(root, `files-${n++}`);
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x" } } }));
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".codex", "config.toml"), '[mcp_servers.other]\ncommand = "x"\n');
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# app\n\n## Tomrade\n\nold words\n\n## Layout\n\nkeep me\n");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agents\n\nKeep this.\n");
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(pnpm test)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };

    expect(writeConnectFiles(dir, input).sort()).toEqual([".agents/skills/tomrade-sync/SKILL.md", ".claude/settings.json", ".codex/config.toml", ".mcp.json", "AGENTS.md", "CLAUDE.md"]);
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
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain("Before your first reply in every session, call the `tomrade` MCP tool `get_project_rules`");
    expect(claude).not.toContain("get_project_rules");
    const skill = fs.readFileSync(path.join(dir, ".agents", "skills", "tomrade-sync", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: tomrade-sync\ndescription: "Bring .*\(project \\"App\\"\).*"\n---\n/);
    expect(skill).toContain("ticket keys look like APP-42");
    const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")) as { permissions: unknown; hooks: Record<string, unknown[]> };
    expect(settings.permissions).toEqual({ allow: ["Bash(pnpm test)"] });
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.SessionStart).toHaveLength(1);

    // Idempotent: a second pass changes nothing.
    expect(writeConnectFiles(dir, input)).toEqual([]);
  });

  it("commits them on a branch of their own and pushes it, leaving the checkout alone", async () => {
    const { codeLink, project, repo, checkout, remote } = await machine();
    const result = await codeLink.connect(project.id, repo.id);
    expect(result).toMatchObject({ branch: "tomrade/connect", committed: true, pushed: true });
    expect(result.files.sort()).toEqual([".agents/skills/tomrade-sync/SKILL.md", ".claude/settings.json", ".codex/config.toml", ".mcp.json", "AGENTS.md", "CLAUDE.md"]);
    // The remote has the branch with the files; the user's checkout was never touched.
    expect(git(["ls-remote", "--heads", remote, "tomrade/connect"], checkout)).toMatch(/tomrade\/connect/);
    git(["fetch", "-q", "origin"], checkout);
    expect(git(["show", "origin/tomrade/connect:.mcp.json"], checkout)).toContain("/mcp/");
    expect(git(["show", "origin/tomrade/connect:.codex/config.toml"], checkout)).toContain("mcp_servers.tomrade");
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
    expect(claimed.tracking.message).toContain(language === "zh" ? "未被 Tomrade 跟踪" : "not tracked by Tomrade");
    expect(claimed.conventions).not.toContain("call note_progress with one line at milestones");
    expect(items.get(project.id, item.id)?.status).toBe("doing");
    expect(codeLink.sessionsOf(project.id, item.id)).toEqual([]);
    for (const [tool, args] of [["note_progress", { text: "working" }], ["report_merge_blocked", { reason: "checks failed" }]] as const) {
      await expect(ctx.tools.execute(tool, { key: item.key, ...args }, inv)).rejects.toThrow(claimed.tracking.message);
    }
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

    const claimed = (await ctx.tools.execute("claim_ticket", { key: item.key }, { by: "ai:claude-code", projectId: project.id })) as { branch: string; status: string; repository: { name: string } };
    expect(claimed.status).toBe("doing");
    expect(claimed).toMatchObject({ tracking: { tracked: true } });
    expect(claimed.branch).toBe(`tom-${item.keyNum}/offline-work`);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ id: session.id, itemIds: [item.id], branch: claimed.branch });
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ branch: claimed.branch, source: "mcp" });

    // No token: the note finds the session through the ticket it claimed.
    expect(await ctx.tools.execute("note_progress", { key: item.key, text: "parser done" }, { by: "ai:claude-code", projectId: project.id })).toMatchObject({ ok: true });
    expect(codeLink.sessionsOf(project.id, item.id)[0].summary).toBe("parser done");

    const other = items.create({ projectId: project.id, boardId: board.id, title: "Separate work", status: "todo", by: "human" });
    await expect(ctx.tools.execute("claim_ticket", { key: other.key }, { by: "ai:claude-code", projectId: project.id })).rejects.toThrow(
      `this session already owns ${item.key}`
    );
    expect(items.get(project.id, other.id)!.status).toBe("todo");
    await expect(ctx.tools.execute("note_progress", { key: other.key, text: "x" }, { by: "ai:claude-code", projectId: project.id })).rejects.toThrow(
      `Tomrade is not tracking a session on ${other.key}`
    );

    await post({ hook_event_name: "Stop", session_id: "cli-9", cwd: checkout });
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("waiting");
    await post({ hook_event_name: "SessionEnd", session_id: "cli-9", cwd: checkout });
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("ended");
    // A hook from somewhere Tomrade does not know is ignored.
    expect(await post({ hook_event_name: "SessionStart", session_id: "x", cwd: os.tmpdir() })).toBe(200);
    expect(codeLink.sessionsOf(project.id)).toHaveLength(1);
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
