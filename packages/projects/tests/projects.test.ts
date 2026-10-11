/**
 * Projects are the container. Each is its own cache file; the catalog says
 * which exist on this machine and survives a boot; removing one deletes the
 * file and everything in it, so nothing can be resurrected into it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { afterAll, describe, expect, it } from "vitest";
import { boards } from "@tomradex/boards";
import { Db } from "@tomradex/db";
import { keyPrefixFor, NotFoundError } from "@tomradex/domain";
import { Fields } from "@tomradex/fields";
import { Hub } from "@tomradex/hub";
import { Items } from "@tomradex/items";
import { Oplog } from "@tomradex/oplog";
import { Projects } from "@tomradex/projects";
import { fresh, settle } from "@tomradex/testkit";
import { policy } from "@tomradex/write";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-projects-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** The real thing: a file-backed pool and a file-backed Hub, so a second boot finds the catalog. */
async function bootFrom(userData: string) {
  const ctx = new Context();
  await ctx.plugin(Db, { dir: path.join(userData, "cache") });
  await ctx.plugin(Hub, {
    stateFile: path.join(userData, "hub.json"),
    catalogFile: path.join(userData, "catalog.json"),
    deviceFile: path.join(userData, "device.json"),
    defaultDir: path.join(userData, "Tomrade")
  });
  await ctx.plugin(Oplog);
  await ctx.plugin(policy);
  await ctx.plugin(Fields);
  await ctx.plugin(Items);
  await ctx.plugin(boards);
  await ctx.plugin(Projects, { legacyPath: path.join(userData, "tomrade.db"), backupsDir: path.join(userData, "backups") });
  await settle();
  return ctx;
}

describe("projects", () => {
  it("seeds a default project with one workstream and the default views", async () => {
    const { projects, boards, views, project } = await fresh();
    expect(project.id).not.toBe("default");
    expect(project.name).toBe("Default Project");
    expect(project.keyPrefix).toBe("TOM");
    expect(projects.list().length).toBe(1);
    expect(boards.list(project.id).map((b) => b.name)).toEqual(["Main"]);
    expect(views.listForProject(project.id).map((v) => v.name)).toEqual(["Backlog", "Recently updated"]);
  });

  it("names the seeded workstream and views in the language asked for", async () => {
    const { projects, boards, views } = await fresh();
    const p = projects.create({ name: "番茄", locale: "zh-CN" });
    expect(boards.list(p.id).map((b) => b.name)).toEqual(["主线"]);
    expect(views.listForProject(p.id).map((v) => v.name)).toEqual(["看板", "最近更新"]);
  });

  it("a seed fills a project before anyone hears of it, leaves no history, and takes the project with it when it fails", async () => {
    const { ctx, projects, items, boards } = await fresh();
    const heard: string[] = [];
    ctx.on("projects/created", (p) => heard.push(`${p.name}:${items.list({ projectId: p.id }).length}`));
    const seeded = projects.create(
      { name: "Seeded" },
      { seed: (p) => void items.create({ projectId: p.id, boardId: boards.list(p.id)[0].id, title: "Already here", by: "human" }) }
    );
    expect(heard).toEqual(["Seeded:1"]);
    expect(ctx.db.for(seeded.id).prepare("SELECT COUNT(*) AS n FROM oplog").get()).toEqual({ n: 0 });

    expect(() => projects.create({ name: "Broken" }, { seed: () => { throw new Error("no"); } })).toThrow("no");
    expect(projects.list().map((p) => p.name)).toEqual(["Default Project", "Seeded"]);
    expect(heard).toEqual(["Seeded:1"]);
  });

  it("derives a key prefix from the project name", () => {
    expect(keyPrefixFor("Tomrade Next")).toBe("TOM");
    expect(keyPrefixFor("42")).toBe("ISS");
  });

  it("create/list/update/remove projects", async () => {
    const { ctx, projects, hub } = await fresh();
    const p = projects.create({ name: "Acme App", description: "v2" });
    expect(projects.list().length).toBe(2);
    expect(projects.get(p.id)?.description).toBe("v2");
    expect(p.keyPrefix).toBe("ACM");
    expect(ctx.db.has(p.id)).toBe(true);
    expect(hub.catalog.project(p.id)?.keyPrefix).toBe("ACM");
    expect(projects.update(p.id, { name: "Acme App 2" })?.name).toBe("Acme App 2");
    expect(hub.catalog.project(p.id)?.name).toBe("Acme App 2");
    projects.remove(p.id);
    expect(projects.get(p.id)).toBeNull();
    expect(ctx.db.has(p.id)).toBe(false);
    expect(hub.catalog.project(p.id)).toBeNull();
  });

  it("items are scoped per project; removing a project takes its file, items and boards with it", async () => {
    const { ctx, projects, boards, items, board, project } = await fresh();
    const p = projects.create({ name: "P" });
    items.create({ title: "in P", projectId: p.id, boardId: boards.defaultFor(p.id).id, by: "human" });
    items.create({ title: "in default", projectId: project.id, boardId: board.id, by: "human" });
    expect(items.list({ projectId: p.id }).length).toBe(1);
    expect(items.list({ projectId: project.id }).length).toBe(1);
    expect(items.list().length).toBe(2);
    projects.remove(p.id);
    expect(ctx.db.has(p.id)).toBe(false);
    expect(items.list().length).toBe(1);
    expect(items.list({ projectId: project.id }).length).toBe(1);
  });

  it("deleting a project takes its history, so undo cannot resurrect into it", async () => {
    const { oplog, projects, boards, items } = await fresh();
    const p = projects.create({ name: "Doomed" });
    const doomed = items.create({ title: "in P", projectId: p.id, boardId: boards.defaultFor(p.id).id, by: "human" });
    projects.remove(p.id);
    expect(() => oplog.undoLast(p.id, doomed.id)).toThrow(/not open/);
    expect(projects.get(p.id)).toBeNull();
  });

  it("a patch only writes the fields it carries", async () => {
    const { projects } = await fresh();
    const p = projects.create({ name: "Acme", description: "v2" });
    expect(projects.update(p.id, { archived: true })).toMatchObject({ name: "Acme", description: "v2", archived: true });
    expect(projects.update(p.id, { description: null })).toMatchObject({ name: "Acme", description: null, archived: true });
  });

  it("archived lives in the catalog, per machine", async () => {
    const { projects, hub } = await fresh();
    const p = projects.create({ name: "Old" });
    projects.update(p.id, { archived: true });
    expect(hub.catalog.project(p.id)?.archived).toBe(true);
    expect(projects.get(p.id)?.archived).toBe(true);
  });

  it("an edge across projects cannot exist: each project is one file", async () => {
    const { projects, boards, items, board, project } = await fresh();
    const p = projects.create({ name: "Other" });
    const here = items.create({ title: "here", projectId: project.id, boardId: board.id, by: "human" });
    const there = items.create({ title: "there", projectId: p.id, boardId: boards.defaultFor(p.id).id, by: "human" });
    expect(() => items.addRelation(project.id, here.id, there.id)).toThrow(NotFoundError);
    expect(items.get(project.id, here.id)?.blocks).toEqual([]);
  });

  it("the catalog survives a boot: a deleted project stays deleted, a created one is still there", async () => {
    const userData = path.join(root, "boot-1");
    const first = await bootFrom(userData);
    const seeded = first.projects.list()[0]!;
    first.projects.create({ name: "Keeper" });
    first.projects.remove(seeded.id);
    await first.fiber.dispose();
    const second = await bootFrom(userData);
    expect(second.projects.list().map((p) => p.name)).toEqual(["Keeper"]);
    expect(second.db.openIds().length).toBe(1);
    await second.fiber.dispose();
  });

  it("an emptied catalog is seeded again, so Tomrade always opens on a project", async () => {
    const userData = path.join(root, "boot-2");
    const first = await bootFrom(userData);
    first.projects.remove(first.projects.list()[0]!.id);
    expect(first.projects.list()).toEqual([]);
    await first.fiber.dispose();
    const second = await bootFrom(userData);
    const project = second.projects.list()[0]!;
    expect(project.name).toBe("Default Project");
    expect(second.boards.list(project.id).length).toBe(1);
    expect(second.views.listForProject(project.id).length).toBe(2);
    await second.fiber.dispose();
  });

  it("the device id is stable across boots", async () => {
    const userData = path.join(root, "boot-3");
    const first = await bootFrom(userData);
    const id = first.hub.deviceId;
    await first.fiber.dispose();
    const second = await bootFrom(userData);
    expect(second.hub.deviceId).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    await second.fiber.dispose();
  });

  it("keys are per project, so two projects can both hold #1", async () => {
    const { projects, boards, items, board, project } = await fresh();
    const p = projects.create({ name: "Acme" });
    const a = items.create({ title: "A", projectId: project.id, boardId: board.id, by: "human" });
    const b = items.create({ title: "B", projectId: p.id, boardId: boards.defaultFor(p.id).id, by: "human" });
    expect(a.key).toBe("TOM-1");
    expect(b.key).toBe("ACM-1");
  });
});
