import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomrade/testkit";
import { Settings } from "@tomrade/settings";
import { Storage } from "@tomrade/storage";
import { Tools } from "@tomrade/tools";
import { Contributions } from "@tomrade/contributions";
import { Files, createGitBackend } from "@tomrade/files";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-files-svc-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

async function machine() {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({
    hubDir,
    plugins: [
      [Settings, { path: path.join(hubDir, "settings.json") }],
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      Tools,
      Contributions,
      [Files, { watch: false, autoSyncMs: 0 }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  return bag;
}

function bare(): string {
  const dir = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
  return dir;
}

/** A remote backend for tests: any folder path is the remote. */
const folderBackend = createGitBackend<{ path: string }>({
  id: "folder",
  title: "A folder",
  configSchema: z.object({ path: z.string().min(1) }),
  defaults: { path: "" },
  describe: (c) => c.path,
  remote: (c) => ({ url: c.path, branch: "main" })
});

describe("ctx.files", () => {
  it("keeps a project's files beside its folder, on the local backend until a remote is chosen", async () => {
    const { ctx, project } = await machine();
    try {
      const dir = ctx.storage.entry(project.id)!.dir!;
      expect(ctx.files.dirFor(project.id)).toBe(path.join(dir, "files"));
      const info = await ctx.files.info(project.id);
      expect(info.remote).toBeNull();
      expect(info.status.state).toBe("local");
      expect(fs.existsSync(path.join(dir, "files", ".git"))).toBe(true);
      expect(ctx.files.describe().map((b) => b.id)).toEqual(["local"]);

      const saved = await ctx.files.write(project.id, "docs/plan.md", "# Plan\n");
      expect((await ctx.files.tree(project.id)).map((e) => e.path)).toEqual(["docs", "docs/plan.md"]);
      expect((await ctx.files.read(project.id, "docs/plan.md"))?.versionId).toBe(saved.versionId);
      expect(await ctx.files.readVersion(project.id, { fileId: saved.fileId!, versionId: saved.versionId! })).toMatchObject({ body: "# Plan\n" });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("is the version resolver tickets pin artifacts through", async () => {
    const { ctx, items, project, board } = await machine();
    try {
      const ticket = items.create({ projectId: project.id, boardId: board.id, title: "Write the brief", workType: "general", by: "human" });
      const saved = await ctx.files.write(project.id, "brief.md", "v1");
      const attached = await ctx.files.attach(project.id, ticket.id, { path: "brief.md", role: "output" });
      expect(attached.evidence.resources).toHaveLength(1);
      expect(attached.evidence.resources[0]).toMatchObject({ name: "brief.md", role: "output", file: { fileId: saved.fileId, versionId: saved.versionId } });

      // The pinned version stays what it was after the file moves on.
      await ctx.files.write(project.id, "brief.md", "v2");
      const pinned = attached.evidence.resources[0]!.file;
      expect((await ctx.files.readVersion(project.id, pinned))?.body).toBe("v1");
      await expect(items.addResource(project.id, ticket.id, { name: "ghost", role: "input", file: { fileId: saved.fileId!, versionId: "0".repeat(40) } }, "human")).rejects.toThrow(/does not exist/);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("gives the agent list, read and write, each write a version to hand to add_delivery_resource", async () => {
    const { ctx, items, project, board } = await machine();
    try {
      const inv = { by: "ai:test" as const, projectId: project.id };
      const written = (await ctx.tools.execute("write_file", { path: "out/report.md", content: "# Report" }, inv)) as { path: string; fileId: string; versionId: string };
      expect(written).toMatchObject({ path: "out/report.md" });
      expect(written.versionId).toMatch(/^[0-9a-f]{40}$/);
      const listed = (await ctx.tools.execute("list_files", { dir: "out" }, inv)) as { path: string; fileId: string }[];
      expect(listed).toEqual([expect.objectContaining({ path: "out/report.md", fileId: written.fileId })]);
      const read = (await ctx.tools.execute("read_file", { path: "out/report.md" }, inv)) as { text: string };
      expect(read.text).toBe("# Report");
      await expect(ctx.tools.execute("write_file", { path: "../escape.md", content: "x" }, inv)).rejects.toThrow(/Not a file path/);

      const ticket = items.create({ projectId: project.id, boardId: board.id, title: "Report", workType: "general", by: "human" });
      const item = (await ctx.tools.execute("add_delivery_resource", { projectId: project.id, id: ticket.id, resource: { name: "Report", role: "output", file: { fileId: written.fileId, versionId: written.versionId } } }, inv)) as { evidence: { resources: unknown[] } };
      expect(item.evidence.resources).toHaveLength(1);
      expect(await ctx.contributions.run("files.sync", { projectId: project.id })).toMatchObject({ toast: expect.stringMatching(/^Files: local/) });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("shares files through a registered backend: the row travels, another machine clones it, and both sync", async () => {
    const one = await machine();
    const two = await machine();
    try {
      one.ctx.plugin({ name: "folder-backend", inject: ["files"], apply: (c) => void c.files.register(folderBackend) });
      two.ctx.plugin({ name: "folder-backend", inject: ["files"], apply: (c) => void c.files.register(folderBackend) });
      await settle();
      const remote = bare();
      await one.ctx.files.write(one.project.id, "shared.md", "hello");
      const bound = await one.ctx.files.bind(one.project.id, "folder", { path: remote });
      expect(bound.state).toBe("synced");
      expect(bound.location).toBe(remote);
      expect((await one.ctx.files.info(one.project.id)).remote).toEqual({ backend: "folder", config: { path: remote } });
      // The project's own folder must not swallow the files' repository.
      const projectDir = one.ctx.storage.entry(one.project.id)!.dir!;
      expect(fs.readFileSync(path.join(projectDir, ".tomrade", ".gitignore"), "utf8")).toMatch(/^files\/$/m);

      // Machine two learns the remote the way a project's folder carries it: the same row in its table.
      two.ctx.db.for(two.project.id).prepare("INSERT INTO plugin_files_remotes (project_id, backend, config_json, updated_at) VALUES (?, 'folder', ?, ?)").run(two.project.id, JSON.stringify({ path: remote }), Date.now());
      const status = await two.ctx.files.status(two.project.id);
      expect(status.state).toBe("synced");
      expect((await two.ctx.files.read(two.project.id, "shared.md"))?.body).toBe("hello");

      await two.ctx.files.write(two.project.id, "from-two.md", "two");
      expect((await two.ctx.files.sync(two.project.id)).state).toBe("synced");
      expect((await one.ctx.files.sync(one.project.id)).state).toBe("synced");
      expect((await one.ctx.files.read(one.project.id, "from-two.md"))?.body).toBe("two");

      // Unbinding keeps the files and the versions, and stops sharing.
      const unbound = await one.ctx.files.unbind(one.project.id);
      expect(unbound.remote).toBeNull();
      expect(unbound.status.state).toBe("local");
      expect((await one.ctx.files.read(one.project.id, "from-two.md"))?.body).toBe("two");
    } finally {
      await one.ctx.fiber.dispose();
      await two.ctx.fiber.dispose();
    }
  });

  it("refuses a backend whose config would carry a secret", async () => {
    const { ctx } = await machine();
    try {
      expect(() =>
        ctx.files.register(
          createGitBackend({ id: "leaky", title: "Leaky", configSchema: z.object({ token: z.string().meta({ format: "password" }) }), defaults: { token: "" }, remote: (c) => ({ url: c.token, branch: "main" }) })
        )
      ).toThrow(/secret/);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
