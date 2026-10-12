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
import { CodeLink, BOOTSTRAP_LABEL, sessionContext } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import { Repos } from "@tomradex/repos";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

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

async function machine(repo: { remote: string; checkout: string } | null, opts: { gitBinary?: string } = {}) {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const turns: TurnInput[] = [];
  const enginePlugin = { name: "fake-code-engine", inject: ["agent"], apply: (ctx: Context) => void ctx.agent.engine(fakeCodeEngine(turns)) };
  const bag = await fresh({
    hubDir,
    plugins: [
      Tools,
      [Settings, { path: path.join(hubDir, "settings.json") }],
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      [Repos, { gitBinary: opts.gitBinary ?? "git" }],
      Contributions,
      Agent,
      enginePlugin,
      [CodeLink, { scanMs: 0, gitBinary: opts.gitBinary ?? "git" }]
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
  return { ...bag, codeLink: bag.ctx.codeLink, agent: bag.ctx.agent, repo: row, checkout: repo?.checkout ?? null, hubDir, turns, ticket };
}

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
  const connection = vi.spyOn(ctx.storage, "connection").mockResolvedValue({ connected: true, label: "@right-account" });
  fs.writeFileSync(path.join(hubDir, "settings.json"), JSON.stringify({ github: { token: "fake-project-token" } }));
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
  const world = await machine({ ...local, remote });
  const { ctx, codeLink, project, hubDir } = world;
  const connection = vi.spyOn(ctx.storage, "connection").mockResolvedValue({ connected: true, label: "@right-account" });
  fs.writeFileSync(path.join(hubDir, "settings.json"), JSON.stringify({ github: { token: "fake-project-token" } }));
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
  const connection = vi.spyOn(ctx.storage, "connection").mockResolvedValue({ connected: true, label: "@account" });
  fs.writeFileSync(path.join(hubDir, "settings.json"), JSON.stringify({ github: { token: "fake-token" } }));
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
    expect(codeLink.repoState(project.id, repo!.id)!.readiness).toBe("empty"); // no manifest yet — the fake agent wrote no package.json
    expect(ctx.items.get(project.id, feature.id)!.blockedBy).toEqual([bootstrap.id]);
    expect(await codeLink.start(project.id, feature.id, { mode: "run" })).toMatchObject({ ok: false, gate: "readiness" });
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
    expect(section.rows.find((r) => r.label === "Pull request")).toMatchObject({ value: "none — no remote; merge the branch into main here" });
    expect(await codeLink.openPr(project.id, item.id)).toMatchObject({ pushed: false, message: expect.stringContaining("has no remote") });

    const handed = (await sessionContext.run({ projectId: project.id, sessionId: result.sessionId }, () => ctx.tools.execute("link_code", { scopeChecked: true }, { by: "ai:fake-code", projectId: project.id }))) as { status: string };
    expect(handed.status).toBe("verifying");

    git(["merge", "-q", "--no-ff", "-m", `Merge ${item.key}`, result.branch], folder);
    await codeLink.scan(project.id);
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
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

    await expect(sessionContext.run({ projectId: project.id, sessionId: first.sessionId }, () => ctx.tools.execute("link_code", { prState: "merged", scopeChecked: true }, { by: "human", projectId: project.id }))).rejects.toThrow("reopen");
    expect(codeLink.deliveries(project.id, item.id)).toHaveLength(1);
    ctx.items.update(project.id, item.id, { status: "todo" }, "human");
    await expect(sessionContext.run({ projectId: project.id, sessionId: first.sessionId }, () => ctx.tools.execute("claim_ticket", { key: item.key }, { by: "human", projectId: project.id }))).rejects.toThrow("earlier delivery");
    expect(codeLink.store.session(project.id, first.sessionId)?.delivery).toBe(1);
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
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "running", externalId: "cli-abc", mode: "terminal" });
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

    const item = ticket("Gemini terminal work");
    expect(await codeLink.start(project.id, item.id, { mode: "run", engine: "gemini" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringMatching(/only in a terminal/) });
    const gemini = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "gemini", options: { model: "pro" } });
    expect(gemini.ok).toBe(true);
    if (!gemini.ok) return;
    expect(gemini.command).toMatch(/^GEMINI_CLI_SYSTEM_DEFAULTS_PATH=".*gemini-settings\.json" gemini -m pro -i "\$\(cat ".*prompt\.md"\)"$/);
    const geminiSettings = JSON.parse(fs.readFileSync(path.join(codeLink.sessionDir(gemini.sessionId), "gemini-settings.json"), "utf8"));
    expect(geminiSettings).toEqual({ mcpServers: { tomrade: { httpUrl: ctx.mcp.urlFor(project.id), headers: { "X-Tomrade-Run": codeLink.sessions.token(gemini.sessionId) } } } });
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
      c.agent.engine({ ...fakeCodeEngine([]), id: "hermes", title: "Hermes", author: "ai:hermes", terminal: false });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("WorkBuddy terminal work");
    const result = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "workbuddy", options: { model: "hy3" } });
    expect(result.ok ? result.command : result).toMatch(/^codebuddy --model hy3 --mcp-config ".*mcp\.json" --settings ".*settings\.json" "\$\(cat ".*prompt\.md"\)"$/);

    const other = ticket("Hermes terminal work");
    expect(await codeLink.start(project.id, other.id, { mode: "terminal", engine: "hermes" }))
      .toEqual({ ok: false, gate: "engine", engine: "hermes", message: "Hermes runs only inside Tomrade — choose Run here, or set up another CLI agent under Settings → Code link" });
    const general = world.items.create({ projectId: project.id, boardId: world.board.id, title: "Hermes general work", workType: "general", status: "todo", by: "human" });
    expect(await codeLink.start(project.id, general.id, { mode: "terminal", engine: "hermes" })).toMatchObject({ ok: false, gate: "engine" });
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
    expect(world.turns.at(-1)?.options).toBeUndefined();
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
    expect(agent.store.thread(project.id, run.threadId)).toMatchObject({ surface: "code", execution: { playbook: { id: "document.write" } } });
    expect(ctx.items.get(project.id, item.id)?.playbookId).toBe("document.write");
    const sessions = codeLink.sessionsOf(project.id, item.id);
    expect(sessions.find((s) => s.id === opened.sessionId)).toMatchObject({ mode: "terminal", state: "running", threadId: run.threadId });
    dispose();
  });
});
