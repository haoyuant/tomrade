import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service } from "cordis";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { Tools } from "@tomradex/tools";
import { Contributions } from "@tomradex/contributions";
import { Files } from "@tomradex/files";

class FakeIpc extends Service {
  static provide = "ipc";
  sent: unknown[][] = [];
  handle() {
    return () => {};
  }
  send(channel: string, ...args: unknown[]) {
    this.sent.push([channel, ...args]);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-files-paths-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function boot(name: string, gitBinary?: string) {
  const hubDir = path.join(root, name);
  fs.mkdirSync(hubDir, { recursive: true });
  const world = await fresh({
    hubDir,
    plugins: [
      FakeIpc,
      [Settings, { path: path.join(hubDir, "settings.json") }],
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      Tools,
      Contributions,
      [Files, { watch: false, autoSyncMs: 0, ...(gitBinary ? { gitBinary } : {}) }]
    ]
  });
  await settle();
  await world.ctx.storage.ready;
  const ipc = world.ctx.get("ipc") as unknown as FakeIpc;
  const changed = () => ipc.sent.filter(([channel, projectId]) => channel === "files.changed" && projectId === world.project.id).map(([, , paths]) => paths ?? null);
  return { ...world, ipc, changed };
}

describe.skipIf(process.platform === "win32")("a change to a project's files names the paths it touched", { timeout: 30_000 }, () => {
  for (const [label, git] of [["in a folder without git", path.join(root, "no", "git")], ["in a git store", undefined]] as const) {
    it(label, async () => {
      const { ctx, project, ipc, changed } = await boot(label.replace(/\W+/g, "-"), git);
      try {
        await ctx.files.write(project.id, "docs/plan.md", "# Plan\n");
        await ctx.files.mkdir(project.id, "empty");
        await ctx.files.copy(project.id, "docs/plan.md", "docs/copy.md");
        await ctx.files.move(project.id, "docs/copy.md", "notes.md");
        await ctx.files.remove(project.id, "empty");
        // No broadcast leaves the paths out: a window keeps what it read of every other file.
        expect(changed().every((paths) => Array.isArray(paths))).toBe(true);
        expect(new Set(changed().flat())).toEqual(new Set(["docs/plan.md", "empty", "docs/copy.md", "notes.md"]));
        ipc.sent.length = 0;
        await ctx.files.sync(project.id);
        expect(changed().every((paths) => paths === null)).toBe(true);
      } finally {
        await ctx.fiber.dispose();
      }
    });
  }
});
