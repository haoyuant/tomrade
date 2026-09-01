import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { keyPrefixFor } from "@tomrade/domain";
import { fresh } from "@tomrade/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-projects-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("projects", () => {
  it("seeds a default project with one board and two cross-board scopes", async () => {
    const { projects, boards, views, project } = await fresh();
    expect(project.id).toBe("default");
    expect(projects.list().length).toBe(1);
    const all = boards.list(project.id);
    expect(all.filter((b) => !b.across).map((b) => b.name)).toEqual(["Main"]);
    expect(all.filter((b) => b.across).map((b) => b.name)).toEqual(["Recently updated", "Epics"]);
    expect(views.listForBoard(all[0].id).map((v) => v.kind)).toEqual(["status", "priority", "epic", "dependencies"]);
  });

  it("derives a key prefix from the project name", () => {
    expect(keyPrefixFor("Tomrade Next")).toBe("TOM");
    expect(keyPrefixFor("42")).toBe("ISS");
  });

  it("create/list/update/remove projects", async () => {
    const { projects } = await fresh();
    const p = projects.create({ name: "Acme App", description: "v2" });
    expect(projects.list().length).toBe(2);
    expect(projects.get(p.id)?.description).toBe("v2");
    expect(p.keyPrefix).toBe("ACM");
    expect(projects.update(p.id, { name: "Acme App 2" })?.name).toBe("Acme App 2");
    projects.remove(p.id);
    expect(projects.get(p.id)).toBeNull();
  });

  it("items are scoped per project; removing a project cascades its items and boards", async () => {
    const { projects, boards, items, board } = await fresh();
    const p = projects.create({ name: "P" });
    items.create({ title: "in P", projectId: p.id, boardId: boards.defaultFor(p.id).id, by: "human" });
    items.create({ title: "in default", boardId: board.id, by: "human" });
    expect(items.list({ projectId: p.id }).length).toBe(1);
    expect(items.list({ projectId: "default" }).length).toBe(1);
    projects.remove(p.id);
    expect(items.list({ projectId: p.id }).length).toBe(0);
    expect(boards.list(p.id).length).toBe(0);
    expect(items.list({ projectId: "default" }).length).toBe(1);
  });

  it("deleting a project takes its history, so undo cannot resurrect into it", async () => {
    const { oplog, projects, boards, items } = await fresh();
    const p = projects.create({ name: "Doomed" });
    const doomed = items.create({ title: "in P", projectId: p.id, boardId: boards.defaultFor(p.id).id, by: "human" });
    projects.remove(p.id);
    expect(oplog.undoLast(doomed.id)).toBeNull();
    expect(items.get(doomed.id)).toBeNull();
  });

  it("a patch only writes the fields it carries", async () => {
    const { projects } = await fresh();
    const p = projects.create({ name: "Acme", description: "v2" });
    expect(projects.update(p.id, { archived: true })).toMatchObject({ name: "Acme", description: "v2", archived: true });
    expect(projects.update(p.id, { description: null })).toMatchObject({ name: "Acme", description: null, archived: true });
  });

  it("removing a project cuts relations pointing into it from another project", async () => {
    const { db, projects, boards, items, board } = await fresh();
    const p = projects.create({ name: "Doomed" });
    const outside = items.create({ title: "stays", boardId: board.id, by: "human" });
    const inside = items.create({ title: "goes", projectId: p.id, boardId: boards.defaultFor(p.id).id, by: "human" });
    // Nothing stops an agent relating across projects, and each edge is one row.
    items.addRelation(outside.id, inside.id);
    items.addRelation(inside.id, outside.id);
    projects.remove(p.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM item_relations").get() as { n: number }).n).toBe(0);
    expect(items.get(outside.id)?.blocks).toEqual([]);
  });

  it("a project the human deleted stays deleted across a boot", async () => {
    const file = path.join(dir, "deleted-default.db");
    const first = await fresh({ dbPath: file });
    first.projects.create({ name: "Keeper" });
    first.projects.remove("default");
    await first.ctx.fiber.dispose();
    const second = await fresh({ dbPath: file });
    expect(second.projects.list().map((p) => p.name)).toEqual(["Keeper"]);
  });

  it("an emptied database is seeded again, so Tomrade always opens on a project", async () => {
    const file = path.join(dir, "emptied.db");
    const first = await fresh({ dbPath: file });
    first.projects.remove("default");
    expect(first.projects.list()).toEqual([]);
    await first.ctx.fiber.dispose();
    const second = await fresh({ dbPath: file });
    expect(second.projects.list().map((p) => p.name)).toEqual(["Default Project"]);
    expect(second.boards.list(second.project.id).length).toBe(3);
  });

  it("keys are per project, so two projects can both hold #1", async () => {
    const { projects, boards, items, board } = await fresh();
    const p = projects.create({ name: "Acme" });
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", projectId: p.id, boardId: boards.defaultFor(p.id).id, by: "human" });
    expect(a.key).toBe("TOM-1");
    expect(b.key).toBe("ACM-1");
  });
});
