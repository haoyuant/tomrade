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
import { afterAll, describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { Agent, type Engine, type TurnInput } from "@tomrade/agent";
import { CodeLink, BOOTSTRAP_LABEL } from "@tomrade/code-link";
import { Contributions } from "@tomrade/contributions";
import { Repos } from "@tomrade/repos";
import { Settings } from "@tomrade/settings";
import { Storage } from "@tomrade/storage";
import { fresh, settle } from "@tomrade/testkit";
import { Tools } from "@tomrade/tools";

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

/** A code-capable engine that records what it was asked and makes one commit in the worktree. */
function fakeCodeEngine(turns: TurnInput[]): Engine {
  return {
    id: "fake-code",
    title: "Fake coding agent",
    author: "ai:fake-code",
    capabilities: ["backlog", "code"],
    available: async () => ({ ok: true }),
    async turn(input, io) {
      turns.push(input);
      if (input.cwd) {
        fs.writeFileSync(path.join(input.cwd, `work-${turns.length}.ts`), "export {};\n");
        git(["add", "-A"], input.cwd);
        git(["commit", "-q", "-m", `${input.ticket?.key ?? "TOM-0"}: work`], input.cwd);
      }
      io.emit({ type: "text", text: "done a step" });
      return { stop: "end", resume: "fake-session-1" };
    }
  };
}

async function machine(repo: { remote: string; checkout: string } | null) {
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
      Repos,
      Contributions,
      Agent,
      enginePlugin,
      [CodeLink, { scanMs: 0 }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  let row = null as ReturnType<typeof bag.ctx.repos.create> | null;
  if (repo) {
    row = bag.ctx.repos.create({ projectId: bag.project.id, remote: repo.remote });
    bag.boards.update(bag.project.id, bag.board.id, { repoId: row.id });
  }
  const ticket = (title: string, status: "backlog" | "todo" | "doing" = "todo") => bag.items.create({ projectId: bag.project.id, boardId: bag.board.id, title, status, by: "human" });
  return { ...bag, codeLink: bag.ctx.codeLink, agent: bag.ctx.agent, repo: row, checkout: repo?.checkout ?? null, hubDir, turns, ticket };
}

async function untilRunsSettle(agent: Agent, timeout = 8000) {
  const t0 = Date.now();
  while (agent.activeRuns().length) {
    if (Date.now() - t0 > timeout) throw new Error("runs did not settle");
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("starting a ticket", () => {
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
    expect(codeLink.repoState(project.id, repo!.id)).toMatchObject({ readiness: "unknown", summary: expect.stringContaining("remote unreachable") });
    const gated = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(gated).toMatchObject({ ok: false, gate: "remote" });
    expect(ctx.items.list({ projectId: project.id }).some((i) => i.labels.includes(BOOTSTRAP_LABEL))).toBe(false);
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
    const section = ctx.contributions.sectionsFor(project.id, item.id).find((s) => s.id === "code")!;
    expect(section.rows.find((r) => r.label === "Pull request")).toMatchObject({ value: "#12 · open", href: "https://github.com/acme/app/pull/12" });
    expect(section.rows.find((r) => r.label === "Session")?.value).toMatch(/^idle · run by Tomrade/);
    expect(section.rows.find((r) => r.label === "Worktree")).toMatchObject({ value: result.worktree, command: "code-link.open-terminal" });
    expect(ctx.contributions.badgesFor(project.id)[item.id]).toEqual([{ id: "pr", label: "PR #12", tone: "strong", title: "https://github.com/acme/app/pull/12" }]);
  });

  it("opens a terminal session: files for the agent, a token that binds its calls and hooks to the ticket", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    const item = ticket("Terminal work");

    // Without the MCP server there is nothing for the agent to connect to.
    expect(await codeLink.start(project.id, item.id, { mode: "terminal" })).toMatchObject({ ok: false, gate: "mcp" });

    const { Mcp } = await import("@tomrade/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
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
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toContain(`Implement ${item.key}`);
    expect(fs.existsSync(path.join(dir, "run.command"))).toBe(true);

    // A hook posts to the event URL: the session's state follows.
    const post = async (payload: unknown) => {
      const res = await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      return res.status;
    };
    expect(await post({ hook_event_name: "SessionStart", session_id: "cli-abc" })).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "running", externalId: "cli-abc", mode: "terminal" });
    await post({ hook_event_name: "Stop", session_id: "cli-abc" });
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("waiting");
    expect(ctx.contributions.badgesFor(project.id)[item.id]).toEqual(expect.arrayContaining([{ id: "waiting", label: "waiting", tone: "strong", title: "The coding session is waiting for you" }]));
    // Tomrade restarts: the binding is gone from memory, the token is still in the session's folder, and comes back.
    codeLink.sessions.release(result.sessionId);
    expect(await post({ hook_event_name: "PostToolUse" })).toBe(404);
    expect(codeLink.rebindSessions(project.id)).toBe(1);
    expect(await post({ hook_event_name: "PostToolUse" })).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("running");

    expect(await post({ hook_event_name: "SessionEnd" })).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("ended");
    expect(await post({ hook_event_name: "SessionStart" })).toBe(404);

    // Continuing resumes the CLI session it learned about.
    const again = await codeLink.start(project.id, item.id, { mode: "terminal" });
    expect(again.ok && again.continued).toBe(true);
    expect(again.ok ? again.command : "").toContain("--resume cli-abc");
  });
});
