/**
 * A ticket's changes as a diff view reads them. The parser is fed patches as git prints them; the service is asked
 * against a real repository, because which commits a scope compares is git's answer, not a guess.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodeLink, type ChangedFile } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import { Repos } from "@tomradex/repos";
import GitHubAccount from "@tomradex/github";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { fresh, settle } from "@tomradex/testkit";
import { addedFileHunks, parseFileList, parsePatch, unquotePath } from "../src/changes-parse.js";
import { looksGenerated } from "../src/changes-read.js";

const kinds = (file: { hunks: { lines: { kind: string; old: number | null; new: number | null; text: string }[] }[] }) =>
  file.hunks.flatMap((h) => h.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.old ?? ""}:${l.new ?? ""} ${l.text}`));

describe("a patch as files, hunks and numbered lines", () => {
  it("numbers each side of a modified file and keeps the hunk's heading", () => {
    const [file, ...rest] = parsePatch(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,4 +1,4 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        " four",
        "@@ -20,2 +20,3 @@ export function run() {",
        " twenty",
        "+added",
        " twenty-one",
        ""
      ].join("\n")
    );
    expect(rest).toEqual([]);
    expect(file).toMatchObject({ path: "src/app.ts", oldPath: null, status: "modified", additions: 2, deletions: 1, binary: false, truncated: false });
    expect(file.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines, h.header])).toEqual([
      [1, 4, 1, 4, ""],
      [20, 2, 20, 3, "export function run() {"]
    ]);
    expect(kinds(file)).toEqual([" 1:1 one", "-2: two", "+:2 TWO", " 3:3 three", " 4:4 four", " 20:20 twenty", "+:21 added", " 21:22 twenty-one"]);
  });

  it("reads a rename, an added file and a deleted one", () => {
    const files = parsePatch(
      [
        "diff --git a/old name.ts b/new name.ts",
        "similarity index 80%",
        "rename from old name.ts",
        "rename to new name.ts",
        "index 1111111..2222222 100644",
        "--- a/old name.ts\t",
        "+++ b/new name.ts\t",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/fresh.txt b/fresh.txt",
        "new file mode 100644",
        "index 0000000..3333333",
        "--- /dev/null",
        "+++ b/fresh.txt",
        "@@ -0,0 +1,2 @@",
        "+first",
        "+second",
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index 4444444..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        ""
      ].join("\n")
    );
    expect(files.map((f) => [f.path, f.oldPath, f.status, f.additions, f.deletions])).toEqual([
      ["new name.ts", "old name.ts", "renamed", 1, 1],
      ["fresh.txt", null, "added", 2, 0],
      ["gone.txt", null, "deleted", 0, 1]
    ]);
    expect(kinds(files[1])).toEqual(["+:1 first", "+:2 second"]);
  });

  it("reads files the patch has no lines for: a binary, a mode change, an empty new file", () => {
    const files = parsePatch(
      [
        "diff --git a/logo.png b/logo.png",
        "index 1111111..2222222 100644",
        "Binary files a/logo.png and b/logo.png differ",
        "diff --git a/run me.sh b/run me.sh",
        "old mode 100644",
        "new mode 100755",
        "diff --git a/empty b/empty",
        "new file mode 100644",
        "index 0000000..e69de29",
        ""
      ].join("\n")
    );
    expect(files.map((f) => [f.path, f.status, f.binary, f.additions, f.hunks.length])).toEqual([
      ["logo.png", "modified", true, null, 0],
      ["run me.sh", "modified", false, 0, 0],
      ["empty", "added", false, 0, 0]
    ]);
  });

  it("marks the line a file ends on without a newline, on either side", () => {
    const [file] = parsePatch(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " keep", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file", ""].join("\n"));
    expect(file.hunks[0].lines.map((l) => [l.kind, l.text, l.noEol ?? false])).toEqual([
      ["context", "keep", false],
      ["del", "old", true],
      ["add", "new", true]
    ]);
  });

  it("leaves a CRLF file's line endings out of the text", () => {
    const [file] = parsePatch(["diff --git a/win.txt b/win.txt", "--- a/win.txt", "+++ b/win.txt", "@@ -1,2 +1,2 @@", " same\r", "-before\r", "+after\r", ""].join("\n"));
    expect(file.hunks[0].lines.map((l) => l.text)).toEqual(["same", "before", "after"]);
  });

  it("reads names git quotes, and names that are not ASCII", () => {
    expect(unquotePath('"caf\\303\\251 \\"x\\"\\t.txt"')).toBe('café "x"\t.txt');
    expect(unquotePath("plain.txt")).toBe("plain.txt");
    const files = parsePatch(
      [
        'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
        "index 1111111..2222222 100644",
        '--- "a/tab\\there.txt"',
        '+++ "b/tab\\there.txt"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/文档/说明.md b/文档/说明.md",
        "old mode 100644",
        "new mode 100755",
        'diff --git "a/q\\"uote.bin" "b/q\\"uote.bin"',
        "new file mode 100644",
        'Binary files /dev/null and "b/q\\"uote.bin" differ',
        ""
      ].join("\n")
    );
    expect(files.map((f) => f.path)).toEqual(["tab\there.txt", "文档/说明.md", 'q"uote.bin']);
  });

  it("is not misled by changed lines that look like a patch's own headers", () => {
    const [file, ...rest] = parsePatch(
      ["diff --git a/notes.md b/notes.md", "--- a/notes.md", "+++ b/notes.md", "@@ -1,3 +1,3 @@", "--- a/old-heading", "+++ b/new-heading", " diff --git a/x b/x", "-@@ -1 +1 @@", "+@@ -2 +2 @@", ""].join("\n")
    );
    expect(rest).toEqual([]);
    expect(file.path).toBe("notes.md");
    expect(file.hunks[0].lines.map((l) => `${l.kind} ${l.text}`)).toEqual(["del -- a/old-heading", "add ++ b/new-heading", "context diff --git a/x b/x", "del @@ -1 +1 @@", "add @@ -2 +2 @@"]);
  });

  it("stops at a byte limit on a whole line and says the file was cut", () => {
    const patch = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,2 +1,2 @@", "-1", "+one", "-2", "+two", ""].join("\n");
    const [file] = parsePatch(patch, patch.indexOf("-2") + 1);
    expect(file.truncated).toBe(true);
    expect(file.hunks[0].lines.map((l) => l.text)).toEqual(["1", "one"]);
    expect(parsePatch(patch)[0].truncated).toBe(false);
  });

  it("turns a file git does not track into added lines", () => {
    expect(addedFileHunks("")).toEqual([]);
    expect(addedFileHunks("a\r\nb\n")[0]).toMatchObject({ oldLines: 0, newStart: 1, newLines: 2, lines: [{ kind: "add", new: 1, text: "a" }, { kind: "add", new: 2, text: "b" }] });
    expect(addedFileHunks("a\nb")[0].lines.at(-1)).toMatchObject({ text: "b", noEol: true });
  });

  it("reads the file list with renames and binaries", () => {
    const out = [":100644 100644 1111111 2222222 M", "a.ts", ":100644 100644 3333333 4444444 R090", "old.ts", "new.ts", ":000000 100644 0000000 5555555 A", "pic.png", ":100644 000000 6666666 0000000 D", "gone.ts", "3\t1\ta.ts", "2\t2\t", "old.ts", "new.ts", "-\t-\tpic.png", "0\t7\tgone.ts", ""].join("\0");
    expect(parseFileList(out)).toEqual([
      { path: "a.ts", oldPath: null, status: "modified", additions: 3, deletions: 1, binary: false },
      { path: "new.ts", oldPath: "old.ts", status: "renamed", additions: 2, deletions: 2, binary: false },
      { path: "pic.png", oldPath: null, status: "added", additions: null, deletions: null, binary: true },
      { path: "gone.ts", oldPath: null, status: "deleted", additions: 0, deletions: 7, binary: false }
    ]);
  });

  it("knows lockfiles and build output by name", () => {
    expect(["pnpm-lock.yaml", "web/package-lock.json", "yarn.lock", "Cargo.lock", "a/b.min.js", "packages/x/dist/index.js"].map(looksGenerated)).toEqual([true, true, true, true, true, true]);
    expect(["src/lock.ts", "distance.ts", "package.json"].map(looksGenerated)).toEqual([false, false, false]);
  });
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-changes-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const write = (dir: string, file: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const commit = (dir: string, message: string) => {
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir);
};

/** A bare remote with one commit on main, a developer's checkout of it, and a project whose workstream is that repository. */
async function machine() {
  const remote = path.join(fs.mkdtempSync(path.join(root, "remote-")), "app.git");
  fs.mkdirSync(remote, { recursive: true });
  git(["init", "--bare", "-b", "main", "."], remote);
  const checkout = fs.realpathSync(fs.mkdtempSync(path.join(root, "checkout-")));
  git(["init", "-q", "-b", "main"], checkout);
  git(["remote", "add", "origin", remote], checkout);
  git(["config", "user.email", "dev@localhost"], checkout);
  git(["config", "user.name", "Dev"], checkout);
  // A person's own settings must not change what is read.
  git(["config", "diff.noprefix", "true"], checkout);
  write(checkout, "README.md", "# app\n\none\ntwo\nthree\n");
  write(checkout, "package.json", '{ "name": "app" }\n');
  write(checkout, "old-name.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  write(checkout, "win.txt", "one\r\ntwo\r\n");
  write(checkout, ".gitattributes", "gen/** linguist-generated\nwin.txt -text\n");
  commit(checkout, "initial");
  git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);

  const hubDir = fs.mkdtempSync(path.join(root, "hub-"));
  const bag = await fresh({
    hubDir,
    plugins: [[Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount, [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }], Repos, Contributions, [CodeLink, { scanMs: 0 }]]
  });
  await settle();
  await bag.ctx.storage.ready;
  const row = bag.ctx.repos.create({ projectId: bag.project.id, remote });
  bag.boards.update(bag.project.id, bag.board.id, { repoId: row.id });
  await bag.ctx.repos.setCheckout(remote, checkout);
  await settle();
  bag.ctx.codeLink.pulls = async () => null;
  const ticket = (title: string) => bag.items.create({ projectId: bag.project.id, boardId: bag.board.id, title, status: "todo", by: "human" });
  return { ...bag, codeLink: bag.ctx.codeLink, checkout, ticket };
}

const byPath = (files: ChangedFile[]) => new Map(files.map((f) => [f.path, f]));

describe("a ticket's changes, read from git", () => {
  it("answers for the branch, one commit and the working tree, and falls back when a scope is gone", async () => {
    const { codeLink, ctx, project, checkout, ticket } = await machine();
    try {
      const quiet = ticket("Nothing in git yet");
      expect(await codeLink.changes(project.id, quiet.id)).toBeNull();

      const item = ticket("Change many things");
      const branch = `tom-${item.keyNum}/many`;
      git(["checkout", "-q", "-b", branch, "main"], checkout);
      write(checkout, "README.md", "# app\n\none\nTWO\nthree\n");
      write(checkout, "win.txt", "one\r\nzwei\r\n");
      const first = commit(checkout, `${item.key}: reword`);
      git(["mv", "old-name.ts", "new-name.ts"], checkout);
      write(checkout, "new-name.ts", "export const a = 1;\nexport const b = 20;\nexport const c = 3;\n");
      write(checkout, "文档/说 明.md", "你好\n");
      write(checkout, "logo.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
      write(checkout, "pnpm-lock.yaml", "lockfileVersion: 9\n");
      write(checkout, "gen/api.ts", "export {};\n");
      write(checkout, "big.txt", Array.from({ length: 3200 }, (_, i) => `line ${i}`).join("\n") + "\n");
      fs.rmSync(path.join(checkout, "package.json"));
      const second = commit(checkout, `${item.key}: the rest`);
      git(["push", "-q", "origin", branch], checkout);
      await codeLink.scan(project.id);

      const view = (await codeLink.changes(project.id, item.id))!;
      expect(view.scope).toEqual({ kind: "branch" });
      expect(view.links).toEqual([{ id: view.linkId, branch, repoName: expect.any(String) }]);
      expect(view.scopes).toEqual(["branch", "uncommitted", "commit"]);
      expect(view.commits.map((c) => [c.sha, c.subject, c.author])).toEqual([
        [second, `${item.key}: the rest`, "Dev"],
        [first, `${item.key}: reword`, "Dev"]
      ]);
      expect(view.base).toBe(git(["rev-parse", "main"], checkout));
      expect(view.head).toBe(second);
      expect(view.root).toBe(checkout);
      const files = byPath(view.files);
      expect([...files.keys()].sort()).toEqual(["README.md", "big.txt", "gen/api.ts", "logo.bin", "new-name.ts", "package.json", "pnpm-lock.yaml", "win.txt", "文档/说 明.md"].sort());
      expect(files.get("README.md")).toMatchObject({ status: "modified", additions: 1, deletions: 1, generated: false, truncated: false });
      expect(files.get("README.md")!.hunks![0].lines.filter((l) => l.kind !== "context")).toEqual([
        { kind: "del", old: 4, new: null, text: "two" },
        { kind: "add", old: null, new: 4, text: "TWO" }
      ]);
      expect(files.get("win.txt")!.hunks![0].lines.map((l) => l.text)).toEqual(["one", "two", "zwei"]);
      expect(files.get("new-name.ts")).toMatchObject({ status: "renamed", oldPath: "old-name.ts", additions: 1, deletions: 1 });
      expect(files.get("package.json")).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });
      expect(files.get("文档/说 明.md")).toMatchObject({ status: "added", additions: 1 });
      expect(files.get("文档/说 明.md")!.hunks![0].lines[0].text).toBe("你好");
      expect(files.get("logo.bin")).toMatchObject({ status: "added", binary: true, additions: null, deletions: null, hunks: null, truncated: false });
      // Folded until asked for: a lockfile by name, a path .gitattributes marks, a file too long for one answer.
      expect(files.get("pnpm-lock.yaml")).toMatchObject({ generated: true, truncated: true, hunks: null, additions: 1 });
      expect(files.get("gen/api.ts")).toMatchObject({ generated: true, truncated: true, hunks: null });
      expect(files.get("big.txt")).toMatchObject({ generated: false, truncated: true, hunks: null, additions: 3200 });

      const big = (await codeLink.changeFile(project.id, item.id, { path: "big.txt" }))!;
      expect(big).toMatchObject({ status: "added", truncated: false, additions: 3200 });
      expect(big.hunks![0].lines).toHaveLength(3200);
      expect((await codeLink.changeFile(project.id, item.id, { path: "new-name.ts" }))!).toMatchObject({ status: "renamed", oldPath: "old-name.ts" });
      expect((await codeLink.changeFile(project.id, item.id, { path: "pnpm-lock.yaml" }))!.hunks![0].lines[0].text).toBe("lockfileVersion: 9");
      expect(await codeLink.changeFile(project.id, item.id, { path: "untouched.ts" })).toBeNull();

      const one = (await codeLink.changes(project.id, item.id, { scope: { kind: "commit", sha: first.slice(0, 10) } }))!;
      expect(one.scope).toEqual({ kind: "commit", sha: first });
      expect(one.files.map((f) => f.path).sort()).toEqual(["README.md", "win.txt"]);
      expect([one.base, one.head]).toEqual([git(["rev-parse", "main"], checkout), first]);

      // The working tree: a tracked file edited, a new one git does not know, an ignored one it never shows.
      write(checkout, "README.md", "# app\n\none\nTWO\n   three\nfour\n");
      write(checkout, "notes/todo.md", "- [ ] write\n- [ ] ship");
      write(checkout, "raw.dat", Buffer.from([1, 0, 2]));
      write(checkout, ".git/info/exclude", "secret.env\n");
      write(checkout, "secret.env", "KEY=1\n");
      const dirty = (await codeLink.changes(project.id, item.id, { scope: { kind: "uncommitted" } }))!;
      expect(dirty.scope).toEqual({ kind: "uncommitted" });
      expect([dirty.base, dirty.head]).toEqual([second, null]);
      const now = byPath(dirty.files);
      expect([...now.keys()].sort()).toEqual(["README.md", "notes/todo.md", "raw.dat"]);
      expect(now.get("README.md")).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
      expect(now.get("notes/todo.md")).toMatchObject({ status: "added", additions: 2, deletions: 0, truncated: false });
      expect(now.get("notes/todo.md")!.hunks![0].lines.map((l) => [l.new, l.text, l.noEol ?? false])).toEqual([
        [1, "- [ ] write", false],
        [2, "- [ ] ship", true]
      ]);
      expect(now.get("raw.dat")).toMatchObject({ status: "added", binary: true, hunks: null });
      const spaceless = (await codeLink.changes(project.id, item.id, { scope: { kind: "uncommitted" }, ignoreWhitespace: true }))!;
      expect(byPath(spaceless.files).get("README.md")).toMatchObject({ additions: 1, deletions: 0 });
      expect((await codeLink.changeFile(project.id, item.id, { scope: { kind: "uncommitted" }, path: "notes/todo.md" }))!.hunks![0].lines).toHaveLength(2);
      expect(await codeLink.changeFile(project.id, item.id, { scope: { kind: "uncommitted" }, path: "secret.env" })).toBeNull();
      expect(await codeLink.changeFile(project.id, item.id, { scope: { kind: "uncommitted" }, path: "../outside" })).toBeNull();

      // The branch is checked out nowhere: no working tree to show, and asking for it shows the branch.
      for (const file of ["notes", "raw.dat", "secret.env"]) fs.rmSync(path.join(checkout, file), { recursive: true });
      git(["checkout", "-q", "--", "."], checkout);
      git(["checkout", "-q", "main"], checkout);
      const away = (await codeLink.changes(project.id, item.id, { scope: { kind: "uncommitted" } }))!;
      expect(away.scope).toEqual({ kind: "branch" });
      expect(away.scopes).toEqual(["branch", "commit"]);
      expect(away.root).toBeNull();
      expect((await codeLink.changes(project.id, item.id, { scope: { kind: "commit", sha: "0000000" } }))!.scope).toEqual({ kind: "branch" });

      // What the agent's report reads is unchanged by all this.
      expect((await codeLink.deliveryDiff(project.id, item.id))!.patch).toContain("+TWO");
    } finally {
      await ctx.fiber.dispose();
    }
  }, 60_000);

  it("shows a merged branch by its merge, and nothing once git has no trace of the branch", async () => {
    const { codeLink, ctx, project, checkout, ticket } = await machine();
    try {
      const merged = ticket("Land it");
      const branch = `tom-${merged.keyNum}/land`;
      git(["checkout", "-q", "-b", branch, "main"], checkout);
      write(checkout, "landed.ts", "export const landed = true;\n");
      commit(checkout, `${merged.key}: land`);
      git(["push", "-q", "origin", branch], checkout);
      await codeLink.scan(project.id);
      git(["checkout", "-q", "main"], checkout);
      git(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch], checkout);
      git(["push", "-q", "origin", "main", `:${branch}`], checkout);
      git(["branch", "-q", "-D", branch], checkout);
      await codeLink.scan(project.id);
      const mergeSha = codeLink.links(project.id, merged.id)[0].mergedSha!;
      expect(mergeSha).toBeTruthy();
      const view = (await codeLink.changes(project.id, merged.id))!;
      expect([view.base, view.head]).toEqual([git(["rev-parse", `${mergeSha}^1`], checkout), mergeSha]);
      expect(view.files.map((f) => [f.path, f.status])).toEqual([["landed.ts", "added"]]);
      expect(view.scopes).toEqual(["branch", "commit"]);

      const lost = ticket("Thrown away");
      const gone = `tom-${lost.keyNum}/gone`;
      git(["checkout", "-q", "-b", gone, "main"], checkout);
      write(checkout, "wip.ts", "export {};\n");
      commit(checkout, `${lost.key}: wip`);
      git(["push", "-q", "origin", gone], checkout);
      await codeLink.scan(project.id);
      expect((await codeLink.changes(project.id, lost.id))!.files.map((f) => f.path)).toEqual(["wip.ts"]);
      git(["checkout", "-q", "main"], checkout);
      git(["push", "-q", "origin", `:${gone}`], checkout);
      git(["branch", "-q", "-D", gone], checkout);
      expect(await codeLink.changes(project.id, lost.id)).toBeNull();
      expect(await codeLink.changeFile(project.id, lost.id, { path: "wip.ts" })).toBeNull();
    } finally {
      await ctx.fiber.dispose();
    }
  }, 60_000);
});
