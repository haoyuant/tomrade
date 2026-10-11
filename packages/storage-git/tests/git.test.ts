/**
 * Against a real bare repository, because the point of a dedicated repository
 * is that git does the moving: Tomrade commits and pushes the project's own
 * folder, brings a teammate's push in, and never forces. Inside someone's own
 * checkout it writes its subtree and touches nothing else.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { ARTIFACT_DIR, Storage, digestState, readArtifact, writeArtifact } from "@tomradex/storage";
import storageGit from "@tomradex/storage-git";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-git-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
function bareRemote(): string {
  const dir = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "--bare", "-b", "main", "."], dir);
  return dir;
}

const QUIET = { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 };

async function machine(label: string, storage: Record<string, unknown> = {}) {
  const hubDir = path.join(root, `${label}-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({ hubDir, plugins: [[Storage, { ...QUIET, ...storage }], storageGit] });
  await settle();
  await bag.ctx.storage.ready;
  return { ...bag, storage: bag.ctx.storage, hubDir, dir: bag.hub.catalog.project(bag.project.id)!.dir! };
}

/** A teammate without Tomrade: clone the remote, edit the text, push. */
function teammateEdits(remote: string, edit: (dir: string) => void): void {
  const work = path.join(root, `mate-${n++}`);
  git(["clone", "-q", "--branch", "main", remote, work], root);
  git(["config", "user.email", "mate@localhost"], work);
  git(["config", "user.name", "Mate"], work);
  edit(work);
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", "teammate"], work);
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], work);
}

describe("a dedicated repository", () => {
  it("registers a provider whose config holds no secrets", async () => {
    const { storage } = await machine("providers");
    const provider = storage.describe().find((p) => p.id === "git");
    expect(provider).toBeDefined();
    expect(Object.keys((provider!.schema as { properties: Record<string, unknown> }).properties)).toEqual(["remote", "branch"]);
  });

  it("binds the project's own folder to a remote, pushes, and a second machine clones it", async () => {
    const a = await machine("a");
    const remote = bareRemote();
    a.items.create({ title: "Pushed", projectId: a.project.id, boardId: a.board.id, by: "human" });
    const status = await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    expect(status.state).toBe("synced");
    expect(status.location).toContain("remote-");
    expect(a.hub.catalog.project(a.project.id)?.git).toBe("dedicated");
    expect(git(["rev-parse", "--show-toplevel"], a.dir)).toBe(fs.realpathSync(a.dir));
    expect(git(["ls-tree", "--name-only", "main", ".tomrade/"], remote)).toContain(".tomrade/project.json");
    expect(JSON.parse(git(["show", "main:.tomrade/project.json"], remote)).repo).toBe("dedicated");

    const b = await machine("b");
    const id = await b.storage.attachRemote("git", { remote, branch: "main" });
    expect(id).toBe(a.project.id);
    expect(b.items.list({ projectId: id }).map((i) => i.title)).toEqual(["Pushed"]);
    const entry = b.hub.catalog.project(id)!;
    expect(entry.git).toBe("dedicated");
    expect(entry.remote).toEqual({ provider: "git", config: { remote, branch: "main" } });
    expect(entry.dir.startsWith(path.join(b.hubDir, "projects"))).toBe(true);
  });

  it("brings a teammate's push in on sync, and publishes nothing when nothing changed", async () => {
    const a = await machine("ff");
    const remote = bareRemote();
    const item = a.items.create({ title: "Mine", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    const head = git(["rev-parse", "main"], remote);

    teammateEdits(remote, (work) => {
      const state = readArtifact(work)!;
      state.tables.items.find((r) => r.id === item.id)!.title = "Theirs";
      state.manifest.snapshot!.digest = digestState(state);
      writeArtifact(work, state);
    });
    expect((await a.storage.statusFor(a.project.id)).state).toBe("behind");
    await a.storage.sync(a.project.id);
    expect(a.items.get(a.project.id, item.id)?.title).toBe("Theirs");
    expect((await a.storage.statusFor(a.project.id)).state).toBe("synced");
    // Nothing of ours changed, so the sync pushed no commit of its own.
    expect(git(["rev-parse", "main"], remote)).not.toBe(head);
    const after = git(["rev-parse", "main"], remote);
    await a.storage.publish(a.project.id);
    expect(git(["rev-parse", "main"], remote)).toBe(after);
  });

  it("merges a teammate's commits with ours into one merge commit, never forcing", async () => {
    const a = await machine("diverge");
    const remote = bareRemote();
    const item = a.items.create({ title: "Mine", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    teammateEdits(remote, (work) => {
      const state = readArtifact(work)!;
      state.tables.items.find((r) => r.id === item.id)!.title = "Theirs";
      state.manifest.snapshot!.digest = digestState(state);
      writeArtifact(work, state);
    });
    const theirs = git(["rev-parse", "main"], remote);
    a.items.update(a.project.id, item.id, { status: "done" }, "human");
    const status = await a.storage.publish(a.project.id);
    expect(status.state).toBe("synced");
    const head = git(["rev-parse", "main"], remote);
    expect(head).not.toBe(theirs);
    // The remote's tip is a merge commit that has the teammate's commit as a parent.
    expect(git(["rev-list", "--parents", "-n", "1", "main"], remote).split(" ")).toContain(theirs);
    const merged = a.items.get(a.project.id, item.id)!;
    expect(merged.title).toBe("Theirs");
    expect(merged.status).toBe("done");
    expect(JSON.parse(git(["show", "main:.tomrade/state/items.jsonl"], remote))).toMatchObject({ title: "Theirs", status: "done" });
  });

  it("never records a repository inside the folder, and drops one an earlier commit recorded", async () => {
    const a = await machine("embedded");
    const remote = bareRemote();
    // The Files store keeps a repository of its own, made before the project had one.
    const files = path.join(a.dir, "files");
    fs.mkdirSync(files, { recursive: true });
    git(["init", "-q", "-b", "main"], files);
    fs.writeFileSync(path.join(files, "note.md"), "hello\n");
    git(["-c", "user.email=t@localhost", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "store"], files);
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    expect(git(["ls-tree", "--name-only", "main"], remote).split("\n")).not.toContain("files");

    // A build without the guard committed the pointer; the next publish takes it out.
    git(["update-index", "--add", "--cacheinfo", `160000,${git(["rev-parse", "HEAD"], files)},files`], a.dir);
    git(["-c", "user.email=t@localhost", "-c", "user.name=T", "commit", "-q", "-m", "old build"], a.dir);
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], a.dir);
    expect(git(["ls-tree", "main", "files"], remote)).toMatch(/^160000 commit/);
    a.items.create({ title: "Next", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.publish(a.project.id);
    expect(git(["ls-tree", "main", "files"], remote)).toBe("");
    expect(fs.existsSync(path.join(files, "note.md"))).toBe(true);
  });

  it("keeps a submodule .gitmodules declares", async () => {
    const a = await machine("submodule");
    const remote = bareRemote();
    const lib = path.join(a.dir, "lib");
    fs.mkdirSync(lib, { recursive: true });
    git(["init", "-q", "-b", "main"], lib);
    git(["-c", "user.email=t@localhost", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "lib"], lib);
    fs.writeFileSync(path.join(a.dir, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = ./lib\n');
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    expect(git(["ls-tree", "main", "lib"], remote)).toMatch(/^160000 commit/);
  });

  it("reports offline for a remote that is not there, rather than throwing", async () => {
    const a = await machine("offline");
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    fs.rmSync(remote, { recursive: true, force: true });
    const status = await a.storage.statusFor(a.project.id);
    expect(status.state).toBe("offline");
  });

  it("inside someone's checkout it writes only .tomrade and never pushes", async () => {
    const a = await machine("shared");
    const remote = bareRemote();
    const checkout = path.join(root, `code-${n++}`);
    fs.mkdirSync(checkout, { recursive: true });
    git(["init", "-q", "-b", "main"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    git(["config", "user.email", "dev@localhost"], checkout);
    git(["config", "user.name", "Dev"], checkout);
    fs.writeFileSync(path.join(checkout, "README.md"), "# code\n");
    fs.writeFileSync(path.join(checkout, "wip.ts"), "// half done\n");
    git(["add", "README.md"], checkout);
    git(["commit", "-q", "-m", "code"], checkout);
    git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);
    const pushed = git(["rev-parse", "main"], remote);

    const info = await a.storage.setFolder(a.project.id, checkout);
    expect(info.git).toBe("shared");
    expect(info.origin?.url).toBe(remote);
    expect(info.origin?.branch).toBe("main");
    expect(fs.existsSync(path.join(checkout, ARTIFACT_DIR, "project.json"))).toBe(true);
    // Untracked user work and the remote are untouched; nothing was committed.
    expect(git(["status", "--porcelain", "--", "wip.ts"], checkout)).toMatch(/^\?\? wip\.ts/);
    expect(git(["rev-parse", "HEAD"], checkout)).toBe(pushed);
    expect(git(["rev-parse", "main"], remote)).toBe(pushed);

    await a.storage.setAutoCommit(a.project.id, true);
    a.items.create({ title: "Committed subtree", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.publish(a.project.id);
    expect(git(["rev-parse", "HEAD"], checkout)).not.toBe(pushed);
    expect(git(["show", "--name-only", "--format=", "HEAD"], checkout).split("\n").every((f) => f.startsWith(".tomrade/"))).toBe(true);
    expect(git(["status", "--porcelain", "--", "wip.ts"], checkout)).toMatch(/^\?\? wip\.ts/);
    expect(git(["rev-parse", "main"], remote)).toBe(pushed);
    await expect(a.storage.bind(a.project.id, "git", { remote, branch: "main" })).rejects.toThrow(/never pushes/);
  });

  it("exports the same bytes whichever machine wrote them", async () => {
    const a = await machine("bytes-a");
    const remote = bareRemote();
    a.items.create({ title: "Same", projectId: a.project.id, boardId: a.board.id, labels: ["x"], by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    const b = await machine("bytes-b");
    const id = await b.storage.attachRemote("git", { remote, branch: "main" });
    const one = readArtifact(a.dir)!;
    const two = readArtifact(b.hub.catalog.project(id)!.dir!)!;
    expect(digestState(two)).toBe(digestState(one));
  });
});

describe("the Hub as a repository", () => {
  it("publishes the portable catalog, and a second machine attaches every project it names", async () => {
    const a = await machine("hub-a");
    const projectRemote = bareRemote();
    const hubRemote = bareRemote();
    a.items.create({ title: "Shared work", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote: projectRemote, branch: "main" });
    const status = await a.storage.bindHub("git", { remote: hubRemote, branch: "main" });
    expect(status.state).toBe("synced");
    const manifest = JSON.parse(git(["show", "main:hub.json"], hubRemote));
    expect(manifest.projects).toEqual([expect.objectContaining({ id: a.project.id, remote: { provider: "git", config: { remote: projectRemote, branch: "main" } } })]);
    // The project's own repository is not the Hub repository's to track.
    expect(git(["show", "main:.gitignore"], hubRemote)).toContain("projects/default-project/");
    expect(git(["ls-tree", "-r", "--name-only", "main"], hubRemote)).not.toContain("projects/default-project/.tomrade");

    // Restores by hand here; restore.test.ts covers the automatic path.
    const b = await machine("hub-b", { autoRestore: false });
    b.projects.remove(b.project.id);
    await b.storage.bindHub("git", { remote: hubRemote, branch: "main" });
    const info = await b.storage.hubInfo();
    expect(info.attachable).toEqual([a.project.id]);
    expect(await b.storage.attachAll()).toEqual([a.project.id]);
    expect(b.items.list({ projectId: a.project.id }).map((i) => i.title)).toEqual(["Shared work"]);
    expect((await b.storage.hubInfo()).attachable).toEqual([]);
  });
});

describe("a repository GitHub initialised", () => {
  it("joins the histories: the README stays, the project lands, nothing is forced", async () => {
    const a = await machine("readme");
    const remote = bareRemote();
    // "Initialize this repository with a README": one commit nobody made through Tomrade.
    const seed = path.join(root, `seed-${n++}`);
    git(["clone", "-q", remote, seed], root);
    git(["config", "user.email", "gh@localhost"], seed);
    git(["config", "user.name", "GitHub"], seed);
    fs.writeFileSync(path.join(seed, "README.md"), "# tomrade-test-project\n");
    git(["add", "README.md"], seed);
    git(["commit", "-q", "-m", "Initial commit"], seed);
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], seed);

    a.items.create({ title: "Bound over a README", projectId: a.project.id, boardId: a.board.id, by: "human" });
    const status = await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    expect(status.state).toBe("synced");
    const tree = git(["ls-tree", "-r", "--name-only", "main"], remote).split("\n");
    expect(tree).toContain("README.md");
    expect(tree).toContain(".tomrade/project.json");
    expect(git(["rev-list", "--count", "main"], remote)).toBe("3");
    expect((await a.storage.statusFor(a.project.id)).state).toBe("synced");
  });
});
