import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { gitRunner, type Git } from "@tomrade/storage";
import { GitFileStore, type GitRemoteTarget } from "../src/git-store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "files-selective-"));
let serial = 0;
const stores: GitFileStore[] = [];
afterAll(() => { for (const s of stores) s.close(); fs.rmSync(root, { recursive: true, force: true }); });
const run = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const text = (s: string) => Buffer.from(s);
const git = gitRunner("git");
function bare() {
  const dir = path.join(root, `remote-${serial++}`);
  fs.mkdirSync(dir);
  run(dir, "init", "-q", "--bare", "-b", "main");
  return dir;
}
async function open(target: GitRemoteTarget | null, dir = path.join(root, `local-${serial++}`), runner: Git = git) {
  const s = await new GitFileStore({ dir, git: runner, gitBinary: "git", remote: target ? () => target : null, location: null, onChange() {}, warn() {}, watch: false, pushMs: 3600000 }).open();
  stores.push(s);
  return s;
}
const target = (url: string, directory?: string): GitRemoteTarget => ({ url, branch: "main", directory });
const ref = (c: { fileId: string | null; versionId: string | null }) => ({ fileId: c.fileId!, versionId: c.versionId! });
function blobs(remote: string): string {
  return run(remote, "rev-list", "--objects", "--all").trim().split("\n").map((line) => line.split(" ")[0]!).filter((oid) => run(remote, "cat-file", "-t", oid).trim() === "blob").map((oid) => run(remote, "cat-file", "blob", oid)).join("\n");
}

describe("selective Git projection", { timeout: 30000 }, () => {
  it("keeps private bytes and commits local, publishes only the current version when sharing a private draft", async () => {
    const remote = bare();
    const a = await open(target(remote));
    await a.setSyncRules(["private"], "local");
    const secret = await a.write("private/draft.txt", text("PRIVATE-FIRST-SECRET"));
    const later = await a.write("private/draft.txt", text("PRIVATE-SECOND-SECRET"));
    const shared = await a.write("public.txt", text("public"));
    expect((await a.sync()).state).toBe("synced");
    expect(await a.readVersion(ref(secret))).toMatchObject({ body: "PRIVATE-FIRST-SECRET" });
    expect(await a.history("private/draft.txt")).toHaveLength(2);
    expect(blobs(remote)).not.toContain("PRIVATE-FIRST-SECRET");
    expect(blobs(remote)).not.toContain(Buffer.from("PRIVATE-FIRST-SECRET").toString("base64"));
    expect(() => run(remote, "cat-file", "-e", `${shared.versionId}^{commit}`)).toThrow();
    await a.setSyncRules(["private/draft.txt"], "shared");
    expect((await a.sync()).state).toBe("synced");
    const b = await open(target(remote));
    expect(await b.readVersion(ref(secret))).toBeNull();
    expect(await b.readVersion(ref(later))).toMatchObject({ body: "PRIVATE-SECOND-SECRET" });
    expect(blobs(remote)).not.toContain(Buffer.from("PRIVATE-FIRST-SECRET").toString("base64"));
    expect(run(a.dir, "remote").trim()).toBe("");
    expect(run(a.dir, "ls-files")).not.toContain("files-sync");
    // A published version is the file's own blob, so the current version costs the remote nothing extra.
    expect(run(remote, "rev-parse", `main:.tomrade-files/versions/${later.fileId}/${later.versionId}`)).toBe(run(remote, "rev-parse", "main:private/draft.txt"));
    expect(JSON.parse(run(remote, "show", `main:.tomrade-files/versions/${later.fileId}/${later.versionId}.json`))).toEqual({ fileId: later.fileId, versionId: later.versionId, path: "private/draft.txt" });
  });

  it("replaces an early draft's inline version records, local and remote, with bytes beside them", async () => {
    const remote = bare();
    const a = await open(target(remote));
    const v = await a.write("doc.txt", text("hello"));
    await a.sync();
    const rel = `.tomrade-files/versions/${v.fileId}/${v.versionId}`;
    const inline = JSON.stringify({ fileId: v.fileId, versionId: v.versionId, path: "doc.txt", body: Buffer.from("hello").toString("base64") });
    fs.writeFileSync(path.join(a.dir, ".git", "files-sync", "versions", v.fileId!, `${v.versionId}.json`), inline);
    expect(await a.readVersion(ref(v))).toMatchObject({ body: "hello" });
    expect(JSON.parse(fs.readFileSync(path.join(a.dir, ".git", "files-sync", "versions", v.fileId!, `${v.versionId}.json`), "utf8"))).toEqual({ fileId: v.fileId, versionId: v.versionId, path: "doc.txt" });
    const seed = path.join(root, `seed-${serial++}`);
    run(root, "clone", "-q", remote, seed);
    run(seed, "config", "user.email", "test@example.com"); run(seed, "config", "user.name", "Test");
    fs.rmSync(path.join(seed, rel));
    fs.writeFileSync(path.join(seed, `${rel}.json`), inline);
    run(seed, "add", "-A"); run(seed, "commit", "-qm", "inline record"); run(seed, "push", "-q", "origin", "main");
    const b = await open(target(remote));
    expect(await b.readVersion(ref(v))).toMatchObject({ body: "hello" });
    expect(run(remote, "show", `main:${rel}`)).toBe("hello");
    expect(JSON.parse(run(remote, "show", `main:${rel}.json`))).toEqual({ fileId: v.fileId, versionId: v.versionId, path: "doc.txt" });
  });

  it("retains published pins after deselection and deletion on a fresh machine", async () => {
    const remote = bare();
    const a = await open(target(remote));
    const v1 = await a.write("shared.txt", text("first"));
    const v2 = await a.write("shared.txt", text("second"));
    await a.sync();
    await a.setSyncRules(["shared.txt"], "local");
    const privateVersion = await a.write("shared.txt", text("PRIVATE-AFTER-DESELECT"));
    await a.sync();
    await a.remove("shared.txt");
    await a.sync();
    const fresh = await open(target(remote));
    expect(await fresh.read("shared.txt")).toBeNull();
    expect(await fresh.readVersion(ref(v1))).toMatchObject({ body: "first" });
    expect(await fresh.readVersion(ref(v2))).toMatchObject({ body: "second" });
    expect(await fresh.resolveVersion(ref(v1))).toEqual(ref(v1));
    expect(await fresh.readVersion(ref(privateVersion))).toBeNull();
    expect(blobs(remote)).not.toContain("PRIVATE-AFTER-DESELECT");
    expect(blobs(remote)).not.toContain(Buffer.from("PRIVATE-AFTER-DESELECT").toString("base64"));
  });

  it("preserves monorepo siblings exactly, including executable modes and symlinks", async () => {
    const remote = bare();
    const seed = path.join(root, `seed-${serial++}`);
    run(root, "clone", "-q", remote, seed);
    run(seed, "config", "user.email", "test@example.com"); run(seed, "config", "user.name", "Test");
    fs.mkdirSync(path.join(seed, "code"));
    fs.writeFileSync(path.join(seed, "code", "run.sh"), "#!/bin/sh\necho unchanged\n", { mode: 0o755 });
    fs.symlinkSync("code/run.sh", path.join(seed, "link"));
    fs.writeFileSync(path.join(seed, ".gitattributes"), "*.txt text eol=crlf\n");
    run(seed, "add", "-A"); run(seed, "commit", "-qm", "code"); run(seed, "push", "-q", "origin", "main");
    const before = run(remote, "ls-tree", "-r", "main");
    const a = await open(target(remote, "project-files"));
    expect(await a.tree()).toEqual([]);
    await a.write("notes.txt", text("notes\n"));
    expect((await a.sync()).state).toBe("synced");
    const after = run(remote, "ls-tree", "-r", "main").split("\n").filter((line) => !line.includes("\tproject-files/")).join("\n");
    expect(after).toBe(before);
    expect(run(remote, "show", "main:project-files/notes.txt")).toBe("notes\n");
    const b = await open(target(remote, "project-files"));
    expect((await b.tree()).map((e) => e.path)).toEqual(["notes.txt"]);
    await a.remove("notes.txt"); await a.sync(); await b.sync();
    expect(await b.read("notes.txt")).toBeNull();
    expect(run(remote, "ls-tree", "-r", "main").split("\n").filter((line) => !line.includes("\tproject-files/")).join("\n")).toBe(before);
  });

  it("shares persistent folder rules, preserves explicit descendants and carries move rules but not copy rules", async () => {
    const remote = bare(); const a = await open(target(remote));
    await a.setSyncRules([""], "local");
    await a.setSyncRules(["docs"], "shared");
    await a.setSyncRules(["docs/private"], "local");
    await a.write("docs/private/a.txt", text("hidden"));
    await a.write("docs/a.txt", text("shared"));
    await a.setSyncRules(["docs"], "local");
    expect((await a.syncPolicy()).rules).toContainEqual({ path: "docs/private", mode: "local" });
    await a.setSyncRules(["docs"], "shared");
    await a.sync();
    const b = await open(target(remote));
    expect(await b.syncPolicy()).toEqual(await a.syncPolicy());
    await b.write("new-private.txt", text("fresh-private"));
    await b.write("docs/new.txt", text("fresh-shared"));
    await b.sync();
    expect(run(remote, "ls-tree", "-r", "--name-only", "main")).not.toContain("new-private.txt");
    await a.move("docs", "renamed");
    expect((await a.syncPolicy()).rules).toContainEqual({ path: "renamed/private", mode: "local" });
    expect((await a.list()).find((e) => e.path === "renamed")?.sync).toMatchObject({ mode: "shared", source: "explicit", mixed: true });
    await a.copy("renamed", "copy");
    expect((await a.list()).find((e) => e.path === "copy")?.sync).toMatchObject({ mode: "local", source: "default" });
    a.close(); const reopened = await open(null, a.dir);
    expect(await reopened.syncPolicy()).toEqual(await a.syncPolicy());
  });

  it("persists content and delete conflicts through reopen, and retries a refused push", async () => {
    const remote = bare(); const a = await open(target(remote));
    await a.write("a.txt", text("base")); await a.sync();
    let rejectPush = false;
    const runner: Git = async (args, options) => rejectPush && args[0] === "push" ? { code: 1, stdout: "", stderr: "injected rejection" } : git(args, options);
    let b = await open(target(remote), undefined, runner);
    await a.write("a.txt", text("remote")); await a.sync();
    await b.remove("a.txt");
    expect((await b.sync()).state).toBe("conflicted");
    b.close(); b = await open(target(remote), b.dir, runner);
    expect((await b.conflicts())[0]).toMatchObject({ kind: "delete-modify", ours: null, theirs: "remote" });
    expect((await b.sync()).state).toBe("conflicted");
    await b.resolve("a.txt", "theirs");
    await b.write("retry.txt", text("retry preserved"));
    rejectPush = true;
    expect((await b.sync()).state).toBe("error");
    rejectPush = false;
    expect((await b.sync()).state).toBe("synced");
    await a.sync();
    expect(await a.read("retry.txt")).toMatchObject({ body: "retry preserved" });
  });

  it("merges distinct policy edits and fails closed for conflicting same-rule edits", async () => {
    const remote = bare(); const a = await open(target(remote)); const b = await open(target(remote));
    await a.setSyncRules(["a"], "local"); await b.setSyncRules(["b"], "local");
    await a.sync(); expect((await b.sync()).state).toBe("synced"); await a.sync();
    expect((await a.syncPolicy()).rules).toEqual(expect.arrayContaining([{ path: "a", mode: "local" }, { path: "b", mode: "local" }]));
    await a.setSyncRules(["a"], "shared"); await b.setSyncRules(["a"], "inherit");
    await a.sync();
    expect(await b.sync()).toMatchObject({ state: "error", detail: expect.stringContaining("policy conflict") });
    expect((await b.syncPolicy()).rules).not.toContainEqual({ path: "a", mode: "shared" });
  });

  it("adopts remote identity for identical independently created content", async () => {
    const remote = bare(); const a = await open(target(remote)); const b = await open(target(remote));
    const original = await a.write("same.txt", text("same")); await b.write("same.txt", text("same"));
    await a.sync(); await b.sync(); await a.sync();
    expect((await b.read("same.txt"))?.fileId).toBe(original.fileId);
    expect((await a.read("same.txt"))?.fileId).toBe(original.fileId);
  });

  it("refuses old root caches for scoped remotes and saves outside edits in local sync", async () => {
    const remote = bare(); const a = await open(target(remote));
    await a.write("code.ts", text("legacy code")); await a.sync(); a.close();
    await expect(open(target(remote, "project-files"), a.dir)).rejects.toThrow(/new local store/);
    expect(run(remote, "ls-tree", "-r", "--name-only", "main")).not.toContain("project-files/code.ts");
    const local = await open(null);
    fs.writeFileSync(path.join(local.dir, "outside.txt"), "external");
    await local.sync(); expect((await local.read("outside.txt"))?.versionId).toBeTruthy();
  });
});
