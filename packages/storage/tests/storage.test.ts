/**
 * The artifact is the contract: a project must round-trip through text without
 * losing a row, and an unchanged project must produce no diff. Everything the
 * providers do rests on those two properties.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomrade/testkit";
import { DivergedError, ForeignProjectError, Storage, digestState, exportState, importState, readArtifact, serializeState, writeArtifact } from "@tomrade/storage";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-storage-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
const tmp = (name: string) => {
  const dir = path.join(root, `${name}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** A context with storage loaded and nothing published automatically. */
async function withStorage() {
  const home = tmp("home");
  const bag = await fresh({ plugins: [[Storage, { path: path.join(home, "storage.json"), debounceMs: 60_000, reconcileMs: 0 }]] });
  await settle();
  return { ...bag, storage: bag.ctx.storage, home };
}

describe("the artifact", () => {
  it("round-trips a project through text without losing anything", async () => {
    const { ctx, db, items, boards, views, board, project } = await withStorage();
    const epic = items.create({ title: "Reporting", kind: "epic", projectId: project.id, boardId: board.id, by: "human" });
    const ticket = items.create({ title: "Export PDF", projectId: project.id, parentId: epic.id, boardId: board.id, labels: ["ui", "bug"], priority: 4, by: "human" });
    const other = items.create({ title: "Blocked one", projectId: project.id, boardId: board.id, by: "ai:mcp" });
    items.addRelation(project.id, ticket.id, other.id);
    const second = boards.create({ projectId: project.id, name: "Second" });
    views.setRank(project.id, views.listForProject(project.id)[0].id, ticket.id, 3.5);

    const before = exportState(db, project.id);
    const dir = tmp("artifact");
    writeArtifact(dir, before);
    const read = readArtifact(dir);
    expect(read).not.toBeNull();
    // The bytes are the contract, so compare the serialisation, not the object.
    expect([...serializeState(read!)]).toEqual([...serializeState(before)]);

    // And it survives a real import into an empty cache on another machine.
    const fresh2 = await withStorage();
    const target = fresh2.ctx.db.open(project.id);
    importState(target, read!);
    const reexported = exportState(target, project.id);
    expect(digestState(reexported)).toBe(digestState(before));
    expect(fresh2.items.list({ projectId: project.id }).map((i) => i.key).sort()).toEqual(items.list({ projectId: project.id }).map((i) => i.key).sort());
    expect(fresh2.items.get(project.id, ticket.id)?.labels.sort()).toEqual(["bug", "ui"]);
    expect(fresh2.items.get(project.id, ticket.id)?.blocks).toEqual([other.id]);
    expect(fresh2.items.get(project.id, ticket.id)?.parentId).toBe(epic.id);
    expect(fresh2.boards.list(project.id).map((b) => b.name).sort()).toEqual(boards.list(project.id).map((b) => b.name).sort());
    await ctx.fiber.dispose();
  });

  it("is deterministic: the same data writes the same bytes, and nothing is touched twice", async () => {
    const { db, board, items, project } = await withStorage();
    items.create({ title: "A", projectId: project.id, boardId: board.id, by: "human" });
    const dir = tmp("stable");
    expect(writeArtifact(dir, exportState(db, project.id))).toBe(true);
    expect(writeArtifact(dir, exportState(db, project.id))).toBe(false);
    items.create({ title: "B", projectId: project.id, boardId: board.id, by: "human" });
    expect(writeArtifact(dir, exportState(db, project.id))).toBe(true);
  });

  it("carries the key counter, so two machines never mint the same key", async () => {
    const { db, board, items, project } = await withStorage();
    items.create({ title: "A", projectId: project.id, boardId: board.id, by: "human" });
    items.create({ title: "B", projectId: project.id, boardId: board.id, by: "human" });
    const state = exportState(db, project.id);
    expect(state.manifest.project.next_key_num).toBe(3);

    const other = await withStorage();
    importState(other.ctx.db.open(project.id), state);
    expect(other.items.create({ title: "C", boardId: board.id, projectId: project.id, by: "human" }).key).toBe("TOM-3");
  });

  it("an edge whose other end lives in another project cannot exist, so none is exported", async () => {
    const { db, boards, items, board, projects, project } = await withStorage();
    const outside = projects.create({ name: "Outside" });
    const here = items.create({ title: "here", projectId: project.id, boardId: board.id, by: "human" });
    const there = items.create({ title: "there", projectId: outside.id, boardId: boards.defaultFor(outside.id).id, by: "human" });
    // One project, one file: the other end is not in this file, so the edge is refused.
    expect(() => items.addRelation(project.id, here.id, there.id)).toThrow();
    expect(exportState(db, project.id).tables.item_relations).toEqual([]);
  });
});

describe("ctx.storage", () => {
  it("refuses a provider that puts a secret in its per-project config", async () => {
    const { storage, ctx } = await withStorage();
    expect(() =>
      storage.register({
        id: "leaky",
        title: "Leaky",
        configSchema: z.object({ token: z.string().meta({ format: "password" }) }),
        defaults: { token: "" },
        open: async () => {
          throw new Error("never");
        }
      })
    ).toThrow(/settings section/);
    expect(storage.describe().map((p) => p.id)).toEqual(["folder"]);
    await ctx.fiber.dispose();
  });

  it("an unbound project is a local project", async () => {
    const { storage, project } = await withStorage();
    expect(await storage.statusFor(project.id)).toMatchObject({ state: "local", location: null });
  });

  it("names the artifact dir for a bound project, and null for a local one", async () => {
    const { ctx, storage, project } = await withStorage();
    expect(await storage.artifactDirFor(project.id)).toBeNull();
    const dir = tmp("dest");
    await storage.bind(project.id, "folder", { dir });
    expect(await storage.artifactDirFor(project.id)).toBe(path.join(dir, ".tomrade"));
    await ctx.fiber.dispose();
  });

  it("binds to a folder, publishes, and reports ahead then synced", async () => {
    const { storage, project, items, board } = await withStorage();
    const dir = tmp("dest");
    expect(await storage.bind(project.id, "folder", { dir })).toMatchObject({ state: "synced" });
    expect(fs.existsSync(path.join(dir, ".tomrade", "project.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".tomrade", "state", "items.jsonl"))).toBe(true);
    // The live database never belongs in a destination.
    expect(fs.readFileSync(path.join(dir, ".tomrade", ".gitignore"), "utf8")).toMatch(/\*\.db/);

    items.create({ title: "after binding", projectId: project.id, boardId: board.id, by: "human" });
    expect(await storage.statusFor(project.id)).toMatchObject({ state: "ahead" });
    expect(await storage.flush(project.id)).toMatchObject({ state: "synced" });
    expect(fs.readFileSync(path.join(dir, ".tomrade", "state", "items.jsonl"), "utf8")).toMatch(/after binding/);
  });

  it("takes the destination's copy on refresh when local is clean", async () => {
    const { storage, db, project, items, board } = await withStorage();
    const dir = tmp("incoming");
    await storage.bind(project.id, "folder", { dir });
    // A teammate's edit, arriving as text — a complete row, as the schema demands.
    const theirs = exportState(db, project.id);
    theirs.tables.items.push({
      id: "their-item",
      project_id: project.id,
      board_id: board.id,
      key_num: 99,
      title: "Wrote this elsewhere",
      body: null,
      kind: "ticket",
      status: "todo",
      priority: 2,
      parent_id: null,
      rank: 0,
      updated_at: Date.now(),
      updated_by: "human",
      version: 1,
      human_locked: 0
    });
    theirs.manifest.project.next_key_num = 100;
    writeArtifact(dir, theirs);

    expect(await storage.statusFor(project.id)).toMatchObject({ state: "behind" });
    expect(await storage.refresh(project.id)).toMatchObject({ state: "synced" });
    expect(items.get(project.id, "their-item")?.title).toBe("Wrote this elsewhere");
  });

  it("refuses to overwrite a destination that also moved", async () => {
    const { storage, db, project, items, board } = await withStorage();
    const dir = tmp("both");
    await storage.bind(project.id, "folder", { dir });
    const theirs = exportState(db, project.id);
    theirs.tables.labels.push({ id: "their-label", project_id: project.id, name: "theirs" });
    writeArtifact(dir, theirs);
    items.create({ title: "mine", projectId: project.id, boardId: board.id, by: "human" });

    expect(await storage.statusFor(project.id)).toMatchObject({ state: "diverged" });
    await expect(storage.flush(project.id)).rejects.toThrow(DivergedError);
    await expect(storage.refresh(project.id)).rejects.toThrow(DivergedError);
    // Nothing was destroyed on either side.
    expect(items.list({ projectId: project.id }).some((i) => i.title === "mine")).toBe(true);
    expect(readArtifact(dir)!.tables.labels.some((l) => l.id === "their-label")).toBe(true);
  });

  it("never writes one project over another's destination", async () => {
    const { storage, projects, project } = await withStorage();
    const dir = tmp("taken");
    await storage.bind(project.id, "folder", { dir });
    const second = projects.create({ name: "Second" });
    await expect(storage.bind(second.id, "folder", { dir })).rejects.toThrow(ForeignProjectError);
  });

  it("attaches a project this machine does not know, and unbinding leaves the files alone", async () => {
    const source = await withStorage();
    const dir = tmp("shared");
    const shared = source.projects.create({ name: "Shared", keyPrefix: "SHR" });
    source.items.create({ title: "From the other machine", projectId: shared.id, boardId: source.boards.defaultFor(shared.id).id, by: "human" });
    await source.storage.bind(shared.id, "folder", { dir });

    const other = await withStorage();
    expect(other.projects.get(shared.id)).toBeNull();
    const attached = await other.storage.attach("folder", { dir });
    expect(attached).toBe(shared.id);
    expect(other.projects.get(shared.id)?.name).toBe("Shared");
    expect(other.items.list({ projectId: shared.id }).map((i) => i.key)).toEqual(["SHR-1"]);
    expect(await other.storage.statusFor(shared.id)).toMatchObject({ state: "synced" });
    // Attaching twice is refused rather than duplicating a project.
    await expect(other.storage.attach("folder", { dir })).rejects.toThrow(/already on this machine/);

    await other.storage.unbind(shared.id);
    expect(await other.storage.statusFor(shared.id)).toMatchObject({ state: "local" });
    expect(fs.existsSync(path.join(dir, ".tomrade", "project.json"))).toBe(true);
  });

  it("forgets a destination whose project has been deleted", async () => {
    const { storage, projects } = await withStorage();
    const doomed = projects.create({ name: "Doomed" });
    const dir = tmp("doomed");
    await storage.bind(doomed.id, "folder", { dir });
    expect(storage.binding(doomed.id)).not.toBeNull();

    // Projects are removed through their own service, which knows nothing of destinations.
    projects.remove(doomed.id);
    expect(await storage.statusFor(doomed.id)).toMatchObject({ state: "local" });
    expect(storage.binding(doomed.id)).toBeNull();
    // The published copy is left exactly where it was.
    expect(fs.existsSync(path.join(dir, ".tomrade", "project.json"))).toBe(true);
  });

  it("reports a destination whose provider is not loaded, instead of failing", async () => {
    const home = tmp("unavailable");
    const file = path.join(home, "storage.json");
    // The project has to exist before its binding is read, so storage loads after the core.
    const bag = await fresh();
    fs.writeFileSync(file, JSON.stringify({ v: 1, bindings: [{ projectId: bag.project.id, provider: "ghost", config: {}, lastFlushedDigest: null, lastSyncAt: null }] }));
    await bag.ctx.plugin(Storage, { path: file, debounceMs: 60_000, reconcileMs: 0 });
    await settle();
    expect(await bag.ctx.storage.statusFor(bag.project.id)).toMatchObject({ state: "unavailable" });
  });
});
