/**
 * Boards are the Workstream field's options and own their issues; views belong
 * to the project and are one layout plus one query. Every call names the
 * project first: each project is its own file.
 */
import { describe, expect, it } from "vitest";
import { InUseError } from "@tomradex/domain";
import { fresh } from "@tomradex/testkit";

describe("boards (workstreams)", () => {
  it("a new project has one workstream and the default views", async () => {
    const { boards, views, project } = await fresh();
    expect(boards.list(project.id).map((b) => b.name)).toEqual(["Main"]);
    expect(views.listForProject(project.id).map((v) => `${v.name}:${v.layout}`)).toEqual(["Backlog:board", "Recently updated:table", "By status:table", "By epic:table", "By priority:table", "By workstream:table"]);
    const byEpic = views.listForProject(project.id).find((v) => v.name === "By epic")!;
    expect(byEpic.query.groupBy).toBe("epic");
    expect(byEpic.query.sortBy).toEqual([
      { field: "priority", dir: "asc" },
      { field: "updated", dir: "desc" }
    ]);
  });

  it("creating a workstream is undoable and creates no views", async () => {
    const { oplog, boards, views, project } = await fresh();
    const before = views.listForProject(project.id).length;
    const b = boards.create({ projectId: project.id, name: "UI", icon: "i-panel" });
    expect(views.listForProject(project.id).length).toBe(before);
    expect(oplog.undoLast(project.id)?.summary).toBe("Removed UI");
    expect(boards.get(project.id, b.id)).toBeNull();
  });

  it("bulk move rewrites board_id and bumps version, keeping status and rank", async () => {
    const { boards, items, board, project } = await fresh();
    const dest = boards.create({ projectId: project.id, name: "Core" });
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, status: "doing", rank: 3, by: "human" });
    boards.moveItems(project.id, board.id, dest.id, [a.id]);
    const moved = items.get(project.id, a.id)!;
    expect(moved.boardId).toBe(dest.id);
    expect(moved.status).toBe("doing");
    expect(moved.rank).toBe(3);
    expect(moved.version).toBe(2);
  });

  it("a bulk move is one logged write per issue, so it travels and undoes an issue at a time", async () => {
    const { boards, items, oplog, board, project } = await fresh();
    const dest = boards.create({ projectId: project.id, name: "Core" });
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    boards.moveItems(project.id, board.id, dest.id, [a.id, b.id], "ai:test");
    const moves = oplog.recent(project.id, 10).filter((e) => e.entity === "item" && e.op === "update");
    expect(moves.length).toBe(2);
    expect(moves.every((e) => e.by === "ai:test" && e.patch?.boardId === dest.id)).toBe(true);
    oplog.undoLast(project.id);
    expect([items.get(project.id, a.id)!.boardId, items.get(project.id, b.id)!.boardId].sort()).toEqual([board.id, dest.id].sort());
  });

  it("updating a workstream keeps its glyph", async () => {
    const { boards, project } = await fresh();
    const b = boards.create({ projectId: project.id, name: "UI" });
    const next = boards.update(project.id, b.id, { name: "Interface", icon: "i-panel" });
    expect([next.name, next.icon]).toEqual(["Interface", "i-panel"]);
  });

  it("a workstream that still holds issues, or is the last one, refuses to be deleted", async () => {
    const { boards, items, board, project } = await fresh();
    expect(() => boards.remove(project.id, board.id)).toThrow(InUseError);
    const dest = boards.create({ projectId: project.id, name: "Elsewhere" });
    items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    expect(() => boards.remove(project.id, board.id)).toThrow(InUseError);
    boards.moveItems(
      project.id,
      board.id,
      dest.id,
      items.list({ projectId: project.id, boardId: board.id }).map((i) => i.id)
    );
    expect(() => boards.remove(project.id, board.id)).not.toThrow();
  });

  it("moveItems reports the rows it actually changed", async () => {
    const { boards, items, board, project } = await fresh();
    const dest = boards.create({ projectId: project.id, name: "Dest" });
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: dest.id, by: "human" });
    expect(boards.moveItems(project.id, board.id, dest.id, [a.id, b.id])).toBe(1);
  });

  it("undoing a workstream create is refused once work has been moved onto it", async () => {
    const { oplog, boards, items, board, project } = await fresh();
    const dest = boards.create({ projectId: project.id, name: "Dest" });
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    boards.moveItems(project.id, board.id, dest.id, [a.id]);
    expect(() => oplog.undoLast(project.id, dest.id)).toThrow(InUseError);
    expect(boards.get(project.id, dest.id)).not.toBeNull();
  });

  it("two projects are two files: a board id from one is unknown to the other", async () => {
    const { boards, projects, project } = await fresh();
    const other = projects.create({ name: "Other" });
    const b = boards.create({ projectId: other.id, name: "Theirs" });
    expect(boards.get(project.id, b.id)).toBeNull();
    expect(boards.get(other.id, b.id)?.name).toBe("Theirs");
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
    const next = views.update(project.id, v.id, { name: "Sprint", layout: "table", query: { ...v.query, groupBy: "board", wip: { doing: 3 } } });
    expect([next.name, next.layout, next.query.groupBy, next.query.wip]).toEqual(["Sprint", "table", "board", { doing: 3 }]);
    oplog.undoLast(project.id);
    const back = views.get(project.id, v.id)!;
    expect([back.name, back.layout, back.query.groupBy]).toEqual(["Backlog", "board", null]);
  });

  it("removing a view takes its manual order with it, and undo brings both back", async () => {
    const { oplog, views, items, board, project } = await fresh();
    const v = views.create({ projectId: project.id, name: "Temp" });
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    views.setRank(project.id, v.id, a.id, 1.5);
    views.remove(project.id, v.id);
    expect(views.get(project.id, v.id)).toBeNull();
    expect(views.ranks(project.id, v.id)).toEqual({});
    oplog.undoLast(project.id, v.id);
    expect(views.get(project.id, v.id)?.name).toBe("Temp");
    expect(views.ranks(project.id, v.id)).toEqual({ [a.id]: 1.5 });
  });

  it("the project's last view refuses to go", async () => {
    const { views, project } = await fresh();
    const all = views.listForProject(project.id);
    for (const v of all.slice(1)) views.remove(project.id, v.id);
    expect(() => views.remove(project.id, all[0].id)).toThrow(InUseError);
  });

  it("per-view rank is sparse and falls back to items.rank", async () => {
    const { views, items, board, project } = await fresh();
    const v = views.listForProject(project.id)[0];
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    expect(views.ranks(project.id, v.id)).toEqual({});
    views.setRank(project.id, v.id, a.id, 1.5);
    expect(views.ranks(project.id, v.id)).toEqual({ [a.id]: 1.5 });
    views.setRank(project.id, v.id, a.id, 2.5);
    expect(views.ranks(project.id, v.id)).toEqual({ [a.id]: 2.5 });
  });

  it("a drag is its own logged op, and undo moves the item back — or out, when it had no row", async () => {
    const { oplog, views, items, board, project } = await fresh();
    const v = views.listForProject(project.id)[0];
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    views.setRank(project.id, v.id, a.id, 1.5);
    views.setRank(project.id, v.id, a.id, 2.5);
    const latest = oplog.recent(project.id, 1)[0];
    expect([latest.entity, latest.op, latest.entityId]).toEqual(["view", "rank", v.id]);
    expect(latest.patch).toEqual({ itemId: a.id, rank: 2.5 });
    expect(oplog.undoLast(project.id)?.summary).toMatch(/Moved back/);
    expect(views.ranks(project.id, v.id)).toEqual({ [a.id]: 1.5 });
    oplog.undoLast(project.id);
    expect(views.ranks(project.id, v.id)).toEqual({});
    // the item's own history is untouched by rank undos
    expect(items.get(project.id, a.id)).not.toBeNull();
  });

  it("a renumbered column is one logged op: one undo puts it all back, one redo replays it", async () => {
    const { oplog, views, items, board, project } = await fresh();
    const v = views.listForProject(project.id)[0];
    const [a, b, c] = ["A", "B", "C"].map((title) => items.create({ projectId: project.id, title, boardId: board.id, by: "human" }));
    views.setRank(project.id, v.id, a.id, 5);
    const before = oplog.recent(project.id, 50).length;
    views.setRanks(project.id, v.id, { [c.id]: 0, [a.id]: 1, [b.id]: 2 });
    expect(oplog.recent(project.id, 50).length).toBe(before + 1);
    expect(views.ranks(project.id, v.id)).toEqual({ [c.id]: 0, [a.id]: 1, [b.id]: 2 });
    expect(oplog.undoLast(project.id)?.summary).toMatch(/Moved back/);
    expect(views.ranks(project.id, v.id)).toEqual({ [a.id]: 5 });
    await oplog.redo(project.id);
    expect(views.ranks(project.id, v.id)).toEqual({ [c.id]: 0, [a.id]: 1, [b.id]: 2 });
  });

  it("editing a view is undoable and does not consume an item's undo", async () => {
    const { oplog, views, items, board, project } = await fresh();
    const v = views.listForProject(project.id)[0];
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    views.update(project.id, v.id, { query: { ...v.query, columns: ["todo"] } });
    oplog.undoLast(project.id);
    expect(views.get(project.id, v.id)?.query.columns).toEqual([]);
    expect(items.get(project.id, a.id)).not.toBeNull();
  });
});
