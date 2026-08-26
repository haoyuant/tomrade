/**
 * Projects: create/list/update/remove + the boards and views seeded with them.
 */
import { describe, expect, it } from "vitest";
import { keyPrefixFor, undoLast } from "../src/index.js";
import { fresh } from "./helpers.js";

describe("projects", () => {
  it("seeds a default project with one board and two cross-board scopes", () => {
    const { projects, boards, views, project } = fresh();
    expect(project.id).toBe("default");
    expect(projects.list().length).toBe(1);
    const all = boards.list(project.id);
    expect(all.filter((b) => !b.across).map((b) => b.name)).toEqual(["All work"]);
    expect(all.filter((b) => b.across).map((b) => b.name)).toEqual(["Recently updated", "Epics"]);
    expect(views.listForBoard(all[0].id).map((v) => v.name)).toEqual(["All work"]);
  });

  it("derives a key prefix from the project name", () => {
    expect(keyPrefixFor("Tomrade Next")).toBe("TOM");
    expect(keyPrefixFor("42")).toBe("ISS");
  });

  it("create/list/update/remove projects", () => {
    const { projects } = fresh();
    const p = projects.create({ name: "Acme App", description: "v2" });
    expect(projects.list().length).toBe(2);
    expect(projects.get(p.id)?.description).toBe("v2");
    expect(p.keyPrefix).toBe("ACM");
    const renamed = projects.update(p.id, { name: "Acme App 2" });
    expect(renamed?.name).toBe("Acme App 2");
    projects.remove(p.id);
    expect(projects.get(p.id)).toBeNull();
  });

  it("items are scoped per project; removing a project cascades its items and boards", () => {
    const { projects, boards, items, board } = fresh();
    const p = projects.create({ name: "P" });
    const pBoard = boards.list(p.id).find((b) => !b.across)!;
    items.create({ title: "in P", projectId: p.id, boardId: pBoard.id, by: "human" });
    items.create({ title: "in default", boardId: board.id, by: "human" });
    expect(items.list({ projectId: p.id }).length).toBe(1);
    expect(items.list({ projectId: "default" }).length).toBe(1);
    projects.remove(p.id);
    expect(items.list({ projectId: p.id }).length).toBe(0);
    expect(boards.list(p.id).length).toBe(0);
    expect(items.list({ projectId: "default" }).length).toBe(1);
  });

  it("deleting a project takes its history, so undo cannot resurrect into it", () => {
    const { db, projects, boards, items } = fresh();
    const p = projects.create({ name: "Doomed" });
    const pBoard = boards.list(p.id).find((b) => !b.across)!;
    const doomed = items.create({ title: "in P", projectId: p.id, boardId: pBoard.id, by: "human" });
    projects.remove(p.id);
    expect(undoLast(db, doomed.id)).toBeNull();
    expect(items.get(doomed.id)).toBeNull();
  });

  it("keys are per project, so two projects can both hold #1", () => {
    const { projects, boards, items, board } = fresh();
    const p = projects.create({ name: "Acme" });
    const pBoard = boards.list(p.id).find((b) => !b.across)!;
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", projectId: p.id, boardId: pBoard.id, by: "human" });
    expect(a.key).toBe("TOM-1");
    expect(b.key).toBe("ACM-1");
  });
});
