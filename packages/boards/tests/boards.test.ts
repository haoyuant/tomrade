/**
 * Boards own issues; views slice one board. A drag never changes board_id —
 * only the deliberate bulk move in board settings does.
 */
import { describe, expect, it } from "vitest";
import { InUseError } from "@tomrade/domain";
import { fresh } from "@tomrade/testkit";

describe("boards", () => {
  it("a new board always gets the All work view", async () => {
    const { boards, views, project } = await fresh();
    const b = boards.create({ projectId: project.id, name: "UI", icon: "i-panel", subtitle: "packages/ui" });
    const list = views.listForBoard(b.id);
    expect(list.map((v) => v.name)).toEqual(["All work"]);
    expect(list[0].columns).toEqual(["backlog", "todo", "doing", "verifying", "done", "cancelled"]);
    expect(b.defaultViewId).toBe(list[0].id);
  });

  it("boards sort workstreams before cross-board scopes", async () => {
    const { boards, project } = await fresh();
    boards.create({ projectId: project.id, name: "UI" });
    expect(boards.list(project.id).map((b) => b.across)).toEqual([false, false, true, true]);
  });

  it("creating a board is undoable and takes its views with it", async () => {
    const { oplog, boards, views, project } = await fresh();
    const b = boards.create({ projectId: project.id, name: "Temp" });
    expect(oplog.undoLast()?.summary).toBe("Removed Temp");
    expect(boards.get(b.id)).toBeNull();
    expect(views.listForBoard(b.id).length).toBe(0);
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

  it("updating a board keeps its glyph and package", async () => {
    const { boards, project } = await fresh();
    const b = boards.create({ projectId: project.id, name: "UI" });
    const next = boards.update(b.id, { name: "Interface", icon: "i-panel", subtitle: "packages/ui" });
    expect([next.name, next.icon, next.subtitle]).toEqual(["Interface", "i-panel", "packages/ui"]);
  });
});

describe("views", () => {
  it("stores grouping, columns, filter and WIP caps", async () => {
    const { views, board } = await fresh();
    const v = views.create({
      boardId: board.id,
      name: "Sprint 12",
      icon: "i-clock",
      groupBy: "status",
      columns: ["todo", "doing", "verifying", "done"],
      filter: { labels: ["bug"], priorities: [3, 4] },
      wip: { doing: 3 }
    });
    const read = views.get(v.id)!;
    expect(read.columns).toEqual(["todo", "doing", "verifying", "done"]);
    expect(read.filter).toEqual({ labels: ["bug"], priorities: [3, 4] });
    expect(read.wip).toEqual({ doing: 3 });
  });

  it("per-view rank is sparse and falls back to items.rank", async () => {
    const { views, items, board } = await fresh();
    const v = views.listForBoard(board.id)[0];
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    expect(views.ranks(v.id)).toEqual({});
    views.setRank(v.id, a.id, 1.5);
    expect(views.ranks(v.id)).toEqual({ [a.id]: 1.5 });
    views.setRank(v.id, a.id, 2.5);
    expect(views.ranks(v.id)).toEqual({ [a.id]: 2.5 });
  });

  it("removing a view drops its ranks", async () => {
    const { views, items, board } = await fresh();
    const v = views.create({ boardId: board.id, name: "Temp" });
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    views.setRank(v.id, a.id, 1);
    views.remove(v.id);
    expect(views.get(v.id)).toBeNull();
    expect(views.ranks(v.id)).toEqual({});
  });
});

describe("destructive writes", () => {
  it("a board that still owns issues refuses to be deleted", async () => {
    const { boards, items, board, project } = await fresh();
    items.create({ title: "A", boardId: board.id, by: "human" });
    expect(() => boards.remove(board.id)).toThrow(InUseError);
    const dest = boards.create({ projectId: project.id, name: "Elsewhere" });
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

  it("undoing a board delete restores the views it was deleted with", async () => {
    const { oplog, boards, views, project } = await fresh();
    const b = boards.create({ projectId: project.id, name: "Temp" });
    const extra = views.create({ boardId: b.id, name: "Sprint" });
    boards.remove(b.id);
    expect(views.listForBoard(b.id).length).toBe(0);
    oplog.undoLast();
    expect(boards.get(b.id)?.name).toBe("Temp");
    expect(views.listForBoard(b.id).map((v) => v.name).sort()).toEqual(["All work", "Sprint"]);
    expect(views.get(extra.id)).not.toBeNull();
  });

  it("undoing a board create is refused once work has been moved onto it", async () => {
    const { oplog, boards, items, board, project } = await fresh();
    const dest = boards.create({ projectId: project.id, name: "Dest" });
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    boards.moveItems(board.id, dest.id, [a.id]);
    expect(() => oplog.undoLast(dest.id)).toThrow(InUseError);
    expect(boards.get(dest.id)).not.toBeNull();
  });

  it("removing a view is undoable, ranks included", async () => {
    const { oplog, views, items, board } = await fresh();
    const v = views.create({ boardId: board.id, name: "Temp" });
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    views.setRank(v.id, a.id, 4);
    views.remove(v.id);
    expect(views.get(v.id)).toBeNull();
    oplog.undoLast();
    expect(views.get(v.id)?.name).toBe("Temp");
    expect(views.ranks(v.id)).toEqual({ [a.id]: 4 });
  });

  it("editing a view is undoable and does not consume an item's undo", async () => {
    const { oplog, views, items, board } = await fresh();
    const v = views.listForBoard(board.id)[0];
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    views.update(v.id, { name: "Renamed" });
    oplog.undoLast();
    expect(views.get(v.id)?.name).toBe("All work");
    expect(items.get(a.id)).not.toBeNull();
  });
});
