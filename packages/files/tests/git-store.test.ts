import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { gitRunner } from "@tomrade/storage";
import { GitFileStore, IDS_FILE, normalizeRel, parseLedger } from "@tomrade/files";

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

async function store(remote: string | null = null) {
  const dir = path.join(root, `store-${n++}`);
  return new GitFileStore({
    git,
    gitBinary: "git",
    dir,
    remote: remote ? () => ({ url: remote, branch: "main" }) : null,
    location: remote ? "test remote" : null,
    warn: noop,
    onChange: noop,
    watch: false
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

describe("two machines sharing a remote", () => {
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

  it("reports an unreachable remote as offline and keeps working", async () => {
    const s = await store(path.join(root, "missing.git"));
    await s.write("x.md", text("x"));
    expect((await s.sync()).state).toBe("offline");
    expect((await s.read("x.md"))?.body).toBe("x");
    s.close();
  });
});
