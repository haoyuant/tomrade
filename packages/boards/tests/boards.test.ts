/**
 * Boards are the Workstream field's options and own their issues; views belong
 * to the project and are one layout plus one query.
 */
import { describe, expect, it } from "vitest";
import { InUseError } from "@tomrade/domain";
import { fresh } from "@tomrade/testkit";

describe("boards (workstreams)", () => {
  it("a new project has one workstream and the default views", async () => {
    const { boards, views, project } = await fresh();
    expect(boards.list(project.id).map((b) => b.name)).toEqual(["Main"]);
    expect(views.listForProject(project.id).map((v) => `${v.name}:${v.layout}`)).toEqual(["Backlog:board", "Recently updated:table"]);
  });

  it("creating a workstream is undoable and creates no views", async () => {
    const { oplog, boards, views, project } = await fresh();
    const before = views.listForProject(project.id).length;
    const b = boards.create({ projectId: project.id, name: "UI", icon: "i-panel", subtitle: "packages/ui" });
    expect(views.listForProject(project.id).length).toBe(before);
    expect(oplog.undoLast()?.summary).toBe("Removed UI");
    expect(boards.get(b.id)).toBeNull();
  });

  it("bulk move rewrites board_id and bumps version, keeping status and rank", async () => {
    const { boards, items, board, project } = await fresh();
    const dest = boards.create({ projectId: project.id, name: "Core" });
    const a = items.create({ title: "A", boardId: board.id, status: "doing", rank: 3, by: "human" });
    boards.moveItems(board.id, dest.id, [a.id]);
    const moved = items.get(a.id)!;
    expect(moved.boardId).toBe(dest.id);
    expect(moved.status).toBe("doing");
    expect(moved.rank).toBe(3);
    expect(moved.version).toBe(2);
  });

  it("updating a workstream keeps its glyph and package", async () => {
    const { boards, project } = await fresh();
    const b = boards.create({ projectId: project.id, name: "UI" });
    const next = boards.update(b.id, { name: "Interface", icon: "i-panel", subtitle: "packages/ui" });
    expect([next.name, next.icon, next.subtitle]).toEqual(["Interface", "i-panel", "packages/ui"]);
  });

  it("a workstream that still holds issues, or is the last one, refuses to be deleted", async () => {
    const { boards, items, board, project } = await fresh();
    expect(() => boards.remove(board.id)).toThrow(InUseError);
    const dest = boards.create({ projectId: project.id, name: "Elsewhere" });
    items.create({ title: "A", boardId: board.id, by: "human" });
    expect(() => boards.remove(board.id)).toThrow(InUseError);
    boards.moveItems(board.id, dest.id, items.list({ boardId: board.id }).map((i) => i.id));
    expect(() => boards.remove(board.id)).not.toThrow();
  });

  it("moveItems reports the rows it actually changed", async () => {
    const { boards, items, board, project } = await fresh();
    const dest = boards.create({ projectId: project.id, name: "Dest" });
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: dest.id, by: "human" });
    expect(boards.moveItems(board.id, dest.id, [a.id, b.id])).toBe(1);
  });

  it("undoing a workstream create is refused once work has been moved onto it", async () => {
    const { oplog, boards, items, board, project } = await fresh();
    const dest = boards.create({ projectId: project.id, name: "Dest" });
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    boards.moveItems(board.id, dest.id, [a.id]);
    expect(() => oplog.undoLast(dest.id)).toThrow(InUseError);
    expect(boards.get(dest.id)).not.toBeNull();
  });
});

describe("views", () => {
  it("create stores a normalized query and lands at the end of the roster", async () => {
    const { views, project } = await fresh();
    const v = views.create({ projectId: project.id, name: "Bugs", icon: "i-bug", query: { filter: [{ field: "labels", op: "in", values: ["bug"] }], sortBy: [{ field: "priority", dir: "asc" }] } });
    expect(v.layout).toBe("board");
    expect(v.query.columnBy).toBe("status");
    expect(v.query.filter).toEqual([{ field: "labels", op: "in", values: ["bug"] }]);
    expect(v.query.sortBy).toEqual([{ field: "priority", dir: "asc" }]);
    expect(views.listForProject(project.id).at(-1)?.id).toBe(v.id);
  });

  it("update rewrites layout, query and name; the change is undoable", async () => {
    const { oplog, views, project } = await fresh();
    const v = views.listForProject(project.id)[0];
    const next = views.update(v.id, { name: "Sprint", layout: "table", query: { ...v.query, groupBy: "board", wip: { doing: 3 } } });
    expect([next.name, next.layout, next.query.groupBy, next.query.wip]).toEqual(["Sprint", "table", "board", { doing: 3 }]);
    oplog.undoLast();
    const back = views.get(v.id)!;
    expect([back.name, back.layout, back.query.groupBy]).toEqual(["Backlog", "board", null]);
  });

  it("removing a view takes its manual order with it, and undo brings both back", async () => {
    const { oplog, views, items, board, project } = await fresh();
    const v = views.create({ projectId: project.id, name: "Temp" });
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    views.setRank(v.id, a.id, 1.5);
    views.remove(v.id);
    expect(views.get(v.id)).toBeNull();
    expect(views.ranks(v.id)).toEqual({});
    oplog.undoLast(v.id);
    expect(views.get(v.id)?.name).toBe("Temp");
    expect(views.ranks(v.id)).toEqual({ [a.id]: 1.5 });
  });

  it("the project's last view refuses to go", async () => {
    const { views, project } = await fresh();
    const all = views.listForProject(project.id);
    for (const v of all.slice(1)) views.remove(v.id);
    expect(() => views.remove(all[0].id)).toThrow(InUseError);
  });

  it("per-view rank is sparse and falls back to items.rank", async () => {
    const { views, items, board, project } = await fresh();
    const v = views.listForProject(project.id)[0];
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    expect(views.ranks(v.id)).toEqual({});
    views.setRank(v.id, a.id, 1.5);
    expect(views.ranks(v.id)).toEqual({ [a.id]: 1.5 });
    views.setRank(v.id, a.id, 2.5);
    expect(views.ranks(v.id)).toEqual({ [a.id]: 2.5 });
  });

  it("editing a view is undoable and does not consume an item's undo", async () => {
    const { oplog, views, items, board, project } = await fresh();
    const v = views.listForProject(project.id)[0];
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    views.update(v.id, { query: { ...v.query, columns: ["todo"] } });
    oplog.undoLast();
    expect(views.get(v.id)?.query.columns).toEqual([]);
    expect(items.get(a.id)).not.toBeNull();
  });
});
