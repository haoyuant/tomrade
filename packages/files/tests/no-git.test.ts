import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakeProgram, fresh, settle } from "@tomradex/testkit";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { Tools } from "@tomradex/tools";
import { Contributions } from "@tomradex/contributions";
import { Files } from "@tomradex/files";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-files-nogit-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("files on a machine without git", { timeout: 30_000 }, () => {
  it("work as a plain folder, then keep the same files as versions once git is installed", async () => {
    const hubDir = path.join(root, "hub");
    fs.mkdirSync(hubDir, { recursive: true });
    // Absent until the test "installs" it.
    const gitBinary = path.join(root, "bin", "git");
    const { ctx, items, project, board } = await fresh({
      hubDir,
      plugins: [
        [Settings, { path: path.join(hubDir, "settings.json") }],
        [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
        Tools,
        Contributions,
        [Files, { watch: false, autoSyncMs: 0, gitBinary }]
      ]
    });
    await settle();
    await ctx.storage.ready;
    try {
      const status = await ctx.files.status(project.id);
      expect(status).toMatchObject({ state: "local", versionless: true });
      expect(status.detail).toMatch(/git/);

      const saved = await ctx.files.write(project.id, "docs/plan.md", "# Plan\nship it\n");
      expect(saved).toMatchObject({ body: "# Plan\nship it\n", fileId: null, versionId: null });
      await ctx.files.mkdir(project.id, "empty");
      await ctx.files.copy(project.id, "docs/plan.md", "docs/copy.md");
      await ctx.files.move(project.id, "docs/copy.md", "notes.md");
      await ctx.files.remove(project.id, "empty");
      expect((await ctx.files.tree(project.id)).map((e) => e.path)).toEqual(["docs", "docs/plan.md", "notes.md"]);
      expect((await ctx.files.search(project.id, { queries: ["ship"], max: 10 })).hits.map((h) => h.path)).toEqual(["docs/plan.md", "notes.md"]);

      const dir = ctx.files.dirFor(project.id)!;
      expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
      const ticket = items.create({ projectId: project.id, boardId: board.id, title: "Use the plan", workType: "general", by: "human" });
      await expect(ctx.files.attach(project.id, ticket.id, { path: "docs/plan.md", role: "input" })).rejects.toThrow(/git/);

      fs.mkdirSync(path.dirname(gitBinary), { recursive: true });
      fakeProgram(gitBinary, '#!/bin/sh\nexec git "$@"\n');
      const after = await ctx.files.sync(project.id);
      expect(after.state).toBe("local");
      expect(after.versionless).toBeUndefined();
      expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
      const kept = await ctx.files.read(project.id, "docs/plan.md");
      expect(kept).toMatchObject({ body: "# Plan\nship it\n" });
      expect(kept?.fileId).toBeTruthy();
      expect(kept?.versionId).toBeTruthy();
      expect((await ctx.files.attach(project.id, ticket.id, { path: "docs/plan.md", role: "input" })).evidence.resources).toHaveLength(1);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
