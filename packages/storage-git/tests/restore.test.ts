/**
 * A new machine signs in and every project the Hub names comes back without
 * being asked: cloned from its remote, or adopted from a copy already on disk.
 * What cannot come back yet says why, and nothing half-made is ever left where
 * a project would be looked for.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import { ARTIFACT_DIR, ForeignProjectError, Storage, digestState, readArtifact, readClone, readHubManifest, writeArtifact, writeHubManifest, type HubProject } from "@tomradex/storage";
import storageGit from "@tomradex/storage-git";
import { Onboarding } from "@tomradex/onboarding";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-restore-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
function bareRemote(): string {
  const dir = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "--bare", "-b", "main", "."], dir);
  return dir;
}

const QUIET = { snapshotIdleMs: 3_600_000, snapshotMaxMs: 3_600_000, watch: false, reconcileMs: 0, autoRestore: false };

async function machine(label: string, storage: Record<string, unknown> = {}) {
  const hubDir = path.join(root, `${label}-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({ hubDir, plugins: [[Storage, { ...QUIET, ...storage }], storageGit] });
  await settle();
  await bag.ctx.storage.ready;
  return { ...bag, storage: bag.ctx.storage, hubDir, dir: bag.hub.catalog.project(bag.project.id)!.dir! };
}

const record = (id: string, patch: Partial<HubProject> = {}): HubProject => ({ id, name: `Project ${id}`, keyPrefix: "PRJ", remote: null, hint: null, updatedAt: 1, ...patch });
const viaGit = (remote: string) => ({ provider: "git", config: { remote, branch: "main" } });

/** What the account's catalog would hand this machine. */
const names = (hubDir: string, ...projects: HubProject[]) => writeHubManifest(hubDir, { v: 1, projects, repos: [], removed: [] });

const staged = (hubDir: string) => fs.readdirSync(path.join(hubDir, "projects")).filter((name) => name.startsWith("."));

describe("restoring the projects the Hub names", () => {
  it("brings every project back unprompted, and the untouched first-run project makes way", async () => {
    const a = await machine("a");
    const remote = bareRemote();
    a.items.create({ title: "Survives the move", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });

    const b = await machine("b", { autoRestore: true });
    expect(b.hub.catalog.project(b.project.id)?.seed).toBe(true);
    names(b.hubDir, record(a.project.id, { name: a.project.name, remote: viaGit(remote) }));
    expect(await b.storage.restoreMissing()).toEqual([a.project.id]);

    expect(b.items.list({ projectId: a.project.id }).map((i) => i.title)).toEqual(["Survives the move"]);
    const entry = b.hub.catalog.project(a.project.id)!;
    expect(entry).toMatchObject({ git: "dedicated", remote: viaGit(remote) });
    expect(git(["remote", "get-url", "origin"], entry.dir!)).toBe(remote);
    // The placeholder is gone, folder and all, and never reached the catalog.
    expect(b.projects.list().map((p) => p.id)).toEqual([a.project.id]);
    expect(fs.existsSync(b.dir)).toBe(false);
    await b.storage.writeHub();
    expect(readHubManifest(b.hubDir)!.projects.map((p) => p.id)).toEqual([a.project.id]);
    expect(b.storage.restores()).toEqual({ entries: [], restored: 1 });
    expect(staged(b.hubDir)).toEqual([]);
  });

  it("the untouched sample project makes way too, but a used one stays, still out of the catalog", async () => {
    const a = await machine("a");
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });

    const hubDir = path.join(root, `sample-${n++}`);
    fs.mkdirSync(hubDir, { recursive: true });
    const b = await fresh({ hubDir, firstRun: "none", plugins: [[Storage, { ...QUIET, autoRestore: true }], storageGit, Onboarding] });
    await settle();
    await b.ctx.storage.ready;
    expect(b.project.sample).toBe(true);
    names(hubDir, record(a.project.id, { name: a.project.name, remote: viaGit(remote) }));
    expect(await b.ctx.storage.restoreMissing()).toEqual([a.project.id]);
    expect(b.projects.list().map((p) => p.id)).toEqual([a.project.id]);

    const c = await fresh({ hubDir: path.join(root, `sample-${n++}`), firstRun: "none", plugins: [[Storage, { ...QUIET, autoRestore: true }], storageGit, Onboarding] });
    await settle();
    await c.ctx.storage.ready;
    c.items.update(c.project.id, c.items.list({ projectId: c.project.id })[0].id, { status: "done" }, "human");
    names(c.hub.dir!, record(a.project.id, { name: a.project.name, remote: viaGit(remote) }));
    expect(await c.ctx.storage.restoreMissing()).toEqual([a.project.id]);
    expect(c.projects.list().map((p) => p.id).sort()).toEqual([a.project.id, c.project.id].sort());
    await c.ctx.storage.writeHub();
    expect(readHubManifest(c.hub.dir!)!.projects.map((p) => p.id)).toEqual([a.project.id]);
  });

  it("says why a project cannot come back yet, and leaves nothing half-made", async () => {
    const b = await machine("why");
    const empty = bareRemote();
    names(
      b.hubDir,
      record("never", { hint: "github.com/acme/app · main" }),
      record("empty", { remote: viaGit(empty) }),
      record("gone", { remote: viaGit(path.join(root, "missing.git")) }),
      record("down", { remote: viaGit("http://127.0.0.1:9/project.git") }),
      record("plugin", { remote: { provider: "gitlab", config: {} } })
    );
    expect(await b.storage.attachAll()).toEqual([]);
    const by = Object.fromEntries(b.storage.restores().entries.map((e) => [e.projectId, e]));
    expect(by.never).toMatchObject({ state: "not-backed-up", hint: "github.com/acme/app · main", provider: null });
    expect(by.empty).toMatchObject({ state: "unpublished", provider: { id: "git" } });
    expect(by.empty.location).toContain("main");
    expect(by.gone).toMatchObject({ state: "failed" });
    expect(by.gone.detail).toMatch(/No access/);
    expect(by.down).toMatchObject({ state: "offline" });
    expect(by.plugin).toMatchObject({ state: "needs-provider", provider: { id: "gitlab", title: "gitlab" } });
    expect(b.hub.catalog.projects().map((p) => p.id)).toEqual([b.project.id]);
    expect(staged(b.hubDir)).toEqual([]);
    // The manual path words it the same way.
    await expect(b.storage.attachRemote("git", { remote: empty, branch: "main" })).rejects.toThrow(/Nothing has been published/);
    expect(staged(b.hubDir)).toEqual([]);
  });

  it("comes back once the machine that has it publishes", async () => {
    const a = await machine("late-a");
    const remote = bareRemote();
    a.items.create({ title: "Published late", projectId: a.project.id, boardId: a.board.id, by: "human" });
    const b = await machine("late-b");
    names(b.hubDir, record(a.project.id, { remote: viaGit(remote) }));
    await b.storage.attachAll();
    expect(b.storage.restores().entries[0].state).toBe("unpublished");

    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    expect(await b.storage.attachAll()).toEqual([a.project.id]);
    expect(b.items.list({ projectId: a.project.id }).map((i) => i.title)).toEqual(["Published late"]);
  });

  it("adopts a copy already on disk instead of cloning again, and settles it with the remote", async () => {
    const a = await machine("disk-a");
    const remote = bareRemote();
    const item = a.items.create({ title: "Before", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });

    const b = await machine("disk-b");
    const leftover = path.join(b.hubDir, "projects", "from-an-earlier-install");
    fs.cpSync(a.dir, leftover, { recursive: true });
    a.items.update(a.project.id, item.id, { title: "After" }, "human");
    await a.storage.publish(a.project.id);

    names(b.hubDir, record(a.project.id, { remote: viaGit(remote) }));
    expect(await b.storage.attachAll()).toEqual([a.project.id]);
    expect(b.hub.catalog.project(a.project.id)!.dir).toBe(leftover);
    expect(b.items.get(a.project.id, item.id)?.title).toBe("After");
    expect(fs.readdirSync(path.join(b.hubDir, "projects"))).toEqual(["from-an-earlier-install"]);
  });

  it("opens the folder the person points at for a project with no remote, and refuses another project's", async () => {
    const a = await machine("loc-a");
    a.items.create({ title: "Only here", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.publish(a.project.id);
    const other = await machine("loc-other");

    const b = await machine("loc-b");
    names(b.hubDir, record(a.project.id));
    await b.storage.attachAll();
    expect(b.storage.restores().entries[0].state).toBe("not-backed-up");
    await expect(b.storage.locate(a.project.id, other.dir)).rejects.toThrow(ForeignProjectError);
    expect(await b.storage.locate(a.project.id, a.dir)).toBe(a.project.id);
    expect(b.items.list({ projectId: a.project.id }).map((i) => i.title)).toEqual(["Only here"]);
    expect(b.storage.restores().entries).toEqual([]);
  });

  it("takes a project nobody can find out of the Hub, for good, and deletes nothing", async () => {
    const b = await machine("forget");
    names(b.hubDir, record("lost-sketches", { name: "Old sketches" }));
    await b.storage.attachAll();
    expect(b.storage.restores().entries.map((e) => e.state)).toEqual(["not-backed-up"]);
    expect(b.storage.removeFromHub("lost-sketches")).toEqual({ entries: [], restored: 0 });
    await b.storage.writeHub();
    const manifest = readHubManifest(b.hubDir)!;
    expect(manifest.projects.map((p) => p.id)).not.toContain("lost-sketches");
    expect(manifest.removed.map((r) => r.id)).toContain("lost-sketches");
    expect(await b.storage.attachAll()).toEqual([]);
    expect(b.storage.restores().entries).toEqual([]);
    // Only what the Hub names and this machine lacks can be taken out this way.
    expect(() => b.storage.removeFromHub(b.project.id)).toThrow(/on this machine/);
    expect(b.projects.get(b.project.id)).not.toBeNull();
  });

  it("never brings back a project removed on this machine", async () => {
    const a = await machine("rm-a");
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    const b = await machine("rm-b", { autoRestore: true });
    names(b.hubDir, record(a.project.id, { remote: viaGit(remote) }));
    expect(await b.storage.restoreMissing()).toEqual([a.project.id]);
    b.projects.remove(a.project.id);
    expect(await b.storage.restoreMissing()).toEqual([]);
    expect(b.hub.catalog.project(a.project.id)).toBeNull();
    expect(b.storage.restores().entries).toEqual([]);
  });

  it("waits for the destination's account, and goes on by itself once it is connected", async () => {
    const a = await machine("acct-a");
    const remote = bareRemote();
    a.items.create({ title: "Private", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });

    const b = await machine("acct-b", { autoRestore: true });
    let token = "";
    b.storage.register({
      id: "vault",
      title: "Vault",
      configSchema: z.object({ name: z.string() }),
      defaults: { name: "" },
      // Without the account the host answers as if the repository were not there, like GitHub does.
      toRemote: () => ({ url: token ? remote : path.join(root, "locked.git"), branch: "main" }),
      connection: {
        prompt: { label: "Token" },
        status: async () => ({ connected: token !== "" }),
        connect: async (secret) => {
          token = secret;
          return { connected: true, label: "@me" };
        },
        disconnect: async () => {
          token = "";
        }
      }
    });
    names(b.hubDir, record(a.project.id, { remote: { provider: "vault", config: { name: "backlog" } } }));
    await b.storage.restoreMissing();
    expect(b.storage.restores().entries[0]).toMatchObject({ state: "needs-connection", provider: { id: "vault", title: "Vault" } });

    await b.storage.connect("vault", "secret");
    expect(await b.storage.restoreMissing()).toEqual([a.project.id]);
    expect(b.items.list({ projectId: a.project.id }).map((i) => i.title)).toEqual(["Private"]);
  });
});

describe("what reaches the backup", () => {
  const FILES_BINDING = "plugins/files/plugin_files_remotes.jsonl";

  it("commits a plugin namespace called files: only the Files store itself is kept out of git", async () => {
    const a = await machine("ns-files");
    a.ctx.db.migrate("files", [{ version: 1, up: "CREATE TABLE plugin_files_remotes (project_id TEXT PRIMARY KEY, backend TEXT NOT NULL)" }], {
      tables: { plugin_files_remotes: { project: "project_id", export: { order: "project_id", always: true } } }
    });
    a.dbFor(a.project.id).prepare("INSERT INTO plugin_files_remotes (project_id, backend) VALUES (?, 'github')").run(a.project.id);
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    expect(git(["show", `main:${ARTIFACT_DIR}/${FILES_BINDING}`], remote)).toContain("github");
    expect(git(["show", `main:${ARTIFACT_DIR}/.gitignore`], remote)).toMatch(/^\/files\/$/m);
  });

  /** A "files" table like the Files plugin's, so the binding travels the way it does in the app. */
  const withFilesTable = (bag: Awaited<ReturnType<typeof machine>>) =>
    bag.ctx.db.migrate("files", [{ version: 1, up: "CREATE TABLE plugin_files_remotes (project_id TEXT PRIMARY KEY, backend TEXT NOT NULL)" }], {
      tables: { plugin_files_remotes: { project: "project_id", export: { order: "project_id", always: true } } }
    });
  const bindingOf = (bag: Awaited<ReturnType<typeof machine>>, projectId: string) =>
    (bag.dbFor(projectId).prepare("SELECT backend FROM plugin_files_remotes").all() as { backend: string }[]).map((r) => r.backend);

  /** What every backup made before the fix looks like: the digest counts plugins/files/, git never received it. */
  function pushedShort(remote: string): void {
    const work = path.join(root, `short-work-${n++}`);
    git(["clone", "-q", "--branch", "main", remote, work], root);
    git(["config", "user.email", "old@localhost"], work);
    git(["config", "user.name", "Old"], work);
    fs.writeFileSync(path.join(work, ARTIFACT_DIR, ".gitignore"), "*.tmp\nfiles/\n");
    git(["rm", "-r", "-q", "--cached", `${ARTIFACT_DIR}/plugins/files`], work);
    git(["commit", "-q", "-am", "as the old build pushed it"], work);
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], work);
  }

  it("restores a backup whose empty Files binding never reached git, and writes nothing to the remote", async () => {
    const a = await machine("short-a");
    withFilesTable(a);
    a.items.create({ title: "Kept", projectId: a.project.id, boardId: a.board.id, by: "human" });
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    pushedShort(remote);
    const head = git(["rev-parse", "main"], remote);

    const b = await machine("short-b");
    withFilesTable(b);
    names(b.hubDir, record(a.project.id, { remote: viaGit(remote) }));
    expect(await b.storage.attachAll()).toEqual([a.project.id]);
    expect(b.items.list({ projectId: a.project.id }).map((i) => i.title)).toEqual(["Kept"]);
    const entry = b.hub.catalog.project(a.project.id)!;
    expect(entry.withheld).toEqual([]);
    expect(readArtifact(entry.dir!)).not.toBeNull();
    expect((await b.storage.statusFor(a.project.id)).state).toBe("synced");
    expect(git(["rev-parse", "main"], remote)).toBe(head);
  });

  it("withholds a Files binding it could not read, so nothing here erases it on the machine that has it", async () => {
    const a = await machine("held-a");
    withFilesTable(a);
    a.dbFor(a.project.id).prepare("INSERT INTO plugin_files_remotes (project_id, backend) VALUES (?, 'github')").run(a.project.id);
    const item = a.items.create({ title: "Shared", projectId: a.project.id, boardId: a.board.id, by: "human" });
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "git", { remote, branch: "main" });
    pushedShort(remote);
    await a.storage.sync(a.project.id);
    const head = git(["rev-parse", "main"], remote);

    const b = await machine("held-b");
    withFilesTable(b);
    names(b.hubDir, record(a.project.id, { remote: viaGit(remote) }));
    expect(await b.storage.attachAll()).toEqual([a.project.id]);
    expect(b.hub.catalog.project(a.project.id)!.withheld).toEqual(["files/plugin_files_remotes"]);
    expect(git(["rev-parse", "main"], remote)).toBe(head);

    // An edit here travels without a binding of this machine's making…
    b.items.update(a.project.id, item.id, { title: "Edited on the new machine" }, "human");
    await b.storage.publish(a.project.id);
    expect(git(["ls-tree", "-r", "--name-only", "main"], remote)).not.toContain(`${ARTIFACT_DIR}/plugins/files/plugin_files_remotes.jsonl`);
    // …so the machine that has the binding takes the edit and keeps it,
    await a.storage.sync(a.project.id);
    expect(a.items.get(a.project.id, item.id)?.title).toBe("Edited on the new machine");
    expect(bindingOf(a, a.project.id)).toEqual(["github"]);
    // and once it publishes with the anchored .gitignore, the binding reaches the new machine too.
    expect(git(["show", `main:${ARTIFACT_DIR}/plugins/files/plugin_files_remotes.jsonl`], remote)).toContain("github");
    await b.storage.sync(a.project.id);
    expect(bindingOf(b, a.project.id)).toEqual(["github"]);
    expect(b.hub.catalog.project(a.project.id)!.withheld).toEqual([]);
  });
});
