import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { Tools } from "@tomradex/tools";
import { Contributions } from "@tomradex/contributions";
import { Files, createGitBackend } from "@tomradex/files";

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

describe("ctx.files", { timeout: 30_000 }, () => {
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

  it("pins several files to a ticket in one item write and leaves no partial resources", async () => {
    const { ctx, items, project, board } = await machine();
    try {
      const ticket = items.create({ projectId: project.id, boardId: board.id, title: "Ship the package", workType: "general", by: "human" });
      const first = await ctx.files.write(project.id, "package/one.md", "one");
      const second = await ctx.files.write(project.id, "package/two.md", "two");
      const attached = await ctx.files.attachMany(project.id, ticket.id, { paths: ["package/one.md", "package/two.md"], role: "output" });
      expect(attached.version).toBe(ticket.version + 1);
      expect(attached.evidence.resources).toEqual([
        expect.objectContaining({ name: "one.md", file: { fileId: first.fileId, versionId: first.versionId } }),
        expect.objectContaining({ name: "two.md", file: { fileId: second.fileId, versionId: second.versionId } })
      ]);
      expect(new Set(attached.evidence.resources.map(resource => resource.deliveryId)).size).toBe(1);

      const untouched = items.create({ projectId: project.id, boardId: board.id, title: "Reject a partial package", workType: "general", by: "human" });
      await expect(ctx.files.attachMany(project.id, untouched.id, { paths: ["package/one.md", "package/missing.md"], role: "output" })).rejects.toThrow(/No file/);
      expect(items.get(project.id, untouched.id)?.evidence.resources).toEqual([]);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("lands a ticket's files in a folder named after its workstream", async () => {
    const { ctx, items, boards, project, board } = await machine();
    try {
      const web = boards.create({ projectId: project.id, name: " Web / App " });
      const ticket = items.create({ projectId: project.id, boardId: web.id, title: "Write the brief", workType: "general", by: "human" });
      expect(ctx.files.folderFor(project.id, ticket.id)).toBe("Web - App");
      expect(ctx.files.pathFor(project.id, ticket.id, "docs/brief.md")).toBe("Web - App/docs/brief.md");
      expect(() => ctx.files.pathFor(project.id, ticket.id, "")).toThrow(/Not a file path/);
      expect(() => ctx.files.folderFor(project.id, "nope")).toThrow(/nope/);
      expect(ctx.files.folderFor(project.id, items.create({ projectId: project.id, boardId: board.id, title: "Elsewhere", workType: "general", by: "human" }).id)).toBe(board.name);

      const inv = { by: "ai:test" as const, projectId: project.id };
      const written = (await ctx.tools.execute("write_file", { itemId: ticket.id, path: "brief.md", content: "# Brief" }, inv)) as { path: string };
      expect(written.path).toBe("Web - App/brief.md");
      const elsewhere = (await ctx.tools.execute("write_file", { path: "notes/loose.md", content: "loose" }, inv)) as { path: string };
      expect(elsewhere.path).toBe("notes/loose.md");

      const src = path.join(root, `import-${n++}`);
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, "spec.md"), "# Spec");
      fs.writeFileSync(path.join(src, "mock.txt"), "mock");
      const pinned = await ctx.files.importFor(project.id, ticket.id, { sources: [path.join(src, "spec.md"), path.join(src, "mock.txt")], role: "input" });
      expect(pinned.evidence.resources.map((r) => [r.name, r.role]).sort()).toEqual([["mock.txt", "input"], ["spec.md", "input"]]);
      expect((await ctx.files.read(project.id, "Web - App/spec.md"))?.body).toBe("# Spec");
      expect((await ctx.files.tree(project.id)).filter((e) => e.kind === "dir").map((e) => e.path).sort()).toEqual(["Web - App", "notes"]);
      await expect(ctx.files.importFor(project.id, ticket.id, { sources: [], role: "input" })).rejects.toThrow(/at least one/);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("saves a ticket body's files under its workstream's attachments folder, as one version, and finds them by id after a move", async () => {
    const { ctx, items, boards, project } = await machine();
    try {
      const web = boards.create({ projectId: project.id, name: "Web" });
      const ticket = items.create({ projectId: project.id, boardId: web.id, title: "Fix the header", workType: "general", by: "human" });
      const folder = `Web/attachments/${ticket.key}`;
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
      await ctx.files.write(project.id, `${folder}/截图.png`, Buffer.from("already here"));
      const before = (await ctx.oplog.timeline(project.id)).length;

      const added = await ctx.files.addAttachments(project.id, ticket.id, [
        { name: "截图.png", base64: png },
        { name: "../../截图.png", base64: png },
        { name: "spec.pdf", base64: Buffer.from("%PDF-1.4").toString("base64") },
        { name: " \u0007 ", base64: Buffer.from("x").toString("base64") }
      ]);
      expect(added.map((a) => a.path)).toEqual([`${folder}/截图 2.png`, `${folder}/截图 3.png`, `${folder}/spec.pdf`, `${folder}/attachment`]);
      expect(added[0]).toMatchObject({ name: "截图 2.png", mime: "image/png", size: 11, localPath: path.join(ctx.files.dirFor(project.id)!, "Web", "attachments", ticket.key, "截图 2.png") });
      expect(added.every((a) => /^[0-9a-f-]{36}$/.test(a.fileId))).toBe(true);
      const timeline = await ctx.oplog.timeline(project.id);
      expect(timeline.length).toBe(before + 1);
      expect(timeline[0]).toMatchObject({ provider: "files", op: "write" });
      expect((await ctx.files.history(project.id, `${folder}/spec.pdf`))[0]?.message).toBe(`Attached 4 files to ${ticket.key}`);
      expect(await ctx.files.addAttachments(project.id, ticket.id, [])).toEqual([]);

      // Reached through the ticket, so not volunteered — but never refused.
      const inv = { by: "ai:test" as const, projectId: project.id };
      expect((await ctx.files.tree(project.id)).find((e) => e.path === "Web/attachments")?.listing).toMatchObject({ mode: "unlisted", source: "default" });
      expect((await ctx.tools.execute("list_files", { depth: 4 }, inv)) as string).not.toContain("attachments");
      expect((await ctx.tools.execute("search_files", { queries: ["PDF-1.4"] }, inv)) as string).toContain("no matches");
      expect((await ctx.tools.execute("search_files", { queries: ["PDF-1.4"], path: "Web/attachments" }, inv)) as string).toContain("spec.pdf");

      const pic = added[0]!;
      expect((await ctx.files.readById(project.id, pic.fileId))?.body).toBe(png);
      await ctx.files.move(project.id, pic.path, "Elsewhere/renamed.png");
      expect((await ctx.files.readById(project.id, pic.fileId))?.path).toBe("Elsewhere/renamed.png");
      const ghost = "00000000-0000-4000-8000-000000000000";
      expect(await ctx.files.readById(project.id, ghost)).toBeNull();
      const described = await ctx.files.describeFiles(project.id, [ghost, pic.fileId, added[2]!.fileId]);
      expect(described.map((d) => [d.path, d.name])).toEqual([["Elsewhere/renamed.png", "renamed.png"], [`${folder}/spec.pdf`, "spec.pdf"]]);

      await ctx.files.remove(project.id, `${folder}/spec.pdf`);
      expect(await ctx.files.readById(project.id, added[2]!.fileId)).toBeNull();
      expect(await ctx.files.describeFiles(project.id, [added[2]!.fileId])).toEqual([]);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("refuses a body file over the binary limit, and writes nothing of the batch", async () => {
    const { ctx, items, project, board } = await machine();
    try {
      const ticket = items.create({ projectId: project.id, boardId: board.id, title: "Big", workType: "general", by: "human" });
      const big = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
      await expect(ctx.files.addAttachments(project.id, ticket.id, [{ name: "ok.txt", base64: "b2s=" }, { name: "huge.bin", base64: big }])).rejects.toThrow("huge.bin is larger than 8 MB; add it in Files instead");
      expect(await ctx.files.tree(project.id)).toEqual([]);
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
      const listed = (await ctx.tools.execute("list_files", { dir: "out" }, inv)) as string;
      expect(listed).toContain("out/report.md");
      const read = (await ctx.tools.execute("read_file", { path: "out/report.md" }, inv)) as string;
      expect(read).toContain("# Report");
      // The head of a read is what a delivery pins, so it never needs a second call.
      expect(read).toContain(`versionId ${written.versionId}`);
      await expect(ctx.tools.execute("write_file", { path: "../escape.md", content: "x" }, inv)).rejects.toThrow(/Not a file path/);

      const ticket = items.create({ projectId: project.id, boardId: board.id, title: "Report", workType: "general", by: "human" });
      const item = (await ctx.tools.execute("add_delivery_resource", { projectId: project.id, id: ticket.id, resource: { name: "Report", role: "output", file: { fileId: written.fileId, versionId: written.versionId } } }, inv)) as { evidence: { resources: unknown[] } };
      expect(item.evidence.resources).toHaveLength(1);
      expect(await ctx.contributions.run("files.sync", { projectId: project.id })).toMatchObject({ toast: expect.stringMatching(/^Files: local/) });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("gives the agent one tool for move, copy and delete, each guarded the way the store guards them", async () => {
    const { ctx, project } = await machine();
    try {
      const inv = { by: "ai:test" as const, projectId: project.id };
      const written = (await ctx.tools.execute("write_file", { path: "draft.md", content: "hello" }, inv)) as { fileId: string };
      expect(await ctx.tools.execute("manage_file", { action: "move", path: "draft.md", to: "docs/draft.md" }, inv)).toBe("Moved draft.md to docs/draft.md");
      expect((await ctx.files.read(project.id, "docs/draft.md"))?.fileId).toBe(written.fileId);

      await ctx.tools.execute("manage_file", { action: "copy", path: "docs/draft.md", to: "docs/draft (copy).md" }, inv);
      const copy = await ctx.files.read(project.id, "docs/draft (copy).md");
      expect(copy?.body).toBe("hello");
      expect(copy?.fileId).not.toBe(written.fileId);
      await expect(ctx.tools.execute("manage_file", { action: "copy", path: "docs/draft.md", to: "docs/draft (copy).md" }, inv)).rejects.toThrow(/already exists/);
      await expect(ctx.tools.execute("manage_file", { action: "move", path: "docs/draft.md" }, inv)).rejects.toThrow(/needs a destination/);

      await ctx.tools.execute("manage_file", { action: "delete", path: "docs/draft (copy).md" }, inv);
      expect(await ctx.files.read(project.id, "docs/draft (copy).md")).toBeNull();
      expect((await ctx.files.read(project.id, "docs/draft.md"))?.fileId).toBe(written.fileId);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("searches several queries in one call, and reads a long file by range", async () => {
    const { ctx, project } = await machine();
    try {
      const inv = { by: "ai:test" as const, projectId: project.id };
      await ctx.files.write(project.id, "notes/api.md", Buffer.from("# API\nRate limit is 120 per minute.\nAuth uses a bearer token.\n"));
      await ctx.files.write(project.id, "notes/ops.md", Buffer.from("# Ops\nThe rate limit alarm pages on-call.\n"));
      const found = (await ctx.tools.execute("search_files", { queries: ["rate limit", "bearer", "nowhere"] }, inv)) as string;
      expect(found).toContain("notes/api.md:2");
      expect(found).toContain("notes/ops.md:2");
      expect(found).toContain("notes/api.md:3");
      expect(found).toContain('"nowhere" — no matches.');

      const long = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
      await ctx.files.write(project.id, "notes/long.md", Buffer.from(long));
      const slice = (await ctx.tools.execute("read_file", { path: "notes/long.md", range: { start: 100, lines: 3 } }, inv)) as string;
      expect(slice).toContain("lines 100–102 of 300");
      expect(slice).toContain("line 100");
      expect(slice).not.toContain("line 104");
      expect(slice).toContain("read again from line 103");

      // Several files in one call is one round trip, not three.
      const both = (await ctx.tools.execute("read_file", { paths: ["notes/api.md", "notes/ops.md"] }, inv)) as string;
      expect(both).toContain("Rate limit is 120");
      expect(both).toContain("pages on-call");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("keeps unlisted paths out of the index, the listing and open searches, and reads them anyway", async () => {
    const { ctx, project } = await machine();
    try {
      const inv = { by: "ai:test" as const, projectId: project.id };
      await ctx.files.write(project.id, "Specs/brief.md", Buffer.from("# Product brief\nThe plan.\n"));
      await ctx.files.write(project.id, "Private/salary.md", Buffer.from("# Salary bands\nsecret sauce\n"));
      expect(await ctx.files.agentPolicy(project.id)).toEqual({ default: "listed", rules: [] });

      const before = await ctx.files.agentIndex(project.id, {});
      expect(before?.markdown).toContain("Private/salary.md");
      expect(before?.markdown).toContain("Product brief");

      await ctx.files.setAgentRules(project.id, ["Private"], "unlisted");
      const after = await ctx.files.agentIndex(project.id, {});
      expect(after?.markdown).not.toContain("Private");
      expect(after?.markdown).toContain("Specs/brief.md");
      expect(after?.markdown).toContain("Paths the person keeps out of this index");
      expect(after?.listed).toBe(1);
      expect(after?.total).toBe(2);

      expect((await ctx.tools.execute("list_files", { depth: 3 }, inv)) as string).not.toContain("Private");
      expect((await ctx.tools.execute("search_files", { queries: ["secret sauce"] }, inv)) as string).toContain("no matches");
      // Disclosure only: naming the path, or searching inside it, still works.
      expect((await ctx.tools.execute("read_file", { path: "Private/salary.md" }, inv)) as string).toContain("secret sauce");
      expect((await ctx.tools.execute("search_files", { queries: ["secret sauce"], path: "Private" }, inv)) as string).toContain("Private/salary.md:2");

      await ctx.files.setAgentRules(project.id, ["Private"], "inherit");
      expect((await ctx.files.agentIndex(project.id, {}))?.markdown).toContain("Private/salary.md");
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

describe("importing", () => {
  it("brings a folder in whole as one version, hidden names left behind and empty folders kept", async () => {
    const { ctx, project } = await machine();
    try {
      const src = path.join(root, `import-${n++}`);
      fs.mkdirSync(path.join(src, "assets", "img"), { recursive: true });
      fs.mkdirSync(path.join(src, "empty"));
      fs.writeFileSync(path.join(src, "readme.md"), "# Readme");
      fs.writeFileSync(path.join(src, "assets", "img", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      fs.writeFileSync(path.join(src, ".DS_Store"), "junk");
      const loose = path.join(root, `loose-${n++}.txt`);
      fs.writeFileSync(loose, "loose");

      const added = await ctx.files.importFiles(project.id, "in", [src, loose]);
      expect(added.map((e) => [e.name, e.kind])).toEqual([
        [path.basename(src), "dir"],
        [path.basename(loose), "file"]
      ]);
      const paths = (await ctx.files.tree(project.id)).map((e) => e.path);
      expect(paths).toContain(`in/${path.basename(src)}/assets/img/logo.png`);
      expect(paths).toContain(`in/${path.basename(src)}/empty`);
      expect(paths.some((p) => p.includes(".DS_Store"))).toBe(false);
      const readme = await ctx.files.read(project.id, `in/${path.basename(src)}/readme.md`);
      expect(readme?.fileId).toBeTruthy();
      expect(readme?.versionId).toBeTruthy();
      expect((await ctx.files.history(project.id, `in/${path.basename(src)}/readme.md`))[0]?.message).toBe(`Imported folder in/${path.basename(src)}`);
      await expect(ctx.files.importFiles(project.id, "in", [src])).rejects.toThrow(/already exists/);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe("files in the undo timeline", () => {
  it("restores a deleted file with its id through ⌘Z, and deletes it again through ⇧⌘Z", async () => {
    const { ctx, project } = await machine();
    try {
      const saved = await ctx.files.write(project.id, "docs/brief.md", "# Brief\n");
      const ref = await ctx.files.remove(project.id, "docs/brief.md");
      expect(ref).toMatch(/^files:\d+$/);
      expect(await ctx.files.read(project.id, "docs/brief.md")).toBeNull();

      const step = await ctx.oplog.undo(project.id);
      expect(step?.record).toMatchObject({ ref, provider: "files", entity: "file", op: "remove", label: "docs/brief.md" });
      expect(step?.summary).toBe("Restored docs/brief.md");
      const back = await ctx.files.read(project.id, "docs/brief.md");
      expect(back?.body).toBe("# Brief\n");
      expect(back?.fileId).toBe(saved.fileId);
      expect((await ctx.files.history(project.id, "docs/brief.md"))[0]?.message).toBe("Undid: Deleted docs/brief.md");

      const redo = await ctx.oplog.redo(project.id);
      expect(redo?.record.ref).toBe(ref);
      expect(await ctx.files.read(project.id, "docs/brief.md")).toBeNull();
      // Deleting nothing records nothing.
      expect(await ctx.files.remove(project.id, "docs/brief.md")).toBeNull();
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("puts a moved file back where it was, id and all, and refuses once the path has moved on", async () => {
    const { ctx, project } = await machine();
    try {
      const saved = await ctx.files.write(project.id, "a.md", "A");
      await ctx.files.move(project.id, "a.md", "b.md");
      expect((await ctx.oplog.undo(project.id))?.summary).toBe("Moved b.md back to a.md");
      expect((await ctx.files.read(project.id, "a.md"))?.fileId).toBe(saved.fileId);
      expect(await ctx.files.read(project.id, "b.md")).toBeNull();
      expect((await ctx.oplog.redo(project.id))?.summary).toBe("Moved a.md to b.md again");
      expect((await ctx.files.read(project.id, "b.md"))?.fileId).toBe(saved.fileId);

      const moveRef = (await ctx.oplog.timeline(project.id)).find((r) => r.op === "move")!.ref;
      await ctx.files.write(project.id, "b.md", "B, edited since");
      await expect(ctx.oplog.revert(project.id, moveRef)).rejects.toThrow(/has changed since/);
      expect((await ctx.files.read(project.id, "b.md"))?.body).toBe("B, edited since");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("undoes a folder and an import whole", async () => {
    const { ctx, project } = await machine();
    try {
      await ctx.files.mkdir(project.id, "empty");
      expect((await ctx.files.tree(project.id)).map((e) => e.path)).toEqual(["empty"]);
      expect((await ctx.oplog.undo(project.id))?.summary).toBe("Removed folder empty");
      expect(await ctx.files.tree(project.id)).toEqual([]);

      const src = path.join(root, `undo-import-${n++}`);
      fs.mkdirSync(path.join(src, "deep"), { recursive: true });
      fs.writeFileSync(path.join(src, "deep", "x.txt"), "x");
      const loose = path.join(root, `undo-loose-${n++}.txt`);
      fs.writeFileSync(loose, "loose");
      await ctx.files.importFiles(project.id, "in", [src, loose]);
      const record = (await ctx.oplog.timeline(project.id))[0]!;
      expect(record).toMatchObject({ op: "import", label: `in/${path.basename(src)}, in/${path.basename(loose)}` });
      expect((await ctx.oplog.undo(project.id))?.summary).toBe("Removed 2 imported items");
      expect((await ctx.files.tree(project.id)).map((e) => e.path)).toEqual([]);
      await ctx.oplog.redo(project.id);
      expect((await ctx.files.read(project.id, `in/${path.basename(src)}/deep/x.txt`))?.body).toBe("x");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("shares one timeline with the backlog: ⌘Z takes the newest of either, and a backlog write empties the files' redo stack", async () => {
    const { ctx, items, project, board } = await machine();
    try {
      const a = items.create({ projectId: project.id, boardId: board.id, title: "A", by: "human" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ctx.files.write(project.id, "x.md", "x");
      const timeline = await ctx.oplog.timeline(project.id);
      expect(timeline.slice(0, 2).map((r) => r.provider)).toEqual(["files", "oplog"]);
      expect(timeline[1]!.label).toBe(a.key);

      expect((await ctx.oplog.undo(project.id))?.summary).toBe("Reverted x.md");
      expect(await ctx.files.read(project.id, "x.md")).toBeNull();
      expect((await ctx.oplog.undo(project.id))?.summary).toBe(`Removed ${a.key}`);
      expect((await ctx.oplog.redo(project.id))?.summary).toBe(`Re-created ${a.key}`);
      expect((await ctx.oplog.redo(project.id))?.summary).toBe("Saved x.md again");
      expect((await ctx.files.read(project.id, "x.md"))?.body).toBe("x");

      await ctx.oplog.undo(project.id);
      items.create({ projectId: project.id, boardId: board.id, title: "B", by: "human" });
      expect(await ctx.oplog.redo(project.id)).toBeNull();
      expect((await ctx.oplog.timeline(project.id)).some((r) => r.undoneAt !== null)).toBe(false);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
