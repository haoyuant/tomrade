/**
 * Two whole machines, each its own device, sharing one project: its folder on one remote and its Files on another.
 * Whatever both do, they come to agree, and then every sync on either stays quiet: no commit on either remote.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import storageGit from "@tomradex/storage-git";
import { Files, createGitBackend } from "@tomradex/files";
import { Contributions } from "@tomradex/contributions";
import { Inbox } from "@tomradex/inbox";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-two-machines-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

function bareRemote(): string {
  const dir = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "--bare", "-b", "main", "."], dir);
  return dir;
}

/** A Files destination that is any git repository by its path, as a self-hosted one is. */
const folderBackend = createGitBackend({
  id: "folder",
  title: "A folder",
  configSchema: z.object({ path: z.string().min(1), directory: z.string().default(""), branch: z.string().default("main") }),
  defaults: { path: "", directory: "", branch: "main" },
  remote: (c) => ({ url: c.path, branch: c.branch, directory: c.directory })
});

async function machine(device: string) {
  const hubDir = path.join(root, `${device}-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({
    hubDir,
    device,
    plugins: [
      [Settings, { path: path.join(hubDir, "settings.json") }],
      // No timers: the test syncs by hand, so every commit on a remote is one of its own rounds.
      [Storage, { snapshotIdleMs: 3_600_000, snapshotMaxMs: 3_600_000, watch: false, reconcileMs: 0, remoteFreshMs: 0, remoteRetryMs: 0 }],
      storageGit,
      [Files, { watch: false, autoSyncMs: 0, pushMs: 3_600_000 }],
      Contributions,
      [Inbox, { pullMs: 3_600_000 }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  bag.ctx.plugin({ name: "folder-backend", inject: ["files"], apply: (c) => void c.files.register(folderBackend) });
  await settle();
  return { ...bag, storage: bag.ctx.storage };
}

type Machine = Awaited<ReturnType<typeof machine>>;

describe("two machines sharing a project's folder and its files", () => {
  it("agree whatever both did, and then no sync on either commits anything", async () => {
    const a = await machine("machine-a");
    const id = a.project.id;
    const projectRemote = bareRemote();
    const filesRemote = bareRemote();
    const shared = a.items.create({ title: "Shared", projectId: id, boardId: a.board.id, by: "human" });
    const other = a.items.create({ title: "Other", projectId: id, boardId: a.board.id, by: "human" });
    await a.ctx.files.write(id, "Specs/brief.md", "# Brief\n");
    await a.ctx.files.write(id, "Specs/plan.md", "# Plan\n");
    a.ctx.inbox.add(id, "feedback", [
      { externalId: "f1", kind: "bug", title: "It crashes", body: "", receivedAt: Date.now() - 60_000 },
      { externalId: "f2", kind: "feature", title: "Dark mode", body: "", receivedAt: Date.now() - 30_000 }
    ]);
    // The project was made before the inbox loaded, so its namespace is ticked by hand, as in its storage settings.
    await a.storage.setExports(id, ["inbox"]);
    await a.storage.bind(id, "git", { remote: projectRemote, branch: "main" });
    expect((await a.ctx.files.bind(id, "folder", { path: filesRemote })).state).toBe("synced");
    await a.storage.sync(id);

    // The second machine takes the project from its remote; the Files binding travels with it.
    const b = await machine("machine-b");
    expect(await b.storage.attachRemote("git", { remote: projectRemote, branch: "main" })).toBe(id);
    expect((await b.ctx.files.sync(id)).state).toBe("synced");
    expect((await b.ctx.files.read(id, "Specs/brief.md"))?.body).toBe("# Brief\n");

    // Both work before hearing of the other: the same ticket, a ticket each, neighbouring files and one file each.
    a.items.update(id, shared.id, { status: "doing" }, "human");
    b.items.update(id, shared.id, { priority: 3 }, "human");
    a.items.create({ title: "From A", projectId: id, boardId: shared.boardId, by: "human" });
    b.items.create({ title: "From B", projectId: id, boardId: shared.boardId, by: "human" });
    b.items.update(id, other.id, { title: "Other, renamed on B" }, "human");
    await a.ctx.files.write(id, "Specs/brief.md", "# Brief\nFrom A.\n");
    await b.ctx.files.write(id, "Specs/plan.md", "# Plan\nFrom B.\n");
    await a.ctx.files.write(id, "Notes/a.md", "a\n");
    await b.ctx.files.write(id, "Notes/b.md", "b\n");
    // The inbox too: one triaged on B while A hears of new feedback.
    await b.ctx.inbox.close(id, b.ctx.inbox.list(id).find((e) => e.externalId === "f1")!.id, "wontfix");
    a.ctx.inbox.add(id, "feedback", [{ externalId: "f3", kind: "question", title: "How do I export?", body: "", receivedAt: Date.now() }]);

    const round = async (m: Machine) => {
      await m.storage.sync(id);
      await m.ctx.files.sync(id);
    };
    for (let i = 0; i < 3; i++) for (const m of [a, b]) await round(m);

    const backlog = (m: Machine) =>
      m.items
        .list({ projectId: id })
        .map((i) => ({ id: i.id, title: i.title, status: i.status, priority: i.priority, key: i.keyNum }))
        .sort((x, y) => x.id.localeCompare(y.id));
    const files = async (m: Machine) => {
      const paths = (await m.ctx.files.tree(id)).filter((e) => e.kind === "file").map((e) => e.path).sort();
      return Promise.all(paths.map(async (p) => [p, (await m.ctx.files.read(id, p))?.body]));
    };
    const inbox = (m: Machine) => m.ctx.inbox.list(id, "all").map((e) => [e.externalId, e.status]).sort();
    expect(backlog(b)).toEqual(backlog(a));
    expect(inbox(b)).toEqual(inbox(a));
    expect(inbox(a)).toEqual([["f1", "closed"], ["f2", "new"], ["f3", "new"]]);
    expect(await files(b)).toEqual(await files(a));
    expect(a.items.get(id, shared.id)).toMatchObject({ status: "doing", priority: 3 });
    expect(a.items.get(id, other.id)?.title).toBe("Other, renamed on B");
    expect(new Set(backlog(a).map((i) => i.key)).size).toBe(backlog(a).length);
    expect(await files(a)).toEqual([
      ["Notes/a.md", "a\n"],
      ["Notes/b.md", "b\n"],
      ["Specs/brief.md", "# Brief\nFrom A.\n"],
      ["Specs/plan.md", "# Plan\nFrom B.\n"]
    ]);
    for (const m of [a, b]) {
      expect((await m.storage.statusFor(id)).state).toBe("synced");
      expect((await m.ctx.files.status(id)).state).toBe("synced");
    }

    // Settled: every kind of sync, on both, again and again, and neither remote moves.
    const commits = () => [git(["rev-list", "--count", "main"], projectRemote), git(["rev-list", "--count", "main"], filesRemote)];
    const settled = commits();
    for (let i = 0; i < 3; i++) {
      for (const m of [a, b]) {
        await m.storage.sync(id);
        await m.storage.reconcile(id);
        await m.ctx.files.sync(id);
        await m.ctx.files.syncAll();
      }
    }
    expect(commits()).toEqual(settled);
    for (const m of [a, b]) {
      expect(m.storage.pending(id)?.count).toBe(0);
      expect((await m.storage.statusFor(id)).state).toBe("synced");
      expect((await m.ctx.files.status(id)).state).toBe("synced");
    }
    await a.ctx.fiber.dispose();
    await b.ctx.fiber.dispose();
  }, 120_000);
});
