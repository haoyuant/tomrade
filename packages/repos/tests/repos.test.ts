/**
 * A repository's identity is shared through the project; its checkout is this
 * machine's alone and must be a checkout of that very repository. Agents run in
 * a worktree of it, never in the user's working copy unless asked.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InUseError } from "@tomradex/domain";
import { Repos, CheckoutUnsetError, normalizeRemote } from "@tomradex/repos";
import { Storage } from "@tomradex/storage";
import { fresh, settle } from "@tomradex/testkit";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-repos-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
/** A bare remote with one commit on main, and a user's checkout of it. */
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
  fs.mkdirSync(path.join(checkout, "packages", "ui"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "packages", "ui", "index.ts"), "export {};\n");
  git(["add", "-A"], checkout);
  git(["commit", "-q", "-m", "code"], checkout);
  git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);
  return { remote, checkout };
}

async function machine() {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({ hubDir, plugins: [[Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }], Repos] });
  await settle();
  await bag.ctx.storage.ready;
  return { ...bag, repos: bag.ctx.repos, hubDir };
}

describe("repositories", () => {
  it("normalises a remote so two spellings are one repository", () => {
    expect(normalizeRemote("https://x-access-token:secret@github.com/acme/app.git/")).toBe("https://github.com/acme/app");
    expect(normalizeRemote("git@github.com:acme/app.git")).toBe("git@github.com:acme/app");
  });

  it("is a project row: created once per remote, named after it, refused while a workstream stands for it", async () => {
    const { repos, boards, project, board } = await machine();
    const repo = repos.create({ projectId: project.id, remote: "git@github.com:acme/app.git" });
    expect(repo.name).toBe("app");
    expect(repo.defaultBranch).toBe("main");
    expect(repos.create({ projectId: project.id, remote: "git@github.com:acme/app" }).id).toBe(repo.id);
    expect(repos.list(project.id)).toHaveLength(1);
    const linked = boards.update(project.id, board.id, { repoId: repo.id, repoPath: "packages/ui" });
    expect(linked.repoId).toBe(repo.id);
    expect(linked.repoPath).toBe("packages/ui");
    expect(() => repos.remove(project.id, repo.id)).toThrow(InUseError);
    boards.update(project.id, board.id, { repoId: null, repoPath: "" });
    repos.remove(project.id, repo.id);
    expect(repos.list(project.id)).toEqual([]);
  });

  it("travels with the project's folder", async () => {
    const { ctx, repos, project, boards, board } = await machine();
    const repo = repos.create({ projectId: project.id, remote: "git@github.com:acme/app.git" });
    boards.update(project.id, board.id, { repoId: repo.id });
    await ctx.storage.publish(project.id);
    const dir = ctx.hub.catalog.project(project.id)!.dir!;
    expect(fs.readFileSync(path.join(dir, ".tomrade", "state", "repos.jsonl"), "utf8")).toMatch(/acme\/app/);
    expect(fs.readFileSync(path.join(dir, ".tomrade", "state", "boards.jsonl"), "utf8")).toMatch(new RegExp(`"repo_id":"${repo.id}"`));
  });

  it("accepts only a checkout of the same repository, and remembers it per machine", async () => {
    const { repos, hub } = await machine();
    const a = codeRepo();
    const b = codeRepo();
    const view = await repos.setCheckout(a.remote, a.checkout);
    expect(view.checkout).toBe(a.checkout);
    await expect(repos.setCheckout(a.remote, b.checkout)).rejects.toThrow(/is a checkout of/);
    await expect(repos.setCheckout(a.remote, path.join(root, "nowhere"))).rejects.toThrow(/does not exist/);
    expect(hub.catalog.repo(normalizeRemote(a.remote))?.checkout).toBe(a.checkout);
    repos.clearCheckout(a.remote);
    expect(repos.checkout(a.remote).checkout).toBeNull();
  });

  it("requires an explicit parent-folder selection and clones into a repository-named child", async () => {
    const { repos } = await machine();
    const code = codeRepo();
    const parent = path.join(root, `chosen-${n++}`);
    fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, "keep.txt"), "keep");
    const target = path.join(parent, path.basename(code.remote, ".git"));

    expect(await repos.selectCheckout(code.remote, parent)).toEqual({ state: "clone", remote: normalizeRemote(code.remote), parent, dir: target });
    expect(repos.checkout(code.remote).checkout).toBeNull();

    const view = await repos.cloneInto(code.remote, "main", parent);
    expect(view.checkout).toBe(target);
    expect(fs.existsSync(path.join(target, "packages", "ui", "index.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(parent, "keep.txt"), "utf8")).toBe("keep");

    const conflictParent = path.join(root, `conflict-${n++}`);
    const conflictTarget = path.join(conflictParent, path.basename(code.remote, ".git"));
    fs.mkdirSync(conflictTarget, { recursive: true });
    fs.writeFileSync(path.join(conflictTarget, "keep.txt"), "keep");
    await expect(repos.selectCheckout(code.remote, conflictParent)).rejects.toThrow(/already exists and is not empty/);
    await expect(repos.cloneInto(code.remote, "main", conflictParent)).rejects.toThrow(/already exists and is not empty/);
    expect(fs.readFileSync(path.join(conflictTarget, "keep.txt"), "utf8")).toBe("keep");
  });

  it("runs a thread in a worktree of the checkout, or in the checkout itself when asked; refuses without one", async () => {
    const { repos, boards, project, board, hubDir } = await machine();
    const code = codeRepo();
    const repo = repos.create({ projectId: project.id, remote: code.remote });
    boards.update(project.id, board.id, { repoId: repo.id, repoPath: "packages/ui" });
    await expect(repos.workdirFor(project.id, board.id, "t1")).rejects.toThrow(CheckoutUnsetError);

    await repos.setCheckout(code.remote, code.checkout);
    const view = (await repos.workdirFor(project.id, board.id, "t1"))!;
    expect(view.worktree).toBe(path.join(hubDir, "worktrees", "remote-" + path.basename(code.remote, ".git").split("-")[1], "t1").replace(/remote-\d+/, path.basename(view.worktree!.split(path.sep).slice(-2)[0])));
    expect(view.cwd).toBe(path.join(view.worktree!, "packages", "ui"));
    expect(fs.existsSync(path.join(view.cwd, "index.ts"))).toBe(true);
    expect(git(["rev-parse", "HEAD"], view.worktree!)).toBe(git(["rev-parse", "main"], code.checkout));
    // The user's checkout is untouched apart from the worktree registration.
    expect(git(["status", "--porcelain"], code.checkout)).toBe("");
    // Asking again reuses the worktree.
    expect((await repos.workdirFor(project.id, board.id, "t1"))!.worktree).toBe(view.worktree);

    repos.setRunInCheckout(code.remote, true);
    const direct = (await repos.workdirFor(project.id, board.id, "t2"))!;
    expect(direct.worktree).toBeNull();
    expect(direct.cwd).toBe(path.join(code.checkout, "packages", "ui"));

    await repos.removeWorktree(view);
    expect(fs.existsSync(view.worktree!)).toBe(false);
  });

});
