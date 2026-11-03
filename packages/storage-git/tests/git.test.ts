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
import { ARTIFACT_DIR, GitError, GitFolder, Storage, clearStaleIndexLock, digestState, gitRunner, probeUrl, readArtifact, writeArtifact, type Git } from "@tomradex/storage";
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

async function machine(label: string, storage: Record<string, unknown> = {}, device?: string) {
  const hubDir = path.join(root, `${label}-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({ hubDir, device, plugins: [[Storage, { ...QUIET, ...storage }], storageGit] });
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

  it("keeps what the last sync did, where it went and each step, for the person to read", async () => {
    const a = await machine("trace");
    const remote = bareRemote();
    a.items.create({ title: "Traced", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    await a.storage.sync(a.project.id);
    const status = await a.storage.statusFor(a.project.id);
    expect(status.progress).toBeUndefined();
    expect(status.trace).toMatchObject({ remote, branch: "main" });
    expect(status.trace!.steps.map((s) => s.step)).toEqual(expect.arrayContaining(["reaching", "fetching"]));
    expect(status.trace!.steps.every((s) => s.ok)).toBe(true);
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

  it("a merge keeps what the other side added outside the project's data, the shared files above all, and a removal there still travels", async () => {
    const a = await machine("keep-a");
    const remote = bareRemote();
    a.items.create({ title: "A's", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    const b = await machine("keep-b");
    // Two machines, two device logs: each merge writes the other's into its folder.
    b.hub.deviceId = "device-b";
    const id = await b.storage.attachRemote("git", { remote, branch: "main" });
    const bDir = b.hub.catalog.project(id)!.dir!;
    // A already tracks B's device log when B adds to it: a merge on A writes it into A's folder before git merges.
    b.items.create({ title: "B's first", projectId: id, boardId: b.board.id, by: "human" });
    await b.storage.publish(id);
    expect((await a.storage.sync(a.project.id)).state).toBe("synced");
    b.items.create({ title: "B's", projectId: id, boardId: b.board.id, by: "human" });
    await b.storage.publish(id);
    // What the Files projection pushes beside the project's data.
    teammateEdits(remote, (work) => {
      fs.mkdirSync(path.join(work, "project-files"), { recursive: true });
      fs.writeFileSync(path.join(work, "project-files", "report.md"), "new on the remote\n");
    });
    a.items.create({ title: "A's again", projectId: a.project.id, boardId: a.board.id, by: "human" });
    expect((await a.storage.publish(a.project.id)).state).toBe("synced");
    expect(git(["rev-list", "--parents", "-n", "1", "main"], remote).split(" ")).toHaveLength(3);
    expect(git(["show", "main:project-files/report.md"], remote)).toBe("new on the remote");
    expect(fs.existsSync(path.join(a.dir, "project-files", "report.md"))).toBe(true);
    expect(a.items.list({ projectId: a.project.id }).map((i) => i.title).sort()).toEqual(["A's", "A's again", "B's", "B's first"]);

    // B never saw the file and moved on meanwhile: its merge takes the file in rather than undoing it.
    b.items.create({ title: "B's again", projectId: id, boardId: b.board.id, by: "human" });
    expect((await b.storage.publish(id)).state).toBe("synced");
    expect(git(["show", "main:project-files/report.md"], remote)).toBe("new on the remote");
    expect(fs.existsSync(path.join(bDir, "project-files", "report.md"))).toBe(true);

    // A removal made there is a change like any other, and reaches the folder that moved too.
    teammateEdits(remote, (work) => fs.rmSync(path.join(work, "project-files", "report.md")));
    a.items.create({ title: "A's third", projectId: a.project.id, boardId: a.board.id, by: "human" });
    expect((await a.storage.publish(a.project.id)).state).toBe("synced");
    expect(git(["ls-tree", "--name-only", "-r", "main", "project-files"], remote)).toBe("");
    expect(fs.existsSync(path.join(a.dir, "project-files", "report.md"))).toBe(false);
    expect(git(["status", "--porcelain"], a.dir)).toBe("");
  }, 30_000);

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

  it("a push the remote turns away is no delivery: the status says why, the count stays, and the next sync pushes", async () => {
    const a = await machine("rejected");
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    const head = git(["rev-parse", "main"], remote);
    const said: string[] = [];
    a.ctx.logger.exporter({ export: (m: { type: string; args: unknown[] }) => void said.push(`${m.type} ${String(m.args[0])}`) } as never);
    const hook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\necho 'pushes are frozen' >&2\nexit 1\n", { mode: 0o755 });

    a.items.create({ title: "Turned away", projectId: a.project.id, boardId: a.board.id, by: "human" });
    const status = await a.storage.publish(a.project.id);
    expect(status.state).toBe("error");
    expect(status.detail).toMatch(/pushes are frozen/);
    expect(status.detail).toMatch(/pre-receive hook declined/);
    expect(git(["rev-parse", "main"], remote)).toBe(head);
    expect(a.storage.pending(a.project.id)?.count).toBe(1);
    expect(said.some((l) => l.startsWith("warn") && l.includes("not pushed") && l.includes("pushes are frozen"))).toBe(true);

    // On the way out too: the quit dialog still hears of what did not go.
    a.items.create({ title: "Still waiting", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.flushAll("quit");
    expect(git(["rev-parse", "main"], remote)).toBe(head);
    expect(a.storage.pendingAll()).toEqual([{ projectId: a.project.id, name: a.project.name, count: 2 }]);
    expect((await a.storage.statusFor(a.project.id)).state).toBe("error");

    fs.rmSync(hook);
    expect((await a.storage.sync(a.project.id)).state).toBe("synced");
    expect(a.storage.pending(a.project.id)?.count).toBe(0);
    expect(git(["show", "main:.tomrade/state/items.jsonl"], remote)).toContain("Still waiting");
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

  it("a push turned away because a teammate pushed after our fetch goes again at once, merged; with nothing of ours to push, none goes", async () => {
    const remote = bareRemote();
    const mate = path.join(root, `mate-${n++}`);
    const ran = path.join(root, `ran-${n++}.log`);
    // git as Tomrade runs it, except that the first push lets the teammate's push land just before it.
    const wrapper = path.join(root, `git-${n++}.sh`);
    fs.writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> '${ran}'\ncase " $* " in *" push "*) if [ -f '${mate}.ready' ]; then rm '${mate}.ready'; git -C '${mate}' push -q origin HEAD:refs/heads/main; fi;; esac\nexec git "$@"\n`, { mode: 0o755 });
    const a = await machine("stale-push", { gitBinary: wrapper });
    const item = a.items.create({ title: "Mine", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    git(["clone", "-q", "--branch", "main", remote, mate], root);
    git(["config", "user.email", "mate@localhost"], mate);
    git(["config", "user.name", "Mate"], mate);
    const state = readArtifact(mate)!;
    state.tables.items.find((r) => r.id === item.id)!.title = "Theirs";
    state.manifest.snapshot!.digest = digestState(state);
    writeArtifact(mate, state);
    git(["add", "-A"], mate);
    git(["commit", "-q", "-m", "teammate"], mate);
    const theirs = git(["rev-parse", "HEAD"], mate);
    fs.writeFileSync(`${mate}.ready`, "");

    a.items.update(a.project.id, item.id, { status: "done" }, "human");
    const status = await a.storage.publish(a.project.id);
    expect(fs.existsSync(`${mate}.ready`)).toBe(false);
    expect(status.state).toBe("synced");
    expect(git(["rev-list", "--parents", "-n", "1", "main"], remote).split(" ")).toContain(theirs);
    expect(JSON.parse(git(["show", "main:.tomrade/state/items.jsonl"], remote))).toMatchObject({ title: "Theirs", status: "done" });
    expect(a.storage.pending(a.project.id)?.count).toBe(0);

    fs.writeFileSync(ran, "");
    expect((await a.storage.sync(a.project.id)).state).toBe("synced");
    const commands = fs.readFileSync(ran, "utf8").split("\n");
    expect(commands.some((c) => c.startsWith("fetch"))).toBe(true);
    expect(commands.filter((c) => c.startsWith("push") || c.startsWith("commit"))).toEqual([]);
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

describe("two machines on one project", () => {
  it("agree after both edit it, the same ticket and the same field included, and then commit nothing more", async () => {
    // Two machines, each with a device of its own, as real ones are.
    const a = await machine("pair-a", {}, "machine-a");
    const remote = bareRemote();
    const shared = a.items.create({ title: "Shared", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    const b = await machine("pair-b", {}, "machine-b");
    const id = await b.storage.attachRemote("git", { remote, branch: "main" });
    expect(id).toBe(a.project.id);
    const both = [a, b];

    // A ticket each, and different fields of the same one, before either has heard of the other's.
    a.items.create({ title: "From A", projectId: id, boardId: shared.boardId, by: "human" });
    b.items.create({ title: "From B", projectId: id, boardId: shared.boardId, by: "human" });
    a.items.update(id, shared.id, { status: "doing" }, "human");
    b.items.update(id, shared.id, { priority: 3 }, "human");
    await a.storage.publish(id);
    await b.storage.publish(id);
    await a.storage.sync(id);
    // Then the same field.
    a.items.update(id, shared.id, { title: "Title from A" }, "human");
    b.items.update(id, shared.id, { title: "Title from B" }, "human");
    await a.storage.publish(id);
    await b.storage.publish(id);
    for (let round = 0; round < 2; round++) for (const m of both) await m.storage.sync(id);
    const view = (m: typeof a) => m.items.list({ projectId: id }).map((i) => ({ id: i.id, title: i.title, status: i.status, priority: i.priority, key: i.keyNum })).sort((x, y) => x.id.localeCompare(y.id));
    expect(view(b)).toEqual(view(a));
    expect(view(a).map((i) => i.title)).toEqual(expect.arrayContaining(["From A", "From B"]));
    expect(new Set(view(a).map((i) => i.key)).size).toBe(view(a).length);
    expect(a.items.get(id, shared.id)).toMatchObject({ status: "doing", priority: 3 });
    expect(["Title from A", "Title from B"]).toContain(a.items.get(id, shared.id)!.title);
    for (const m of both) expect((await m.storage.statusFor(id)).state).toBe("synced");

    // Settled: syncing and sweeping again, on both, adds nothing to the remote.
    const commits = () => git(["rev-list", "--count", "main"], remote);
    const settled = commits();
    for (let round = 0; round < 3; round++) {
      for (const m of both) {
        await m.storage.sync(id);
        await m.storage.reconcile(id);
      }
    }
    expect(commits()).toBe(settled);
    for (const m of both) {
      expect(m.storage.pending(id)?.count).toBe(0);
      expect(git(["status", "--porcelain"], m.hub.catalog.project(id)!.dir!)).toBe("");
      // Each has the other's history: what both count as taken in is the same.
      expect(readArtifact(m.hub.catalog.project(id)!.dir!)!.manifest.snapshot?.checkpoint).toEqual(readArtifact(a.hub.catalog.project(id)!.dir!)!.manifest.snapshot?.checkpoint);
    }
  }, 60_000);
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

  it("a Hub push the remote turns away is not taken for one that landed", async () => {
    const a = await machine("hub-rejected");
    const hubRemote = bareRemote();
    expect((await a.storage.bindHub("git", { remote: hubRemote, branch: "main" })).state).toBe("synced");
    const head = git(["rev-parse", "main"], hubRemote);
    const said: string[] = [];
    a.ctx.logger.exporter({ export: (m: { type: string; args: unknown[] }) => void said.push(`${m.type} ${String(m.args[0])}`) } as never);
    const hook = path.join(hubRemote, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\necho 'hub is read-only' >&2\nexit 1\n", { mode: 0o755 });

    a.projects.create({ name: "Another" });
    const status = await a.storage.syncHub();
    expect(status.state).toBe("error");
    expect(status.detail).toMatch(/hub is read-only/);
    expect(git(["rev-parse", "main"], hubRemote)).toBe(head);
    expect(said.some((l) => l.startsWith("warn") && l.includes("Hub") && l.includes("hub is read-only"))).toBe(true);

    fs.rmSync(hook);
    expect((await a.storage.syncHub()).state).toBe("synced");
    expect(JSON.parse(git(["show", "main:hub.json"], hubRemote)).projects.map((p: { name: string }) => p.name)).toContain("Another");
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

  it("concludes a merge whose tree is HEAD's own, so the push after it fast-forwards the remote", async () => {
    const remote = bareRemote();
    const dir = repo();
    git(["remote", "add", "origin", remote], dir);
    fs.writeFileSync(path.join(dir, "f.txt"), "a\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], dir);
    const other = path.join(root, `other-${n++}`);
    git(["clone", "-q", "--branch", "main", remote, other], root);
    fs.writeFileSync(path.join(other, "f.txt"), "b\n");
    git(["-c", "user.email=o@localhost", "-c", "user.name=O", "commit", "-q", "-am", "theirs"], other);
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], other);
    // Ours arrives at the same content by another commit, as two machines that merged the same pair do.
    fs.writeFileSync(path.join(dir, "f.txt"), "b\n");
    git(["commit", "-q", "-am", "ours"], dir);
    git(["fetch", "-q", "origin", "main"], dir);

    const g = new GitFolder(gitRunner("git"), dir);
    await g.beginMerge("main");
    expect(await g.merging()).toBe(true);
    expect(await g.commit("merge")).toBe(true);
    expect(await g.merging()).toBe(false);
    expect(await g.push("main")).toEqual({ ok: true });
  });

  it("commits only its own subtree, and never concludes someone's merge", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "README.md"), "# code\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "code"], dir);
    fs.mkdirSync(path.join(dir, ".tomrade"));
    fs.writeFileSync(path.join(dir, ".tomrade", "a.json"), "{}\n");
    fs.writeFileSync(path.join(dir, "wip.ts"), "// staged by its owner\n");
    git(["add", "wip.ts"], dir);
    const g = new GitFolder(gitRunner("git"), dir);
    expect(await g.commit("tomrade", ".tomrade")).toBe(true);
    expect(git(["show", "--name-only", "--format=", "HEAD"], dir)).toBe(".tomrade/a.json");
    expect(git(["diff", "--cached", "--name-only"], dir)).toBe("wip.ts");

    git(["commit", "-q", "-m", "wip"], dir);
    git(["checkout", "-q", "-b", "side"], dir);
    fs.writeFileSync(path.join(dir, "side.ts"), "// side\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "side"], dir);
    git(["checkout", "-q", "main"], dir);
    git(["merge", "-q", "--no-ff", "--no-commit", "side"], dir);
    fs.writeFileSync(path.join(dir, ".tomrade", "b.json"), "{}\n");
    const head = git(["rev-parse", "HEAD"], dir);
    expect(await g.commit("tomrade", ".tomrade")).toBe(false);
    expect(git(["rev-parse", "HEAD"], dir)).toBe(head);
    expect(await g.merging()).toBe(true);
  });

  it("cuts off a command that hangs, and a remote that never answered reads as offline", async () => {
    const slow = path.join(root, `slow-${n++}.sh`);
    fs.writeFileSync(slow, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const started = Date.now();
    const r = await gitRunner(slow)(["ls-remote", "origin"], { ok: true, timeout: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    const hung: Git = async () => ({ stdout: "", stderr: "", code: 1, timedOut: true });
    expect(await new GitFolder(hung, root).probe("main")).toBe("offline");
    expect(await new GitFolder(hung, root).push("main")).toMatchObject({ ok: false, reach: "offline" });
    expect(await probeUrl(hung, "https://example.invalid/p.git", "main")).toMatchObject({ reach: "offline" });
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
