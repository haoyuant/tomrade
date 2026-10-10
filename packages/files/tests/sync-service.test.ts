import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { Files, createGitBackend } from "@tomradex/files";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-files-sync-svc-"));
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
      [Files, { watch: false, autoSyncMs: 0 }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  return bag;
}

const folderBackend = createGitBackend({
  id: "scoped-folder",
  title: "A scoped folder",
  configSchema: z.object({ path: z.string().min(1), directory: z.string() }),
  defaults: { path: "", directory: "" },
  remote: (c) => ({ url: c.path, branch: "main", directory: c.directory })
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

describe("selective sync through ctx.files", { timeout: 60_000 }, () => {
  it("inherits the closest rule, preserves descendant exceptions, and resets to the default", async () => {
    const { ctx, project } = await machine();
    const id = project.id;
    try {
      await ctx.files.write(id, "docs/private.md", "private");
      await ctx.files.write(id, "docs/public.md", "public");
      await ctx.files.write(id, "elsewhere.md", "other");
      expect(await ctx.files.syncPolicy(id)).toEqual({ default: "shared", rules: [] });
      await ctx.files.setSyncRules(id, ["docs/public.md"], "shared");
      await ctx.files.setSyncRules(id, ["docs"], "local");
      const tree = await ctx.files.tree(id);
      expect(tree.find((e) => e.path === "docs")?.sync).toEqual({ mode: "local", source: "explicit", sourcePath: "docs", mixed: true });
      expect(tree.find((e) => e.path === "docs/private.md")?.sync).toEqual({ mode: "local", source: "inherited", sourcePath: "docs", mixed: false });
      expect(tree.find((e) => e.path === "docs/public.md")?.sync).toEqual({ mode: "shared", source: "explicit", sourcePath: "docs/public.md", mixed: false });
      expect(tree.find((e) => e.path === "elsewhere.md")?.sync).toEqual({ mode: "shared", source: "default", sourcePath: null, mixed: false });
      expect((await ctx.files.list(id, "docs")).find((e) => e.path === "docs/private.md")?.sync).toEqual(tree.find((e) => e.path === "docs/private.md")?.sync);

      await ctx.files.setSyncRules(id, [""], "local");
      await ctx.files.setSyncRules(id, ["docs"], "inherit");
      expect(await ctx.files.syncPolicy(id)).toEqual({ default: "local", rules: [{ path: "docs/public.md", mode: "shared" }] });
      expect((await ctx.files.tree(id)).find((e) => e.path === "docs/private.md")?.sync).toEqual({ mode: "local", source: "default", sourcePath: null, mixed: false });
      await ctx.files.setSyncRules(id, ["docs/public.md"], "inherit");
      expect(await ctx.files.syncPolicy(id)).toEqual({ default: "local", rules: [] });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("validates the whole batch before changing any rule", async () => {
    const { ctx, project } = await machine();
    const id = project.id;
    try {
      await ctx.files.write(id, "one.md", "one");
      await ctx.files.write(id, "two.md", "two");
      const before = await ctx.files.syncPolicy(id);
      await expect(ctx.files.setSyncRules(id, ["one.md", "../escape.md"], "local")).rejects.toThrow();
      expect(await ctx.files.syncPolicy(id)).toEqual(before);
      await expect(ctx.files.setSyncRules(id, [], "local")).rejects.toThrow();
      expect(await ctx.files.syncPolicy(id)).toEqual(before);
      // Exercise the runtime boundary used by untyped callers such as IPC.
      // @ts-expect-error deliberately invalid runtime mode
      await expect(ctx.files.setSyncRules(id, ["one.md"], "invalid")).rejects.toThrow();
      expect(await ctx.files.syncPolicy(id)).toEqual(before);
      expect(await ctx.files.setSyncRules(id, ["one.md", "two.md", "one.md"], "local")).toEqual({
        default: "shared",
        rules: [{ path: "one.md", mode: "local" }, { path: "two.md", mode: "local" }]
      });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("keeps local-only files versioned and undoable", async () => {
    const { ctx, project } = await machine();
    const id = project.id;
    try {
      await ctx.files.setSyncRules(id, [""], "local");
      const first = await ctx.files.write(id, "private.md", "first");
      const second = await ctx.files.write(id, "private.md", "second");
      expect(first.fileId).toBeTruthy();
      expect(first.versionId).toBeTruthy();
      expect(second.fileId).toBe(first.fileId);
      expect(second.versionId).not.toBe(first.versionId);
      expect((await ctx.files.history(id, "private.md")).map((v) => v.versionId)).toEqual([second.versionId, first.versionId]);
      const ref = { fileId: first.fileId!, versionId: first.versionId! };
      expect((await ctx.files.readVersion(id, ref))?.body).toBe("first");
      expect((await ctx.oplog.undo(id))?.summary).toBe("Reverted private.md");
      expect((await ctx.files.read(id, "private.md"))?.body).toBe("first");
      await ctx.oplog.redo(id);
      expect((await ctx.files.read(id, "private.md"))?.body).toBe("second");
      expect((await ctx.files.readVersion(id, ref))?.body).toBe("first");
      expect(await ctx.files.syncPolicy(id)).toEqual({ default: "local", rules: [] });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("rebinds a root cache to a directory without republishing code or losing pinned versions", async () => {
    const { ctx, project } = await machine();
    const id = project.id;
    try {
      const remote = path.join(root, `remote-${n++}.git`);
      const seed = path.join(root, `seed-${n++}`);
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
      execFileSync("git", ["init", "-q", "-b", "main", seed]);
      git(seed, "config", "user.name", "Test");
      git(seed, "config", "user.email", "test@example.com");
      fs.mkdirSync(path.join(seed, "code", "src"), { recursive: true });
      fs.mkdirSync(path.join(seed, "project-files"));
      fs.writeFileSync(path.join(seed, "code", "src", "index.ts"), "export const version = 1;\n");
      fs.writeFileSync(path.join(seed, "project-files", "brief.md"), "brief\n");
      git(seed, "add", ".");
      git(seed, "commit", "-qm", "Seed monorepo");
      git(seed, "remote", "add", "origin", remote);
      git(seed, "push", "-q", "origin", "main");
      ctx.plugin({ name: "scoped-folder-backend", inject: ["files"], apply: (c) => void c.files.register(folderBackend) });
      await settle();
      expect((await ctx.files.bind(id, "scoped-folder", { path: remote, directory: "" })).state).toBe("synced");
      expect((await ctx.files.tree(id)).map((e) => e.path)).toContain("code/src/index.ts");
      // Create a pinned root version and a stale undo operation before changing scope.
      const saved = await ctx.files.write(id, "code/src/index.ts", "export const version = 2;\n");
      const ref = { fileId: saved.fileId!, versionId: saved.versionId! };
      expect(ref.fileId).toBeTruthy();
      expect(ref.versionId).toBeTruthy();
      const oldOp = (await ctx.oplog.timeline(id)).find((r) => r.provider === "files" && r.entityId === "code/src/index.ts")!;
      expect(oldOp).toBeDefined();
      expect((await ctx.files.sync(id)).state).toBe("synced");
      const codeBlob = git(remote, "rev-parse", "main:code/src/index.ts");

      const dir = (await ctx.files.info(id)).dir!;
      expect((await ctx.files.bind(id, "scoped-folder", { path: remote, directory: "project-files" })).state).toBe("synced");
      // The live store stays where people can see it; the root's copy is parked whole beside the project's text.
      expect((await ctx.files.info(id)).dir).toBe(dir);
      const projectDir = ctx.storage.entry(id)!.dir!;
      expect(fs.readdirSync(path.join(projectDir, ".tomrade", "files-archive"))).toHaveLength(1);
      expect(fs.readFileSync(path.join(projectDir, ".tomrade", ".gitignore"), "utf8")).toContain("files-archive/");
      expect((await ctx.files.tree(id)).map((e) => e.path)).toEqual(["brief.md"]);
      expect((await ctx.files.read(id, "brief.md"))?.body).toBe("brief\n");
      expect(await ctx.files.read(id, "code/src/index.ts")).toBeNull();
      expect(await ctx.files.resolveVersion(id, ref)).toEqual(ref);
      expect(await ctx.files.readVersion(id, ref)).toMatchObject({ path: "code/src/index.ts", body: "export const version = 2;\n" });
      await expect(ctx.oplog.revert(id, oldOp.ref)).rejects.toThrow();
      expect((await ctx.files.tree(id)).map((e) => e.path)).toEqual(["brief.md"]);
      expect((await ctx.files.read(id, "brief.md"))?.body).toBe("brief\n");

      await ctx.files.write(id, "brief.md", "scoped edit\n");
      expect((await ctx.files.sync(id)).state).toBe("synced");
      expect(git(remote, "rev-parse", "main:code/src/index.ts")).toBe(codeBlob);
      expect(git(remote, "show", "main:project-files/brief.md")).toBe("scoped edit");
      const published = git(remote, "ls-tree", "-r", "--name-only", "main").split("\n");
      expect(published.some((p) => p.startsWith("project-files/code/") || p.startsWith("project-files/project-files/"))).toBe(false);
      expect((await ctx.files.readVersion(id, ref))?.body).toBe("export const version = 2;\n");

      // Back to the root brings the parked store back as it was; to the folder again, the folder's.
      expect((await ctx.files.bind(id, "scoped-folder", { path: remote, directory: "" })).state).toBe("synced");
      expect((await ctx.files.read(id, "code/src/index.ts"))?.body).toBe("export const version = 2;\n");
      expect((await ctx.files.info(id)).dir).toBe(dir);
      expect((await ctx.files.bind(id, "scoped-folder", { path: remote, directory: "project-files" })).state).toBe("synced");
      expect((await ctx.files.tree(id)).map((e) => e.path)).toEqual(["brief.md"]);
      expect((await ctx.files.read(id, "brief.md"))?.body).toBe("scoped edit\n");
      expect(fs.readdirSync(path.join(projectDir, ".tomrade", "files-archive"))).toHaveLength(1);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("adopts a store that never shared into a folder scope, uploading its files there", async () => {
    const { ctx, project } = await machine();
    const id = project.id;
    try {
      const remote = path.join(root, `remote-${n++}.git`);
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
      await ctx.files.write(id, "docs/brief.md", "brief\n");
      await ctx.files.setSyncRules(id, ["private.md"], "local");
      await ctx.files.write(id, "private.md", "mine\n");
      const dir = (await ctx.files.info(id)).dir!;
      ctx.plugin({ name: "scoped-folder-backend", inject: ["files"], apply: (c) => void c.files.register(folderBackend) });
      await settle();
      expect((await ctx.files.bind(id, "scoped-folder", { path: remote, directory: "project-files" })).state).toBe("synced");
      expect((await ctx.files.info(id)).dir).toBe(dir);
      expect(fs.existsSync(path.join(ctx.storage.entry(id)!.dir!, ".tomrade", "files-archive"))).toBe(false);
      expect(git(remote, "show", "main:project-files/docs/brief.md")).toBe("brief");
      expect(git(remote, "ls-tree", "-r", "--name-only", "main").split("\n")).not.toContain("project-files/private.md");
      expect((await ctx.files.read(id, "private.md"))?.body).toBe("mine\n");
      // Moving between folders keeps the files too: only the root is a different world.
      expect((await ctx.files.bind(id, "scoped-folder", { path: remote, directory: "docs-only" })).state).toBe("synced");
      expect((await ctx.files.read(id, "docs/brief.md"))?.body).toBe("brief\n");
      expect(git(remote, "show", "main:docs-only/docs/brief.md")).toBe("brief");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("syncs only the scoped docs directory and preserves remote code siblings", async () => {
    const { ctx, project } = await machine();
    const id = project.id;
    try {
      const remote = path.join(root, `remote-${n++}.git`);
      const seed = path.join(root, `seed-${n++}`);
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
      execFileSync("git", ["init", "-q", "-b", "main", seed]);
      git(seed, "config", "user.name", "Test");
      git(seed, "config", "user.email", "test@example.com");
      fs.mkdirSync(path.join(seed, "src"));
      fs.mkdirSync(path.join(seed, "docs"));
      fs.writeFileSync(path.join(seed, "src", "index.ts"), "export const version = 1;\n");
      fs.writeFileSync(path.join(seed, "package.json"), '{"name":"code"}\n');
      fs.writeFileSync(path.join(seed, "docs", "guide.md"), "remote guide\n");
      git(seed, "add", ".");
      git(seed, "commit", "-qm", "Seed code and docs");
      git(seed, "remote", "add", "origin", remote);
      git(seed, "push", "-q", "origin", "main");
      ctx.plugin({ name: "scoped-folder-backend", inject: ["files"], apply: (c) => void c.files.register(folderBackend) });
      await settle();
      expect((await ctx.files.bind(id, "scoped-folder", { path: remote, directory: "docs" })).state).toBe("synced");
      expect((await ctx.files.tree(id)).map((e) => e.path)).toEqual(["guide.md"]);
      expect((await ctx.files.read(id, "guide.md"))?.body).toBe("remote guide\n");
      expect(await ctx.files.read(id, "src/index.ts")).toBeNull();
      expect(await ctx.files.read(id, "package.json")).toBeNull();

      await ctx.files.setSyncRules(id, ["private.md"], "local");
      await ctx.files.write(id, "private.md", "stays here");
      await ctx.files.write(id, "guide.md", "edited guide\n");
      await ctx.files.write(id, "new.md", "new doc\n");
      expect((await ctx.files.sync(id)).state).toBe("synced");
      expect(git(remote, "show", "main:docs/guide.md")).toBe("edited guide");
      expect(git(remote, "show", "main:docs/new.md")).toBe("new doc");
      expect(git(remote, "show", "main:src/index.ts")).toBe("export const version = 1;");
      expect(git(remote, "show", "main:package.json")).toBe('{"name":"code"}');
      expect(git(remote, "ls-tree", "-r", "--name-only", "main").split("\n")).not.toContain("docs/private.md");

      git(seed, "pull", "-q", "--ff-only", "origin", "main");
      fs.writeFileSync(path.join(seed, "src", "index.ts"), "export const version = 2;\n");
      fs.writeFileSync(path.join(seed, "docs", "incoming.md"), "incoming doc\n");
      git(seed, "add", ".");
      git(seed, "commit", "-qm", "Update code and add a doc");
      git(seed, "push", "-q", "origin", "main");
      expect((await ctx.files.sync(id)).state).toBe("synced");
      expect((await ctx.files.tree(id)).map((e) => e.path).sort()).toEqual(["guide.md", "incoming.md", "new.md", "private.md"]);
      expect((await ctx.files.read(id, "incoming.md"))?.body).toBe("incoming doc\n");
      expect((await ctx.files.read(id, "private.md"))?.body).toBe("stays here");
      expect(git(remote, "show", "main:src/index.ts")).toBe("export const version = 2;");
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
