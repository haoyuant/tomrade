/**
 * What this machine wrote and has not yet got to where the project is shared:
 * counted from the device's own log, cleared only by a push that landed, kept
 * while the remote cannot be reached.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Storage } from "@tomradex/storage";
import storageGit from "@tomradex/storage-git";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pending-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
let n = 0;
const QUIET = { snapshotIdleMs: 3_600_000, snapshotMaxMs: 3_600_000, watch: false, reconcileMs: 0, remoteFreshMs: 0, remoteRetryMs: 0, autoRestore: false };

async function machine() {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({ hubDir, plugins: [[Storage, QUIET], storageGit] });
  await settle();
  await bag.ctx.storage.ready;
  return { ...bag, storage: bag.ctx.storage };
}

describe("unsynced writes", () => {
  it("counts writes until a push lands them, and keeps counting while the remote is out of reach", async () => {
    const { storage, items, project, board } = await machine();
    // A folder-only project: written to the folder is where it is shared.
    expect(storage.pending(project.id)).toEqual({ count: 0, since: null });
    items.create({ title: "One", projectId: project.id, boardId: board.id, by: "human" });
    expect(storage.pending(project.id)?.count).toBe(1);
    await storage.publish(project.id);
    expect(storage.pending(project.id)?.count).toBe(0);

    const remote = path.join(root, `remote-${n++}.git`);
    fs.mkdirSync(remote);
    git(["init", "--bare", "-b", "main", "."], remote);
    await storage.bind(project.id, "git", { remote, branch: "main" });
    expect(storage.pending(project.id)?.count).toBe(0);

    // The remote goes away: the commit waits, and so does the count.
    fs.renameSync(remote, `${remote}.away`);
    const before = Date.now();
    items.create({ title: "Two", projectId: project.id, boardId: board.id, by: "ai:mcp" });
    await storage.publish(project.id);
    const waiting = storage.pending(project.id)!;
    expect(waiting.count).toBe(1);
    expect(waiting.since).toBeGreaterThanOrEqual(before);
    expect(storage.pendingAll()).toEqual([{ projectId: project.id, name: project.name, count: 1 }]);
    expect(storage.syncSummary(project.id)).toMatchObject({ pending: { count: 1 } });

    fs.renameSync(`${remote}.away`, remote);
    await storage.publish(project.id);
    expect(storage.pending(project.id)?.count).toBe(0);
    expect(storage.pendingAll()).toEqual([]);
    expect(git(["log", "--oneline", "main"], remote)).not.toBe("");
  });
});
