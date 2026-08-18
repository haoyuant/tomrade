/**
 * Write-path regression tests: the guardrails that must never regress.
 * human edits always win; AI writes are versioned + locked-field protected;
 * every mutation is recorded in the oplog; undo restores state.
 */
import { describe, expect, it } from "vitest";
import { openDb, ItemsRepository, ConflictError, HumanLockedError, NotFoundError } from "../src/index.js";

function freshRepo(): ItemsRepository {
  return new ItemsRepository(openDb(":memory:"));
}

describe("items repository (write path)", () => {
  it("creates an item with version 1, rank, and provenance", () => {
    const repo = freshRepo();
    const item = repo.create({ title: "Export report to PDF", by: "human" });
    expect(item.version).toBe(1);
    expect(item.status).toBe("backlog");
    expect(item.kind).toBe("ticket");
    expect(item.updatedBy).toBe("human");
    expect(item.humanLocked).toBe(false);
    expect(repo.list().length).toBe(1);
  });

  it("lists with filters (status/kind/parent)", () => {
    const repo = freshRepo();
    const epic = repo.create({ title: "Reporting", kind: "epic", by: "human" });
    const t1 = repo.create({ title: "Export PDF", parentId: epic.id, by: "human" });
    repo.create({ title: "Dark mode", by: "human" });
    expect(repo.list({ status: "backlog" }).length).toBe(3);
    expect(repo.list({ kind: "ticket" }).length).toBe(2);
    expect(repo.list({ parentId: epic.id }).map((i) => i.id)).toEqual([t1.id]);
    expect(repo.list({ parentId: null }).length).toBe(2);
  });

  it("AI update with correct baseVersion applies and bumps version", () => {
    const repo = freshRepo();
    const item = repo.create({ title: "A", by: "human" });
    const updated = repo.update(item.id, { status: "todo" }, "ai:extraction", { baseVersion: 1 });
    expect(updated.status).toBe("todo");
    expect(updated.version).toBe(2);
    expect(updated.updatedBy).toBe("ai:extraction");
  });

  it("AI update with stale baseVersion throws ConflictError (G: optimistic lock)", () => {
    const repo = freshRepo();
    const item = repo.create({ title: "A", by: "human" });
    repo.update(item.id, { status: "todo" }, "human");
    expect(() => repo.update(item.id, { status: "done" }, "ai:mcp", { baseVersion: 1 })).toThrow(ConflictError);
  });

  it("AI cannot touch title/body of a human-locked item (HumanLockedError)", () => {
    const repo = freshRepo();
    const item = repo.create({ title: "A", by: "human" });
    repo.update(item.id, { humanLocked: true }, "human");
    expect(() => repo.update(item.id, { title: "hacked" }, "ai:mcp", { baseVersion: 2 })).toThrow(HumanLockedError);
    expect(() => repo.update(item.id, { body: "x" }, "ai:extraction", { baseVersion: 2 })).toThrow(HumanLockedError);
  });

  it("humanLocked is human-only — AI writes to it are refused", () => {
    const repo = freshRepo();
    const item = repo.create({ title: "A", by: "human" });
    expect(() => repo.update(item.id, { humanLocked: true }, "ai:mcp", { baseVersion: 1 })).toThrow(HumanLockedError);
  });

  it("human edits on a locked item are still allowed (human wins)", () => {
    const repo = freshRepo();
    const item = repo.create({ title: "A", by: "human" });
    repo.update(item.id, { humanLocked: true }, "human");
    const edited = repo.update(item.id, { title: "New title" }, "human");
    expect(edited.title).toBe("New title");
    expect(edited.humanLocked).toBe(true);
  });

  it("status + rank can be updated together (board drag semantics)", () => {
    const repo = freshRepo();
    const a = repo.create({ title: "A", by: "human" });
    const b = repo.create({ title: "B", by: "human" });
    const moved = repo.update(a.id, { status: "doing", rank: (b.rank + 1) }, "human", { baseVersion: 1 });
    expect(moved.status).toBe("doing");
    expect(moved.rank).toBe(b.rank + 1);
    expect(moved.version).toBe(2);
  });

  it("delete removes the item and records it in the oplog", () => {
    const repo = freshRepo();
    const item = repo.create({ title: "A", by: "human" });
    repo.delete(item.id, "human");
    expect(repo.get(item.id)).toBeNull();
    expect(repo.recentOplog(10).some((o) => o.op === "delete" && o.entityId === item.id)).toBe(true);
  });

  it("undo restores the previous state (and undo of create removes the item)", () => {
    const repo = freshRepo();
    const item = repo.create({ title: "A", by: "human" });
    repo.update(item.id, { status: "doing" }, "human");
    repo.undo(item.id);
    expect(repo.get(item.id)?.status).toBe("backlog");
    // undo the create -> item gone
    repo.undo(item.id);
    expect(repo.get(item.id)).toBeNull();
  });

  it("oplog records every mutation with provenance", () => {
    const repo = freshRepo();
    const item = repo.create({ title: "A", by: "human" });
    repo.update(item.id, { status: "todo" }, "ai:extraction", { baseVersion: 1 });
    const log = repo.recentOplog(10);
    expect(log.map((o) => o.op + ":" + o.by).join(",")).toBe("update:ai:extraction,create:human");
    expect(log[0].baseVersion).toBe(1);
    expect(log[1].baseVersion).toBeNull();
  });

  it("update on missing item throws NotFoundError", () => {
    const repo = freshRepo();
    expect(() => repo.update("nope", { status: "done" }, "human")).toThrow(NotFoundError);
  });
});
