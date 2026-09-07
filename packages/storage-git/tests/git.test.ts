/**
 * Against a real bare repository, because the whole point of this provider is
 * that git does the moving: clone into userData, commit only our subtree,
 * fast-forward in, and refuse a push that would overwrite someone's work.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomrade/testkit";
import { Storage, exportState, readArtifact, writeArtifact } from "@tomrade/storage";
import storageGit from "@tomrade/storage-git";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-git-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

let n = 0;
function bareRemote(): string {
  const dir = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "--bare", "-b", "main", "."], dir);
  return dir;
}

async function machine(label: string) {
  const home = path.join(root, `${label}-${n++}`);
  fs.mkdirSync(home, { recursive: true });
  const bag = await fresh({
    plugins: [
      [Storage, { path: path.join(home, "storage.json"), debounceMs: 60_000, reconcileMs: 0 }],
      [storageGit, { root: path.join(home, "remotes") }]
    ]
  });
  await settle();
  return { ...bag, storage: bag.ctx.storage, home };
}

/** A teammate: clone the same remote, edit the artifact as text, push. */
function teammateEdits(remote: string, edit: (dir: string) => void): void {
  const work = path.join(root, `mate-${n++}`);
  git(["clone", "--branch", "main", remote, work], root);
  git(["config", "user.email", "mate@localhost"], work);
  git(["config", "user.name", "Mate"], work);
  edit(work);
  git(["add", "--", ".tomrade"], work);
  git(["commit", "-m", "teammate"], work);
  git(["push", "origin", "HEAD:refs/heads/main"], work);
}

describe("a git repository as a destination", () => {
  it("registers a provider whose config holds no secrets", async () => {
    const { storage } = await machine("providers");
    const git_ = storage.describe().find((p) => p.id === "git");
    expect(git_).toBeDefined();
    expect(Object.keys((git_!.schema as { properties: Record<string, unknown> }).properties)).toEqual(["remote", "branch", "path"]);
  });

  it("publishes into an empty repository, and a second machine attaches it", async () => {
    const remote = bareRemote();
    const a = await machine("a");
    const shared = a.projects.create({ name: "Shared", keyPrefix: "SHR" });
    a.items.create({ title: "Written on A", projectId: shared.id, boardId: a.boards.defaultFor(shared.id).id, by: "human" });

    expect(await a.storage.bind(shared.id, "git", { remote, branch: "main", path: "" })).toMatchObject({ state: "synced" });

    // It really is in the repository, as text.
    const check = path.join(root, `check-${n++}`);
    git(["clone", "--branch", "main", remote, check], root);
    expect(fs.existsSync(path.join(check, ".tomrade", "project.json"))).toBe(true);
    expect(fs.readFileSync(path.join(check, ".tomrade", "state", "items.jsonl"), "utf8")).toMatch(/Written on A/);
    expect(fs.existsSync(path.join(check, ".tomrade", "state", "project.db"))).toBe(false);

    const b = await machine("b");
    expect(await b.storage.attach("git", { remote, branch: "main", path: "" })).toBe(shared.id);
    expect(b.items.list({ projectId: shared.id }).map((i) => i.key)).toEqual(["SHR-1"]);
    expect(b.projects.get(shared.id)?.keyPrefix).toBe("SHR");
  });

  it("commits only its own subtree, leaving the rest of the repository alone", async () => {
    const remote = bareRemote();
    // Someone's code repository, with the backlog in a subdirectory.
    const seed = path.join(root, `seed-${n++}`);
    // An empty repository has no named branch to clone yet.
    git(["clone", remote, seed], root);
    fs.writeFileSync(path.join(seed, "README.md"), "# code\n");
    git(["add", "README.md"], seed);
    git(["commit", "-m", "code"], seed);
    git(["push", "origin", "HEAD:refs/heads/main"], seed);

    const a = await machine("subdir");
    await a.storage.bind(a.project.id, "git", { remote, branch: "main", path: "docs" });

    const check = path.join(root, `check-${n++}`);
    git(["clone", "--branch", "main", remote, check], root);
    expect(fs.existsSync(path.join(check, "docs", ".tomrade", "project.json"))).toBe(true);
    expect(fs.readFileSync(path.join(check, "README.md"), "utf8")).toBe("# code\n");
  });

  it("fast-forwards a teammate's push in, and publishes nothing when nothing changed", async () => {
    const remote = bareRemote();
    const a = await machine("ff");
    await a.storage.bind(a.project.id, "git", { remote, branch: "main", path: "" });
    const first = await a.storage.statusFor(a.project.id);
    expect(first.state).toBe("synced");

    // An unchanged project must not make a commit.
    const before = git(["rev-list", "--count", "main"], remote).trim();
    expect(await a.storage.flush(a.project.id)).toMatchObject({ state: "synced" });
    expect(git(["rev-list", "--count", "main"], remote).trim()).toBe(before);

    teammateEdits(remote, (dir) => {
      const state = readArtifact(dir)!;
      state.tables.labels.push({ id: "their-label", project_id: a.project.id, name: "from-mate" });
      writeArtifact(dir, state);
    });

    expect((await a.storage.statusFor(a.project.id)).state).toBe("behind");
    expect(await a.storage.refresh(a.project.id)).toMatchObject({ state: "synced" });
    expect(a.items.labelsFor(a.project.id)).toContain("from-mate");
  });

  it("refuses to publish over a teammate's commits", async () => {
    const remote = bareRemote();
    const a = await machine("diverge");
    await a.storage.bind(a.project.id, "git", { remote, branch: "main", path: "" });

    teammateEdits(remote, (dir) => {
      const state = readArtifact(dir)!;
      state.tables.labels.push({ id: "their-label", project_id: a.project.id, name: "theirs" });
      writeArtifact(dir, state);
    });
    a.items.create({ title: "mine", projectId: a.project.id, boardId: a.board.id, by: "human" });

    await expect(a.storage.flush(a.project.id)).rejects.toThrow(/moved on|not seen|resolve/i);
    // Neither side lost anything.
    expect(a.items.list({ projectId: a.project.id }).some((i) => i.title === "mine")).toBe(true);
    const check = path.join(root, `check-${n++}`);
    git(["clone", "--branch", "main", remote, check], root);
    expect(readArtifact(check)!.tables.labels.some((l) => l.name === "theirs")).toBe(true);
  });

  it("reports offline for a remote that is not there, rather than throwing", async () => {
    const a = await machine("offline");
    await expect(a.storage.bind(a.project.id, "git", { remote: path.join(root, "nope.git"), branch: "main", path: "" })).rejects.toThrow();
    // The failed bind left nothing behind.
    expect(a.storage.binding(a.project.id)).toBeNull();
    expect(await a.storage.statusFor(a.project.id)).toMatchObject({ state: "local" });
  });

  it("exports the same bytes whichever machine wrote them", async () => {
    const remote = bareRemote();
    const a = await machine("bytes-a");
    const shared = a.projects.create({ name: "Bytes", keyPrefix: "BYT" });
    a.items.create({ title: "one", projectId: shared.id, boardId: a.boards.defaultFor(shared.id).id, by: "human" });
    await a.storage.bind(shared.id, "git", { remote, branch: "main", path: "" });

    const b = await machine("bytes-b");
    await b.storage.attach("git", { remote, branch: "main", path: "" });
    expect(exportState(b.dbFor(shared.id), shared.id)).toEqual(exportState(a.dbFor(shared.id), shared.id));
  });
});
