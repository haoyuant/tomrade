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
import { Repos, CheckoutUnsetError, normalizeRemote, sameRepository } from "@tomradex/repos";
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

  it("knows one repository under SSH, HTTPS and an SSH alias", async () => {
    const aliases: Record<string, string> = { "github.com-work": "ssh.github.com" };
    const resolve = async (host: string) => aliases[host] ?? host;
    const https = "https://github.com/acme/app";
    for (const spelling of ["git@github.com:acme/app.git", "ssh://git@github.com:22/acme/app.git", "ssh://git@ssh.github.com:443/Acme/App", "git@github.com-work:acme/app.git"]) {
      expect(await sameRepository(spelling, https, resolve)).toBe(true);
    }
    expect(await sameRepository("git@github.com:acme/other.git", https, resolve)).toBe(false);
    expect(await sameRepository("git@gitlab.com:acme/app.git", https, resolve)).toBe(false);
    expect(await sameRepository("https://gitlab.com/acme/app", https, resolve)).toBe(false);
    expect(await sameRepository("git@unknown-alias:acme/app.git", https, resolve)).toBe(false);
    expect(await sameRepository("/srv/git/app.git", "/srv/git/app", resolve)).toBe(true);
    expect(await sameRepository("/srv/git/app", "/srv/other/app", resolve)).toBe(false);
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

  it("takes a checkout whose origin spells the repository differently, and says whose checkout a wrong one is", async () => {
    const { repos } = await machine();
    const checkout = path.join(root, `named-anything-${n++}`);
    fs.mkdirSync(checkout);
    git(["init", "-q", "-b", "main"], checkout);
    git(["remote", "add", "origin", "git@github.com:Acme/App.git"], checkout);
    const selected = await repos.selectCheckout("https://github.com/acme/app", checkout);
    expect(selected).toEqual({ state: "ready", view: { remote: "https://github.com/acme/app", checkout, runInCheckout: false } });

    const other = await repos.selectCheckout("https://github.com/acme/web", checkout);
    expect(other).toEqual({ state: "clone", remote: "https://github.com/acme/web", parent: checkout, dir: path.join(checkout, "web"), origin: "git@github.com:Acme/App" });
    await expect(repos.setCheckout("https://github.com/acme/web", checkout)).rejects.toThrow(/is a checkout of git@github.com:Acme\/App, not of/);
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

  it("adds the repository in a chosen folder by its origin, reusing a row that spells it differently", async () => {
    const { repos, project, hub } = await machine();
    const known = repos.create({ projectId: project.id, remote: "https://github.com/acme/app" });
    const folder = path.join(root, `cloned-${n++}`);
    fs.mkdirSync(folder);
    git(["init", "-q", "-b", "main"], folder);
    git(["remote", "add", "origin", "git@github.com:Acme/App.git"], folder);
    const added = await repos.addFromFolder(project.id, folder);
    expect(added).toMatchObject({ local: false, existing: true, repo: { id: known.id }, view: { remote: "https://github.com/acme/app", checkout: folder } });
    expect(repos.list(project.id)).toHaveLength(1);

    const code = codeRepo();
    const fresh = await repos.addFromFolder(project.id, code.checkout);
    expect(fresh).toMatchObject({ local: false, existing: false, repo: { remote: normalizeRemote(code.remote), name: path.basename(code.remote, ".git"), defaultBranch: "main" } });
    expect(hub.catalog.repo(normalizeRemote(code.remote))?.checkout).toBe(code.checkout);
  });

  it("adds a folder with no remote as a local repository, and takes the origin it gains later", async () => {
    const { repos, boards, project, board } = await machine();
    const folder = path.join(root, `local-app-${n++}`);
    fs.mkdirSync(folder);
    git(["init", "-q", "-b", "trunk"], folder);
    git(["config", "user.email", "dev@localhost"], folder);
    git(["config", "user.name", "Dev"], folder);
    fs.writeFileSync(path.join(folder, "app.ts"), "export {};\n");
    git(["add", "-A"], folder);
    git(["commit", "-q", "-m", "app"], folder);

    const added = await repos.addFromFolder(project.id, folder);
    expect(added).toMatchObject({ local: true, existing: false, repo: { remote: folder, name: path.basename(folder), defaultBranch: "trunk" }, view: { checkout: folder } });
    expect((await repos.addFromFolder(project.id, folder)).existing).toBe(true);
    expect(repos.list(project.id)).toHaveLength(1);

    // The user's checkout is on a side branch: a thread still starts from the trunk.
    git(["checkout", "-q", "-b", "side"], folder);
    fs.writeFileSync(path.join(folder, "side.ts"), "export {};\n");
    git(["add", "-A"], folder);
    git(["commit", "-q", "-m", "side"], folder);
    boards.update(project.id, board.id, { repoId: added.repo.id });
    const view = (await repos.workdirFor(project.id, board.id, "t1", { branch: "TOM-1/local" }))!;
    expect(git(["rev-parse", "HEAD"], view.worktree!)).toBe(git(["rev-parse", "trunk"], folder));

    const bare = path.join(root, `published-${n++}.git`);
    fs.mkdirSync(bare);
    git(["init", "--bare", "-q", "."], bare);
    expect(await repos.adoptOrigins(project.id)).toEqual([]);
    git(["remote", "add", "origin", bare], folder);
    const [adopted] = await repos.adoptOrigins(project.id);
    expect(adopted).toMatchObject({ id: added.repo.id, remote: normalizeRemote(bare) });
    expect(repos.checkout(bare).checkout).toBe(folder);
    expect(await repos.adoptOrigins(project.id)).toEqual([]);
  });

  it("initialises git in a plain folder and commits what is there, keeping dependency folders out", async () => {
    const { repos, boards, project, board } = await machine();
    const plain = path.join(root, `plain-${n++}`);
    fs.mkdirSync(path.join(plain, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(plain, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(plain, "package.json"), '{ "name": "shop" }\n');
    fs.writeFileSync(path.join(plain, "index.ts"), "export {};\n");

    const added = await repos.addFromFolder(project.id, plain);
    expect(added).toMatchObject({ local: true, existing: false, initialised: true, committed: 2, repo: { remote: plain, name: path.basename(plain), defaultBranch: "main" } });
    expect(git(["rev-list", "--count", "main"], plain)).toBe("1");
    expect(git(["ls-files"], plain).split("\n").sort()).toEqual(["index.ts", "package.json"]);
    expect(git(["status", "--porcelain"], plain)).toBe("");
    expect(fs.existsSync(path.join(plain, ".gitignore"))).toBe(false);

    // The repository stands: a ticket's worktree starts from that first commit.
    boards.update(project.id, board.id, { repoId: added.repo.id });
    const view = (await repos.workdirFor(project.id, board.id, "t-plain", { branch: "TOM-1/first" }))!;
    expect(fs.existsSync(path.join(view.cwd!, "package.json"))).toBe(true);
    expect((await repos.addFromFolder(project.id, plain))).toMatchObject({ existing: true, initialised: false, committed: 0 });

    const empty = path.join(root, `empty-${n++}`);
    fs.mkdirSync(empty);
    expect(await repos.addFromFolder(project.id, empty)).toMatchObject({ local: true, initialised: true, committed: 0 });
    expect(git(["rev-parse", "--is-inside-work-tree"], empty)).toBe("true");
  });

  it("gives a repository with no commit its first one from the working tree, as its .gitignore says", async () => {
    const { repos, project } = await machine();
    const folder = path.join(root, `unborn-${n++}`);
    fs.mkdirSync(folder);
    git(["init", "-q", "-b", "trunk"], folder);
    fs.writeFileSync(path.join(folder, ".gitignore"), "dist/\n");
    fs.mkdirSync(path.join(folder, "dist"));
    fs.writeFileSync(path.join(folder, "dist", "bundle.js"), "");
    fs.mkdirSync(path.join(folder, "node_modules"));
    fs.writeFileSync(path.join(folder, "node_modules", "x.js"), "");
    fs.writeFileSync(path.join(folder, "pyproject.toml"), "[project]\nname = 'shop'\n");

    const added = await repos.addFromFolder(project.id, folder);
    expect(added).toMatchObject({ local: true, initialised: false, committed: 3, repo: { defaultBranch: "trunk" } });
    expect(git(["ls-files"], folder).split("\n").sort()).toEqual([".gitignore", "node_modules/x.js", "pyproject.toml"]);
    expect(git(["log", "-1", "--format=%s", "trunk"], folder)).toBe(`Import ${path.basename(folder)} into Tomrade`);
  });

  it("refuses a folder that is not a repository root, and offers no clone of a local repository it cannot reach", async () => {
    const { repos, project } = await machine();
    const plain = path.join(root, `plain-${n++}`);
    fs.mkdirSync(plain);
    await expect(repos.addFromFolder(project.id, path.join(root, "nowhere"))).rejects.toThrow(/not an existing folder/);
    const code = codeRepo();
    await expect(repos.addFromFolder(project.id, path.join(code.checkout, "packages"))).rejects.toThrow(/is inside the repository at/);
    expect(repos.list(project.id)).toHaveLength(0);

    const elsewhere = "/Users/someone-else/code/app";
    await expect(repos.selectCheckout(elsewhere, plain)).rejects.toThrow(/has no remote to clone from/);
    const copy = path.join(root, `copy-${n++}`);
    fs.mkdirSync(copy);
    git(["init", "-q", "-b", "main"], copy);
    expect(await repos.selectCheckout(elsewhere, copy)).toEqual({ state: "ready", view: { remote: elsewhere, checkout: copy, runInCheckout: false } });
  });
});
