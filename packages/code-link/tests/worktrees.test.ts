/**
 * The worktrees Tomrade makes for tickets, and their end: over the real Agent, code link and a real repository. A
 * stand-in engine makes one commit in the worktree it is given.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Context } from "cordis";
import { Agent, type Engine } from "@tomradex/agent";
import { CodeLink } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import GitHubAccount from "@tomradex/github";
import { Repos } from "@tomradex/repos";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { disposeFresh, fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-worktrees-"));
afterAll(async () => {
  await disposeFresh();
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
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
    fs.writeFileSync(path.join(checkout, ".gitignore"), "node_modules/\n");
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

const engine: Engine = {
  id: "fake-code",
  title: "Fake coding agent",
  author: "ai:fake-code",
  capabilities: ["backlog", "code", "general"],
  available: async () => ({ ok: true }),
  async turn(input, io) {
    if (input.cwd && input.purpose === "code") {
      fs.writeFileSync(path.join(input.cwd, `work-${Date.now()}.ts`), "export {};\n");
      // What an install leaves: ignored by git, and most of what a worktree weighs.
      fs.mkdirSync(path.join(input.cwd, "node_modules", "dep"), { recursive: true });
      fs.writeFileSync(path.join(input.cwd, "node_modules", "dep", "index.js"), "module.exports = 1;\n".repeat(200));
      git(["add", "-A"], input.cwd);
      git(["commit", "-q", "-m", `${input.ticket?.key ?? "TOM-0"}: work`], input.cwd);
    }
    io.emit({ type: "text", text: "done a step" });
    return { stop: "end", resume: "fake-session-1" };
  }
};

async function machine() {
  const repo = codeRepo();
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({
    hubDir,
    plugins: [
      Tools,
      [Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount,
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      [Repos, { gitBinary: "git" }],
      Contributions,
      Agent,
      { name: "fake-code-engine", inject: ["agent"], apply: (ctx: Context) => void ctx.agent.engine(engine) },
      // Passes are asked for here, never timed.
      [CodeLink, { scanMs: 0, worktreeSweepMs: 0, gitBinary: "git", defaultsPath: path.join(hubDir, "code-link.json") }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  const ctx = bag.ctx as Context;
  const projectId = bag.project.id;
  ctx.agent.store.setBrief(projectId, "Test project: the brief is written.");
  const row = ctx.repos.create({ projectId, remote: repo.remote });
  bag.boards.update(projectId, bag.board.id, { repoId: row.id });
  await ctx.repos.setCheckout(repo.remote, repo.checkout);
  ctx.codeLink.pulls = async () => null;
  const keep = (settings: { enabled?: boolean; keepDays?: number; dropBranch?: boolean; dropRemoteBranch?: boolean }) => ctx.settings.set({ ...ctx.settings.get(), worktrees: { enabled: true, keepDays: 0, ...settings } });
  /** A ticket worked by the agent to its end of turn: a commit on its branch, in a worktree of its own. */
  const worked = async (title: string) => {
    const item = bag.items.create({ projectId, boardId: bag.board.id, title, workType: "coding", status: "todo", by: "human" });
    const started = await ctx.codeLink.start(projectId, item.id, { mode: "run" });
    if (!started.ok) throw new Error(`start refused: ${started.message}`);
    const waited = Date.now();
    while (ctx.agent.activeRuns().length) {
      if (Date.now() - waited > 8000) throw new Error("runs did not settle");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    return { item, branch: started.branch, worktree: started.worktree!, threadId: started.threadId! };
  };
  const finish = (itemId: string, status: "done" | "cancelled" = "done") => ctx.items.update(projectId, itemId, { status }, "human");
  const view = async (dir: string) => (await ctx.codeLink.worktreesOf(projectId)).find((tree) => tree.dir === dir);
  return { ...bag, ctx, projectId, codeLink: ctx.codeLink, repo: row, checkout: repo.checkout, keep, worked, finish, view };
}

it("removes a finished ticket's worktree once its keeping time is over; the branch stays and a new Start brings it back", async () => {
  const { ctx, codeLink, projectId, checkout, keep, worked, finish, view } = await machine();
  const { item, branch, worktree, threadId } = await worked("Merged and left behind");
  expect(await view(worktree)).toMatchObject({ owner: "ticket", branch, threadId, hold: "open", removeAt: null, tickets: [{ key: item.key, status: "doing" }] });

  finish(item.id);
  // As after a restart: nothing in memory says where the ticket's worktree is.
  (codeLink as unknown as { worktrees: Map<string, string> }).worktrees.clear();
  const finishedAt = ctx.items.get(projectId, item.id)!.updatedAt;
  expect(await view(worktree)).toMatchObject({ hold: null, removeAt: finishedAt + 24 * 60 * 60_000, tickets: [{ key: item.key, status: "done" }] });
  // Kept for a day by default.
  expect(await codeLink.sweepWorktrees()).toBe(0);
  expect(fs.existsSync(worktree)).toBe(true);

  keep({ keepDays: 0 });
  expect(await codeLink.sweepWorktrees()).toBe(1);
  // The checkout and its installed dependencies are gone; the commits are still on the ticket's branch.
  expect(fs.existsSync(worktree)).toBe(false);
  expect(git(["worktree", "list", "--porcelain"], checkout)).not.toContain(threadId);
  expect(git(["log", "--format=%s", "-1", branch], checkout)).toBe(`${item.key}: work`);
  expect(await codeLink.worktreesOf(projectId)).toEqual([]);
  expect(await codeLink.sweepWorktrees()).toBe(0);

  ctx.items.update(projectId, item.id, { status: "doing" }, "human");
  const again = await codeLink.start(projectId, item.id, { mode: "run", threadId });
  expect(again).toMatchObject({ ok: true, worktree });
  expect(fs.existsSync(worktree)).toBe(true);
});

it("leaves a worktree that still holds something: files git does not have, commits on no branch, a session at work in it", async () => {
  const { ctx, codeLink, projectId, repo, keep, worked, finish, view } = await machine();
  keep({ keepDays: 0 });

  const dirty = await worked("Left a scratch file");
  fs.writeFileSync(path.join(dirty.worktree, "scratch.txt"), "half done\n");
  const loose = await worked("Detached with a commit of its own");
  git(["switch", "-q", "--detach"], loose.worktree);
  fs.writeFileSync(path.join(loose.worktree, "late.ts"), "export {};\n");
  git(["add", "-A"], loose.worktree);
  git(["commit", "-q", "-m", "late"], loose.worktree);
  const busy = await worked("Someone else is in it");
  // An agent in a terminal of the person's own that went into this folder, on no ticket.
  const visitor = codeLink.store.createSession(projectId, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: busy.worktree });
  const detached = await worked("Detached where its branch is");
  git(["switch", "-q", "--detach"], detached.worktree);
  for (const each of [dirty, loose, busy, detached]) finish(each.item.id);

  expect(await view(dirty.worktree)).toMatchObject({ hold: "dirty", removeAt: null });
  expect(await view(loose.worktree)).toMatchObject({ hold: "loose", branch: null, removeAt: null });
  expect(await view(busy.worktree)).toMatchObject({ hold: "busy", removeAt: null });
  expect(await view(detached.worktree)).toMatchObject({ hold: null, branch: null });

  expect(await codeLink.sweepWorktrees()).toBe(1);
  expect([dirty, loose, busy, detached].map((each) => fs.existsSync(each.worktree))).toEqual([true, true, true, false]);
  // Asking by hand gets the same answer, with the reason.
  expect(await codeLink.removeWorktrees(projectId, [dirty.worktree, busy.worktree, ctx.repos.checkout(repo.remote).checkout!])).toEqual([
    { dir: dirty.worktree, removed: false, reason: "dirty", branch: null, remoteBranch: null },
    { dir: busy.worktree, removed: false, reason: "busy", branch: null, remoteBranch: null },
    { dir: ctx.repos.checkout(repo.remote).checkout!, removed: false, reason: "not a worktree Tomrade made for this project", branch: null, remoteBranch: null }
  ]);
  expect(fs.existsSync(ctx.repos.checkout(repo.remote).checkout!)).toBe(true);

  // Each goes once what held it is gone.
  fs.rmSync(path.join(dirty.worktree, "scratch.txt"));
  codeLink.sessions.end(projectId, visitor.id, "ended", true, "left");
  expect(await codeLink.sweepWorktrees()).toBe(2);
  expect([dirty, loose, busy].map((each) => fs.existsSync(each.worktree))).toEqual([false, true, false]);
});

it("never takes the worktree of a ticket that is still open, however clean and merged it looks", async () => {
  const { codeLink, projectId, checkout, keep, worked, view } = await machine();
  keep({ keepDays: 0 });
  const { item, branch, worktree } = await worked("Still being worked");
  // Its branch is already in main, and nothing is uncommitted: what an outside script would call finished.
  git(["merge", "-q", "--ff-only", branch], checkout);
  expect(git(["status", "--porcelain"], worktree)).toBe("");
  expect(await view(worktree)).toMatchObject({ hold: "open", tickets: [{ key: item.key }] });
  expect(await codeLink.sweepWorktrees()).toBe(0);
  expect(await codeLink.removeWorktrees(projectId, [worktree])).toEqual([{ dir: worktree, removed: false, reason: "open", branch: null, remoteBranch: null }]);
  expect(fs.existsSync(worktree)).toBe(true);
});

it("removes a cancelled ticket's worktree too, and none by itself with the setting off — a person still can", async () => {
  const { codeLink, projectId, repo, keep, worked, finish, view } = await machine();
  keep({ enabled: false });
  const cancelled = await worked("Dropped");
  const done = await worked("Finished");
  finish(cancelled.item.id, "cancelled");
  finish(done.item.id);
  // A cancelled ticket's session is not put away for it; here it has ended.
  for (const session of codeLink.store.sessions(projectId, { live: true })) codeLink.sessions.end(projectId, session.id, "ended", true, "stopped");

  expect(await view(cancelled.worktree)).toMatchObject({ hold: null, removeAt: null, tickets: [{ status: "cancelled" }] });
  expect(await codeLink.sweepWorktrees()).toBe(0);
  expect(fs.existsSync(done.worktree)).toBe(true);

  // Across the open projects: this one's repository with its two, and the disk they are on.
  const overview = await codeLink.worktreeOverview();
  expect(overview.root).toBe(path.dirname(path.dirname(done.worktree)));
  expect(overview.disk!.total).toBeGreaterThan(overview.disk!.free);
  expect(overview.groups).toMatchObject([{ projectId, repoId: repo.id, repo: repo.name, trees: [{ hold: null }, { hold: null }] }]);
  expect(overview.groups[0]!.trees.map((tree) => tree.dir).sort()).toEqual([cancelled.worktree, done.worktree].sort());

  // What it weighs: the installed dependencies count.
  expect(await codeLink.worktreeSize(projectId, done.worktree)).toBeGreaterThan(4000);
  expect(await codeLink.worktreeSize(projectId, path.dirname(done.worktree))).toBeNull();

  expect(await codeLink.removeWorktrees(projectId, [cancelled.worktree, done.worktree])).toEqual([
    { dir: cancelled.worktree, removed: true, reason: null, branch: "kept", remoteBranch: null },
    { dir: done.worktree, removed: true, reason: null, branch: "kept", remoteBranch: null }
  ]);
  expect([cancelled, done].map((each) => fs.existsSync(each.worktree))).toEqual([false, false]);

  keep({ enabled: true });
  const next = await worked("Finished with the setting on");
  finish(next.item.id, "cancelled");
  for (const session of codeLink.store.sessions(projectId, { live: true })) codeLink.sessions.end(projectId, session.id, "ended", true, "stopped");
  expect(await codeLink.sweepWorktrees()).toBe(1);
  expect(fs.existsSync(next.worktree)).toBe(false);
});

it("lists a folder git no longer knows as a stray: counted, never taken by itself, removed only on a person's word for it", async () => {
  const { ctx, codeLink, projectId, repo, checkout, keep, worked, finish, view } = await machine();
  keep({ keepDays: 0 });
  // A finished ticket's worktree whose record in the checkout is gone, as after the repository's folder was moved or deleted.
  const lost = await worked("Its repository moved away");
  finish(lost.item.id);
  fs.rmSync(path.join(checkout, ".git", "worktrees", lost.threadId), { recursive: true, force: true });
  // A folder with nothing of git's in it, named for a conversation no project has.
  const bare = path.join(path.dirname(lost.worktree), "left-over");
  fs.mkdirSync(bare);
  fs.writeFileSync(path.join(bare, "notes.txt"), "kept by nobody\n");
  // A working worktree of some other checkout, in the same folder: git still knows it, so it is not called a stray.
  const foreign = path.join(path.dirname(lost.worktree), "foreign");
  git(["worktree", "add", "-q", "-b", "elsewhere", foreign], codeRepo().checkout);

  expect(await view(lost.worktree)).toMatchObject({ stray: true, hold: null, removeAt: null, branch: null, owner: "ticket", tickets: [{ key: lost.item.key, status: "done" }] });
  expect(await view(bare)).toMatchObject({ repoId: repo.id, stray: true, hold: null, removeAt: null, branch: null, owner: "none", tickets: [] });
  expect(await view(foreign)).toBeUndefined();
  expect(await codeLink.worktreeSize(projectId, bare)).toBeGreaterThan(0);
  expect((await codeLink.worktreeOverview()).groups[0]!.trees.map((tree) => tree.dir).sort()).toEqual([lost.worktree, bare].sort());

  // Cleanup leaves them, and so does a removal that was not told they are strays: "remove all" is one.
  expect(await codeLink.sweepWorktrees()).toBe(0);
  expect(await codeLink.removeWorktrees(projectId, [lost.worktree, bare])).toMatchObject([{ dir: lost.worktree, removed: false }, { dir: bare, removed: false }]);
  expect([lost.worktree, bare].map((dir) => fs.existsSync(dir))).toEqual([true, true]);

  // A session in one holds it, as it holds any worktree.
  const visitor = codeLink.store.createSession(projectId, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: bare });
  expect(await view(bare)).toMatchObject({ stray: true, hold: "busy" });
  expect(await codeLink.removeWorktrees(projectId, [bare], true)).toEqual([{ dir: bare, removed: false, reason: "busy", branch: null, remoteBranch: null }]);
  codeLink.sessions.end(projectId, visitor.id, "ended", true, "left");

  expect(await codeLink.removeWorktrees(projectId, [lost.worktree, bare], true)).toEqual([
    { dir: lost.worktree, removed: true, reason: null, branch: null, remoteBranch: null },
    { dir: bare, removed: true, reason: null, branch: null, remoteBranch: null }
  ]);
  expect([lost.worktree, bare, foreign].map((dir) => fs.existsSync(dir))).toEqual([false, false, true]);
  // The ticket's commits were in the checkout all along.
  expect(git(["log", "--format=%s", "-1", lost.branch], checkout)).toBe(`${lost.item.key}: work`);

  // Only a folder git cannot work in, right inside a repository's folder of the Hub's worktrees, is ever deleted this way.
  expect(ctx.repos.removeStrayWorktree(foreign)).toMatch(/still a git worktree/);
  expect(ctx.repos.removeStrayWorktree(path.dirname(foreign))).toMatch(/not a worktree Tomrade made/);
  expect(ctx.repos.removeStrayWorktree(path.join(foreign, "node_modules"))).toMatch(/not a worktree Tomrade made/);
  expect(ctx.repos.removeStrayWorktree(checkout)).toMatch(/not a worktree Tomrade made/);
  expect([foreign, checkout].map((dir) => fs.existsSync(dir))).toEqual([true, true]);
});

it("lists a worktree made outside the Hub with the ticket it was worked for, and removes it only on a person's word", async () => {
  const { ctx, codeLink, projectId, repo, checkout, keep, finish, view, items, board } = await machine();
  keep({ keepDays: 0 });
  // Named as git names them: with links in the path resolved, which is how one made outside the Hub is listed.
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(root, "elsewhere-")));
  const ticket = (title: string) => items.create({ projectId, boardId: board.id, title, workType: "coding", status: "doing", by: "human" });
  const outside = (name: string, branch: string) => {
    const dir = path.join(elsewhere, name);
    git(["worktree", "add", "-q", "-b", branch, dir], checkout);
    return dir;
  };

  // Named by its branch, as an agent in a terminal names the one it makes for a ticket.
  const byBranch = ticket("Worked from a terminal");
  const one = outside("one", `${byBranch.key.toLowerCase()}/from-a-terminal`);
  // Named by the session that said it works there, whatever the branch is called.
  const bySession = ticket("Worked in a folder a session named");
  const two = outside("two", "spike");
  codeLink.store.createSession(projectId, { repoId: repo.id, branch: "spike", itemIds: [bySession.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: two });
  // The person's own, on no ticket.
  const own = outside("own", "scratch");

  expect(await view(one)).toMatchObject({ repoId: repo.id, outside: true, stray: false, threadId: "", branch: `${byBranch.key.toLowerCase()}/from-a-terminal`, owner: "ticket", hold: "open", removeAt: null, tickets: [{ key: byBranch.key, status: "doing" }] });
  expect(await view(two)).toMatchObject({ outside: true, owner: "ticket", hold: "open", tickets: [{ key: bySession.key }] });
  expect(await view(own)).toMatchObject({ outside: true, owner: "none", hold: "unticketed", removeAt: null, tickets: [] });
  // The person's checkout is never one of them.
  expect(await view(checkout)).toBeUndefined();
  expect((await codeLink.worktreesOf(projectId)).map((tree) => tree.dir).sort()).toEqual([one, two, own].sort());
  expect(await codeLink.worktreeSize(projectId, one)).toBeGreaterThan(0);
  expect((await codeLink.worktreeOverview()).groups[0]!.trees).toHaveLength(3);

  finish(byBranch.id);
  finish(bySession.id);
  // A finished ticket's own session is put away with it, and the folder is still that ticket's. Someone else in it holds it.
  const visitor = codeLink.store.createSession(projectId, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: two });
  expect(await view(two)).toMatchObject({ hold: "busy", tickets: [{ key: bySession.key, status: "done" }] });
  expect(await view(one)).toMatchObject({ hold: null, removeAt: null, tickets: [{ status: "done" }] });
  // Cleanup never takes one made elsewhere, whatever the keeping time.
  expect(await codeLink.sweepWorktrees()).toBe(0);
  expect(fs.existsSync(one)).toBe(true);

  // Uncommitted work holds it as it holds any, and so does git itself.
  fs.writeFileSync(path.join(one, "scratch.txt"), "half done\n");
  expect(await view(one)).toMatchObject({ hold: "dirty" });
  expect(await codeLink.removeWorktrees(projectId, [one, two, own, checkout])).toEqual([
    { dir: one, removed: false, reason: "dirty", branch: null, remoteBranch: null },
    { dir: two, removed: false, reason: "busy", branch: null, remoteBranch: null },
    { dir: own, removed: false, reason: "unticketed", branch: null, remoteBranch: null },
    { dir: checkout, removed: false, reason: "not a worktree Tomrade made for this project", branch: null, remoteBranch: null }
  ]);
  expect([one, two, own, checkout].map((dir) => fs.existsSync(dir))).toEqual([true, true, true, true]);

  fs.rmSync(path.join(one, "scratch.txt"));
  codeLink.sessions.end(projectId, visitor.id, "ended", true, "left");
  expect(await codeLink.removeWorktrees(projectId, [one, two])).toEqual([
    { dir: one, removed: true, reason: null, branch: "deleted", remoteBranch: null },
    { dir: two, removed: true, reason: null, branch: "deleted", remoteBranch: null }
  ]);
  expect([one, two, own].map((dir) => fs.existsSync(dir))).toEqual([false, false, true]);
  // Nothing was committed on their branches that main does not have: they went with the folders.
  expect(git(["branch", "--list", "spike", `${byBranch.key.toLowerCase()}/from-a-terminal`], checkout)).toBe("");

  // Asked for by itself, the removal still takes only a worktree the checkout lists.
  expect(await ctx.repos.removeWorktree(checkout, checkout, true)).toMatch(/is not a worktree of/);
  expect(await ctx.repos.removeWorktree(checkout, elsewhere, true)).toMatch(/is not a worktree of/);
  expect([checkout, elsewhere].map((dir) => fs.existsSync(dir))).toEqual([true, true]);
});

it("deletes a removed worktree's branch, here and on the remote, only when nothing on it would be lost", async () => {
  const { ctx, codeLink, projectId, repo, checkout, keep, worked, finish } = await machine();
  keep({ keepDays: 0 });
  const here = () => git(["branch", "--format=%(refname:short)"], checkout).split("\n").sort();
  const there = () => git(["ls-remote", "--heads", "origin"], checkout).split("\n").map((line) => line.replace(/^.*refs\/heads\//, "")).sort();
  const push = (branch: string) => git(["push", "-q", "origin", branch], checkout);
  const merge = (branch: string) => git(["merge", "-q", "--no-ff", "-m", "merge", branch], checkout);

  const merged = await worked("Pushed, and merged into main");
  push(merged.branch);
  merge(merged.branch);
  // As a squash merge lands: one new commit on main with the branch's whole change, and no line back to the branch.
  const squashed = await worked("Pushed, and squash-merged into main");
  push(squashed.branch);
  git(["merge", "-q", "--squash", squashed.branch], checkout);
  git(["commit", "-q", "-m", "squashed"], checkout);
  const pushed = await worked("Pushed, never merged");
  push(pushed.branch);
  const local = await worked("Committed here and nowhere else");
  const unpushed = await worked("Merged here, its branch never pushed");
  merge(unpushed.branch);
  push("main");
  for (const each of [merged, squashed, pushed, local, unpushed]) finish(each.item.id);
  expect(here()).toEqual(["main", merged.branch, squashed.branch, pushed.branch, local.branch, unpushed.branch].sort());
  expect(there()).toEqual(["main", merged.branch, squashed.branch, pushed.branch].sort());

  expect(await codeLink.removeWorktrees(projectId, [merged, squashed, pushed, local, unpushed].map((each) => each.worktree))).toEqual([
    // Main has all of it, here and on the remote: both go.
    { dir: merged.worktree, removed: true, reason: null, branch: "deleted", remoteBranch: "deleted" },
    { dir: squashed.worktree, removed: true, reason: null, branch: "deleted", remoteBranch: "deleted" },
    // Only the remote's branch has it: the local one goes, and that one stays to keep it.
    { dir: pushed.worktree, removed: true, reason: null, branch: "deleted", remoteBranch: "kept" },
    // Its commit is on its branch alone.
    { dir: local.worktree, removed: true, reason: null, branch: "kept", remoteBranch: null },
    { dir: unpushed.worktree, removed: true, reason: null, branch: "deleted", remoteBranch: null }
  ]);
  expect(here()).toEqual(["main", local.branch].sort());
  expect(there()).toEqual(["main", pushed.branch].sort());
  expect(git(["log", "--format=%s", "-1", local.branch], checkout)).toBe(`${local.item.key}: work`);

  // Each has its own setting, and the cleanup follows them as a person's removal does.
  const again = async (title: string) => {
    const each = await worked(title);
    push(each.branch);
    merge(each.branch);
    push("main");
    finish(each.item.id);
    return each;
  };
  keep({ keepDays: 0, dropRemoteBranch: false });
  const localOnly = await again("Local branch only");
  expect(await codeLink.sweepWorktrees()).toBe(1);
  expect([here().includes(localOnly.branch), there().includes(localOnly.branch)]).toEqual([false, true]);

  keep({ keepDays: 0, dropBranch: false });
  const remoteOnly = await again("Remote branch only");
  expect(await codeLink.sweepWorktrees()).toBe(1);
  expect([here().includes(remoteOnly.branch), there().includes(remoteOnly.branch)]).toEqual([true, false]);

  keep({ keepDays: 0, dropBranch: false, dropRemoteBranch: false });
  const neither = await again("Neither");
  expect(await codeLink.removeWorktrees(projectId, [neither.worktree])).toEqual([{ dir: neither.worktree, removed: true, reason: null, branch: "kept", remoteBranch: null }]);
  expect([here().includes(neither.branch), there().includes(neither.branch)]).toEqual([true, true]);

  // Where Tomrade may not push for the repository, nothing on the remote is touched.
  keep({ keepDays: 0 });
  codeLink.setRepoPolicy(projectId, repo.id, { agentPush: false });
  const noPush = await again("Pushing from Tomrade is off");
  expect(await codeLink.removeWorktrees(projectId, [noPush.worktree])).toEqual([{ dir: noPush.worktree, removed: true, reason: null, branch: "deleted", remoteBranch: "kept" }]);
  expect(there()).toContain(noPush.branch);
  expect(ctx.repos.checkout(repo.remote).checkout).toBe(checkout);
});
