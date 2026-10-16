/**
 * The fast path for a developer's own terminal: a repository connected to
 * Tomrade (Claude and Codex MCP config, agent instructions, hooks) as a pull request, tokenless hooks that
 * still find their session by cwd, claim_ticket from such a session, and a
 * branch nobody's ticket names becoming a ticket.
 */
import { parse as parseToml } from "smol-toml";
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

    expect(writeConnectFiles(dir, input).sort()).toEqual([".agents/skills/tomrade-sync/SKILL.md", ".claude/settings.json", ".codex/config.toml", ".cursor/mcp.json", ".gemini/settings.json", ".mcp.json", "AGENTS.md", "CLAUDE.md"]);
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

  it("creates Claude hooks from nothing and merges Cursor/Gemini settings", () => {
    const dir = path.join(root, `agents-${n++}`);
    fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".gemini"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { existing: { command: "custom" } } }));
    fs.writeFileSync(path.join(dir, ".gemini/settings.json"), JSON.stringify({ theme: "dark", mcpServers: { existing: { command: "custom" } } }));
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(dir, input);
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    expect(read(".claude/settings.json").hooks.SessionStart[0].hooks[0].command).toContain(input.eventUrl);
    expect(read(".cursor/mcp.json")).toMatchObject({ mcpServers: { existing: { command: "custom" }, tomrade: { url: input.mcpUrl } } });
    expect(read(".gemini/settings.json")).toMatchObject({ theme: "dark", mcpServers: { existing: { command: "custom" }, tomrade: { httpUrl: input.mcpUrl } } });
    expect(writeConnectFiles(dir, input)).toEqual([]);
  });

  it.each([false, true])("preserves existing Codex hooks (inline arrays: %s), notify and settings", (inline) => {
    const dir = path.join(root, `codex-${n++}`);
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    const file = path.join(dir, ".codex/config.toml");
    fs.writeFileSync(file, 'notify = ["notify-me"]\nmodel = "example"\n' + (inline
      ? '[hooks]\nSessionStart = [{ hooks = [{ type = "command", command = "echo custom" }] }]\n'
      : '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo custom"\n'));
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(dir, input);
    const config = parseToml(fs.readFileSync(file, "utf8"));
    expect(config).toMatchObject({ notify: ["notify-me"], model: "example", hooks: { SessionStart: [{ hooks: [{ command: "echo custom" }] }, { hooks: [{ command: expect.stringContaining("X-Tomrade-Agent: codex") }] }] } });
    expect(writeConnectFiles(dir, input)).toEqual([]);
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

  it("updates all Tomrade hooks when connecting to another instance", () => {
    const dir = path.join(root, `reconnect-${n++}`);
    fs.mkdirSync(dir);
    const input = { projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl: "http://127.0.0.1:19090/sessions/event", prefix: "APP", branchTemplate: "{key}/{slug}" };
    writeConnectFiles(dir, input);
    const next = { ...input, mcpUrl: input.mcpUrl.replace("19090", "19091"), eventUrl: input.eventUrl.replace("19090", "19091") };
    expect(writeConnectFiles(dir, next)).toContain(".claude/settings.json");
    const hooks = fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8");
    expect(hooks).not.toContain("19090");
    expect(hooks).toContain(next.eventUrl);
    expect(writeConnectFiles(dir, next)).toEqual([]);
  });

  it("commits them on a branch of their own and pushes it, leaving the checkout alone", async () => {
    const { codeLink, project, repo, checkout, remote } = await machine();
    const result = await codeLink.connect(project.id, repo.id);
    expect(result).toMatchObject({ branch: "tomrade/connect", committed: true, pushed: true });
    expect(result.files.sort()).toEqual([".agents/skills/tomrade-sync/SKILL.md", ".claude/settings.json", ".codex/config.toml", ".cursor/mcp.json", ".gemini/settings.json", ".mcp.json", "AGENTS.md", "CLAUDE.md"]);
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
    expect(claimed.tracking.message).toContain(".codex/config.toml");
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
    await expect(ctx.tools.execute("claim_ticket", { key: second.key }, a)).rejects.toThrow(`this session still owns ${first.key}, which is doing`);
    items.update(project.id, first.id, { status: "verifying" }, "human");
    await expect(ctx.tools.execute("claim_ticket", { key: second.key }, a)).rejects.toThrow(`this session still owns ${first.key}, which is verifying`);
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
