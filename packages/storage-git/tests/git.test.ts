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
import { afterAll, describe, expect, it, vi } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { ARTIFACT_DIR, GitError, GitFolder, Storage, clearStaleIndexLock, digestState, gitRunner, readArtifact, writeArtifact, type Git } from "@tomradex/storage";
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

// The snapshot timers must never fire mid-test: a timed publish fetches, merges and pushes, and a loaded machine can run a test past a minute.
const QUIET = { snapshotIdleMs: 3_600_000, snapshotMaxMs: 3_600_000, watch: false, reconcileMs: 0, remoteFreshMs: 0, remoteRetryMs: 0 };

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

  it("goes on reading, merging and pushing where git checks files out with core.autocrlf=true", async () => {
    const a = await machine("crlf");
    const remote = bareRemote();
    const item = a.items.create({ title: "Mine", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    git(["config", "core.autocrlf", "true"], a.dir);
    const itemsFile = path.join(a.dir, ARTIFACT_DIR, "state", "items.jsonl");
    const theirEdit = (title: string, keepRule: boolean) =>
      teammateEdits(remote, (work) => {
        const state = readArtifact(work)!;
        state.tables.items.find((r) => r.id === item.id)!.title = title;
        state.manifest.snapshot!.digest = digestState(state);
        writeArtifact(work, state);
        const attributes = path.join(work, ARTIFACT_DIR, ".gitattributes");
        if (!keepRule) fs.writeFileSync(attributes, fs.readFileSync(attributes, "utf8").split("\n").filter((l) => !l.includes("eol=lf")).join("\n"));
      });

    // A folder from before the eol rule, pulled by hand: git leaves its files CRLF here.
    theirEdit("Theirs", false);
    git(["fetch", "-q", "origin"], a.dir);
    git(["merge", "-q", "--ff-only", "origin/main"], a.dir);
    fs.rmSync(path.join(a.dir, ARTIFACT_DIR, "state"), { recursive: true });
    fs.rmSync(path.join(a.dir, ARTIFACT_DIR, "project.json"));
    git(["checkout", "--", ".tomrade"], a.dir);
    expect(fs.readFileSync(itemsFile, "utf8")).toContain("\r\n");
    expect((await a.storage.statusFor(a.project.id)).state).toBe("behind");

    const ours = a.items.create({ title: "Ours", projectId: a.project.id, boardId: a.board.id, by: "human" });
    expect((await a.storage.sync(a.project.id)).state).toBe("synced");
    expect(a.items.get(a.project.id, item.id)?.title).toBe("Theirs");
    expect(a.items.get(a.project.id, ours.id)?.title).toBe("Ours");
    expect(fs.readFileSync(itemsFile, "utf8")).not.toContain("\r");
    expect(git(["show", "main:.tomrade/.gitattributes"], remote)).toContain("*.jsonl text eol=lf");
    expect(git(["show", "main:.tomrade/state/items.jsonl"], remote)).toContain('"title":"Ours"');
    expect(git(["status", "--porcelain"], a.dir)).toBe("");

    // With the rule in the repository, Tomrade's own fast-forward checks the files out LF and takes them in.
    theirEdit("Theirs again", true);
    expect((await a.storage.sync(a.project.id)).state).toBe("synced");
    expect(a.items.get(a.project.id, item.id)?.title).toBe("Theirs again");
    expect(fs.readFileSync(itemsFile, "utf8")).not.toContain("\r");
    expect(readArtifact(a.dir)!.manifest.snapshot!.digest).toBe(git(["show", "main:.tomrade/project.json"], remote).match(/"digest": "(\w+)"/)![1]);
  });

  it("on quit pushes only its own commits, in one try, and never waits on the remote's news", async () => {
    const a = await machine("quit");
    const remote = bareRemote();
    const item = a.items.create({ title: "Mine", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    const tracked = () => git(["rev-parse", "origin/main"], a.dir);

    // Ours goes out.
    a.items.update(a.project.id, item.id, { status: "doing" }, "human");
    await a.storage.flushAll("quit");
    expect(git(["rev-parse", "main"], remote)).toBe(git(["rev-parse", "HEAD"], a.dir));
    expect(git(["log", "-1", "--format=%s", "main"], remote)).toMatch(/^tomrade: quit/);

    // Nothing of ours: the remote is not even asked, so a teammate's push is not fetched.
    teammateEdits(remote, (work) => fs.writeFileSync(path.join(work, "NOTES.md"), "theirs\n"));
    const before = tracked();
    await a.storage.flushAll("quit");
    expect(tracked()).toBe(before);

    // Both moved: the push is turned away, nothing is forced, and the next sync merges.
    const theirs = git(["rev-parse", "main"], remote);
    a.items.update(a.project.id, item.id, { status: "done" }, "human");
    await a.storage.flushAll("quit");
    expect(git(["rev-parse", "main"], remote)).toBe(theirs);
    expect(git(["log", "-1", "--format=%s"], a.dir)).toMatch(/^tomrade: quit/);
    await a.storage.sync(a.project.id);
    expect(git(["rev-list", "--parents", "-n", "1", "main"], remote).split(" ")).toContain(theirs);
    expect(JSON.parse(git(["show", "main:.tomrade/state/items.jsonl"], remote))).toMatchObject({ status: "done" });
  });

  it("publishes that meet take turns: one commit lands, and none fails for want of something to commit", async () => {
    const a = await machine("turns");
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    const before = Number(git(["rev-list", "--count", "main"], remote));
    a.items.create({ title: "Met", projectId: a.project.id, boardId: a.board.id, by: "human" });
    // The periodic catch-up, a write's own publish and a quit, all at once.
    const outcomes = await Promise.allSettled([a.storage.publish(a.project.id, "write"), a.storage.reconcile(a.project.id), a.storage.publish(a.project.id, "catch-up"), a.storage.flushAll("quit")]);
    expect(outcomes.filter((o) => o.status === "rejected")).toEqual([]);
    expect(Number(git(["rev-list", "--count", "main"], remote))).toBe(before + 1);
    expect(JSON.parse(git(["show", "main:.tomrade/state/items.jsonl"], remote))).toMatchObject({ title: "Met" });
    expect(git(["status", "--porcelain"], a.dir)).toBe("");
    expect((await a.storage.statusFor(a.project.id)).state).toBe("synced");
  });

  it("says why git refused a commit, and the next reconcile commits what waited", async () => {
    const a = await machine("refused");
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    const head = git(["rev-parse", "main"], remote);
    // A hook standing in for a signing key that is locked.
    const hooks = path.join(root, `hooks-${n++}`);
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho 'signing key locked' >&2\nexit 1\n", { mode: 0o755 });
    git(["config", "core.hooksPath", hooks], a.dir);

    a.items.create({ title: "Waits for git", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await expect(a.storage.publish(a.project.id)).rejects.toThrow(/signing key locked/);
    const status = await a.storage.statusFor(a.project.id);
    expect(status.state).toBe("error");
    expect(status.detail).toMatch(/^git commit .* failed \(exit 1\): signing key locked$/);
    expect(git(["rev-parse", "main"], remote)).toBe(head);
    // Nothing new to write, yet the reconcile does not take the folder's digest for a commit: it tries again.
    await expect(a.storage.reconcile(a.project.id)).rejects.toThrow(/signing key locked/);
    expect((await a.storage.statusFor(a.project.id)).state).toBe("error");

    git(["config", "--unset", "core.hooksPath"], a.dir);
    await a.storage.reconcile(a.project.id);
    expect(JSON.parse(git(["show", "main:.tomrade/state/items.jsonl"], remote))).toMatchObject({ title: "Waits for git" });
    expect(git(["status", "--porcelain"], a.dir)).toBe("");
    expect((await a.storage.statusFor(a.project.id)).state).toBe("synced");
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

  it("asks the remote once for status reads that overlap or follow closely, and at once on Sync now", async () => {
    const log = path.join(root, `git-calls-${n++}.log`);
    const counting = path.join(root, `git-counting-${n++}`);
    fs.writeFileSync(counting, `#!/bin/sh\necho "$*" >> '${log}'\nexec git "$@"\n`, { mode: 0o755 });
    const a = await machine("asks", { gitBinary: counting, remoteFreshMs: 60_000, remoteRetryMs: 0 });
    const remote = bareRemote();
    a.items.create({ title: "Mine", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    const asks = () => fs.readFileSync(log, "utf8").split("\n").filter((l) => /(^| )(ls-remote|fetch)( |$)/.test(l)).length;
    const before = asks();

    // Our push just now is an answer for reads.
    await a.storage.statusFor(a.project.id);
    expect(asks()).toBe(before);

    // Past the window, five reads at once share one ls-remote and one fetch; the next read takes that answer.
    let now = Date.now() + 61_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const reads = await Promise.all(Array.from({ length: 5 }, () => a.storage.statusFor(a.project.id)));
      expect(reads.map((s) => s.state)).toEqual(Array(5).fill("synced"));
      expect(asks() - before).toBe(2);
      now += 1_000;
      await a.storage.statusFor(a.project.id);
      expect(asks() - before).toBe(2);
    } finally {
      spy.mockRestore();
    }
    const settled = asks();

    // "Sync now" goes to the remote whatever the reads remember, and brings the teammate's push in.
    teammateEdits(remote, (dir) => fs.writeFileSync(path.join(dir, "NOTES.md"), "hi\n"));
    await a.storage.sync(a.project.id);
    expect(asks()).toBeGreaterThan(settled);
    expect(fs.existsSync(path.join(a.dir, "NOTES.md"))).toBe(true);
  });

  it("waits longer each time the remote cannot be reached, and says how long", async () => {
    const a = await machine("backoff", { remoteFreshMs: 0, remoteRetryMs: 10_000 });
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    fs.rmSync(remote, { recursive: true, force: true });
    const said: string[] = [];
    a.ctx.logger.exporter({ export: (m) => { if (String(m.args[0]).includes("cannot reach the remote")) said.push(String(m.args[0])); } });
    let now = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect((await a.storage.statusFor(a.project.id)).state).toBe("offline");
      now += 5_000;
      expect((await a.storage.statusFor(a.project.id)).state).toBe("offline");
      now += 6_000;
      expect((await a.storage.statusFor(a.project.id)).state).toBe("offline");
      now += 15_000;
      expect((await a.storage.statusFor(a.project.id)).state).toBe("offline");
      now += 6_000;
      expect((await a.storage.statusFor(a.project.id)).state).toBe("offline");
    } finally {
      spy.mockRestore();
    }
    // Asked at 0 s, 11 s and 32 s; the reads in between took the last answer.
    expect(said.map((m) => m.match(/in (\d+) s/)?.[1])).toEqual(["10", "20", "40"]);
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

describe("git itself", () => {
  function repo(): string {
    const dir = path.join(root, `repo-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@localhost"], dir);
    git(["config", "user.name", "T"], dir);
    return dir;
  }

  it("says why git failed even when it said so on stdout, and how it ended", async () => {
    expect(new GitError(["commit", "-q", "-m", "x"], "", { stdout: "nothing to commit, working tree clean\n", code: 1 }).message).toBe("git commit -q -m x failed (exit 1): nothing to commit, working tree clean");
    expect(new GitError(["push"], "fatal: denied\n", { stdout: "noise", code: 128 }).message).toBe("git push failed (exit 128): fatal: denied");
    expect(new GitError(["push"], "", { signal: "SIGKILL" }).message).toBe("git push failed (killed by SIGKILL)");
    const failure = await gitRunner("git")(["commit", "-q", "-m", "empty"], { cwd: repo() }).catch((e: GitError) => e);
    expect(failure).toBeInstanceOf(GitError);
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as GitError).message).toMatch(/failed \(exit 1\): \S/);
  });

  it("counts a commit another git made first as nothing to commit, not a failure", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    const real = gitRunner("git");
    // Between our look at the index and our commit, someone else commits it.
    const racing: Git = async (args, opts) => {
      if (args[0] === "commit") git(["commit", "-q", "-m", "theirs"], dir);
      return real(args, opts);
    };
    expect(await new GitFolder(racing, dir).commit("ours")).toBe(false);
    expect(git(["log", "--format=%s"], dir)).toBe("theirs");
  });

  it("takes away an index.lock only when no git could still hold it", async () => {
    const dir = repo();
    const lock = path.join(dir, ".git", "index.lock");
    const none = async () => false;
    fs.writeFileSync(lock, "");
    // Fresh: a git may be at work there this moment.
    expect(await clearStaleIndexLock(dir, { running: none })).toBe(false);
    const old = (Date.now() - 10 * 60_000) / 1000;
    fs.utimesSync(lock, old, old);
    // Old, but some git runs on this machine: it may be that one's.
    expect(await clearStaleIndexLock(dir, { running: async () => true })).toBe(false);
    // A git that started while we looked took a lock of its own.
    const restarted = async () => {
      fs.rmSync(lock);
      fs.writeFileSync(lock, "");
      return false;
    };
    expect(await clearStaleIndexLock(dir, { running: restarted })).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);

    fs.utimesSync(lock, old, old);
    expect(await clearStaleIndexLock(dir, { running: none })).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    expect(await new GitFolder(gitRunner("git"), dir).commit("after")).toBe(true);
  });
});
