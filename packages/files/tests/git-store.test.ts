import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { gitRunner, type Git, type SyncProgress } from "@tomradex/git";
import { GitFileStore, IDS_FILE, normalizeRel, parseLedger } from "@tomradex/files";
import { spawnBudget } from "@tomradex/testkit";

/** The git command a runner was asked to run, past the config the store puts in front of it. */
const verb = (args: string[]): string | undefined => {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-files-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
const git = gitRunner("git");
const noop = () => {};

function bare(): string {
  const dir = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
  return dir;
}

const commits = (remote: string): number => Number(execFileSync("git", ["-C", remote, "rev-list", "--count", "main"]).toString().trim());

/** Another machine putting back a ledger line this one never publishes, as an older Tomrade might. */
function putBack(remote: string): void {
  const run = (args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}) => execFileSync("git", ["-C", remote, ...args], opts).toString().trim();
  const ids = run(["show", `main:${IDS_FILE}`]);
  if (ids.includes('"ghost"')) return;
  const blob = run(["hash-object", "-w", "--stdin"], { input: `${ids}\n{"id":"ghost","path":"ghost.md","at":1}\n` });
  const env = { ...process.env, GIT_INDEX_FILE: path.join(root, `put-back-${n++}`) };
  run(["read-tree", "main"], { env });
  run(["update-index", "--add", "--cacheinfo", `100644,${blob},${IDS_FILE}`], { env });
  const tree = run(["write-tree"], { env });
  run(["update-ref", "refs/heads/main", run(["-c", "user.name=other", "-c", "user.email=other@localhost", "commit-tree", tree, "-p", "main", "-m", "put back"])]);
}

async function store(remote: string | null = null, onChange: () => void = noop, dir = path.join(root, `store-${n++}`), runner: Git = git, warn: (message: string) => void = noop, onProgress?: (progress: SyncProgress | null) => void) {
  return new GitFileStore({
    git: runner,
    gitBinary: "git",
    dir,
    remote: remote ? () => ({ url: remote, branch: "main" }) : null,
    location: remote ? "test remote" : null,
    warn,
    onChange,
    onProgress,
    watch: false,
    // Tests sync by hand; a timed push landing mid-test would be joined by their sync() and skip a later write.
    pushMs: 600_000
  }).open();
}

const text = (s: string) => Buffer.from(s, "utf8");

describe("paths", () => {
  it("normalizes and refuses what would leave the store or hide in it", () => {
    expect(normalizeRel("./docs//a.md/")).toBe("docs/a.md");
    expect(normalizeRel("")).toBe("");
    expect(() => normalizeRel("../x")).toThrow(/Not a file path/);
    expect(() => normalizeRel("docs/../../x")).toThrow();
    expect(() => normalizeRel(".git/config")).toThrow();
    expect(() => normalizeRel("docs/.hidden")).toThrow();
  });

  it("reads the ledger: latest line per id wins, a path names the id that last claimed it", () => {
    const ledger = parseLedger(['{"id":"a","path":"x.md","at":1}', '{"id":"a","path":"y.md","at":3}', '{"id":"b","path":"x.md","at":2}', "garbage", '{"id":"b","path":null,"at":4}'].join("\n"));
    expect(ledger.byId.get("a")).toEqual({ path: "y.md", at: 3 });
    expect(ledger.byId.get("b")).toEqual({ path: null, at: 4 });
    expect(ledger.byPath.get("y.md")).toBe("a");
    expect(ledger.byPath.has("x.md")).toBe(false);
  });
});

describe("a local store", () => {
  it("says nothing when a sync finds nothing to save, and tells of what it saved", async () => {
    let changes = 0;
    const s = await store(null, () => changes++);
    await s.write("docs/a.md", text("a\n"));
    await s.sync();
    changes = 0;
    await s.sync();
    expect(changes).toBe(0);
    fs.writeFileSync(path.join(s.dir, "docs", "b.md"), "edited outside\n");
    await s.sync();
    expect(changes).toBeGreaterThan(0);
  });

  it("saves every write as a version with a stable id, and reads old versions back unchanged", async () => {
    const s = await store();
    const first = await s.write("docs/brief.md", text("# Brief\n"));
    expect(first.fileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.versionId).toMatch(/^[0-9a-f]{40}$/);
    expect(first.encoding).toBe("utf8");
    expect(first.mime).toBe("text/markdown");
    expect(first.body).toBe("# Brief\n");

    const second = await s.write("docs/brief.md", text("# Brief v2\n"), { message: "Second draft" });
    expect(second.fileId).toBe(first.fileId);
    expect(second.versionId).not.toBe(first.versionId);

    const history = await s.history("docs/brief.md");
    expect(history.map((v) => v.versionId)).toEqual([second.versionId, first.versionId]);
    expect(history[0]!.message).toBe("Second draft");

    const old = await s.readVersion({ fileId: first.fileId!, versionId: first.versionId! });
    expect(old?.body).toBe("# Brief\n");
    expect(await s.resolveVersion({ fileId: first.fileId!, versionId: first.versionId! })).toEqual({ fileId: first.fileId, versionId: first.versionId });
    expect(await s.resolveVersion({ fileId: "nope", versionId: first.versionId! })).toBeNull();
    expect(await s.resolveVersion({ fileId: first.fileId!, versionId: "0".repeat(40) })).toBeNull();
    expect(await s.resolveVersion({ fileId: first.fileId!, versionId: first.versionId!.slice(0, 7) })).toBeNull();

    const tree = await s.tree();
    expect(tree.map((e) => [e.path, e.kind])).toEqual([
      ["docs", "dir"],
      ["docs/brief.md", "file"]
    ]);
    expect(tree[1]!.fileId).toBe(first.fileId);
    expect((await s.status()).state).toBe("local");
    s.close();
  });

  it("carries the id across a move, and keeps a deleted file's versions readable", async () => {
    const s = await store();
    const saved = await s.write("a.txt", text("alpha"));
    await s.move("a.txt", "notes/b.txt");
    expect(await s.locate(saved.fileId!)).toBe("notes/b.txt");
    expect((await s.read("notes/b.txt"))?.fileId).toBe(saved.fileId);
    const moved = await s.read("notes/b.txt");
    expect(await s.readVersion({ fileId: saved.fileId!, versionId: moved!.versionId! })).toMatchObject({ path: "notes/b.txt", body: "alpha" });
    expect(await s.readVersion({ fileId: saved.fileId!, versionId: saved.versionId! })).toMatchObject({ path: "a.txt", body: "alpha" });

    await s.remove("notes/b.txt");
    expect(await s.locate(saved.fileId!)).toBeNull();
    expect(await s.read("notes/b.txt")).toBeNull();
    expect((await s.readVersion({ fileId: saved.fileId!, versionId: saved.versionId! }))?.body).toBe("alpha");
    s.close();
  });

  it("copies a file or folder as a version of its own, minting a fresh id", async () => {
    const s = await store();
    const saved = await s.write("a.txt", text("alpha"));
    await s.copy("a.txt", "notes/b.txt");
    expect((await s.read("a.txt"))?.fileId).toBe(saved.fileId);
    const copied = await s.read("notes/b.txt");
    expect(copied?.body).toBe("alpha");
    expect(copied?.fileId).not.toBe(saved.fileId);

    await s.mkdir("assets");
    await s.write("assets/logo.txt", text("logo"));
    await s.copy("assets", "assets-2");
    expect((await s.read("assets-2/logo.txt"))?.body).toBe("logo");
    expect((await s.read("assets/logo.txt"))?.body).toBe("logo");

    await expect(s.copy("assets", "assets/inside")).rejects.toThrow(/into itself/);
    await expect(s.copy("assets", "assets-2")).rejects.toThrow(/already exists/);
    await expect(s.copy("nope.txt", "x.txt")).rejects.toThrow(/does not exist/);
    s.close();
  });

  it("lists folders made empty, and saves outside edits as versions with ids", async () => {
    const s = await store();
    await s.mkdir("assets/img");
    expect((await s.list("assets")).map((e) => [e.name, e.kind])).toEqual([["img", "dir"]]);
    fs.writeFileSync(path.join(s.dir, "assets", "img", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    fs.writeFileSync(path.join(s.dir, "readme.txt"), "hand written");
    const before = await s.list();
    expect(before.find((e) => e.name === "readme.txt")).toMatchObject({ change: "added", fileId: null });
    expect(await s.settle("Edited outside")).toBe(true);
    expect(await s.settle()).toBe(false);
    const after = await s.read("readme.txt");
    expect(after?.fileId).toBeTruthy();
    expect(after?.versionId).toBeTruthy();
    const logo = await s.read("assets/img/logo.png");
    expect(logo).toMatchObject({ mime: "image/png", encoding: "base64" });
    const ledger = parseLedger(fs.readFileSync(path.join(s.dir, IDS_FILE), "utf8"));
    expect([...ledger.byPath.keys()].sort()).toEqual(["assets/img/logo.png", "readme.txt"]);
    s.close();
  });
});

describe("two machines sharing a remote", { timeout: spawnBudget(30_000) }, () => {
  it("adopts the remote, merges independent changes, and pushes back", async () => {
    const remote = bare();
    const a = await store(remote);
    await a.write("shared.md", text("from A\n"));
    expect((await a.status()).state).toBe("ahead");
    expect((await a.sync()).state).toBe("synced");

    const b = await store(remote);
    expect((await b.read("shared.md"))?.body).toBe("from A\n");
    expect((await b.status()).state).toBe("synced");
    const onB = await b.write("only-b.md", text("from B\n"));
    await a.write("only-a.md", text("from A too\n"));
    expect((await b.sync()).state).toBe("synced");
    const merged = await a.sync();
    expect(merged.state).toBe("synced");
    expect((await a.read("only-b.md"))?.fileId).toBe(onB.fileId);
    expect((await b.sync()).state).toBe("synced");
    expect((await b.read("only-a.md"))?.body).toBe("from A too\n");
    a.close();
    b.close();
  });

  it("a copy received while a clash waits was never the remote's: the other machine's later edit to it is kept", async () => {
    const remote = bare();
    const a = await store(remote);
    await a.write("f.md", text("v0\n"));
    await a.write("g.md", text("g0\n"));
    await a.sync();
    const b = await store(remote);
    expect((await b.sync()).state).toBe("synced");
    await a.write("f.md", text("t1\n"));
    await a.write("g.md", text("gA\n"));
    await a.sync();
    await b.write("g.md", text("gB\n"));
    expect((await b.sync()).state).toBe("conflicted");
    expect((await b.read("f.md"))?.body).toBe("t1\n");
    await a.write("f.md", text("t2\n"));
    await a.sync();
    await b.resolve("g.md", "ours");
    expect((await b.sync()).state).toBe("synced");
    expect((await b.read("f.md"))?.body).toBe("t2\n");
    expect((await a.sync()).state).toBe("synced");
    expect((await a.read("f.md"))?.body).toBe("t2\n");
    a.close();
    b.close();
  });

  it("publishes its copy again when the remote went back to one from before it", async () => {
    const remote = bare();
    const a = await store(remote);
    await a.write("f.md", text("v1\n"));
    await a.sync();
    const before = execFileSync("git", ["-C", remote, "rev-parse", "main"]).toString().trim();
    await a.write("f.md", text("v2\n"));
    await a.sync();
    execFileSync("git", ["-C", remote, "update-ref", "refs/heads/main", before]);
    expect((await a.sync()).state).toBe("synced");
    expect((await a.read("f.md"))?.body).toBe("v2\n");
    expect(execFileSync("git", ["-C", remote, "show", "main:f.md"]).toString()).toBe("v2\n");
    a.close();
  });

  it("leaves a clash for a person, shows both sides, and settles it either way", async () => {
    const remote = bare();
    const a = await store(remote);
    await a.write("notes.md", text("base\n"));
    await a.sync();
    const b = await store(remote);

    await a.write("notes.md", text("A wins\n"));
    await a.sync();
    await b.write("notes.md", text("B wins\n"));
    const clashed = await b.sync();
    expect(clashed.state).toBe("conflicted");
    expect(clashed.conflicts).toBe(1);
    const [conflict] = await b.conflicts();
    expect(conflict).toMatchObject({ path: "notes.md", kind: "content", binary: false, ours: "B wins\n", theirs: "A wins\n" });
    expect((await b.tree()).find((e) => e.path === "notes.md")?.change).toBe("conflicted");
    // A save while in conflict must never commit the markers.
    await b.write("aside.md", text("still works\n"));
    expect((await b.status()).state).toBe("conflicted");

    await b.resolve("notes.md", "theirs");
    expect((await b.read("notes.md"))?.body).toBe("A wins\n");
    expect((await b.sync()).state).toBe("synced");
    expect((await a.sync()).state).toBe("synced");
    expect((await a.read("aside.md"))?.body).toBe("still works\n");

    await a.write("notes.md", text("A again\n"));
    await a.sync();
    await b.write("notes.md", text("B again\n"));
    expect((await b.sync()).state).toBe("conflicted");
    await b.resolve("notes.md", "both");
    expect((await b.read("notes.md"))?.body).toBe("B again\n");
    expect((await b.read("notes (theirs).md"))?.body).toBe("A again\n");
    expect((await b.sync()).state).toBe("synced");
    expect((await a.sync()).state).toBe("synced");
    expect((await a.read("notes (theirs).md"))?.body).toBe("A again\n");

    // One side deletes what the other edits.
    await a.remove("aside.md");
    await a.sync();
    await b.write("aside.md", text("kept on B\n"));
    expect((await b.sync()).state).toBe("conflicted");
    expect((await b.conflicts())[0]).toMatchObject({ path: "aside.md", kind: "modify-delete", theirs: null });
    await b.resolve("aside.md", "ours");
    expect((await b.sync()).state).toBe("synced");
    expect((await a.sync()).state).toBe("synced");
    expect((await a.read("aside.md"))?.body).toBe("kept on B\n");
    a.close();
    b.close();
  });

  it("syncs again after a fetch was killed midway, its locks and partial pack left behind", async () => {
    const s = await store(bare());
    await s.write("a.md", text("a\n"));
    expect((await s.sync()).state).toBe("synced");
    const transport = path.join(s.dir, ".git", "files-sync", "transport");
    const git = path.join(transport, fs.readdirSync(transport)[0]!, ".git");
    fs.writeFileSync(path.join(git, "shallow.lock"), "");
    fs.writeFileSync(path.join(git, "index.lock"), "");
    fs.mkdirSync(path.join(git, "objects", "pack"), { recursive: true });
    fs.writeFileSync(path.join(git, "objects", "pack", "tmp_pack_x"), "partial");
    await s.write("b.md", text("b\n"));
    expect((await s.sync()).state).toBe("synced");
    expect(fs.readdirSync(path.join(git, "objects", "pack")).filter((f) => f.startsWith("tmp_"))).toEqual([]);
    s.close();
  });

  it("lets a store reopened mid-sync wait for the one before it instead of running git beside it", async () => {
    let running = 0;
    let most = 0;
    // A fetch slow enough that the second store's sync starts while the first is still in it.
    const slow: Git = async (args, opts) => {
      if (!opts?.cwd?.includes(`${path.sep}transport${path.sep}`)) return git(args, opts);
      most = Math.max(most, ++running);
      try {
        if (verb(args) === "fetch") await new Promise((resolve) => setTimeout(resolve, 300));
        return await git(args, opts);
      } finally {
        running--;
      }
    };
    const remote = bare();
    const first = await store(remote, noop, undefined, slow);
    await first.write("a.md", text("a\n"));
    const second = await store(remote, noop, first.dir, slow);
    await second.write("b.md", text("b\n"));
    const states = (await Promise.all([first.sync(), second.sync()])).map((s) => s.state);
    expect(states).toEqual(["synced", "synced"]);
    expect(most).toBe(1);
    first.close();
    second.close();
  });

  it("publishes the ids a machine syncing for the first time was given, so neither keeps rewriting the other's", async () => {
    const remote = bare();
    const a = await store(remote);
    await a.write("a.md", text("a\n"));
    await a.write("b.md", text("b\n"));
    expect((await a.sync()).state).toBe("synced");
    // B records the ids it receives a moment later, so its own stamps differ from A's.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await store(remote);
    expect((await b.sync()).state).toBe("synced");
    await a.sync();
    const settled = commits(remote);
    for (let round = 0; round < 3; round++) {
      expect((await b.sync()).state).toBe("synced");
      expect((await a.sync()).state).toBe("synced");
    }
    expect(commits(remote)).toBe(settled);
    expect((await b.read("a.md"))?.fileId).toBe((await a.read("a.md"))?.fileId);
    a.close();
    b.close();
  });

  it("stops sharing while another machine keeps putting back what this one replaces, and goes on once something changes", async () => {
    const remote = bare();
    const s = await store(remote);
    await s.write("a.md", text("a\n"));
    expect((await s.sync()).state).toBe("synced");
    const states: string[] = [];
    for (let round = 0; round < 5; round++) {
      putBack(remote);
      states.push((await s.sync()).state);
    }
    expect(states).toEqual(["synced", "synced", "synced", "error", "error"]);
    expect((await s.status()).detail).toMatch(/keeps undoing/);
    expect(execFileSync("git", ["-C", remote, "show", `main:${IDS_FILE}`]).toString()).toContain("ghost");
    await s.write("b.md", text("b\n"));
    expect((await s.sync()).state).toBe("synced");
    expect(execFileSync("git", ["-C", remote, "show", `main:${IDS_FILE}`]).toString()).not.toContain("ghost");
    s.close();
  });

  it("reports an unreachable remote as offline and keeps working", async () => {
    const said: string[] = [];
    const s = await store(path.join(root, "missing.git"), noop, undefined, git, (m) => said.push(m));
    await s.write("x.md", text("x"));
    const status = await s.sync();
    expect(status).toMatchObject({ state: "offline", failure: "network", detail: expect.stringContaining("missing.git") });
    expect(status.trace?.steps.map((step) => [step.step, step.ok])).toEqual([["saving", true], ["reaching", false]]);
    expect(status.trace?.output).toContain("missing.git");
    // Opening syncs once too: each failed sync tells the log once.
    expect(said.length).toBeGreaterThan(0);
    for (const line of said) expect(line).toMatch(/^sync: reach failed \(network\): .*missing\.git/);
    expect((await s.read("x.md"))?.body).toBe("x");
    s.close();
  });

  it("shows a remote that refuses the push as trouble, not offline, in the remote's own words", async () => {
    const remote = bare();
    fs.writeFileSync(path.join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'refused by policy' >&2\nexit 1\n", { mode: 0o755 });
    const said: string[] = [];
    const s = await store(remote, noop, undefined, git, (m) => said.push(m));
    await s.write("x.md", text("x"));
    expect(await s.sync()).toMatchObject({ state: "error", failure: "other", detail: "remote: refused by policy" });
    expect([...new Set(said)]).toEqual(["sync: push failed (other): remote: refused by policy"]);
    s.close();
  });

  it("records and shares exactly the bytes it is given, whatever the person's own git config says", async () => {
    const own = path.join(root, `own-config-${n++}`);
    fs.mkdirSync(path.join(own, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(own, "ignore"), "*.log\n");
    fs.writeFileSync(path.join(own, "hooks", "pre-commit"), "#!/bin/sh\necho 'not in my repositories' >&2\nexit 1\n", { mode: 0o755 });
    const config = path.join(own, "gitconfig");
    // A backslash starts an escape in git's config, so a Windows path goes in with forward slashes, as git reads it.
    const gitPath = (p: string) => p.replaceAll("\\", "/");
    fs.writeFileSync(config, `[core]\n\tautocrlf = true\n\texcludesFile = ${gitPath(path.join(own, "ignore"))}\n\thooksPath = ${gitPath(path.join(own, "hooks"))}\n`);
    const was = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      const remote = bare();
      const a = await store(remote);
      await a.write("run.log", text("one\n"));
      await a.write("crlf.txt", text("a\r\nb\r\n"));
      expect((await a.sync()).state).toBe("synced");
      const b = await store(remote);
      expect((await b.sync()).state).toBe("synced");
      expect((await b.read("run.log"))?.body).toBe("one\n");
      expect((await b.read("crlf.txt"))?.body).toBe("a\r\nb\r\n");
      await b.write("crlf.txt", text("a\r\nB\r\n"));
      expect((await b.sync()).state).toBe("synced");
      expect((await a.sync()).state).toBe("synced");
      expect((await a.read("crlf.txt"))?.body).toBe("a\r\nB\r\n");
      expect((await b.sync()).state).toBe("synced");
      expect((await a.sync()).state).toBe("synced");
      expect(execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", "main"]).toString()).toContain("run.log");
      expect(execFileSync("git", ["-C", remote, "show", "main:crlf.txt"]).toString()).toBe("a\r\nB\r\n");
      a.close();
      b.close();
      // Its own history never leaves the machine: a signing key that cannot sign stops nothing there.
      fs.appendFileSync(config, `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${gitPath(path.join(own, "no-gpg"))}\n`);
      const local = await store();
      await local.write("signed.md", text("never signed\n"));
      expect((await local.read("signed.md"))?.body).toBe("never signed\n");
      expect((await local.status()).state).toBe("local");
      local.close();
    } finally {
      if (was === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = was;
    }
  });

  it("a store closed while its sync waits on the remote leaves the folder to its successor", async () => {
    const remote = bare();
    const other = await store(remote);
    await other.write("a.md", text("a\n"));
    await other.sync();
    let gate: Promise<void> | null = null;
    let release!: () => void;
    let reached!: () => void;
    const atFetch = new Promise<void>((resolve) => (reached = resolve));
    const gated: Git = async (args, opts) => {
      if (gate && verb(args) === "fetch") {
        reached();
        await gate;
      }
      return git(args, opts);
    };
    const dir = path.join(root, `store-${n++}`);
    const a = await store(remote, noop, dir, gated);
    await other.write("later.md", text("later\n"));
    await other.sync();
    gate = new Promise<void>((resolve) => (release = resolve));
    const syncing = a.sync();
    await atFetch;
    a.close();
    const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
    release();
    await syncing;
    expect(execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim()).toBe(head);
    expect(fs.existsSync(path.join(dir, "later.md"))).toBe(false);
    gate = null;
    const successor = await store(remote, noop, dir);
    expect((await successor.sync()).state).toBe("synced");
    expect((await successor.read("later.md"))?.body).toBe("later\n");
    other.close();
    successor.close();
  });

  it("says offline, not error, when the host it asks to make the remote cannot be reached", async () => {
    const remote = bare();
    const s = await new GitFileStore({ git, gitBinary: "git", dir: path.join(root, `store-${n++}`), remote: () => ({ url: remote, branch: "main" }), location: "test remote", warn: noop, onChange: noop, watch: false, pushMs: 600_000, ensureRemote: async () => { throw new TypeError("fetch failed"); } }).open();
    expect(await s.sync()).toMatchObject({ state: "offline", detail: "fetch failed" });
    s.close();
  });

  it("goes on saying why the remote refuses a push, however often it is tried: a refusal replaced nothing", async () => {
    const remote = bare();
    fs.writeFileSync(path.join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'refused by policy' >&2\nexit 1\n", { mode: 0o755 });
    const s = await store(remote);
    await s.write("x.md", text("x"));
    for (let round = 0; round < 5; round++) expect(await s.sync()).toMatchObject({ state: "error", failure: "other", detail: "remote: refused by policy" });
    s.close();
  });

  it("with nothing new on either side, only asks the remote: no fetch, no commit, no push", async () => {
    const remote = bare();
    const ran: string[][] = [];
    const counting: Git = (args, opts) => {
      ran.push(args);
      return git(args, opts);
    };
    const s = await store(remote, noop, undefined, counting);
    await s.write("a.md", text("a\n"));
    expect((await s.sync()).state).toBe("synced");
    const before = commits(remote);
    ran.length = 0;
    expect((await s.sync()).state).toBe("synced");
    const verbs = ran.map((args) => args.find((a) => !a.startsWith("-") && !a.includes("=")));
    expect(verbs).toContain("ls-remote");
    expect(verbs.filter((v) => v === "fetch" || v === "push" || v === "commit-tree")).toEqual([]);
    expect(commits(remote)).toBe(before);
    s.close();
  });

  it("two machines that each add a rule settle on one order, and stop publishing", async () => {
    const remote = bare();
    const a = await store(remote);
    await a.write("a.md", text("a\n"));
    expect((await a.sync()).state).toBe("synced");
    const b = await store(remote);
    expect((await b.sync()).state).toBe("synced");
    await a.setAgentRules(["zeta"], "unlisted");
    await b.setAgentRules(["alpha"], "unlisted");
    for (let round = 0; round < 2; round++) {
      await a.sync();
      await b.sync();
    }
    const settled = commits(remote);
    for (let round = 0; round < 3; round++) {
      expect((await a.sync()).state).toBe("synced");
      expect((await b.sync()).state).toBe("synced");
    }
    expect(commits(remote)).toBe(settled);
    expect((await a.agentPolicy()).rules).toEqual([{ path: "alpha", mode: "unlisted" }, { path: "zeta", mode: "unlisted" }]);
    expect(await b.agentPolicy()).toEqual(await a.agentPolicy());
    a.close();
    b.close();
  });

  it("a change made while a sync is already pushing goes out right after it", async () => {
    const remote = bare();
    let reached!: () => void;
    const atPush = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Armed once the store is open: opening a first copy syncs too.
    let held = true;
    const gated: Git = async (args, opts) => {
      if (verb(args) === "push" && !held) {
        held = true;
        reached();
        await gate;
      }
      return git(args, opts);
    };
    const s = await new GitFileStore({ git: gated, gitBinary: "git", dir: path.join(root, `store-${n++}`), remote: () => ({ url: remote, branch: "main" }), location: "test remote", warn: noop, onChange: noop, watch: false, pushMs: 20 }).open();
    held = false;
    await s.write("a.md", text("a\n"));
    const first = s.sync();
    await atPush;
    await s.write("b.md", text("b\n"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await first;
    const shows = () => execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", "main"]).toString();
    for (let i = 0; i < 100 && !shows().includes("b.md"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shows()).toContain("b.md");
    s.close();
  });

  it("follows a sync step by step, says when it is over, and keeps what it did", async () => {
    const remote = bare();
    const told: (SyncProgress | null)[] = [];
    const s = await store(remote, noop, undefined, git, noop, (progress) => told.push(progress));
    await s.write("a.md", text("a\n"));
    await s.sync();
    await s.write("b.md", text("b\n"));
    told.length = 0;
    const status = await s.sync();
    // A transfer tells its step again as it moves; the steps themselves come once each, in order.
    const steps = told.flatMap((p, i) => (p && p.step !== told[i - 1]?.step ? [p.step] : []));
    // The remote is still at our last push, so there is nothing to fetch.
    expect(steps).toEqual(["saving", "reaching", "merging", "pushing"]);
    expect(told.at(-1)).toBeNull();
    expect(status.progress).toBeUndefined();
    expect(status.trace).toMatchObject({ remote, branch: "main" });
    expect(status.trace?.steps.map((step) => [step.step, step.ok])).toEqual([["saving", true], ["reaching", true], ["merging", true], ["pushing", true]]);
    s.close();
  });
});

describe("a commit another git makes first", () => {
  it("is no failure: a save whose staged changes someone else committed in between goes on", async () => {
    const dir = path.join(root, `store-${n++}`);
    let race = false;
    // As the store this one replaced might, finishing its last step: it commits what this store just staged.
    const racing: Git = async (args, opts) => {
      const verb = args.find((a, i) => a !== "-c" && args[i - 1] !== "-c");
      if (race && verb === "commit") {
        race = false;
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "theirs"], { cwd: dir });
      }
      return git(args, opts);
    };
    const s = await store(null, noop, dir, racing);
    race = true;
    await s.write("notes/a.md", text("hello\n"));
    expect(race).toBe(false);
    expect((await s.read("notes/a.md"))?.body.toString("utf8")).toBe("hello\n");
    expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim()).toBe("theirs");
    s.close();
  });
});
