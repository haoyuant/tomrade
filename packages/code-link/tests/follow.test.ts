/**
 * The checkout's default branch following the remote's after a fetch: over real repositories, then through a scan
 * with the per-checkout switch.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Context } from "cordis";
import { CodeLink } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import { gitRunner } from "@tomradex/git";
import GitHubAccount from "@tomradex/github";
import { Repos } from "@tomradex/repos";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { disposeFresh, fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { followDefault } from "../src/scan/follow.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-follow-"));
afterAll(async () => {
  await disposeFresh();
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const run = gitRunner("git");
const nobody = () => false;

let n = 0;
/** A remote with one commit, the person's checkout of it, and a second clone that stands for everyone else. */
function repos() {
  const remote = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(remote);
  git(["init", "-q", "--bare", "-b", "main", "."], remote);
  const clone = (name: string) => {
    const dir = path.join(root, `${name}-${n++}`);
    git(["clone", "-q", remote, dir], root);
    git(["config", "user.email", "dev@localhost"], dir);
    git(["config", "user.name", "Dev"], dir);
    return dir;
  };
  const other = clone("other");
  fs.writeFileSync(path.join(other, "app.ts"), "export const v = 1;\n");
  git(["add", "-A"], other);
  git(["commit", "-q", "-m", "initial"], other);
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], other);
  const checkout = clone("checkout");
  /** Someone else's commit lands on the remote, and the checkout fetches it. */
  const land = (text: string) => {
    fs.writeFileSync(path.join(other, "app.ts"), text);
    git(["commit", "-q", "-am", "more"], other);
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], other);
    return git(["rev-parse", "HEAD"], other);
  };
  const fetched = (text: string) => {
    const sha = land(text);
    git(["fetch", "-q", "origin"], checkout);
    return sha;
  };
  const head = (ref = "main") => git(["rev-parse", ref], checkout);
  const file = () => fs.readFileSync(path.join(checkout, "app.ts"), "utf8");
  return { remote, checkout, land, fetched, head, file };
}

it("fast-forwards the checked-out default branch, files and all, when it is only behind", async () => {
  const { checkout, fetched, head, file } = repos();
  expect(await followDefault(run, checkout, "main", nobody)).toBe("current");
  const sha = fetched("export const v = 2;\n");
  // A file git does not track is no reason to wait.
  fs.writeFileSync(path.join(checkout, "notes.txt"), "mine\n");
  expect(await followDefault(run, checkout, "main", nobody)).toBe("moved");
  expect(head()).toBe(sha);
  expect(file()).toBe("export const v = 2;\n");
  expect(fs.readFileSync(path.join(checkout, "notes.txt"), "utf8")).toBe("mine\n");
  expect(await followDefault(run, checkout, "main", nobody)).toBe("current");
});

it("leaves it alone with commits of its own, uncommitted changes, or an agent at work in the folder", async () => {
  const ahead = repos();
  fs.writeFileSync(path.join(ahead.checkout, "local.ts"), "export {};\n");
  git(["add", "-A"], ahead.checkout);
  git(["commit", "-q", "-m", "mine"], ahead.checkout);
  const mine = ahead.head();
  // Ahead only: nothing to follow. Then the remote moves too, and bringing them together is the person's to do.
  expect(await followDefault(run, ahead.checkout, "main", nobody)).toBe("current");
  ahead.fetched("export const v = 2;\n");
  expect(await followDefault(run, ahead.checkout, "main", nobody)).toBe("ahead");
  expect(ahead.head()).toBe(mine);

  const dirty = repos();
  const before = dirty.head();
  dirty.fetched("export const v = 2;\n");
  fs.writeFileSync(path.join(dirty.checkout, "app.ts"), "export const v = 1; // half done\n");
  expect(await followDefault(run, dirty.checkout, "main", nobody)).toBe("dirty");
  expect(dirty.head()).toBe(before);
  expect(dirty.file()).toBe("export const v = 1; // half done\n");

  const busy = repos();
  const was = busy.head();
  busy.fetched("export const v = 2;\n");
  const asked: string[] = [];
  expect(await followDefault(run, busy.checkout, "main", (dir) => { asked.push(dir); return true; })).toBe("busy");
  expect(asked.map((dir) => fs.realpathSync(dir))).toEqual([fs.realpathSync(busy.checkout)]);
  expect(busy.head()).toBe(was);
  expect(busy.file()).toBe("export const v = 1;\n");

  // A file of the person's that the new commits would write over: git refuses, and nothing moves.
  const clash = repos();
  const kept = clash.head();
  const other = path.join(clash.checkout, "new.ts");
  fs.writeFileSync(other, "mine, untracked\n");
  const elsewhere = fs.mkdtempSync(path.join(root, "pusher-"));
  git(["clone", "-q", clash.remote, elsewhere], root);
  fs.writeFileSync(path.join(elsewhere, "new.ts"), "theirs\n");
  git(["add", "-A"], elsewhere);
  git(["-c", "user.email=dev@localhost", "-c", "user.name=Dev", "commit", "-q", "-m", "adds new.ts"], elsewhere);
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], elsewhere);
  git(["fetch", "-q", "origin"], clash.checkout);
  expect(await followDefault(run, clash.checkout, "main", nobody)).toBe("refused");
  expect(clash.head()).toBe(kept);
  expect(fs.readFileSync(other, "utf8")).toBe("mine, untracked\n");
});

it("moves only the branch when it is checked out nowhere, and follows it in the worktree that has it", async () => {
  const { checkout, fetched, head, file } = repos();
  git(["switch", "-q", "-c", "feature"], checkout);
  fs.writeFileSync(path.join(checkout, "app.ts"), "export const v = 1; // on feature, uncommitted\n");
  const sha = fetched("export const v = 2;\n");
  expect(await followDefault(run, checkout, "main", () => { throw new Error("no folder holds it: nobody is asked"); })).toBe("moved");
  expect(head("main")).toBe(sha);
  // The folder is on another branch: its files, and what is uncommitted in them, are as they were.
  expect(git(["rev-parse", "--abbrev-ref", "HEAD"], checkout)).toBe("feature");
  expect(file()).toBe("export const v = 1; // on feature, uncommitted\n");

  // Checked out in a worktree of its own: that folder follows.
  const side = path.join(root, `side-${n++}`);
  git(["worktree", "add", "-q", side, "main"], checkout);
  const next = fetched("export const v = 3;\n");
  expect(await followDefault(run, checkout, "main", nobody)).toBe("moved");
  expect(head("main")).toBe(next);
  expect(fs.readFileSync(path.join(side, "app.ts"), "utf8")).toBe("export const v = 3;\n");
});

it("follows after a scan's fetch, unless the checkout's switch is off or an agent is running there", async () => {
  const { remote, checkout, land, head, file } = repos();
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
      [CodeLink, { scanMs: 0, worktreeSweepMs: 0, gitBinary: "git", defaultsPath: path.join(hubDir, "code-link.json") }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  const ctx = bag.ctx as Context;
  const projectId = bag.project.id;
  const repo = ctx.repos.create({ projectId, remote });
  await ctx.repos.setCheckout(remote, checkout);
  ctx.codeLink.pulls = async () => null;
  // On unless the person turned it off.
  expect(ctx.repos.checkout(remote).pullDefault).toBe(true);

  const first = land("export const v = 2;\n");
  await ctx.codeLink.scan(projectId);
  expect(head()).toBe(first);
  expect(file()).toBe("export const v = 2;\n");

  // An agent running in the folder: it waits for the scan after that run.
  const session = ctx.codeLink.store.createSession(projectId, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: checkout });
  ctx.codeLink.store.patchSession(projectId, session.id, { state: "running" });
  const second = land("export const v = 3;\n");
  await ctx.codeLink.scan(projectId);
  expect(head()).toBe(first);
  expect(head("origin/main")).toBe(second);
  // Open there but not running — waiting for the person — holds nothing.
  ctx.codeLink.store.patchSession(projectId, session.id, { state: "waiting" });
  await ctx.codeLink.scan(projectId);
  expect(head()).toBe(second);

  expect(ctx.repos.setPullDefault(remote, false)).toMatchObject({ checkout, pullDefault: false });
  const third = land("export const v = 4;\n");
  await ctx.codeLink.scan(projectId);
  expect(head("origin/main")).toBe(third);
  expect(head()).toBe(second);
  expect(file()).toBe("export const v = 3;\n");

  ctx.repos.setPullDefault(remote, true);
  await ctx.codeLink.scan(projectId);
  expect(head()).toBe(third);
});
