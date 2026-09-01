/**
 * Write-path regression: a supplied baseVersion is enforced for every author,
 * only AI writes are refused on a locked item's protected fields, every
 * mutation lands in the oplog, and undo restores state.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, DependencyCycleError, HumanLockedError, NotFoundError, PurgeNotPermittedError, provenanceOf } from "@tomrade/domain";
import { fresh } from "@tomrade/testkit";

describe("items (write path)", () => {
  it("creates an item with version 1, a project key, and provenance", async () => {
    const { items, board } = await fresh();
    const item = items.create({ title: "Export report to PDF", boardId: board.id, by: "human" });
    expect(item.version).toBe(1);
    expect(item.status).toBe("backlog");
    expect(item.kind).toBe("ticket");
    expect(item.priority).toBe(2);
    expect(item.key).toBe("TOM-1");
    expect(item.boardId).toBe(board.id);
    expect(item.updatedBy).toBe("human");
    expect(item.humanLocked).toBe(false);
    expect(items.list().length).toBe(1);
  });

  it("assigns keys in sequence and never reuses one", async () => {
    const { items, board } = await fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    items.delete(b.id, "human");
    const c = items.create({ title: "C", boardId: board.id, by: "human" });
    expect([a.key, b.key, c.key]).toEqual(["TOM-1", "TOM-2", "TOM-3"]);
    expect(items.getByKey("default", "TOM-1")?.id).toBe(a.id);
  });

  it("lists with filters (status/kind/parent/board/label)", async () => {
    const { items, boards, board, project } = await fresh();
    const other = boards.create({ projectId: project.id, name: "Other" });
    const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const t1 = items.create({ title: "Export PDF", parentId: epic.id, boardId: board.id, labels: ["ui"], by: "human" });
    items.create({ title: "Dark mode", boardId: other.id, by: "human" });
    expect(items.list({ status: "backlog" }).length).toBe(3);
    expect(items.list({ kind: "ticket" }).length).toBe(2);
    expect(items.list({ boardId: other.id }).length).toBe(1);
    expect(items.list({ label: "ui" }).map((i) => i.id)).toEqual([t1.id]);
    expect(items.list({ parentId: epic.id }).map((i) => i.id)).toEqual([t1.id]);
    expect(items.list({ parentId: null }).length).toBe(2);
  });

  it("labels round-trip and register on the project", async () => {
    const { items, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, labels: ["ui", "bug"], by: "human" });
    expect(items.get(item.id)?.labels.sort()).toEqual(["bug", "ui"]);
    items.update(item.id, { labels: ["core"] }, "human");
    expect(items.get(item.id)?.labels).toEqual(["core"]);
    expect(items.labelsFor("default")).toEqual(["bug", "core", "ui"]);
  });

  it("blocks relations are exposed on the item", async () => {
    const { items, board } = await fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    items.addRelation(a.id, b.id);
    expect(items.get(a.id)?.blocks).toEqual([b.id]);
    expect(items.get(b.id)?.blocks).toEqual([]);
    items.removeRelation(a.id, b.id);
    expect(items.get(a.id)?.blocks).toEqual([]);
  });

  it("blocks edit through update: logged, versioned, and normalized", async () => {
    const { items, oplog, board } = await fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    const updated = items.update(a.id, { blocks: [b.id, b.id, a.id] }, "human", { baseVersion: 1 });
    expect(updated.blocks).toEqual([b.id]);
    expect(updated.version).toBe(2);
    expect(items.get(a.id)?.blocks).toEqual([b.id]);
    const entry = oplog.historyFor("item", a.id, 1)[0];
    expect((entry.before as { blocks: string[] }).blocks).toEqual([]);
    expect((entry.after as { blocks: string[] }).blocks).toEqual([b.id]);
    expect(items.update(a.id, { blocks: [] }, "human").blocks).toEqual([]);
    expect(items.get(a.id)?.blocks).toEqual([]);
  });

  it("a blocks edit that would close a cycle is refused, direct or transitive", async () => {
    const { items, board } = await fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    const c = items.create({ title: "C", boardId: board.id, by: "human" });
    items.update(a.id, { blocks: [b.id] }, "human");
    items.update(b.id, { blocks: [c.id] }, "human");
    expect(() => items.update(c.id, { blocks: [a.id] }, "human")).toThrow(DependencyCycleError);
    expect(() => items.update(b.id, { blocks: [c.id, a.id] }, "human")).toThrow(DependencyCycleError);
    expect(items.get(c.id)?.blocks).toEqual([]);
    // replacing the edge that made the path is fine — the check runs on the proposed graph
    expect(items.update(a.id, { blocks: [c.id] }, "human").blocks).toEqual([c.id]);
  });

  it("blocks targets must exist in the same project", async () => {
    const { items, projects, board } = await fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const elsewhere = projects.create({ name: "Elsewhere", keyPrefix: "ELS" });
    const foreign = items.create({ title: "F", projectId: elsewhere.id, boardId: board.id, by: "human" });
    expect(() => items.update(a.id, { blocks: ["ghost"] }, "human")).toThrow(NotFoundError);
    expect(() => items.update(a.id, { blocks: [foreign.id] }, "human")).toThrow(NotFoundError);
  });

  it("undo of a blocks edit restores the edges exactly", async () => {
    const { items, oplog, board } = await fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    const c = items.create({ title: "C", boardId: board.id, by: "human" });
    items.update(a.id, { blocks: [b.id] }, "human");
    items.update(a.id, { blocks: [c.id] }, "human");
    oplog.undoLast(a.id);
    expect(items.get(a.id)?.blocks).toEqual([b.id]);
    oplog.undoLast(a.id);
    expect(items.get(a.id)?.blocks).toEqual([]);
  });

  it("AI update with correct baseVersion applies and bumps version", async () => {
    const { items, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    const updated = items.update(item.id, { status: "todo" }, "ai:extraction", { baseVersion: 1 });
    expect(updated.status).toBe("todo");
    expect(updated.version).toBe(2);
    expect(updated.updatedBy).toBe("ai:extraction");
    expect(provenanceOf(updated)).toBe("ai");
  });

  it("AI update with stale baseVersion throws ConflictError", async () => {
    const { items, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "todo" }, "human");
    expect(() => items.update(item.id, { status: "done" }, "ai:mcp", { baseVersion: 1 })).toThrow(ConflictError);
  });

  it("a stale baseVersion is refused whoever asserted it", async () => {
    const { items, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "todo" }, "ai:mcp");
    expect(() => items.update(item.id, { status: "doing" }, "human", { baseVersion: 1 })).toThrow(ConflictError);
    expect(items.update(item.id, { status: "doing" }, "human").status).toBe("doing");
  });

  it("AI cannot touch title/body of a human-locked item", async () => {
    const { items, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { humanLocked: true }, "human");
    expect(() => items.update(item.id, { title: "hacked" }, "ai:mcp", { baseVersion: 2 })).toThrow(HumanLockedError);
    // the lock is checked before staleness, so the error names the real problem
    expect(() => items.update(item.id, { title: "hacked" }, "ai:mcp", { baseVersion: 1 })).toThrow(HumanLockedError);
    expect(() => items.update(item.id, { body: "x" }, "ai:extraction", { baseVersion: 2 })).toThrow(HumanLockedError);
    expect(provenanceOf(items.get(item.id)!)).toBe("locked");
  });

  it("humanLocked is human-only", async () => {
    const { items, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    expect(() => items.update(item.id, { humanLocked: true }, "ai:mcp", { baseVersion: 1 })).toThrow(HumanLockedError);
  });

  it("human edits on a locked item are still allowed", async () => {
    const { items, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { humanLocked: true }, "human");
    const edited = items.update(item.id, { title: "New title" }, "human");
    expect(edited.title).toBe("New title");
    expect(edited.humanLocked).toBe(true);
  });

  it("status + rank can be updated together (board drag semantics)", async () => {
    const { items, board } = await fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    const moved = items.update(a.id, { status: "doing", rank: b.rank + 1 }, "human", { baseVersion: 1 });
    expect(moved.status).toBe("doing");
    expect(moved.rank).toBe(b.rank + 1);
    expect(moved.version).toBe(2);
  });

  it("delete removes the item and records it in the oplog", async () => {
    const { items, oplog, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.delete(item.id, "human");
    expect(items.get(item.id)).toBeNull();
    expect(oplog.recent(10).some((o) => o.op === "delete" && o.entityId === item.id)).toBe(true);
  });

  it("undo restores the previous state, and undo of create removes the item", async () => {
    const { items, oplog, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "doing" }, "human");
    oplog.undoLast(item.id);
    expect(items.get(item.id)?.status).toBe("backlog");
    oplog.undoLast(item.id);
    expect(items.get(item.id)).toBeNull();
  });

  it("undo restores labels alongside the rest of the snapshot", async () => {
    const { items, oplog, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, labels: ["ui"], by: "human" });
    items.update(item.id, { labels: ["core", "ui"] }, "ai:mcp", { baseVersion: 1 });
    oplog.undoLast();
    expect(items.get(item.id)?.labels).toEqual(["ui"]);
  });

  it("oplog records every mutation with provenance", async () => {
    const { items, oplog, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "todo" }, "ai:extraction", { baseVersion: 1 });
    const log = oplog.historyFor("item", item.id, 10);
    expect(log.map((o) => o.op + ":" + o.by).join(",")).toBe("update:ai:extraction,create:human");
    expect(log[0].baseVersion).toBe(1);
    expect(log[1].baseVersion).toBeNull();
  });

  it("write/committed announces every landed write and no refused one", async () => {
    const { ctx, items, board } = await fresh();
    const seen: string[] = [];
    ctx.on("write/committed", (intent) => seen.push(`${intent.entity}:${intent.op}`));
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "todo" }, "human");
    expect(() => items.update(item.id, { status: "done" }, "ai:mcp", { baseVersion: 1 })).toThrow(ConflictError);
    expect(seen).toEqual(["item:create", "item:update"]);
  });

  it("undo of a delete restores the blocks relations in both directions", async () => {
    const { items, oplog, board } = await fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    items.addRelation(a.id, b.id);
    items.addRelation(b.id, a.id);
    items.delete(a.id, "human");
    oplog.undoLast();
    expect(items.get(a.id)?.blocks).toEqual([b.id]);
    expect(items.get(b.id)?.blocks).toEqual([a.id]);
  });

  it("deleting an epic releases its children rather than orphaning them", async () => {
    const { items, board } = await fresh();
    const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const child = items.create({ title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    items.delete(epic.id, "human");
    expect(items.get(child.id)?.parentId).toBeNull();
  });

  it("creating into a project that does not exist is refused", async () => {
    const { items, board } = await fresh();
    expect(() => items.create({ title: "A", projectId: "ghost", boardId: board.id, by: "human" })).toThrow(NotFoundError);
  });

  it("update on missing item throws NotFoundError", async () => {
    const { items } = await fresh();
    expect(() => items.update("nope", { status: "done" }, "human")).toThrow(NotFoundError);
  });
});

describe("items (permanent purge)", () => {
  it("purge removes the item and leaves a tombstone carrying no snapshot", async () => {
    const { items, oplog, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.purge(item.id, "human");
    expect(items.get(item.id)).toBeNull();
    const tomb = oplog.recent(10).find((o) => o.entityId === item.id);
    expect(tomb?.op).toBe("purge");
    expect(tomb?.after).toBeNull();
    expect(tomb?.before).toEqual({ key: item.key, title: "A", projectId: item.projectId, releasedChildren: [] });
  });

  it("purge takes the item's own history with it", async () => {
    const { items, oplog, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "doing" }, "ai:mcp", { baseVersion: 1 });
    expect(oplog.historyFor("item", item.id, 10).length).toBe(2);
    items.purge(item.id, "human");
    expect(oplog.historyFor("item", item.id, 10).map((o) => o.op)).toEqual(["purge"]);
  });

  it("no amount of undo brings a purged item back", async () => {
    const { items, oplog, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "doing" }, "human", { baseVersion: 1 });
    items.update(item.id, { priority: 4 }, "human", { baseVersion: 2 });
    items.purge(item.id, "human");
    for (let i = 0; i < 6; i += 1) oplog.undoLast();
    expect(items.get(item.id)).toBeNull();
    expect(oplog.undoLast(item.id)).toBeNull();
  });

  it("undo walks past the tombstone to the write before it, and leaves it in the log", async () => {
    const { items, oplog, board } = await fresh();
    const keep = items.create({ title: "Keep", boardId: board.id, by: "human" });
    items.update(keep.id, { status: "doing" }, "human", { baseVersion: 1 });
    const doomed = items.create({ title: "Doomed", boardId: board.id, by: "human" });
    items.purge(doomed.id, "human");
    const result = oplog.undoLast();
    expect(result?.entry.entityId).toBe(keep.id);
    expect(items.get(keep.id)?.status).toBe("backlog");
    expect(oplog.recent(10).some((o) => o.op === "purge" && o.entityId === doomed.id)).toBe(true);
  });

  it("purging an epic releases its children and names them on the tombstone", async () => {
    const { items, oplog, board } = await fresh();
    const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const a = items.create({ title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    const b = items.create({ title: "Schedule", parentId: epic.id, boardId: board.id, by: "human" });
    items.purge(epic.id, "human");
    expect(items.get(a.id)?.parentId).toBeNull();
    const tomb = oplog.recent(10).find((o) => o.op === "purge");
    expect((tomb?.before as { releasedChildren: string[] }).releasedChildren.sort()).toEqual([a.id, b.id].sort());
  });

  it("an agent may not purge — the reversible delete is the only destroy it gets", async () => {
    const { items, board } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    expect(() => items.purge(item.id, "ai:mcp")).toThrow(PurgeNotPermittedError);
    expect(items.get(item.id)).not.toBeNull();
  });

  it("a stale confirmation is refused rather than destroying work the human never saw", async () => {
    const { items, board } = await fresh();
    const item = items.create({ title: "Fix login", boardId: board.id, by: "human" });
    items.update(item.id, { title: "Fix SSO redirect loop" }, "ai:mcp", { baseVersion: 1 });
    expect(() => items.purge(item.id, "human", { baseVersion: 1 })).toThrow(ConflictError);
    expect(items.get(item.id)?.title).toBe("Fix SSO redirect loop");
    items.purge(item.id, "human", { baseVersion: 2 });
    expect(items.get(item.id)).toBeNull();
  });

  it("a soft-deleted epic still round-trips: only a purge drops the link", async () => {
    const { items, oplog, board } = await fresh();
    const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const child = items.create({ title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    items.update(child.id, { parentId: null }, "human", { baseVersion: 1 });
    items.delete(epic.id, "ai:mcp");
    oplog.undoLast(child.id);
    oplog.undoLast(epic.id);
    expect(items.get(epic.id)).not.toBeNull();
    expect(items.get(child.id)?.parentId).toBe(epic.id);
  });

  it("purge cuts the blocks relations in both directions", async () => {
    const { items, board } = await fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    items.addRelation(a.id, b.id);
    items.addRelation(b.id, a.id);
    items.purge(a.id, "human");
    expect(items.get(b.id)?.blocks).toEqual([]);
  });

  it("undoing an older write never restores an edge to, or a parent that is, a purged item", async () => {
    const { items, oplog, board } = await fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    items.addRelation(b.id, a.id);
    items.update(b.id, { status: "doing" }, "human", { baseVersion: 1 });
    items.purge(a.id, "human");
    oplog.undoLast(b.id);
    expect(items.get(b.id)?.status).toBe("backlog");
    expect(items.get(b.id)?.blocks).toEqual([]);

    const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const child = items.create({ title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    items.update(child.id, { status: "doing" }, "human", { baseVersion: 1 });
    items.purge(epic.id, "human");
    oplog.undoLast(child.id);
    expect(items.get(child.id)?.status).toBe("backlog");
    expect(items.get(child.id)?.parentId).toBeNull();
  });

  it("a purged key is never handed out again", async () => {
    const { items, board, project } = await fresh();
    const first = items.create({ title: "A", boardId: board.id, by: "human" });
    items.purge(first.id, "human");
    const next = items.create({ title: "B", boardId: board.id, projectId: project.id, by: "human" });
    expect(next.key).not.toBe(first.key);
  });

  it("a purge tombstone does not outlive the project it names", async () => {
    const { db, items, projects, board, project } = await fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.purge(item.id, "human");
    projects.remove(project.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM oplog").get() as { n: number }).n).toBe(0);
  });

  it("purging a missing item throws NotFoundError", async () => {
    const { items } = await fresh();
    expect(() => items.purge("nope", "human")).toThrow(NotFoundError);
  });
});
