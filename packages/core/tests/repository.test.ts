/**
 * Write-path regression tests: the guardrails that must never regress.
 * A supplied baseVersion is enforced for every author; only AI writes are refused
 * on a human-locked item's protected fields; every mutation lands in the oplog;
 * undo restores state.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, HumanLockedError, NotFoundError, PurgeNotPermittedError, provenanceOf, undoLast } from "../src/index.js";
import { fresh } from "./helpers.js";

describe("items repository (write path)", () => {
  it("creates an item with version 1, a project key, and provenance", () => {
    const { items, board } = fresh();
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

  it("assigns keys in sequence and never reuses one", () => {
    const { items, board } = fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    items.delete(b.id, "human");
    const c = items.create({ title: "C", boardId: board.id, by: "human" });
    expect([a.key, b.key, c.key]).toEqual(["TOM-1", "TOM-2", "TOM-3"]);
    expect(items.getByKey("default", "TOM-1")?.id).toBe(a.id);
  });

  it("lists with filters (status/kind/parent/board/label)", () => {
    const { items, boards, board, project } = fresh();
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

  it("labels round-trip and register on the project", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, labels: ["ui", "bug"], by: "human" });
    expect(items.get(item.id)?.labels.sort()).toEqual(["bug", "ui"]);
    items.update(item.id, { labels: ["core"] }, "human");
    expect(items.get(item.id)?.labels).toEqual(["core"]);
    expect(items.labelsFor("default")).toEqual(["bug", "core", "ui"]);
  });

  it("blocks relations are exposed on the item", () => {
    const { items, board } = fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    items.addRelation(a.id, b.id);
    expect(items.get(a.id)?.blocks).toEqual([b.id]);
    expect(items.get(b.id)?.blocks).toEqual([]);
    items.removeRelation(a.id, b.id);
    expect(items.get(a.id)?.blocks).toEqual([]);
  });

  it("AI update with correct baseVersion applies and bumps version", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    const updated = items.update(item.id, { status: "todo" }, "ai:extraction", { baseVersion: 1 });
    expect(updated.status).toBe("todo");
    expect(updated.version).toBe(2);
    expect(updated.updatedBy).toBe("ai:extraction");
    expect(provenanceOf(updated)).toBe("ai");
  });

  it("AI update with stale baseVersion throws ConflictError (G: optimistic lock)", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "todo" }, "human");
    expect(() => items.update(item.id, { status: "done" }, "ai:mcp", { baseVersion: 1 })).toThrow(ConflictError);
  });

  it("a stale baseVersion is refused whoever asserted it (the board's conflict banner)", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "todo" }, "ai:mcp");
    expect(() => items.update(item.id, { status: "doing" }, "human", { baseVersion: 1 })).toThrow(ConflictError);
    // omitting baseVersion is an unconditional write, and human still wins the lock rules
    expect(items.update(item.id, { status: "doing" }, "human").status).toBe("doing");
  });

  it("AI cannot touch title/body of a human-locked item (HumanLockedError)", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { humanLocked: true }, "human");
    expect(() => items.update(item.id, { title: "hacked" }, "ai:mcp", { baseVersion: 2 })).toThrow(HumanLockedError);
    // the lock is checked before staleness, so the error names the real problem
    expect(() => items.update(item.id, { title: "hacked" }, "ai:mcp", { baseVersion: 1 })).toThrow(HumanLockedError);
    expect(() => items.update(item.id, { body: "x" }, "ai:extraction", { baseVersion: 2 })).toThrow(HumanLockedError);
    expect(provenanceOf(items.get(item.id)!)).toBe("locked");
  });

  it("humanLocked is human-only — AI writes to it are refused", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    expect(() => items.update(item.id, { humanLocked: true }, "ai:mcp", { baseVersion: 1 })).toThrow(HumanLockedError);
  });

  it("human edits on a locked item are still allowed (human wins)", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { humanLocked: true }, "human");
    const edited = items.update(item.id, { title: "New title" }, "human");
    expect(edited.title).toBe("New title");
    expect(edited.humanLocked).toBe(true);
  });

  it("status + rank can be updated together (board drag semantics)", () => {
    const { items, board } = fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    const moved = items.update(a.id, { status: "doing", rank: b.rank + 1 }, "human", { baseVersion: 1 });
    expect(moved.status).toBe("doing");
    expect(moved.rank).toBe(b.rank + 1);
    expect(moved.version).toBe(2);
  });

  it("delete removes the item and records it in the oplog", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.delete(item.id, "human");
    expect(items.get(item.id)).toBeNull();
    expect(items.recentOplog(10).some((o) => o.op === "delete" && o.entityId === item.id)).toBe(true);
  });

  it("undo restores the previous state (and undo of create removes the item)", () => {
    const { db, items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "doing" }, "human");
    undoLast(db, item.id);
    expect(items.get(item.id)?.status).toBe("backlog");
    undoLast(db, item.id);
    expect(items.get(item.id)).toBeNull();
  });

  it("undo restores labels alongside the rest of the snapshot", () => {
    const { db, items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, labels: ["ui"], by: "human" });
    items.update(item.id, { labels: ["core", "ui"] }, "ai:mcp", { baseVersion: 1 });
    undoLast(db);
    expect(items.get(item.id)?.labels).toEqual(["ui"]);
  });

  it("oplog records every mutation with provenance", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "todo" }, "ai:extraction", { baseVersion: 1 });
    const log = items.historyFor(item.id, 10);
    expect(log.map((o) => o.op + ":" + o.by).join(",")).toBe("update:ai:extraction,create:human");
    expect(log[0].baseVersion).toBe(1);
    expect(log[1].baseVersion).toBeNull();
  });

  it("undo of a delete restores the blocks relations in both directions", () => {
    const { db, items, board } = fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    items.addRelation(a.id, b.id);
    items.addRelation(b.id, a.id);
    items.delete(a.id, "human");
    undoLast(db);
    expect(items.get(a.id)?.blocks).toEqual([b.id]);
    expect(items.get(b.id)?.blocks).toEqual([a.id]);
  });

  it("deleting an epic releases its children rather than orphaning them", () => {
    const { items, board } = fresh();
    const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const child = items.create({ title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    items.delete(epic.id, "human");
    expect(items.get(child.id)?.parentId).toBeNull();
  });

  it("creating into a project that does not exist is refused, not silently keyed 1", () => {
    const { items, board } = fresh();
    expect(() => items.create({ title: "A", projectId: "ghost", boardId: board.id, by: "human" })).toThrow(NotFoundError);
  });

  it("update on missing item throws NotFoundError", () => {
    const { items } = fresh();
    expect(() => items.update("nope", { status: "done" }, "human")).toThrow(NotFoundError);
  });
});

/**
 * `delete` is the reversible one. `purge` is the human-only permanent destroy:
 * no snapshot survives it, so nothing — not undo, not an older update entry —
 * can put the issue back.
 */
describe("items repository (permanent purge)", () => {
  it("purge removes the item and leaves a tombstone carrying no snapshot", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.purge(item.id, "human");
    expect(items.get(item.id)).toBeNull();
    const tomb = items.recentOplog(10).find((o) => o.entityId === item.id);
    expect(tomb?.op).toBe("purge");
    expect(tomb?.after).toBeNull();
    expect(tomb?.before).toEqual({ key: item.key, title: "A", projectId: item.projectId, releasedChildren: [] });
  });

  it("purge takes the item's own history with it", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "doing" }, "ai:mcp", { baseVersion: 1 });
    expect(items.historyFor(item.id, 10).length).toBe(2);
    items.purge(item.id, "human");
    expect(items.historyFor(item.id, 10).map((o) => o.op)).toEqual(["purge"]);
  });

  it("no amount of undo brings a purged item back", () => {
    const { db, items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.update(item.id, { status: "doing" }, "human", { baseVersion: 1 });
    items.update(item.id, { priority: 4 }, "human", { baseVersion: 2 });
    items.purge(item.id, "human");
    for (let i = 0; i < 6; i += 1) undoLast(db);
    expect(items.get(item.id)).toBeNull();
    expect(undoLast(db, item.id)).toBeNull();
  });

  it("undo walks past the tombstone to the write before it, and leaves it in the log", () => {
    const { db, items, board } = fresh();
    const keep = items.create({ title: "Keep", boardId: board.id, by: "human" });
    items.update(keep.id, { status: "doing" }, "human", { baseVersion: 1 });
    const doomed = items.create({ title: "Doomed", boardId: board.id, by: "human" });
    items.purge(doomed.id, "human");

    const result = undoLast(db);
    expect(result?.entry.entityId).toBe(keep.id);
    expect(items.get(keep.id)?.status).toBe("backlog");
    expect(items.recentOplog(10).some((o) => o.op === "purge" && o.entityId === doomed.id)).toBe(true);
  });

  it("purging an epic releases its children rather than taking them with it", () => {
    const { items, board } = fresh();
    const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const child = items.create({ title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    items.purge(epic.id, "human");
    expect(items.get(child.id)?.parentId).toBeNull();
  });

  it("the tombstone names the children the purge reparented", () => {
    const { items, board } = fresh();
    const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const a = items.create({ title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    const b = items.create({ title: "Schedule", parentId: epic.id, boardId: board.id, by: "human" });
    items.purge(epic.id, "human");
    const tomb = items.recentOplog(10).find((o) => o.op === "purge");
    expect((tomb?.before as { releasedChildren: string[] }).releasedChildren.sort()).toEqual([a.id, b.id].sort());
  });

  it("an agent may not purge — the reversible delete is the only destroy it gets", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    expect(() => items.purge(item.id, "ai:mcp")).toThrow(PurgeNotPermittedError);
    expect(items.get(item.id)).not.toBeNull();
  });

  it("a stale confirmation is refused rather than destroying work the human never saw", () => {
    const { items, board } = fresh();
    const item = items.create({ title: "Fix login", boardId: board.id, by: "human" });
    // the sheet is open on version 1 when an agent rewrites the issue
    items.update(item.id, { title: "Fix SSO redirect loop" }, "ai:mcp", { baseVersion: 1 });
    expect(() => items.purge(item.id, "human", { baseVersion: 1 })).toThrow(ConflictError);
    expect(items.get(item.id)?.title).toBe("Fix SSO redirect loop");
    // confirming against what is actually there now goes through
    items.purge(item.id, "human", { baseVersion: 2 });
    expect(items.get(item.id)).toBeNull();
  });

  it("a soft-deleted epic still round-trips: only a purge drops the link", () => {
    const { db, items, board } = fresh();
    const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const child = items.create({ title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    items.update(child.id, { parentId: null }, "human", { baseVersion: 1 });
    items.delete(epic.id, "ai:mcp");
    undoLast(db, child.id);
    undoLast(db, epic.id);
    expect(items.get(epic.id)).not.toBeNull();
    expect(items.get(child.id)?.parentId).toBe(epic.id);
  });

  it("purge cuts the blocks relations in both directions", () => {
    const { items, board } = fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    items.addRelation(a.id, b.id);
    items.addRelation(b.id, a.id);
    items.purge(a.id, "human");
    expect(items.get(b.id)?.blocks).toEqual([]);
  });

  it("undoing an older write never restores an edge to a purged item", () => {
    const { db, items, board } = fresh();
    const a = items.create({ title: "A", boardId: board.id, by: "human" });
    const b = items.create({ title: "B", boardId: board.id, by: "human" });
    items.addRelation(b.id, a.id);
    // b's snapshot at version 1 still names a as blocked
    items.update(b.id, { status: "doing" }, "human", { baseVersion: 1 });
    items.purge(a.id, "human");
    undoLast(db, b.id);
    expect(items.get(b.id)?.status).toBe("backlog");
    expect(items.get(b.id)?.blocks).toEqual([]);
  });

  it("undoing an older write never re-parents an issue onto a purged epic", () => {
    const { db, items, board } = fresh();
    const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const child = items.create({ title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    items.update(child.id, { status: "doing" }, "human", { baseVersion: 1 });
    items.purge(epic.id, "human");
    undoLast(db, child.id);
    expect(items.get(child.id)?.status).toBe("backlog");
    expect(items.get(child.id)?.parentId).toBeNull();
  });

  it("a purged key is never handed out again", () => {
    const { items, board, project } = fresh();
    const first = items.create({ title: "A", boardId: board.id, by: "human" });
    items.purge(first.id, "human");
    const next = items.create({ title: "B", boardId: board.id, projectId: project.id, by: "human" });
    expect(next.key).not.toBe(first.key);
  });

  it("a purge tombstone does not outlive the project it names", () => {
    const { db, items, projects, board, project } = fresh();
    const item = items.create({ title: "A", boardId: board.id, by: "human" });
    items.purge(item.id, "human");
    projects.remove(project.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM oplog").get() as { n: number }).n).toBe(0);
  });

  it("purging a missing item throws NotFoundError", () => {
    const { items } = fresh();
    expect(() => items.purge("nope", "human")).toThrow(NotFoundError);
  });
});
