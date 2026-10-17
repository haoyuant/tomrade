/**
 * Start hands a ticket to a local coding agent: six gates, then a thread on
 * the ticket's branch in a worktree of its own, a session that follows the
 * agent, and the tools the agent reports back with. A fake code engine stands
 * in for Claude Code so the whole path runs offline.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Context } from "cordis";
import { Agent, type Engine, type TurnInput } from "@tomradex/agent";
import { fakeLlm } from "@tomradex/llm";
import { CodeLink, BOOTSTRAP_LABEL, sessionContext } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import { Repos } from "@tomradex/repos";
import GitHubAccount from "@tomradex/github";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { FakeHerdr, fresh, settle } from "@tomradex/testkit";
import { Herdr } from "@tomradex/herdr";
import { Tools, defineTool } from "@tomradex/tools";
import { z } from "zod";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-start-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
function codeRepo(opts: { manifest?: boolean } = {}): { remote: string; checkout: string } {
  const remote = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(["init", "--bare", "-b", "main", "."], remote);
  const checkout = path.join(root, `checkout-${n++}`);
  fs.mkdirSync(checkout, { recursive: true });
  git(["init", "-q", "-b", "main"], checkout);
  git(["remote", "add", "origin", remote], checkout);
  git(["config", "user.email", "dev@localhost"], checkout);
  git(["config", "user.name", "Dev"], checkout);
  fs.writeFileSync(path.join(checkout, "README.md"), "# app\n");
  if (opts.manifest !== false) fs.writeFileSync(path.join(checkout, "package.json"), '{ "name": "app" }\n');
  git(["add", "-A"], checkout);
  git(["commit", "-q", "-m", "initial"], checkout);
  git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);
  return { remote, checkout };
}

/** A repository with no remote: a folder of its own with one commit on main. */
function localRepo(): string {
  const folder = path.join(root, `local-${n++}`);
  fs.mkdirSync(folder);
  git(["init", "-q", "-b", "main"], folder);
  git(["config", "user.email", "dev@localhost"], folder);
  git(["config", "user.name", "Dev"], folder);
  fs.writeFileSync(path.join(folder, "package.json"), '{ "name": "app" }\n');
  git(["add", "-A"], folder);
  git(["commit", "-q", "-m", "initial"], folder);
  return folder;
}

function gitWithFailure(command: "ls-remote" | "push", stderr: string): string {
  const file = path.join(root, `git-${n++}`);
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "${command}" ]; then\n  echo "${stderr.replaceAll('"', '\\"')}" >&2\n  exit 128\nfi\nexec git "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** A code-capable engine that records what it was asked and makes one commit in the worktree. */
function fakeCodeEngine(turns: TurnInput[]): Engine {
  return {
    id: "fake-code",
    title: "Fake coding agent",
    author: "ai:fake-code",
    capabilities: ["backlog", "code", "general"],
    available: async () => ({ ok: true }),
    async turn(input, io) {
      turns.push(input);
      if (input.cwd && input.purpose === "code") {
        fs.writeFileSync(path.join(input.cwd, `work-${turns.length}.ts`), "export {};\n");
        git(["add", "-A"], input.cwd);
        git(["commit", "-q", "-m", `${input.ticket?.key ?? "TOM-0"}: work`], input.cwd);
      }
      io.emit({ type: "text", text: "done a step" });
      return { stop: "end", resume: "fake-session-1" };
    }
  };
}

async function machine(repo: { remote: string; checkout: string } | null, opts: { gitBinary?: string; defaultsPath?: string; llm?: (system: string, user: string) => unknown } = {}) {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const turns: TurnInput[] = [];
  const enginePlugin = { name: "fake-code-engine", inject: ["agent"], apply: (ctx: Context) => void ctx.agent.engine(fakeCodeEngine(turns)) };
  const bag = await fresh({
    hubDir,
    plugins: [
      Tools,
      [Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount,
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      [Repos, { gitBinary: opts.gitBinary ?? "git" }],
      Contributions,
      Agent,
      enginePlugin,
      ...(opts.llm ? [fakeLlm(opts.llm)] : []),
      [CodeLink, { scanMs: 0, gitBinary: opts.gitBinary ?? "git", defaultsPath: opts.defaultsPath ?? path.join(hubDir, "code-link.json") }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  let row = null as ReturnType<typeof bag.ctx.repos.create> | null;
  if (repo) {
    row = bag.ctx.repos.create({ projectId: bag.project.id, remote: repo.remote });
    bag.boards.update(bag.project.id, bag.board.id, { repoId: row.id });
  }
  const ticket = (title: string, status: "backlog" | "todo" | "doing" = "todo") => bag.items.create({ projectId: bag.project.id, boardId: bag.board.id, title, workType: "coding", status, by: "human" });
  // GitHub is never asked from a test; one that needs its answer sets its own.
  bag.ctx.codeLink.pulls = async () => null;
  return { ...bag, codeLink: bag.ctx.codeLink, agent: bag.ctx.agent, repo: row, checkout: repo?.checkout ?? null, hubDir, turns, ticket };
}

async function until(check: () => boolean, timeout = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("runs a ticket in a herdr workspace, follows the pane's status as the session's, and continues it in the same pane", async () => {
  const world = await machine(codeRepo());
  const { codeLink, ctx, project, repo, checkout, ticket } = world;
  await ctx.repos.setCheckout(repo!.remote, checkout!);
  const { Mcp } = await import("@tomradex/mcp");
  await ctx.plugin(Mcp, { port: 0 });
  const fake = new FakeHerdr();
  await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
  await settle();
  ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "herdr" } });
  const item = ticket("Herdr work");

  const result = await codeLink.start(project.id, item.id, { mode: "terminal" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // A workspace for the ticket, in its worktree, with the session's script typed into its pane.
  expect(result).toMatchObject({ mode: "terminal", launched: true, pane: "w1:p1" });
  expect(fake.of("workspace.create")).toEqual([{ cwd: result.cwd, label: item.key, focus: false }]);
  const dir = codeLink.sessionDir(result.sessionId);
  expect(fake.of("pane.send_input")).toEqual([{ pane_id: "w1:p1", text: `bash '${path.join(dir, "run.command")}'`, keys: ["enter"] }]);
  expect(codeLink.store.session(project.id, result.sessionId)).toMatchObject({ herdrPane: "w1:p1", state: "running" });
  const row = async () => (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!.rows.find((r) => r.label === "Session")!;
  expect((await row()).value).toContain("in herdr");
  await until(() => fake.of("events.subscribe").length === 2);

  // herdr's reading of the pane moves the session: blocked is "needs you", done a stop with what the screen says.
  fake.setStatus("w1:p1", "claude", "working");
  await until(() => codeLink.store.session(project.id, result.sessionId)!.lastEventAt !== null && codeLink.store.session(project.id, result.sessionId)!.state === "running");
  fake.setStatus("w1:p1", "claude", "blocked");
  await until(() => codeLink.store.session(project.id, result.sessionId)!.state === "waiting");
  expect(codeLink.store.session(project.id, result.sessionId)).toMatchObject({ state: "waiting", activity: "needs your approval" });
  expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "waiting" })]));
  fake.setStatus("w1:p1", "claude", "working");
  await until(() => codeLink.store.session(project.id, result.sessionId)!.state === "running");
  fake.panes.get("w1:p1")!.text = "⏺ Scaffold in place.\n╭────╮\n│ > │\n╰────╯\n? for shortcuts";
  fake.setStatus("w1:p1", "claude", "done");
  await until(() => codeLink.store.session(project.id, result.sessionId)!.state === "waiting");
  expect(codeLink.store.session(project.id, result.sessionId)!.summary).toBe("⏺ Scaffold in place.");
  // idle says nothing: the person may have looked, or not.
  fake.setStatus("w1:p1", "claude", "idle");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(codeLink.store.session(project.id, result.sessionId)!.state).toBe("waiting");

  // The session's own hook spoke: herdr's reading of the screen defers to it for a while.
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")) as { mcpServers: { tomrade: { headers: Record<string, string> } } };
  const token = mcpConfig.mcpServers.tomrade.headers["X-Tomrade-Run"];
  await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hook_event_name: "Stop", session_id: "cli-h", last_assistant_message: "Hooks say: done with tests." }) });
  expect(codeLink.store.session(project.id, result.sessionId)).toMatchObject({ state: "waiting", summary: "Hooks say: done with tests." });
  fake.setStatus("w1:p1", "claude", "working");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(codeLink.store.session(project.id, result.sessionId)).toMatchObject({ state: "waiting", summary: "Hooks say: done with tests." });

  // Continue goes into the same pane as a prompt — no new workspace, the same token — and the prompt file is what it reads.
  const again = await codeLink.start(project.id, item.id, { mode: "terminal" });
  expect(again).toMatchObject({ ok: true, continued: true, launched: true, pane: "w1:p1", command: null, sessionId: result.sessionId });
  expect(fake.of("workspace.create").length).toBe(1);
  expect(fake.of("agent.prompt")).toEqual([{ target: "w1:p1", text: `Tomrade: continue this ticket — read ${path.join(dir, "prompt.md")} and follow it.` }]);
  expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toContain(item.key);
  expect(JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")).mcpServers.tomrade.headers["X-Tomrade-Run"]).toBe(token);
  expect(codeLink.store.session(project.id, result.sessionId)!.state).toBe("running");

  // The pane closing is the end of the session, whatever a hook said last; then Continue opens a new pane.
  fake.exit("w1:p1");
  await until(() => codeLink.store.session(project.id, result.sessionId)!.state === "ended");
  const fresh2 = await codeLink.start(project.id, item.id, { mode: "terminal" });
  expect(fresh2).toMatchObject({ ok: true, launched: true, pane: "w2:p1" });
  expect(fake.of("workspace.create").length).toBe(2);

  // herdr gone: the script is written and the person told to run it, and why.
  fake.stop();
  const alone = ticket("Alone");
  const without = await codeLink.start(project.id, alone.id, { mode: "terminal" });
  expect(without).toMatchObject({ ok: true, launched: false, pane: null, warnings: [expect.stringContaining("brew install herdr")] });
  expect(without.ok && without.command).toMatch(/^claude /);
  fake.close();
});

async function untilRunsSettle(agent: Agent, timeout = 8000) {
  const t0 = Date.now();
  while (agent.activeRuns().length) {
    if (Date.now() - t0 > timeout) throw new Error("runs did not settle");
    await new Promise((r) => setTimeout(r, 15));
  }
}

it("offers the connected account for credential failures, reprobes after switching, and supplies headless gh credentials", async () => {
  const local = codeRepo();
  const remote = "https://github.com/example/private-app";
  git(["remote", "set-url", "origin", remote], local.checkout);
  const binary = path.join(root, `git-credential-probe-${n++}`);
  fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "fetch" ]; then echo 'Repository not found' >&2; exit 128; fi\nif [ "$1" = "ls-remote" ]; then\n  git config --local --get-all credential.https://github.com.helper | grep -q tomrade-credential && exit 0\n  echo 'Repository not found' >&2; exit 128\nfi\nexec git "$@"\n`, { mode: 0o755 });
  const world = await machine({ ...local, remote }, { gitBinary: binary });
  const { ctx, codeLink, project, repo, hubDir } = world;
  const connection = vi.spyOn(ctx.github, "status").mockResolvedValue({ connected: true, label: "@right-account" });
  ctx.settings.set({ ...ctx.settings.get(), github: { token: "fake-project-token" } });
  await ctx.repos.setCheckout(remote, local.checkout);
  await codeLink.scan(project.id);
  expect(await codeLink.githubCredentialAccount(project.id, repo!.id)).toBe("@right-account");
  connection.mockResolvedValueOnce({ connected: false });
  await expect(codeLink.useGithubCredential(project.id, repo!.id)).rejects.toThrow("Connect your GitHub account");
  const state = await codeLink.useGithubCredential(project.id, repo!.id);
  expect(state).toMatchObject({ remote: "ok", remoteDetail: null });
  expect(state.remoteAt).toBeGreaterThan(0);
  expect(await codeLink.remoteIdentity(remote)).toEqual({ host: "github.com", login: "right-account", tomrade: true });
  expect(await codeLink.githubCredentialAccount(project.id, repo!.id)).toBeNull();
  const item = world.ticket("Use the connected account");
  codeLink.setRepoPolicy(project.id, repo!.id, { agentPush: false });
  expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: true });
  await untilRunsSettle(world.agent);
  expect(world.turns.at(-1)?.env).toEqual({ GH_TOKEN: "fake-project-token", GITHUB_TOKEN: "fake-project-token" });
  expect(JSON.stringify(world.agent.store.messages(project.id, world.turns.at(-1)!.threadId))).not.toContain("fake-project-token");
  git(["remote", "set-url", "origin", "https://github.com/example/different"], local.checkout);
  await expect(codeLink.useGithubCredential(project.id, repo!.id)).rejects.toThrow("origin has changed");
  connection.mockRestore();
});

it("repoints a helper an earlier version left under the Hub, on the next scan", async () => {
  const local = codeRepo();
  const remote = "https://github.com/example/private-app";
  git(["remote", "set-url", "origin", remote], local.checkout);
  // The scan's fetch and remote probe answer here, as for a private repository, rather than from github.com.
  const binary = path.join(root, `git-offline-${n++}`);
  fs.writeFileSync(binary, `#!/bin/sh\ncase "$1" in fetch|ls-remote|pull|push) echo 'Repository not found' >&2; exit 128;; esac\nexec git "$@"\n`, { mode: 0o755 });
  const world = await machine({ ...local, remote }, { gitBinary: binary });
  const { ctx, codeLink, project, hubDir } = world;
  const connection = vi.spyOn(ctx.github, "status").mockResolvedValue({ connected: true, label: "@right-account" });
  ctx.settings.set({ ...ctx.settings.get(), github: { token: "fake-project-token" } });
  // An upgrade left this checkout opted in, naming the helper's old Hub home.
  const legacy = path.join(hubDir, "old-hub", "bin", "tomrade-credential");
  git(["config", "--local", "--replace-all", "credential.https://github.com.helper", ""], local.checkout);
  git(["config", "--local", "--add", "credential.https://github.com.helper", `!'${legacy}'`], local.checkout);
  expect(git(["config", "--local", "--get-all", "credential.https://github.com.helper"], local.checkout)).toContain(legacy);
  await ctx.repos.setCheckout(remote, local.checkout);
  await codeLink.scan(project.id);
  const config = fs.readFileSync(path.join(local.checkout, ".git/config"), "utf8");
  expect(config).toContain(path.join(hubDir, "bin", "tomrade-credential"));
  expect(config).not.toContain(legacy);
  expect(await codeLink.remoteIdentity(remote)).toEqual({ host: "github.com", login: "right-account", tomrade: true });
  connection.mockRestore();
});

it("keeps an unsuccessful credential reprobe unreachable and does not offer account switching for network failures", async () => {
  const local = codeRepo();
  const remote = "https://github.com/example/still-private";
  git(["remote", "set-url", "origin", remote], local.checkout);
  const binary = path.join(root, `git-denied-${n++}`);
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "fetch" ] || [ "$1" = "ls-remote" ]; then echo "Repository not found" >&2; exit 128; fi\nexec git "$@"\n', { mode: 0o755 });
  const { ctx, codeLink, project, repo, hubDir } = await machine({ ...local, remote }, { gitBinary: binary });
  const connection = vi.spyOn(ctx.github, "status").mockResolvedValue({ connected: true, label: "@account" });
  ctx.settings.set({ ...ctx.settings.get(), github: { token: "fake-token" } });
  await ctx.repos.setCheckout(remote, local.checkout);
  await codeLink.scan(project.id);
  expect(await codeLink.useGithubCredential(project.id, repo!.id)).toMatchObject({ remote: "unreachable", remoteDetail: "Repository not found" });
  codeLink.store.upsertRepoState(project.id, repo!.id, { remote: "unreachable", remoteDetail: "Could not resolve host" });
  expect(await codeLink.githubCredentialAccount(project.id, repo!.id)).toBeNull();
  const ssh = ctx.repos.create({ projectId: project.id, remote: "git@github.com:example/ssh.git" });
  await expect(codeLink.useGithubCredential(project.id, ssh.id)).rejects.toThrow("HTTPS GitHub");
  connection.mockRestore();
});

describe("starting a ticket", () => {
  it("hands a main conversation each workstream's repository folder on this machine", async () => {
    const world = await machine(codeRepo());
    const { ctx, project, board, repo } = world;
    world.boards.update(project.id, board.id, { repoPath: "mobile-app" });
    const input = (purpose: "backlog" | "code") => ({ threadId: "t", projectId: project.id, purpose, input: { kind: "text", text: "hi" }, messages: [], cards: [], brief: null, pending: null, options: {} }) as TurnInput;
    const before = input("backlog");
    await ctx.parallel("agent/prepare-turn", before);
    expect(before.repositories).toEqual([{ workstream: board.name, name: repo!.name, path: null, defaultBranch: "main" }]);

    await ctx.repos.setCheckout(repo!.remote, world.checkout!);
    const after = input("backlog");
    await ctx.parallel("agent/prepare-turn", after);
    expect(after.repositories).toEqual([{ workstream: board.name, name: repo!.name, path: path.join(world.checkout!, "mobile-app"), defaultBranch: "main" }]);
    const code = input("code");
    await ctx.parallel("agent/prepare-turn", code);
    expect(code.repositories).toBeUndefined();
  });

  it("recognises a project rooted at the workstream's repository path", async () => {
    const local = codeRepo({ manifest: false });
    const world = await machine(local);
    const { codeLink, ctx, project, board, repo, ticket } = world;
    world.boards.update(project.id, board.id, { repoPath: "mobile-app" });
    await ctx.repos.setCheckout(repo!.remote, local.checkout);
    await codeLink.scan(project.id);
    const feature = ticket("Add charts");
    expect(await codeLink.start(project.id, feature.id, { mode: "run" })).toMatchObject({ ok: false, gate: "readiness" });
    const bootstrap = ctx.items.list({ projectId: project.id }).find((item) => item.labels.includes(BOOTSTRAP_LABEL))!;
    expect(bootstrap.blocks).toContain(feature.id);

    fs.mkdirSync(path.join(local.checkout, "mobile-app"));
    fs.writeFileSync(path.join(local.checkout, "mobile-app", "package.json"), '{ "name": "mobile-app" }\n');
    git(["add", "-A"], local.checkout);
    git(["commit", "-q", "-m", "add mobile app"], local.checkout);
    git(["push", "-q", "origin", "main"], local.checkout);
    await codeLink.scan(project.id);
    expect(codeLink.repoState(project.id, repo!.id)).toMatchObject({ readiness: "scaffolded", manifests: ["mobile-app/package.json"] });

    const started = await codeLink.start(project.id, feature.id, { mode: "run" });
    expect(started).toMatchObject({ ok: true });
    expect(ctx.items.get(project.id, bootstrap.id)!.blocks).not.toContain(feature.id);
    await untilRunsSettle(world.agent);
  });

  it("answers each gate with the thing that clears it", async () => {
    const world = await machine(null);
    const { codeLink, ctx, project, board, ticket } = world;
    const item = ticket("Gated");

    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "workstream" });

    const repo = codeRepo({ manifest: false });
    const row = ctx.repos.create({ projectId: project.id, remote: repo.remote });
    world.boards.update(project.id, board.id, { repoId: row.id });
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "checkout", remote: row.remote });

    await ctx.repos.setCheckout(repo.remote, repo.checkout);
    const gated = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(gated).toMatchObject({ ok: false, gate: "readiness" });
    const bootstrap = ctx.items.list({ projectId: project.id }).find((i) => i.labels.includes(BOOTSTRAP_LABEL))!;
    expect(bootstrap.blocks).toContain(item.id);
    expect(gated.ok ? null : gated.bootstrapKey).toBe(bootstrap.key);
    // Asked again, the same bootstrap ticket answers — not a second one.
    await codeLink.start(project.id, item.id, { mode: "run" });
    expect(ctx.items.list({ projectId: project.id }).filter((i) => i.labels.includes(BOOTSTRAP_LABEL))).toHaveLength(1);

    // The bootstrap ticket itself may start in an empty repository; once the repository has a project, the blocker is what stands.
    ctx.items.update(project.id, bootstrap.id, { status: "cancelled" }, "human");
    fs.writeFileSync(path.join(repo.checkout, "package.json"), "{}\n");
    git(["add", "-A"], repo.checkout);
    git(["commit", "-q", "-m", "scaffold"], repo.checkout);
    git(["push", "-q", "origin", "main"], repo.checkout);
    await codeLink.scan(project.id);
    const blocker = ticket("Blocker");
    ctx.items.update(project.id, blocker.id, { blocks: [item.id] }, "human");
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "blocked", blockers: [blocker.key] });

    // Waiting is the human's call: starting anyway works ahead, and the brief says what is still open.
    const ahead = await codeLink.start(project.id, item.id, { mode: "run", allowBlocked: true });
    expect(ahead).toMatchObject({ ok: true });
    await untilRunsSettle(world.agent);
    expect((world.turns.at(-1)!.messages[0]?.block as { text: string }).text).toContain(`Waits on (still open): ${blocker.key} Blocker (todo)`);

    ctx.items.update(project.id, item.id, { humanLocked: true }, "human");
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "locked" });
  });

  it("does not mistake a repository it cannot reach for an empty one", async () => {
    // A checkout whose origin cannot be fetched: an empty clone of a full repository looks exactly like this.
    const checkout = path.join(root, `checkout-${n++}`);
    fs.mkdirSync(checkout, { recursive: true });
    git(["init", "-q", "-b", "main"], checkout);
    git(["remote", "add", "origin", path.join(root, "no-such-remote.git")], checkout);
    const world = await machine({ remote: path.join(root, "no-such-remote.git"), checkout });
    const { codeLink, ctx, project, repo, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout);
    const item = ticket("Unreachable");

    await codeLink.scan(project.id);
    expect(codeLink.repoState(project.id, repo!.id)).toMatchObject({ readiness: "unknown", remote: "unreachable", remoteDetail: expect.any(String), remoteAt: null, summary: expect.stringContaining("origin") });
    expect((await ctx.contributions.statusItems({ projectId: project.id })).find((s) => s.id === "code-link")!.text).toContain("1 unreachable");
    const gated = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(gated).toMatchObject({ ok: false, gate: "remote" });
    expect(ctx.items.list({ projectId: project.id }).some((i) => i.labels.includes(BOOTSTRAP_LABEL))).toBe(false);
  });

  it("refuses a scaffolded repository when the live probe reports a credential failure", async () => {
    const source = codeRepo();
    const world = await machine(source, { gitBinary: gitWithFailure("ls-remote", "remote: Repository not found.") });
    const { codeLink, ctx, project, repo, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, source.checkout);
    await codeLink.scan(project.id);
    expect(codeLink.repoState(project.id, repo!.id)?.readiness).toBe("scaffolded");

    const result = await codeLink.start(project.id, ticket("Private work").id, { mode: "run" });
    expect(result).toMatchObject({ ok: false, gate: "remote", remote: repo!.remote, message: expect.stringContaining("private repository") });
    expect(codeLink.sessionsOf(project.id)).toEqual([]);
  });

  it("starts a scaffolded repository with a prompt warning during a network outage", async () => {
    const source = codeRepo();
    const world = await machine(source, { gitBinary: gitWithFailure("ls-remote", "fatal: Could not resolve host: github.com") });
    const { codeLink, ctx, agent, project, repo, ticket, turns } = world;
    await ctx.repos.setCheckout(repo!.remote, source.checkout);
    await codeLink.scan(project.id);

    const result = await codeLink.start(project.id, ticket("Offline work").id, { mode: "run" });
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining("commit locally, do not push")] });
    await untilRunsSettle(agent);
    expect((turns[0].messages[0]?.block as { text: string }).text).toContain(result.ok ? result.warnings?.[0] : "missing warning");
  });

  it("refuses an account that can read origin but cannot dry-run a push", async () => {
    const source = codeRepo();
    const world = await machine(source, { gitBinary: gitWithFailure("push", "remote: Permission denied\nfatal: The requested URL returned error: 403") });
    const { codeLink, ctx, project, repo, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, source.checkout);
    await codeLink.scan(project.id);

    const result = await codeLink.start(project.id, ticket("Protected write").id, { mode: "run" });
    expect(result).toMatchObject({ ok: false, gate: "remote", message: expect.stringContaining("credentials") });
  });

  it("starts the bootstrap ticket in an empty repository on an unborn branch, and its first push creates the default branch", async () => {
    const remote = path.join(root, `remote-${n++}.git`);
    fs.mkdirSync(remote, { recursive: true });
    git(["init", "--bare", "-b", "main", "."], remote);
    const checkout = path.join(root, `checkout-${n++}`);
    fs.mkdirSync(checkout, { recursive: true });
    git(["init", "-q", "-b", "main"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    git(["config", "user.email", "dev@localhost"], checkout);
    git(["config", "user.name", "Dev"], checkout);

    const world = await machine({ remote, checkout });
    const { codeLink, ctx, agent, project, repo, turns, ticket } = world;
    await ctx.repos.setCheckout(remote, checkout);
    // A monorepo layout from day one: the workstream's folder does not exist yet either.
    world.boards.update(project.id, world.board.id, { repoPath: "mobile-app" });
    const feature = ticket("First feature");
    const gated = await codeLink.start(project.id, feature.id, { mode: "run" });
    expect(gated).toMatchObject({ ok: false, gate: "readiness" });
    const bootstrap = ctx.items.list({ projectId: project.id }).find((i) => i.labels.includes(BOOTSTRAP_LABEL))!;

    const result = await codeLink.start(project.id, bootstrap.id, { mode: "run" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No commit anywhere yet: the worktree sits on the ticket's branch, unborn, and the workstream's folder was made for the agent.
    expect(result.cwd).toBe(path.join(result.worktree!, "mobile-app"));
    expect(fs.existsSync(result.cwd)).toBe(true);
    expect(git(["symbolic-ref", "HEAD"], result.cwd)).toBe(`refs/heads/${result.branch}`);
    await untilRunsSettle(agent);
    expect(turns).toHaveLength(1);
    expect(turns[0].messages[0]?.block).toMatchObject({ type: "text", text: expect.stringContaining("Bootstrap") });
    expect((turns[0].messages[0]?.block as { text: string }).text).toContain("lives in mobile-app/");
    // The fake agent made the repository's first commit on that branch.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], result.cwd)).toBe(result.branch);

    const pr = await codeLink.openPr(project.id, bootstrap.id);
    expect(pr.pushed).toBe(true);
    expect(pr.message).toContain("became it");
    expect(git(["ls-remote", "--heads", remote, "main"], checkout)).toMatch(/refs\/heads\/main/);
    await codeLink.scan(project.id);
    expect(ctx.items.get(project.id, bootstrap.id)!.status).toBe("done");
    // No manifest, but the fake agent's code is on main now: the project exists and the feature may start.
    expect(codeLink.repoState(project.id, repo!.id)!.readiness).toBe("scaffolded");
    expect(await codeLink.start(project.id, feature.id, { mode: "run" })).toMatchObject({ ok: true });
    expect(ctx.items.list({ projectId: project.id }).filter((i) => i.labels.includes(BOOTSTRAP_LABEL))).toHaveLength(1);
    await untilRunsSettle(agent);
  });

  it("bootstraps a workstream once, even when a scan still reads it empty afterwards", async () => {
    const world = await machine(codeRepo({ manifest: false }));
    const { codeLink, ctx, project, repo, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, world.checkout!);
    const feature = ticket("First feature");
    expect(await codeLink.start(project.id, feature.id, { mode: "run" })).toMatchObject({ ok: false, gate: "readiness" });
    const bootstrap = ctx.items.list({ projectId: project.id }).find((i) => i.labels.includes(BOOTSTRAP_LABEL))!;
    // Its work never reached main — merged nowhere, or a stack with nothing a scan recognises.
    ctx.items.update(project.id, bootstrap.id, { status: "done" }, "human");

    const started = await codeLink.start(project.id, feature.id, { mode: "run" });
    expect(started).toMatchObject({ ok: true, warnings: [expect.stringContaining(`${bootstrap.key} (bootstrap) is done`)] });
    expect(ctx.items.list({ projectId: project.id }).filter((i) => i.labels.includes(BOOTSTRAP_LABEL))).toHaveLength(1);
    await untilRunsSettle(world.agent);
  });

  it("reads readiness fresh before gating on empty", async () => {
    const world = await machine(codeRepo({ manifest: false }));
    const { codeLink, ctx, project, repo, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, world.checkout!);
    await codeLink.scan(project.id);
    expect(codeLink.repoState(project.id, repo!.id)!.readiness).toBe("empty");
    // Filled after the last scan; the start must not act on the stale reading.
    fs.writeFileSync(path.join(world.checkout!, "package.json"), "{}\n");
    git(["add", "-A"], world.checkout!);
    git(["commit", "-q", "-m", "scaffold"], world.checkout!);
    git(["push", "-q", "origin", "main"], world.checkout!);
    expect(await codeLink.start(project.id, ticket("Feature").id, { mode: "run" })).toMatchObject({ ok: true });
    expect(ctx.items.list({ projectId: project.id }).filter((i) => i.labels.includes(BOOTSTRAP_LABEL))).toHaveLength(0);
    await untilRunsSettle(world.agent);
  });

  it("runs the ticket in a worktree on its own branch, follows the session, and takes the agent's report", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, hubDir, turns, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Push notifications");

    const result = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ continued: false, branch: `tom-${item.keyNum}/push-notifications`, mode: "run" });
    expect(result.worktree).toBe(path.join(hubDir, "worktrees", path.basename(repo!.remote, ".git"), result.threadId));
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], result.cwd)).toBe(result.branch);

    const thread = agent.store.thread(project.id, result.threadId)!;
    expect(thread).toMatchObject({ itemId: item.id, branch: result.branch, engine: "fake-code", boardId: item.boardId });
    expect(ctx.items.get(project.id, item.id)!.status).toBe("doing");
    const [link] = codeLink.links(project.id, item.id);
    expect(link).toMatchObject({ branch: result.branch, threadId: result.threadId, source: "start" });

    await untilRunsSettle(agent);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ purpose: "code", cwd: result.cwd, ticket: { key: item.key, branch: result.branch } });
    expect(turns[0].messages.at(-1)?.block).toMatchObject({ type: "text" });
    expect(agent.store.messages(project.id, thread.id)[0].block).toMatchObject({ type: "text", text: expect.stringContaining(`Implement ${item.key}`) });

    // The run's end is the session's heartbeat: idle, with the CLI session id kept for Continue.
    const [session] = codeLink.sessionsOf(project.id, item.id);
    expect(session).toMatchObject({ mode: "headless", agent: "fake-code", threadId: result.threadId, state: "idle", externalId: "fake-session-1", itemIds: [item.id] });

    // The commit the agent made is on the branch; the scan sees it through the checkout's refs.
    await codeLink.scan(project.id);
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ ahead: 1, behind: 0 });

    // Starting again continues the same thread rather than opening another.
    const again = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(again).toMatchObject({ ok: true, continued: true, threadId: result.threadId });
    await untilRunsSettle(agent);
    expect(turns).toHaveLength(2);
    expect(agent.store.messages(project.id, thread.id).filter((m) => m.role === "user").at(-1)?.block).toMatchObject({ type: "text", text: expect.stringContaining(`Continue ${item.key}`) });

    // The agent reports a pull request; the ticket moves to Verifying and the Code section shows it.
    const reported = (await ctx.tools.execute("link_code", { key: item.key, prUrl: "https://github.com/acme/app/pull/12" }, { by: "ai:fake-code", projectId: project.id })) as { status: string };
    expect(reported.status).toBe("verifying");
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ prNumber: 12, prState: "open", prUrl: "https://github.com/acme/app/pull/12" });
    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!;
    expect(section.rows.find((r) => r.label === "Pull request")).toMatchObject({ value: "#12 · open", href: "https://github.com/acme/app/pull/12" });
    expect(section.rows.find((r) => r.label === "Session")?.value).toMatch(/^idle · run by Tomrade/);
    expect(section.rows.find((r) => r.label === "Worktree")).toMatchObject({ value: result.worktree, command: "code-link.open-terminal" });
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual([{ id: "pr", label: "PR #12", tone: "strong", title: "https://github.com/acme/app/pull/12" }]);
    // An agent elsewhere (an IM conversation) reads the same code.
    const read = await ctx.tools.execute("get_code_links", { key: item.key.toLowerCase() }, { by: "ai:test", projectId: project.id });
    expect(read).toMatchObject({
      key: item.key, status: "verifying", delivery: { sequence: 1, state: "active" },
      links: [{ branch: result.branch, ahead: 1, prNumber: 12, prUrl: "https://github.com/acme/app/pull/12", prState: "open", mergedSha: null }],
      session: { mode: "headless", agent: "fake-code", state: "idle", blocked: null, threadId: result.threadId },
      proposals: []
    });
  });

  it("names a new branch on a Chinese title with the model's English slug, and falls back to the local rule without a model", async () => {
    // The model answers only the CJK title; the plain one is slugged locally and never asked.
    const asked: string[] = [];
    const world = await machine(codeRepo(), {
      llm: (system, user) => {
        asked.push(user);
        expect(system).toContain("git branch");
        return { slug: user.includes("统一") ? "Unify Usage Statistics" : "should-not-be-asked" };
      }
    });
    await world.ctx.repos.setCheckout(world.repo!.remote, world.checkout!);
    const chinese = world.ticket("统一 ticket 用量与用量统计的 token 口径");
    const result = await world.codeLink.start(world.project.id, chinese.id, { mode: "run" });
    expect(result).toMatchObject({ ok: true, branch: `tom-${chinese.keyNum}/unify-usage-statistics` });
    expect(asked).toEqual(["统一 ticket 用量与用量统计的 token 口径"]);

    // Starting the same ticket again continues its branch and does not ask the model a second time.
    const again = await world.codeLink.start(world.project.id, chinese.id, { mode: "run" });
    expect(again).toMatchObject({ ok: true, continued: true, branch: result.ok ? result.branch : "" });
    expect(asked).toHaveLength(1);

    // A model that answers with prose or rubbish cannot leak it into the branch.
    const messy = await machine(codeRepo(), { llm: () => ({ slug: "  Unify usage!!! statistics. " }) });
    await messy.ctx.repos.setCheckout(messy.repo!.remote, messy.checkout!);
    const other = messy.ticket("统一 ticket 用量");
    const tidy = await messy.codeLink.start(messy.project.id, other.id, { mode: "run" });
    if (!tidy.ok) throw new Error(tidy.message);
    expect(tidy.branch).toMatch(/^tom-\d+\/[a-z0-9-]+$/);
    expect(tidy.branch).toBe(`tom-${other.keyNum}/unify-usage-statistics`);
  });

  it("falls back to a local slug when no model answers a Chinese title", async () => {
    const world = await machine(codeRepo(), { llm: () => ({ nope: true }) }); // the answer does not fit the schema
    await world.ctx.repos.setCheckout(world.repo!.remote, world.checkout!);
    const item = world.ticket("统一 ticket 用量与用量统计的 token 口径");
    const result = await world.codeLink.start(world.project.id, item.id, { mode: "run" });
    // No model: the same latin fragments the local rule has always found.
    expect(result).toMatchObject({ ok: true, branch: `tom-${item.keyNum}/ticket-token` });

    const symbols = await machine(codeRepo(), { llm: () => ({ slug: "!!!" }) });
    await symbols.ctx.repos.setCheckout(symbols.repo!.remote, symbols.checkout!);
    const empty = symbols.ticket("!!! ???");
    const fallback = await symbols.codeLink.start(symbols.project.id, empty.id, { mode: "run" });
    expect(fallback).toMatchObject({ ok: true, branch: `tom-${empty.keyNum}/work` });
  });

  it("works a repository with no remote: nothing probed or pushed, the branch handed over for review, a local merge finishes it", async () => {
    const folder = localRepo();
    const world = await machine(null);
    const { codeLink, ctx, agent, project, board, turns, ticket } = world;
    const { repo } = await ctx.repos.addFromFolder(project.id, folder);
    world.boards.update(project.id, board.id, { repoId: repo.id });
    const item = ticket("Local feature");

    const result = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(result).toMatchObject({ ok: true, branch: `tom-${item.keyNum}/local-feature` });
    if (!result.ok) return;
    expect(result.warnings).toBeUndefined();
    await untilRunsSettle(agent);
    const prompt = JSON.stringify(agent.store.messages(project.id, result.threadId)[0].block);
    expect(prompt).toContain("this repository has no remote");
    expect(prompt).not.toContain("git push");
    expect(turns).toHaveLength(1);

    await codeLink.scan(project.id);
    expect(codeLink.repoStates(project.id)[0]).toMatchObject({ remote: "none", readiness: "scaffolded" });
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ ahead: 1 });
    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!;
    expect(section.rows.find((r) => r.label === "Pull request")).toMatchObject({ value: "none — no remote · merge into main", command: "code-link.merge-local" });
    expect(await codeLink.openPr(project.id, item.id)).toMatchObject({ pushed: false, message: expect.stringContaining("has no remote") });

    const handed = (await sessionContext.run({ projectId: project.id, sessionId: result.sessionId }, () => ctx.tools.execute("link_code", { scopeChecked: true }, { by: "ai:fake-code", projectId: project.id }))) as { status: string };
    expect(handed.status).toBe("verifying");

    git(["merge", "-q", "--no-ff", "-m", `Merge ${item.key}`, result.branch], folder);
    await codeLink.scan(project.id);
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
  });

  describe("merging from Tomrade in a repository with no remote", () => {
    /** A local repository, a ticket worked to Verifying on its branch, and that branch's worktree removed. */
    async function handed(title: string, opts: { agentMerge?: boolean } = {}) {
      const folder = localRepo();
      const world = await machine(null);
      const { codeLink, ctx, agent, project, board, ticket } = world;
      const { repo } = await ctx.repos.addFromFolder(project.id, folder);
      world.boards.update(project.id, board.id, { repoId: repo.id });
      if (opts.agentMerge) codeLink.setRepoPolicy(project.id, repo.id, { agentMerge: true });
      const item = ticket(title);
      const result = await codeLink.start(project.id, item.id, { mode: "run" });
      if (!result.ok) throw new Error(result.message);
      await untilRunsSettle(agent);
      await codeLink.scan(project.id);
      const as = (call: () => Promise<unknown>) => sessionContext.run({ projectId: project.id, sessionId: result.sessionId }, call);
      await as(() => ctx.tools.execute("link_code", { scopeChecked: true }, { by: "ai:fake-code", projectId: project.id }));
      expect(ctx.items.get(project.id, item.id)!.status).toBe("verifying");
      const main = () => git(["rev-parse", "main"], folder);
      return { ...world, folder, item, result, as, main, before: main() };
    }

    it("merges from a clean checkout on the default branch and finishes the ticket on that merge", async () => {
      const { codeLink, ctx, project, item, result, folder, main, before } = await handed("Merge here");
      const merged = await codeLink.mergeLocal(project.id, item.id);
      expect(merged).toMatchObject({ merged: true, sha: main() });
      expect(main()).not.toBe(before);
      expect(git(["log", "-1", "--format=%s", "main"], folder)).toBe(`${item.key}: Merge here`);
      expect(git(["merge-base", "--is-ancestor", result.branch, "main"], folder)).toBe("");
      expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ mergedSha: main() });
      expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
    });

    it("merges through a temporary worktree when the default branch is not checked out, leaving the checkout as it was", async () => {
      const { codeLink, ctx, project, item, folder, main, before } = await handed("Merge elsewhere");
      git(["checkout", "-q", "-b", "side", "main"], folder);
      expect(await codeLink.mergeLocal(project.id, item.id)).toMatchObject({ merged: true });
      expect(main()).not.toBe(before);
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], folder)).toBe("side");
      expect(git(["worktree", "list", "--porcelain"], folder)).not.toContain("tomrade-merge-");
      expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
    });

    it("refuses a default branch with uncommitted changes, and aborts a conflict, changing nothing", async () => {
      const { codeLink, ctx, project, item, folder, main, before } = await handed("Not now");
      fs.writeFileSync(path.join(folder, "package.json"), '{ "name": "changed" }\n');
      expect(await codeLink.mergeLocal(project.id, item.id)).toMatchObject({ merged: false, message: expect.stringContaining("uncommitted changes") });
      expect(main()).toBe(before);
      git(["checkout", "-q", "--", "package.json"], folder);

      fs.writeFileSync(path.join(folder, "work-1.ts"), "export const clash = 1;\n");
      git(["add", "-A"], folder);
      git(["commit", "-q", "-m", "clash on main"], folder);
      const clashed = main();
      expect(await codeLink.mergeLocal(project.id, item.id)).toMatchObject({ merged: false, message: expect.stringContaining("conflicts with main in work-1.ts") });
      expect(main()).toBe(clashed);
      expect(fs.existsSync(path.join(folder, ".git", "MERGE_HEAD"))).toBe(false);
      expect(git(["status", "--porcelain"], folder)).toBe("");
      expect(ctx.items.get(project.id, item.id)!.status).toBe("verifying");
    });

    it("lets the agent merge only where agent merging is on, and tells it so", async () => {
      const off = await handed("Person merges");
      const refused = (await off.as(() => off.ctx.tools.execute("merge_branch", {}, { by: "ai:fake-code", projectId: off.project.id }))) as { merged: boolean; message: string };
      expect(refused).toMatchObject({ merged: false, message: expect.stringContaining("Agents don't merge") });
      expect(off.main()).toBe(off.before);

      const on = await handed("Agent merges", { agentMerge: true });
      const prompt = JSON.stringify(on.agent.store.messages(on.project.id, on.result.threadId)[0].block);
      expect(prompt).toContain("call merge_branch");
      const merged = (await on.as(() => on.ctx.tools.execute("merge_branch", {}, { by: "ai:fake-code", projectId: on.project.id }))) as { merged: boolean };
      expect(merged).toMatchObject({ merged: true });
      expect(on.ctx.items.get(on.project.id, on.item.id)!.status).toBe("done");
    });
  });

  it("scans a repository added while a slower scan is still fetching", async () => {
    const slowGit = path.join(root, `git-slow-${n++}`);
    fs.writeFileSync(slowGit, `#!/bin/sh\nif [ "$1" = "fetch" ]; then sleep 1; fi\nexec git "$@"\n`, { mode: 0o755 });
    const world = await machine(codeRepo(), { gitBinary: slowGit });
    const { ctx, codeLink, project, repo, checkout } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const running = codeLink.scan(project.id);
    const { repo: local } = await ctx.repos.addFromFolder(project.id, localRepo());
    await running;
    const t0 = Date.now();
    while (codeLink.repoStates(project.id).find((s) => s.repoId === local.id)?.remote !== "none" && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    expect(codeLink.repoStates(project.id).find((s) => s.repoId === local.id)).toMatchObject({ remote: "none", readiness: "scaffolded" });
  });

  it("says a run here is waiting while it asks permission, however long that takes, and stuck when it fails", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    let fail = false;
    agent.engine({
      id: "asking",
      title: "Asking agent",
      author: "ai:asking",
      capabilities: ["code"],
      available: async () => ({ ok: true }),
      async turn(_input, io) {
        if (fail) throw new Error("model overloaded");
        const said = await io.requestPermission!("Run npm install?", ["Allow", "Deny"]);
        io.emit({ type: "text", text: `got ${said}` });
        return { stop: "end" };
      }
    });
    const item = ticket("Ask before installing");
    const started = await codeLink.start(project.id, item.id, { mode: "run", engine: "asking" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const session = () => codeLink.sessionsOf(project.id, item.id)[0];

    // The question holds the run: the ticket says the session waits for the person…
    await vi.waitFor(() => expect(session()).toMatchObject({ state: "waiting", activity: "needs your approval" }));
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "waiting" })]));
    // …and still does after a long silence, where a running session would be called idle.
    codeLink.sessions.sweep(project.id, Date.now() + 11 * 60 * 1000);
    expect(session().state).toBe("waiting");

    const question = agent.thread(project.id, started.threadId).pending!.question;
    agent.send(project.id, started.threadId, { kind: "answer", questionId: question.id, value: "Allow" });
    await untilRunsSettle(agent);
    expect(session()).toMatchObject({ state: "idle", activity: null });

    // A run that fails is stuck, not idle.
    fail = true;
    await codeLink.start(project.id, item.id, { mode: "run", engine: "asking" });
    await untilRunsSettle(agent);
    expect(session()).toMatchObject({ state: "error", summary: expect.stringContaining("model overloaded") });
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "stuck" })]));
  });

  it("does not answer the agent's open question with Continue, and points at the conversation instead", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    agent.engine({
      id: "asker",
      title: "Asking agent",
      author: "ai:asker",
      capabilities: ["code"],
      available: async () => ({ ok: true }),
      async turn(_input, io) {
        const result = await io.tools.execute("ask_user", { question: "Postgres or SQLite?", options: ["Postgres", "SQLite"] });
        return { stop: (result as { suspended?: boolean })?.suspended === false ? "end" : "asked" };
      }
    });
    const item = ticket("Pick a database");
    const first = await codeLink.start(project.id, item.id, { mode: "run", engine: "asker" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await untilRunsSettle(agent);
    expect(agent.store.pending(project.id, first.threadId)?.question.text).toBe("Postgres or SQLite?");
    const said = () => agent.store.messages(project.id, first.threadId).filter((m) => m.role === "user").length;
    const before = said();

    // Continue: nothing is sent — a message would count as the answer — and the question is handed back.
    const again = await codeLink.start(project.id, item.id, { mode: "run", engine: "asker" });
    expect(again).toMatchObject({ ok: true, continued: true, threadId: first.threadId, waitingOn: "Postgres or SQLite?" });
    expect(said()).toBe(before);
    expect(agent.store.pending(project.id, first.threadId)?.question.text).toBe("Postgres or SQLite?");

    // The Code section's Continue and its Conversation row both bring the conversation up.
    expect(await ctx.contributions.run("code-link.start-run", { projectId: project.id, itemId: item.id })).toMatchObject({ showThread: first.threadId, toast: expect.stringContaining("Postgres or SQLite?") });
    expect(await ctx.contributions.run("code-link.open-thread", { projectId: project.id, itemId: item.id })).toEqual({ showThread: first.threadId });
    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!;
    expect(section.rows.find((r) => r.label === "Conversation")).toMatchObject({ command: "code-link.open-thread" });
  });

  it("speaks the person's language in the Code section, the badges and the status bar", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
    const item = ticket("中文界面");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    await untilRunsSettle(agent);
    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!;
    expect(section.title).toBe("代码");
    expect(section.rows.map((r) => r.label)).toEqual(expect.arrayContaining(["分支", "会话", "继续", "对话", "工作树"]));
    expect(section.rows.find((r) => r.label === "会话")?.value).toMatch(/^空闲 · 由 Tomrade 运行/);
    expect((await ctx.contributions.statusItems({ projectId: project.id })).find((s) => s.id === "code-link")?.text).toMatch(/^代码：1 个会话/);
    expect(ctx.contributions.commands().find((c) => c.id === "code-link.start-run")).toMatchObject({ title: "在这里开始工作项", group: "代码" });
    // The agent reads the brief in English but answers in the language the person reads Tomrade in.
    const brief = agent.store.messages(project.id, started.threadId)[0]?.block;
    expect(brief?.type === "text" && brief.text).toContain("write everything the person will read");
    expect(brief?.type === "text" && brief.text).toContain("Simplified Chinese");
  });

  it("archives completed code conversations while retaining their messages and links", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Archive delivered code");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);
    const messages = agent.store.messages(project.id, started.threadId);
    await ctx.tools.execute("link_code", { key: item.key, branch: started.branch, prState: "merged" }, { by: "human", projectId: project.id });
    expect(ctx.items.get(project.id, item.id)?.status).toBe("done");
    expect(agent.store.threads(project.id).map(t => t.id)).not.toContain(started.threadId);
    expect(agent.store.archivedThreads(project.id).map(t => t.id)).toContain(started.threadId);
    expect(agent.store.messages(project.id, started.threadId)).toEqual(messages);
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ threadId: started.threadId, branch: started.branch, prState: "merged" });
    expect(codeLink.store.session(project.id, started.sessionId)).toMatchObject({ state: "ended", threadId: started.threadId });
  });

  it.each(["scan", "db/opened", "storage/imported"] as const)("backfills completed sessions on %s without repeating archive operations", async trigger => {
    const { codeLink, ctx, agent, project, repo, ticket } = await machine(codeRepo());
    const done = ticket("Previously completed");
    ctx.items.update(project.id, done.id, { status: "done" }, "human");
    const open = ticket("Still needs work");
    const cancelled = ticket("Cancelled work");
    ctx.items.update(project.id, cancelled.id, { status: "cancelled" }, "human");
    const seed = (itemIds: string[], mode: "headless" | "terminal" = "headless") => {
      const thread = agent.store.createThread(project.id, "fake-code", "Historical code", null, itemIds[0], "tom-history", "code");
      return codeLink.store.createSession(project.id, { repoId: repo!.id, branch: "tom-history", itemIds, mode, agent: "fake-code", threadId: thread.id, device: "test" });
    };
    const completed = [seed([done.id]), seed([done.id], "terminal")];
    const untouched = [seed([open.id]), seed([done.id, open.id]), seed([cancelled.id]), seed([])];
    const archive = vi.spyOn(agent, "archiveThread");
    const check = async () => {
      if (trigger === "scan") await codeLink.scan(project.id);
      else ctx.emit(trigger, project.id);
    };
    await check();
    for (const session of completed) {
      expect(agent.store.thread(project.id, session.threadId!)?.archived).toBe(true);
      expect(codeLink.store.session(project.id, session.id)?.state).toBe("ended");
    }
    for (const session of untouched) {
      expect(agent.store.thread(project.id, session.threadId!)?.archived).toBe(false);
      expect(codeLink.store.session(project.id, session.id)?.state).not.toBe("ended");
    }
    expect(archive).toHaveBeenCalledTimes(2);
    const rows = completed.map(session => codeLink.store.session(project.id, session.id));
    await check();
    expect(archive).toHaveBeenCalledTimes(2);
    expect(completed.map(session => codeLink.store.session(project.id, session.id))).toEqual(rows);
  });

  it("defers archiving a completed ticket until its active run ends", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    agent.engine({ ...fakeCodeEngine([]), id: "held", async turn() { await gate; return { stop: "end" }; } });
    const item = ticket("Finish while running");
    const started = await codeLink.start(project.id, item.id, { mode: "run", engine: "held" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    try {
      ctx.items.update(project.id, item.id, { status: "done" }, "human");
      expect(agent.store.thread(project.id, started.threadId)?.archived).toBe(false);
      expect(codeLink.store.session(project.id, started.sessionId)?.state).not.toBe("ended");
    } finally {
      release();
    }
    await untilRunsSettle(agent);
    expect(agent.store.thread(project.id, started.threadId)?.archived).toBe(true);
    expect(codeLink.store.session(project.id, started.sessionId)?.state).toBe("ended");
  });

  it("brings an archived conversation back when its ticket is continued", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Archived midway");
    const first = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await untilRunsSettle(agent);
    agent.archiveThread(project.id, first.threadId);
    expect(agent.store.archivedThreads(project.id).map((t) => t.id)).toContain(first.threadId);
    const again = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(again).toMatchObject({ ok: true, continued: true, threadId: first.threadId });
    expect(agent.store.thread(project.id, first.threadId)?.archived).toBe(false);
    await untilRunsSettle(agent);
  });

  it("puts away a finished ticket's threads that never got a session, once, and leaves one a person brought back", async () => {
    const { codeLink, ctx, agent, project, ticket } = await machine(codeRepo());
    const item = ticket("Left a stray thread");
    const stray = agent.store.createThread(project.id, "fake-code", "Stray", null, item.id, "tom-stray", "assistant");
    ctx.items.update(project.id, item.id, { status: "done" }, "human");
    expect(agent.store.thread(project.id, stray.id)?.archived).toBe(true);
    agent.unarchiveThread(project.id, stray.id, { restored: true });
    await codeLink.scan(project.id);
    expect(agent.store.thread(project.id, stray.id)).toMatchObject({ archived: false, restored: true });
  });

  it("never brings a finished ticket's worktree back on its own; only reopening and starting it does", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Finished and tidied");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);
    await ctx.tools.execute("link_code", { key: item.key, branch: started.branch, prState: "merged" }, { by: "human", projectId: project.id });
    expect(agent.store.thread(project.id, started.threadId)?.archived).toBe(true);
    // The person tidies up after the merge.
    git(["worktree", "remove", "--force", started.worktree!], checkout!);
    git(["branch", "-D", started.branch], checkout!);

    // Looking at the conversation reports; it does not make anything.
    expect(await agent.workdir(project.id, started.threadId)).toMatchObject({ cwd: null, problem: null });
    await codeLink.scan(project.id);
    expect(fs.existsSync(started.worktree!)).toBe(false);
    expect(git(["branch", "--list", started.branch], checkout!)).toBe("");

    // Archived means read-only.
    expect(() => agent.send(project.id, started.threadId, { kind: "text", text: "one more thing" })).toThrow(/archived/);
    // Brought back by hand, a turn still does not quietly recreate finished work.
    agent.unarchiveThread(project.id, started.threadId, { restored: true });
    expect(await agent.workdir(project.id, started.threadId)).toMatchObject({ cwd: null, code: "finished" });
    expect(await agent.workdir(project.id, started.threadId, { create: true })).toMatchObject({ cwd: null, code: "finished" });
    expect(fs.existsSync(started.worktree!)).toBe(false);

    expect(() => agent.send(project.id, started.threadId, { kind: "text", text: "one more thing" })).toThrow(/Reopen it/);

    // Bringing the work back is the person's call: reopen the ticket and continue this conversation.
    ctx.items.update(project.id, item.id, { status: "doing" }, "human");
    const again = await codeLink.start(project.id, item.id, { mode: "run", threadId: started.threadId, message: "one more thing" });
    expect(again).toMatchObject({ ok: true, continued: true, threadId: started.threadId, branch: `${started.branch}-2` });
    if (!again.ok) return;
    expect(fs.existsSync(again.worktree!)).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], again.worktree!)).toBe(`${started.branch}-2`);
    expect(agent.store.thread(project.id, started.threadId)).toMatchObject({ branch: `${started.branch}-2`, restored: false });
    await untilRunsSettle(agent);
    expect(agent.store.messages(project.id, started.threadId).some((m) => m.role === "user" && m.block.type === "text" && m.block.text.endsWith("one more thing"))).toBe(true);
  });

  it("does not rebuild the worktree of a conversation whose ticket was deleted", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Deleted later");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);
    ctx.items.delete(project.id, item.id, "human");
    git(["worktree", "remove", "--force", started.worktree!], checkout!);
    expect(await agent.workdir(project.id, started.threadId, { create: true })).toMatchObject({ cwd: null, code: "finished" });
    expect(fs.existsSync(started.worktree!)).toBe(false);
  });

  it("moves a kept worktree onto the reopened delivery's branch, and refuses while it has uncommitted work", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Reopened with its worktree");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);
    await ctx.tools.execute("link_code", { key: item.key, branch: started.branch, prState: "merged" }, { by: "human", projectId: project.id });
    agent.unarchiveThread(project.id, started.threadId, { restored: true });
    ctx.items.update(project.id, item.id, { status: "doing" }, "human");
    fs.writeFileSync(path.join(started.worktree!, "scratch.txt"), "half done\n");
    expect(await codeLink.start(project.id, item.id, { mode: "run", threadId: started.threadId })).toMatchObject({ ok: false, gate: "workdir", message: expect.stringContaining("uncommitted") });
    expect(agent.store.thread(project.id, started.threadId)?.branch).toBe(started.branch);
    fs.rmSync(path.join(started.worktree!, "scratch.txt"));
    const again = await codeLink.start(project.id, item.id, { mode: "run", threadId: started.threadId });
    expect(again).toMatchObject({ ok: true, threadId: started.threadId, worktree: started.worktree, branch: `${started.branch}-2` });
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], started.worktree!)).toBe(`${started.branch}-2`);
    await untilRunsSettle(agent);
  });

  it("names the conversations a Start opened in the thread list", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const started = await codeLink.start(project.id, ticket("Named in the list").id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const plain = agent.newThread(project.id);
    const listed = agent.withOrigins(project.id, agent.store.threads(project.id));
    expect(listed.find((th) => th.id === started.threadId)?.origins).toEqual(["Code Link"]);
    expect(listed.find((th) => th.id === plain.id)?.origins).toBeUndefined();
    await untilRunsSettle(agent);
  });

  it("leaves no thread behind when a Start is refused at the working folder", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, hubDir, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    // Nothing can be made under the Hub's worktrees folder.
    fs.rmSync(path.join(hubDir, "worktrees"), { recursive: true, force: true });
    fs.writeFileSync(path.join(hubDir, "worktrees"), "");
    const item = ticket("Refused at the folder");
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "workdir" });
    expect(agent.store.threadsForItem(project.id, item.id)).toEqual([]);
    fs.rmSync(path.join(hubDir, "worktrees"));
    const retried = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(retried.ok).toBe(true);
    expect(agent.store.threadsForItem(project.id, item.id)).toHaveLength(1);
    await untilRunsSettle(agent);
  });

  it("starts a reopened ticket in a fresh delivery, thread and suffixed branch", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Revise notifications");

    const first = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await untilRunsSettle(agent);
    await ctx.tools.execute("link_code", { key: item.key, branch: first.branch, prState: "merged" }, { by: "human", projectId: project.id });
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");

    // Linking a merged pull request afterwards is history: on the finished delivery, nothing reopened.
    expect(await sessionContext.run({ projectId: project.id, sessionId: first.sessionId }, () => ctx.tools.execute("link_code", { prState: "merged", scopeChecked: true }, { by: "human", projectId: project.id }))).toMatchObject({
      status: "done",
      warning: expect.stringContaining("not changed")
    });
    expect(codeLink.deliveries(project.id, item.id)).toHaveLength(1);
    ctx.items.update(project.id, item.id, { status: "todo" }, "human");
    const second = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second).toMatchObject({ continued: false, branch: `tom-${item.keyNum}/revise-notifications-2` });
    expect(second.threadId).not.toBe(first.threadId);
    expect(codeLink.links(project.id, item.id).map((link) => [link.delivery, link.branch])).toEqual([
      [1, first.branch],
      [2, second.branch]
    ]);
    expect(codeLink.sessionsOf(project.id, item.id).map((session) => session.delivery).sort()).toEqual([1, 2]);
  });

  it("asks the person before an open pull request reopens a finished ticket", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Finished already");
    const first = await codeLink.start(project.id, item.id, { mode: "run" });
    if (!first.ok) throw new Error(first.message);
    await untilRunsSettle(agent);
    await ctx.tools.execute("link_code", { key: item.key, branch: first.branch, prState: "merged" }, { by: "human", projectId: project.id });
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");

    const inSession = (tool: string, args: unknown) => sessionContext.run({ projectId: project.id, sessionId: first.sessionId }, () => ctx.tools.execute(tool, args, { by: "human", projectId: project.id }));
    const prUrl = "https://github.com/acme/app/pull/9";
    expect(await inSession("link_code", { branch: "tom-x/more", prUrl, scopeChecked: true })).toMatchObject({ ok: false, status: "done" });
    expect(await inSession("link_code", { branch: "tom-x/more", prUrl, scopeChecked: true })).toMatchObject({ ok: false });
    expect(codeLink.proposals(project.id, item.id)).toMatchObject([{ fromStatus: "done", toStatus: "doing" }]);
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
    expect(codeLink.deliveries(project.id, item.id)).toHaveLength(1);
    expect(codeLink.links(project.id, item.id).map((link) => link.branch)).toEqual([first.branch]);

    // A session Tomrade started stays with its one ticket, finished or not.
    const other = ticket("Something else");
    await expect(inSession("claim_ticket", { key: other.key })).rejects.toThrow(`this session already owns ${item.key}`);
    await expect(inSession("claim_ticket", { key: other.key, parallel: true })).rejects.toThrow(`cannot claim ${other.key} in parallel — offer_start ${other.key}`);
    expect(codeLink.sessionsOf(project.id, other.id)).toEqual([]);
    await untilRunsSettle(agent);
  });

  it("moves a session left on an earlier delivery onto the reopened one, never with the branch already merged", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Revise reminders");
    const first = await codeLink.start(project.id, item.id, { mode: "run" });
    if (!first.ok) throw new Error(first.message);
    await untilRunsSettle(agent);
    await ctx.tools.execute("link_code", { key: item.key, branch: first.branch, prState: "merged" }, { by: "human", projectId: project.id });
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
    ctx.items.update(project.id, item.id, { status: "todo" }, "human");

    const inSession = (tool: string, args: unknown) => sessionContext.run({ projectId: project.id, sessionId: first.sessionId }, () => ctx.tools.execute(tool, args, { by: "human", projectId: project.id }));
    const claimed = (await inSession("claim_ticket", { key: item.key })) as { branch: string };
    expect(claimed.branch).toBe(`tom-${item.keyNum}/revise-reminders-2`);
    expect(codeLink.store.session(project.id, first.sessionId)).toMatchObject({ delivery: 2, branch: claimed.branch });

    await expect(inSession("link_code", { branch: first.branch, prState: "merged", scopeChecked: true })).rejects.toThrow("already merged in");
    await inSession("link_code", { scopeChecked: true });
    expect(ctx.items.get(project.id, item.id)!.status).not.toBe("done");
    expect(codeLink.links(project.id, item.id).map((link) => [link.delivery, link.branch])).toEqual([
      [1, first.branch],
      [2, claimed.branch]
    ]);
    await untilRunsSettle(agent);
  });

  it("tells the agent who merges, and hands a refused merge to the person with a link", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const brief = (threadId: string) => JSON.stringify(agent.store.messages(project.id, threadId)[0].block);

    const off = ticket("Merge by hand");
    const manual = await codeLink.start(project.id, off.id, { mode: "run" });
    if (!manual.ok) throw new Error(manual.message);
    await untilRunsSettle(agent);
    expect(brief(manual.threadId)).toContain("do not merge the pull request; the human merges it");

    expect(codeLink.setRepoPolicy(project.id, repo!.id, { agentMerge: true }).agentMerge).toBe(true);
    expect(await codeLink.mergeChecks(project.id, repo!.id)).toEqual([{ engine: "fake-code", title: "Fake coding agent", check: null }]);
    const item = ticket("Merge it yourself");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    if (!started.ok) throw new Error(started.message);
    await untilRunsSettle(agent);
    expect(brief(started.threadId)).toContain("merging is yours");
    expect(brief(started.threadId)).toContain("report_merge_blocked");
    expect(brief(started.threadId)).toContain("If the checks cannot be read at all");
    expect(brief(started.threadId)).toContain("'no checks reported' means there is nothing to wait for");

    const prUrl = "https://github.com/acme/app/pull/7";
    const link = codeLink.links(project.id, item.id)[0]!;
    codeLink.store.patchLink(project.id, link.id, { prUrl, prNumber: 7, prState: "open" });
    const response = codeLink.sessions.event(project.id, started.sessionId, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: `gh pr merge ${prUrl} --squash` },
      tool_error: "GraphQL: Base branch policy prohibits the merge. Required status check \"ci\" is expected."
    });
    expect(response).toMatchObject({ additionalContext: expect.stringContaining("Do not try to merge another way") });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", blocked: "merge", summary: expect.stringContaining("merge blocked:") });
    const notes = agent.store.messages(project.id, started.threadId).filter((message) => message.block.type === "note").map((message) => (message.block as { text: string }).text);
    expect(notes.at(-1)).toContain("merge blocked:");
    // a merge refusal is not a credential stop: other gh commands still run
    expect(codeLink.sessions.event(project.id, started.sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr view 7" } })).toEqual({});

    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((entry) => entry.id === "code")!;
    expect(section.rows).toContainEqual(expect.objectContaining({ label: "Merge", state: "warn", href: prUrl }));

    // origin being reachable clears credential stops, not a merge the person still owes
    await codeLink.scan(project.id);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ blocked: "merge" });
  });

  it("stops a session retry loop after git reports that its credentials cannot see origin", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Private push");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);

    const response = codeLink.sessions.event(project.id, started.sessionId, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "git push origin HEAD" },
      tool_error: "remote: Repository not found.\nfatal: repository 'https://token@github.com/acme/private.git/' not found"
    });
    expect(response).toMatchObject({ additionalContext: expect.stringContaining("Credentials are the human's to fix") });
    expect(JSON.stringify(response)).not.toContain("token@");
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", blocked: "credentials", activity: null, summary: expect.stringContaining("cannot reach origin") });
    const notes = () => agent.store.messages(project.id, started.threadId).filter((message) => message.block.type === "note").map((message) => (message.block as { text: string }).text);
    expect(notes().at(-1)).toContain("cannot reach origin from this worktree");

    const denied = codeLink.sessions.event(project.id, started.sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin HEAD" } });
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("blocked: push") } });
    expect(codeLink.sessions.event(project.id, started.sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" } })).toEqual({});
    codeLink.sessions.touch(project.id, started.sessionId, { state: "running", summary: "blocked: push waiting for the human" });
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("error");

    const continued = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(continued).toMatchObject({ ok: true, continued: true });
    expect(codeLink.sessionsOf(project.id, item.id)[0].blocked).toBeNull();
    await untilRunsSettle(agent);

    codeLink.sessions.event(project.id, started.sessionId, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create" },
      tool_output: { exit_code: 1, stderr: "Invalid username or token." }
    });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", blocked: "credentials" });
    await codeLink.scan(project.id);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "idle", blocked: null });

    // Claude Code's own field names; a limit is said as one, and the thread waits for it
    codeLink.sessions.event(project.id, started.sessionId, { hook_event_name: "StopFailure", error: "rate_limit", error_details: "You've hit your limit · resets 8pm" });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", blocked: null, summary: expect.stringMatching(/^usage limit — lifts at (tomorrow )?20:00$/) });
    codeLink.sessions.event(project.id, started.sessionId, { hook_event_name: "StopFailure", error: "authentication_failed", error_details: "Invalid API key" });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", summary: "stopped: authentication_failed — Invalid API key" });
  });

  it("opens a terminal session: files for the agent, a token that binds its calls and hooks to the ticket", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    const item = ticket("Terminal work");

    // Without the MCP server there is nothing for the agent to connect to.
    expect(await codeLink.start(project.id, item.id, { mode: "terminal" })).toMatchObject({ ok: false, gate: "mcp" });

    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    // a terminal agent gets no system prompt from Tomrade: the project's rules travel in its first prompt
    ctx.agent.setRules(project.id, "- Commit messages in English");
    const result = await codeLink.start(project.id, item.id, { mode: "terminal" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ mode: "terminal", launched: false });
    expect(result.command).toMatch(/^claude --mcp-config ".*mcp\.json" --settings ".*settings\.json" "\$\(cat ".*prompt\.md"\)"$/);
    const dir = codeLink.sessionDir(result.sessionId);
    const mcpConfig = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")) as { mcpServers: { tomrade: { url: string; headers: Record<string, string> } } };
    expect(mcpConfig.mcpServers.tomrade.url).toBe(ctx.mcp.urlFor(project.id));
    const token = mcpConfig.mcpServers.tomrade.headers["X-Tomrade-Run"];
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining(["SessionStart", "Stop", "Notification", "SessionEnd"]));
    expect(JSON.stringify(settings)).not.toMatch(/(?:^|\s)>\/dev\/null/);
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toContain(`Implement ${item.key}`);
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toContain(`this run owns exactly ${item.key}`);
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toContain("inspect the full diff");
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toMatch(/Project rules — [^\n]*\n- Commit messages in English$/);
    expect(fs.existsSync(path.join(dir, "run.command"))).toBe(true);

    // The native MCP client goes through the session binding, not the plain
    // project endpoint. Deferred tool execution must retain the Tools service.
    const client = new Client({ name: "terminal-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpConfig.mcpServers.tomrade.url), { requestInit: { headers: { "X-Tomrade-Run": token } } }));
    const listed = await client.callTool({ name: "list_items", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed.content)).toContain(item.key);
    const crossTicketWrite = await client.callTool({ name: "change_status", arguments: { id: item.id, status: "done" } });
    expect(crossTicketWrite.isError).toBe(true);
    expect(JSON.stringify(crossTicketWrite.content)).toContain("coding session cannot edit the backlog");
    expect(ctx.items.get(project.id, item.id)!.status).toBe("doing");
    // A follow-up may be filed: it waits in Backlog, names the session it came from, and stays out of the session.
    ctx.tools.register(
      defineTool({
        name: "find_similar",
        title: "Find similar",
        description: "",
        input: z.object({ title: z.string().optional(), body: z.string().optional() }),
        readOnly: true,
        execute: ({ title }) => (title === "Already there" ? { verdict: "duplicate", matches: [{ key: item.key, title: item.title }] } : { verdict: "none", matches: [] })
      })
    );
    const filed = await client.callTool({ name: "create_item", arguments: { title: "Follow-up found on the way", body: "Seen while testing." } });
    expect(filed.isError).not.toBe(true);
    const followUp = ctx.items.list({ projectId: project.id }).find((i) => i.title === "Follow-up found on the way")!;
    expect(followUp).toMatchObject({ status: "backlog", body: `Seen while testing.\n\nFiled from ${item.key}'s coding session.` });
    expect(codeLink.store.session(project.id, result.sessionId)!.itemIds).toEqual([item.id]);
    const duplicate = await client.callTool({ name: "create_item", arguments: { title: "Already there" } });
    expect(duplicate.isError).toBe(true);
    expect(JSON.stringify(duplicate.content)).toContain(`${item.key} (${item.title}) already describes this`);
    const sideEdit = await client.callTool({ name: "update_item", arguments: { id: followUp.id, patch: { title: "x" } } });
    expect(sideEdit.isError).toBe(true);
    const uncheckedLink = await client.callTool({ name: "link_code", arguments: { prUrl: "https://github.com/acme/app/pull/9" } });
    expect(uncheckedLink.isError).toBe(true);
    expect(JSON.stringify(uncheckedLink.content)).toContain("scopeChecked: true");
    await client.close();

    // A hook posts to the event URL: the session's state follows.
    const post = async (payload: unknown) => {
      const res = await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      return res.status;
    };
    expect(await post({ hook_event_name: "SessionStart", session_id: "cli-abc" })).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "running", externalId: "cli-abc", mode: "terminal", herdrPane: null });
    // Run inside a herdr pane, the hook names it: the ticket says so, and the row leads back to that pane.
    const paned = await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-Herdr-Pane": "w2:p1" }, body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cli-abc" }) });
    expect(paned.status).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0].herdrPane).toBe("w2:p1");
    expect((await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!.rows.find((r) => r.label === "Session")).toMatchObject({ value: expect.stringContaining("in herdr"), command: "code-link.open-terminal" });
    await post({ hook_event_name: "Stop", session_id: "cli-abc" });
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("waiting");
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual(expect.arrayContaining([{ id: "waiting", label: "waiting", tone: "strong", title: "The coding session is waiting for you" }]));

    // Each tool call says what the agent is doing; what it says when it stops stays with the Code session.
    await post({ hook_event_name: "PreToolUse", session_id: "cli-abc", tool_name: "Bash", tool_input: { command: "flutter create ." } });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "running", activity: "Bash · flutter create ." });
    expect((await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!.rows.find((r) => r.label === "Session")).toMatchObject({ state: "live", value: expect.stringContaining("Bash · flutter create .") });
    await post({ hook_event_name: "PostToolUse", session_id: "cli-abc", tool_name: "Bash" });
    expect(codeLink.sessionsOf(project.id, item.id)[0].activity).toBeNull();
    await post({ hook_event_name: "Stop", session_id: "cli-abc", last_assistant_message: "Scaffold in place.\n\nNext: CI." });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "waiting", summary: "Scaffold in place." });
    expect(ctx.agent.store.threads(project.id)).toEqual([]);
    expect(ctx.agent.store.thread(project.id, result.threadId)).toMatchObject({ surface: "code" });
    expect(ctx.agent.store.messages(project.id, result.threadId)).toEqual([]);
    await post({ hook_event_name: "StopFailure", session_id: "cli-abc", error_type: "rate_limit", error_message: "retry after 20:00" });
    const limited = expect.stringMatching(/^usage limit — lifts at (tomorrow )?20:00$/);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", summary: limited });
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual(expect.arrayContaining([{ id: "stuck", label: "stuck", tone: "strong", title: limited }]));
    // a terminal cannot be typed into: when the limit lifts the person is told, not the agent
    expect(ctx.agent.parked(project.id, result.threadId)).toMatchObject({ resume: false, known: true });
    // Tomrade restarts: the binding is gone from memory, the token is still in the session's folder, and comes back.
    codeLink.sessions.release(result.sessionId);
    expect(await post({ hook_event_name: "PostToolUse" })).toBe(404);
    expect(codeLink.rebindSessions(project.id)).toBe(1);
    expect(await post({ hook_event_name: "PostToolUse" })).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("running");

    expect(await post({ hook_event_name: "SessionEnd" })).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("ended");
    expect((await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!.rows.find((r) => r.label === "Session")).toMatchObject({ value: expect.stringContaining("ended") });
    expect(await post({ hook_event_name: "SessionStart" })).toBe(404);

    // Continuing resumes the CLI session it learned about.
    const again = await codeLink.start(project.id, item.id, { mode: "terminal" });
    expect(again.ok && again.continued).toBe(true);
    expect(again.ok ? again.command : "").toContain("--resume cli-abc");
    if (!again.ok) return;

    // The launch script leaves its pid; a pid that no longer answers ends the session at the next sweep, hook or no hook.
    const script = fs.readFileSync(path.join(codeLink.sessionDir(again.sessionId), "run.command"), "utf8");
    expect(script).toContain("echo $$ >");
    fs.writeFileSync(path.join(codeLink.sessionDir(again.sessionId), "pid"), "99999\n");
    codeLink.sessions.sweep(project.id);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ id: again.sessionId, state: "ended" });
    expect(ctx.agent.store.messages(project.id, result.threadId)).toEqual([]);
  });

  it("starts Gemini CLI and OpenCode only in a terminal, each with its own session-only MCP config", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    for (const [id, title] of [["gemini", "Gemini CLI"], ["opencode", "OpenCode"]] as const) {
      await ctx.plugin({ name: `fake-${id}`, inject: ["agent"], apply: (c: Context) => void c.agent.engine({ ...fakeCodeEngine([]), id, title, author: `ai:${id}`, terminalOnly: true }) });
    }
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();

    // The person's own Gemini home, which the session's is made from.
    const ownHome = fs.mkdtempSync(path.join(root, "gemini-own-"));
    fs.mkdirSync(path.join(ownHome, ".gemini"));
    fs.writeFileSync(path.join(ownHome, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
    const savedHome = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = ownHome;
    const item = ticket("Gemini terminal work");
    expect(await codeLink.start(project.id, item.id, { mode: "run", engine: "gemini" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringMatching(/only in a terminal/) });
    const gemini = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "gemini", options: { model: "pro" } });
    if (savedHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = savedHome;
    expect(gemini.ok).toBe(true);
    if (!gemini.ok) return;
    expect(gemini.command).toMatch(/^GEMINI_CLI_HOME=".*gemini-home" gemini -m pro -i "\$\(cat ".*prompt\.md"\)"$/);
    const geminiSettings = JSON.parse(fs.readFileSync(path.join(codeLink.sessionDir(gemini.sessionId), "gemini-home", ".gemini", "settings.json"), "utf8"));
    expect(geminiSettings).toEqual({ security: { auth: { selectedType: "gemini-api-key" } }, mcpServers: { tomrade: { httpUrl: ctx.mcp.urlFor(project.id), headers: { "X-Tomrade-Run": codeLink.sessions.token(gemini.sessionId) } } } });
    // a terminal-only engine takes no turn inside Tomrade
    expect(() => ctx.agent.send(project.id, gemini.threadId, { kind: "text", text: "go on" })).toThrow(/only in a terminal/);

    const other = ticket("OpenCode terminal work");
    const opencode = await codeLink.start(project.id, other.id, { mode: "terminal", engine: "opencode", options: { model: "anthropic/claude-sonnet-5" } });
    expect(opencode.ok).toBe(true);
    if (!opencode.ok) return;
    expect(opencode.command).toMatch(/^OPENCODE_CONFIG=".*opencode\.json" opencode --model anthropic\/claude-sonnet-5 --prompt "\$\(cat ".*prompt\.md"\)"$/);
    const config = JSON.parse(fs.readFileSync(path.join(codeLink.sessionDir(opencode.sessionId), "opencode.json"), "utf8"));
    expect(config.mcp.tomrade).toEqual({ type: "remote", url: ctx.mcp.urlFor(project.id), enabled: true, headers: { "X-Tomrade-Run": codeLink.sessions.token(opencode.sessionId) } });
  });

  it("opens a terminal pi session whose extension carries the MCP server and reports like Claude's hooks", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    await ctx.plugin({ name: "fake-pi", inject: ["agent"], apply: (c: Context) => void c.agent.engine({ ...fakeCodeEngine([]), id: "pi", title: "Pi", author: "ai:pi" }) });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("Pi terminal work");
    const result = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "pi", options: { effort: "high" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toMatch(/^pi --thinking high -e ".*pi-extension\.ts" "\$\(cat ".*prompt\.md"\)"$/);

    // Load the extension the way pi does, against a stand-in for pi's API; its reports reach the real event endpoint.
    const source = fs.readFileSync(path.join(codeLink.sessionDir(result.sessionId), "pi-extension.ts"), "utf8");
    const servers: Record<string, { url: string; headers: Record<string, string>; exposure: string }> = {};
    const on: Record<string, (event: unknown, ctx?: unknown) => Promise<unknown> | unknown> = {};
    (await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`)).default({
      registerMcpServer: (name: string, config: (typeof servers)[string]) => { servers[name] = config; },
      on: (event: string, handler: (typeof on)[string]) => { on[event] = handler; }
    });
    expect(servers.tomrade).toMatchObject({ url: ctx.mcp.urlFor(project.id), exposure: "direct" });
    expect(servers.tomrade.headers["X-Tomrade-Run"]).toBe(codeLink.sessions.token(result.sessionId));
    const session = () => codeLink.sessionsOf(project.id, item.id)[0];
    await on.session_start!({ type: "session_start", reason: "startup" }, { sessionManager: { getSessionId: () => "pi-abc" } });
    expect(session()).toMatchObject({ state: "running", externalId: "pi-abc", mode: "terminal" });
    expect(await on.tool_call!({ toolName: "bash", input: { command: "flutter create ." } })).toBeUndefined();
    expect(session()).toMatchObject({ state: "running", activity: "Bash · flutter create ." });
    await on.tool_result!({ toolName: "bash", input: { command: "flutter create ." }, content: [{ type: "text", text: "ok" }], isError: false });
    expect(session().activity).toBeNull();
    on.agent_end!({ messages: [{ role: "assistant", content: [{ type: "text", text: "Scaffold in place.\n\nNext: CI." }], stopReason: "stop" }] });
    await vi.waitFor(() => expect(session()).toMatchObject({ state: "waiting", summary: "Scaffold in place." }));
    await on.session_shutdown!({ type: "session_shutdown", reason: "quit" });
    expect(session().state).toBe("ended");

    // Continuing resumes the pi session it heard about.
    const again = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "pi" });
    expect(again.ok ? again.command : "").toContain("--session-id pi-abc");
  });

  it("starts WorkBuddy in a terminal with Claude's flags, and refuses an agent that runs only inside Tomrade", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    await ctx.plugin({ name: "fake-acp", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "workbuddy", title: "WorkBuddy", author: "ai:workbuddy" });
      c.agent.engine({ ...fakeCodeEngine([]), id: "inside", title: "Inside", author: "ai:inside", terminal: false });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("WorkBuddy terminal work");
    const result = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "workbuddy", options: { model: "hy3" } });
    expect(result.ok ? result.command : result).toMatch(/^codebuddy --model hy3 --mcp-config ".*mcp\.json" --settings ".*settings\.json" "\$\(cat ".*prompt\.md"\)"$/);

    const other = ticket("Inside terminal work");
    expect(await codeLink.start(project.id, other.id, { mode: "terminal", engine: "inside" }))
      .toEqual({ ok: false, gate: "engine", engine: "inside", message: "Inside runs only inside Tomrade — choose Run here, or set up another CLI agent under Settings → Code link" });
    const general = world.items.create({ projectId: project.id, boardId: world.board.id, title: "Inside general work", workType: "general", status: "todo", by: "human" });
    expect(await codeLink.start(project.id, general.id, { mode: "terminal", engine: "inside" })).toMatchObject({ ok: false, gate: "engine" });
  });

  it("runs DeepSeek Harness in a terminal as one headless run, with a session-only server, shown and reported, then resumed", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    // Found inside the desktop app, not on PATH.
    const bin = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
    await ctx.plugin({ name: "fake-dsh", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "dsh", title: "DeepSeek Harness", author: "ai:dsh", terminal: true,
        available: async () => ({ ok: true, cli: { name: "dsh", state: "ready", path: bin, attempts: [], searched: [], platform: "darwin", arch: "arm64", pathEnv: "" } }) });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("DeepSeek Harness terminal work");
    const started = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "dsh" });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const dir = codeLink.sessionDir(started.sessionId);
    expect(started.command).toBe(`"${bin}" --profile headless --patch "${path.join(dir, "dsh-patch.yml")}" --json - < "${path.join(dir, "prompt.md")}" | ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${path.join(dir, "dsh-report.mjs")}"`);
    const patch = fs.readFileSync(path.join(dir, "dsh-patch.yml"), "utf8");
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain(`url: "${ctx.mcp.urlFor(project.id)}"`);
    expect(patch).toContain(`X-Tomrade-Run: "${codeLink.sessions.token(started.sessionId)}"`);

    // The run's --json events, as DeepSeek Harness 0.2.0-rc.2 writes them, through the generated script.
    const events = [
      { type: "session", sessionId: "session-abc", cwd: checkout },
      { type: "status", phase: "turn_start", turn: 1 },
      { type: "tool_call", callId: "c1", tool: "bash", input: { command: "echo hi" } },
      { type: "tool_result", callId: "c1", status: "completed", result: "hi\n" },
      { type: "text", text: "Done." },
      { type: "final", text: "Done." }
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    const { execFile } = await import("node:child_process");
    const shown = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [path.join(dir, "dsh-report.mjs")], (err, stdout) => (err ? reject(err) : resolve(stdout)));
      child.stdin!.end(events);
    });
    expect(shown).toContain("DeepSeek Harness session session-abc");
    expect(shown).toContain("> bash echo hi");
    expect(shown).toContain("Done.");
    const [session] = codeLink.sessionsOf(project.id, item.id);
    expect(session).toMatchObject({ agent: "dsh", externalId: "session-abc", state: "ended" });

    // Continue resumes that session.
    const again = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "dsh" });
    expect(again.ok ? again.command : again).toContain("--json --session-id session-abc -");
  });

  it("starts Antigravity CLI in a terminal once it is connected, tells it to claim first, and its claim joins the session Start made", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    let state: "connected" | "missing" = "missing";
    const view = () => ({ state, url: null, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" } });
    await ctx.plugin({ name: "fake-agy", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "agy", title: "Antigravity CLI", author: "ai:agy", capabilities: ["code", "general"], terminalOnly: true, terminalViaLink: true, terminalClaims: true,
        mcpLink: { status: async () => view(), connect: async () => view(), disconnect: async () => view() } });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("Antigravity terminal work");
    expect(await codeLink.start(project.id, item.id, { mode: "terminal", engine: "agy" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringContaining("Connect it under Antigravity CLI in Settings") });

    state = "connected";
    const started = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "agy", options: { model: "gemini-3.6-flash" } });
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(started.command).toMatch(/^agy --model gemini-3\.6-flash -i "\$\(cat ".*prompt\.md"\)"$/);
    const prompt = fs.readFileSync(path.join(codeLink.sessionDir(started.sessionId), "prompt.md"), "utf8");
    expect(prompt.startsWith(`Before anything else, call the tomrade MCP tool claim_ticket with key "${item.key}"`)).toBe(true);

    // Its calls carry no token; the claim over its connection is its first act, and it lands on Start's session.
    const claimed = await ctx.tools.execute("claim_ticket", { key: item.key }, { by: "ai:mcp", projectId: project.id, connection: "agy-conn" }) as { tracking: { tracked: boolean; sessionId: string } };
    expect(claimed.tracking).toMatchObject({ tracked: true, sessionId: started.sessionId });
    expect(codeLink.sessionsOf(project.id, item.id).map((s) => s.id)).toEqual([started.sessionId]);
  });

  it("passes over an engine that can only chat when none is named, and says why when it is named", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    // Tomrade with no model: available, but only to chat; it comes before every CLI.
    const chatOnly: Engine = { ...fakeCodeEngine([]), id: "chat-only", title: "Tomrade", available: async () => ({ ok: true, capabilities: ["backlog"] }) };
    await ctx.plugin({ name: "chat-only", inject: ["agent"], apply: (c: Context) => void c.agent.engine(chatOnly) });
    await settle();
    const engines = vi.spyOn(agent, "codeEngines").mockImplementation(() => [chatOnly, ...agent.allEngines().filter((e) => e.id === "fake-code")]);
    try {
      const started = await codeLink.start(project.id, ticket("Run on whoever can").id, { mode: "run" });
      if (!started.ok) throw new Error(JSON.stringify(started));
      expect(agent.store.thread(project.id, started.threadId)?.engine).toBe("fake-code");
      await untilRunsSettle(agent);

      expect(await codeLink.start(project.id, ticket("Run on Tomrade").id, { mode: "run", engine: "chat-only" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringContaining("Tomrade: can only chat for now — connect a model") });
    } finally {
      engines.mockRestore();
    }
  });

  it("starts Cursor in a terminal once its own config names Tomrade, and tells it to claim first", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    let state: "connected" | "missing" = "missing";
    const view = () => ({ state, url: null, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" } });
    await ctx.plugin({ name: "fake-cursor", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "cursor", title: "Cursor", author: "ai:cursor", capabilities: ["code", "general"], terminalOnly: true, terminalViaLink: true, terminalClaims: true,
        mcpLink: { status: async () => view(), connect: async () => view(), disconnect: async () => view() } });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("Cursor terminal work");
    expect(await codeLink.start(project.id, item.id, { mode: "terminal", engine: "cursor" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringContaining("Connect it under Cursor in Settings") });

    state = "connected";
    const started = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "cursor", options: { model: "gpt-5" } });
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(started.command).toMatch(/^cursor-agent --model gpt-5 "\$\(cat ".*prompt\.md"\)"$/);
    const prompt = fs.readFileSync(path.join(codeLink.sessionDir(started.sessionId), "prompt.md"), "utf8");
    expect(prompt.startsWith(`Before anything else, call the tomrade MCP tool claim_ticket with key "${item.key}"`)).toBe(true);
  });

  it("starts Hermes in a terminal once its own sessions reach Tomrade, and asks for that first", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    let state: "connected" | "missing" = "missing";
    const view = () => ({ state, url: null, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" } });
    await ctx.plugin({ name: "fake-hermes", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "hermes", title: "Hermes", author: "ai:hermes", terminal: true, terminalViaLink: true,
        mcpLink: { status: async () => view(), connect: async () => view(), disconnect: async () => view() } });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("Hermes terminal work");
    expect(await codeLink.start(project.id, item.id, { mode: "terminal", engine: "hermes" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringContaining("Connect it under Hermes in Settings") });
    const general = world.items.create({ projectId: project.id, boardId: world.board.id, title: "Hermes general work", workType: "general", status: "todo", by: "human" });
    expect(await codeLink.start(project.id, general.id, { mode: "terminal", engine: "hermes" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringContaining("Connect it under Hermes in Settings") });

    state = "connected";
    const started = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "hermes", options: { model: "openrouter:some/model" } });
    expect(started.ok ? started.command : started).toMatch(/^hermes chat -m openrouter:some\/model --query-file ".*prompt\.md"$/);
  });

  it("keeps where a headless start was asked for on its brief", async () => {
    const world = await machine(codeRepo());
    const { codeLink, project, agent } = world;
    await world.ctx.repos.setCheckout(world.repo!.remote, world.checkout!);
    const item = world.ticket("Start it from chat");
    const source = { connection: "bot", tenant: "team", conversation: "chat", actor: "owner" };
    const result = await codeLink.start(project.id, item.id, { mode: "run", source });
    expect(result.ok && result.runId).toBeTruthy();
    if (!result.ok) return;
    await untilRunsSettle(agent);
    const row = world.ctx.db.for(project.id).prepare("SELECT source_json FROM plugin_agent_inputs WHERE run_id = ?").get(result.runId) as { source_json: string } | undefined;
    expect(JSON.parse(row!.source_json)).toEqual(source);
  });

  it("carries the knobs picked at Start onto the ticket's thread, where the turn and the panel read them", async () => {
    const world = await machine(codeRepo());
    const { codeLink, project, agent } = world;
    await world.ctx.repos.setCheckout(world.repo!.remote, world.checkout!);
    const item = world.ticket("Pick a model");
    const result = await codeLink.start(project.id, item.id, { mode: "run", options: { model: "opus", effort: "high" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runId).toBeTruthy();
    await untilRunsSettle(agent);
    expect(agent.store.thread(project.id, result.threadId)?.options).toEqual({ model: "opus", effort: "high" });
    expect(world.turns.at(-1)?.options).toEqual({ model: "opus", effort: "high" });
    // Continue without knobs keeps them; an explicit empty set clears them and the engine's settings apply again.
    const again = await codeLink.start(project.id, item.id, { mode: "run" });
    await untilRunsSettle(agent);
    expect(again.ok && again.continued).toBe(true);
    expect(world.turns.at(-1)?.options).toEqual({ model: "opus", effort: "high" });
    await codeLink.start(project.id, item.id, { mode: "run", options: {} });
    await untilRunsSettle(agent);
    expect(agent.store.thread(project.id, result.threadId)?.options).toBeNull();
    // The turn sees no overrides as an empty object, which is what an engine's options schema takes.
    expect(world.turns.at(-1)?.options).toEqual({});
  });
});

describe("remembering the start configuration", () => {
  it("remembers what a start ran with and hands it back after a restart", async () => {
    const where = path.join(root, `code-link-defaults-${n++}.json`);
    const world = await machine(codeRepo(), { defaultsPath: where });
    const { codeLink, ctx, project, repo, checkout, agent, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    expect(codeLink.startDefaults()).toBeNull();

    const first = ticket("Pick a model");
    expect(await codeLink.start(project.id, first.id, { mode: "run", options: { model: "opus", effort: "high" } })).toMatchObject({ ok: true });
    await untilRunsSettle(agent);
    expect(codeLink.startDefaults()).toEqual({ mode: "run", engine: "fake-code", options: { model: "opus", effort: "high" } });

    // A General ticket carries its method along with the surface and the agent.
    const general = world.items.create({ projectId: project.id, boardId: world.board.id, title: "Prepare the workshop", workType: "general", status: "todo", by: "human" });
    expect(await codeLink.start(project.id, general.id, { mode: "run", playbook: "task.assist" })).toMatchObject({ ok: true });
    await untilRunsSettle(agent);
    expect(codeLink.startDefaults()).toEqual({ mode: "run", engine: "fake-code", playbook: "task.assist" });

    // Starting again on a machine that just booted reads the file: the memory is not in-process state.
    const restarted = await machine(codeRepo(), { defaultsPath: where });
    expect(restarted.codeLink.startDefaults()).toEqual({ mode: "run", engine: "fake-code", playbook: "task.assist" });

    // A gate the user had to clear is not a configuration that ran, so it is not remembered.
    const fresh = await machine(null, { defaultsPath: where });
    const gated = fresh.ticket("No repository yet");
    expect(await fresh.codeLink.start(fresh.project.id, gated.id, { mode: "terminal", engine: "other" })).toMatchObject({ ok: false, gate: "workstream" });
    expect(fresh.codeLink.startDefaults()).toEqual({ mode: "run", engine: "fake-code", playbook: "task.assist" });
  });

  it("hands back only what still fits: an agent or a knob the person has since removed is dropped", async () => {
    const where = path.join(root, `code-link-defaults-${n++}.json`);
    // Written by a version that had an engine and an option this machine does not have now.
    fs.writeFileSync(where, JSON.stringify({ mode: "terminal", engine: "vanished-agent", options: { model: "gone", effort: "high" }, permissionMode: "acceptEdits", updatedAt: Date.now() }));
    const world = await machine(codeRepo(), { defaultsPath: where });
    const { codeLink } = world;
    // The memory still loads, so the dialog can keep what it recognises and its own default covers the rest.
    expect(codeLink.startDefaults()).toEqual({ mode: "terminal", engine: "vanished-agent", options: { model: "gone", effort: "high" }, permissionMode: "acceptEdits" });
    // Nothing usable at all reads as no memory, and a start still runs rather than failing on it.
    fs.writeFileSync(where, JSON.stringify({ mode: "run", updatedAt: Date.now() }));
    expect(codeLink.startDefaults()).toBeNull();
    const item = world.ticket("Still starts");
    await world.ctx.repos.setCheckout(world.repo!.remote, world.checkout!);
    expect(await codeLink.start(world.project.id, item.id, { mode: "run" })).toMatchObject({ ok: true });
    await untilRunsSettle(world.agent);
  });
});

describe("starting a General ticket", () => {
  it("runs it here without a repository, then in a terminal over MCP, following it as a session either way", async () => {
    const world = await machine(null);
    const { ctx, codeLink, project, board, agent } = world;
    const item = world.items.create({ projectId: project.id, boardId: board.id, title: "Prepare the workshop", body: "A checklist", workType: "general", status: "todo", by: "human" });

    const run = await codeLink.start(project.id, item.id, { mode: "run", playbook: "task.assist", options: { model: "opus" } });
    expect(run).toMatchObject({ ok: true, continued: false, mode: "run", branch: "", worktree: null, launched: true });
    if (!run.ok) return;
    expect(run.runId).toBeTruthy();
    await untilRunsSettle(agent);
    expect(world.turns.at(-1)).toMatchObject({ purpose: "general", options: { model: "opus" }, execution: { playbook: { id: "task.assist" } } });
    expect(world.turns.at(-1)?.cwd).toBe(run.cwd);
    expect(ctx.items.get(project.id, item.id)).toMatchObject({ status: "doing", playbookId: "task.assist" });
    expect(codeLink.sessionsOf(project.id, item.id)).toMatchObject([{ id: run.sessionId, mode: "headless", repoId: "", branch: "", threadId: run.threadId, agent: "fake-code", state: "idle" }]);
    expect((await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")?.rows.find((r) => r.label === "Session")).toMatchObject({ value: expect.stringContaining("run by Tomrade") });

    // The terminal path binds the same thread and delivery; the CLI gets the whole brief in its prompt file.
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    expect(await codeLink.start(project.id, item.id, { mode: "terminal" })).toMatchObject({ ok: false, gate: "mcp" });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    // A method whose capability no plugin provides is refused before anything is created.
    await expect(codeLink.start(project.id, item.id, { mode: "terminal", playbook: "document.write" })).rejects.toThrow("files.write");
    const dispose = agent.capability("files.write");
    const opened = await codeLink.start(project.id, item.id, { mode: "terminal", playbook: "document.write" });
    expect(opened).toMatchObject({ ok: true, continued: true, mode: "terminal", threadId: run.threadId, launched: false });
    if (!opened.ok) return;
    // The headless run taught the thread the CLI's session id; the terminal continues it.
    expect(opened.command).toMatch(/^claude --mcp-config ".*mcp\.json" --settings ".*settings\.json" --resume fake-session-1 "\$\(cat ".*prompt\.md"\)"$/);
    const prompt = fs.readFileSync(path.join(codeLink.sessionDir(opened.sessionId), "prompt.md"), "utf8");
    expect(prompt).toContain(`Continue ${item.key}: Prepare the workshop`);
    expect(prompt).toContain("You are delivering");
    expect(prompt).toContain("Selected playbook document.write");
    expect(prompt).toContain(`Working directory: ${opened.cwd}`);
    // A General ticket started in Code Link answers in the language the person reads Tomrade in.
    expect(prompt).toContain("the person reads Tomrade in English");
    expect(agent.store.thread(project.id, run.threadId)).toMatchObject({ surface: "code", execution: { playbook: { id: "document.write" } } });
    expect(ctx.items.get(project.id, item.id)?.playbookId).toBe("document.write");
    const sessions = codeLink.sessionsOf(project.id, item.id);
    expect(sessions.find((s) => s.id === opened.sessionId)).toMatchObject({ mode: "terminal", state: "running", threadId: run.threadId });
    dispose();
  });
});

it("lets the assistant offer Start as a card instead of doing the work itself", async () => {
  const { ctx, project, agent, ticket } = await machine(null);
  const item = ticket("Fix the login form");
  const results: unknown[] = [];
  ctx.agent.engine({
    id: "offering",
    title: "Offering",
    author: "ai:test",
    available: async () => ({ ok: true }),
    async turn(_input, io) {
      for (const key of [item.key, "TOM-999"]) results.push(await io.tools.execute("offer_start", { key }).catch((err: Error) => err.message));
      return { stop: "end" };
    }
  });
  try {
    // Every engine in a conversation reaches it over its run-bound session; an outside client does not.
    expect(ctx.tools.served("run").map((t) => t.name)).toContain("offer_start");
    expect(ctx.tools.served().map((t) => t.name)).not.toContain("offer_start");
    const thread = agent.newThread(project.id, "offering");
    const run = agent.send(project.id, thread.id, { kind: "text", text: "fix the login form" });
    await expect.poll(() => agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(results).toEqual([expect.objectContaining({ offered: item.key }), expect.stringContaining("no ticket TOM-999")]);
    const cards = agent.thread(project.id, thread.id).messages.flatMap((m) => (m.block.type === "card" ? [m.block] : []));
    expect(cards).toEqual([expect.objectContaining({ schema: "start", data: { itemId: item.id, key: item.key, title: "Fix the login form" } })]);
    expect(ctx.items.get(project.id, item.id)?.status).toBe("todo");
  } finally {
    await ctx.fiber.dispose();
  }
});
