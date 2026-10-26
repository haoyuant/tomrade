/**
 * Write-path regression: a supplied baseVersion is enforced for every author,
 * only AI writes are refused on a locked item's protected fields, every
 * mutation lands in the oplog, and undo restores state.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, DependencyCycleError, HumanLockedError, NotFoundError, PurgeNotPermittedError, provenanceOf } from "@tomradex/domain";
import { fresh } from "@tomradex/testkit";

describe("items (write path)", () => {
  it("defaults a new ticket's work type to whether its workstream has a repository", async () => {
    const { items, boards, board, project } = await fresh();
    const code = boards.create({ projectId: project.id, name: "App", repoId: "repo-1" }, "human");
    expect(items.create({ projectId: project.id, boardId: board.id, title: "Book the venue", by: "human" }).workType).toBe("general");
    expect(items.create({ projectId: project.id, boardId: code.id, title: "Implement registration", by: "human" }).workType).toBe("coding");
    expect(items.create({ projectId: project.id, boardId: code.id, title: "Print the flyers", workType: "general", by: "human" }).workType).toBe("general");
  });

  it("lets an agent close General work nobody submitted, on the person's word, and never work that was submitted", async () => {
    const { items, board, project } = await fresh();
    const errand = items.create({ projectId: project.id, boardId: board.id, title: "Renew the passport", workType: "general", status: "doing", by: "human" });
    const closed = items.update(project.id, errand.id, { status: "done" }, "ai:loop");
    expect(closed).toMatchObject({ status: "done", evidence: { submissions: [], reviews: [] } });
    expect(items.deliveries.list(project.id, errand.id).map((d) => d.state)).toEqual(["completed"]);

    const logged = items.create({ projectId: project.id, boardId: board.id, title: "Called the bank", workType: "general", status: "done", by: "ai:loop" });
    expect(logged.evidence.submissions).toEqual([]);

    const report = items.create({ projectId: project.id, boardId: board.id, title: "Confirm the booking", workType: "general", status: "doing", by: "human" });
    items.submitDelivery(project.id, report.id, { report: "Booked for Friday", artifactIds: [] }, "ai:loop");
    expect(() => items.update(project.id, report.id, { status: "done" }, "ai:loop")).toThrow("has not been accepted");
  });

  it("persists and queries work type independently of hierarchy", async () => {
    const { items, board, project } = await fresh();
    const general = items.create({ projectId: project.id, boardId: board.id, title: "Prepare event materials", workType: "general", by: "human" });
    const coding = items.create({ projectId: project.id, boardId: board.id, title: "Implement registration", workType: "coding", by: "human" });
    expect(coding.workType).toBe("coding");
    expect(items.get(project.id, general.id)?.workType).toBe("general");
    expect(items.list({ projectId: project.id, workType: "general" }).map(i => i.id)).toEqual([general.id]);
    expect(items.query({ projectId: project.id, filter: [{ field: "workType", op: "in", values: ["general"] }] }).map(i => i.id)).toEqual([general.id]);
    items.update(project.id, general.id, { workType: "coding" }, "human");
    expect(items.get(project.id, general.id)?.kind).toBe("ticket");
    expect(items.list({ projectId: project.id, workType: "general" })).toEqual([]);
  });
  it("creates an item with version 1, a project key, and provenance", async () => {
    const { items, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "Export report to PDF", boardId: board.id, by: "human" });
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
    const { items, board, project } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    items.delete(project.id, b.id, "human");
    const c = items.create({ projectId: project.id, title: "C", boardId: board.id, by: "human" });
    expect([a.key, b.key, c.key]).toEqual(["TOM-1", "TOM-2", "TOM-3"]);
    expect(items.getByKey(project.id, "TOM-1")?.id).toBe(a.id);
  });

  it("hands out a free key when the counter is behind the items it holds", async () => {
    const { items, board, project, db } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    db.prepare("UPDATE projects SET next_key_num = 1 WHERE id = ?").run(project.id);
    const c = items.create({ projectId: project.id, title: "C", boardId: board.id, by: "human" });
    const d = items.create({ projectId: project.id, title: "D", boardId: board.id, by: "human" });
    expect([a.key, b.key, c.key, d.key]).toEqual(["TOM-1", "TOM-2", "TOM-3", "TOM-4"]);
  });

  it("lists with filters (status/kind/parent/board/label)", async () => {
    const { items, boards, board, project } = await fresh();
    const other = boards.create({ projectId: project.id, name: "Other" });
    const epic = items.create({ projectId: project.id, title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const t1 = items.create({ projectId: project.id, title: "Export PDF", parentId: epic.id, boardId: board.id, labels: ["ui"], by: "human" });
    items.create({ projectId: project.id, title: "Dark mode", boardId: other.id, by: "human" });
    expect(items.list({ status: "backlog" }).length).toBe(3);
    expect(items.list({ kind: "ticket" }).length).toBe(2);
    expect(items.list({ boardId: other.id }).length).toBe(1);
    expect(items.list({ label: "ui" }).map((i) => i.id)).toEqual([t1.id]);
    expect(items.list({ parentId: epic.id }).map((i) => i.id)).toEqual([t1.id]);
    expect(items.list({ parentId: null }).length).toBe(2);
  });

  it("labels round-trip and register on the project", async () => {
    const { items, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, labels: ["ui", "bug"], by: "human" });
    expect(items.get(project.id, item.id)?.labels.sort()).toEqual(["bug", "ui"]);
    items.update(project.id, item.id, { labels: ["core"] }, "human");
    expect(items.get(project.id, item.id)?.labels).toEqual(["core"]);
    expect(items.labelsFor(project.id)).toEqual(["bug", "core", "ui"]);
  });

  it("blocks relations are exposed on the item", async () => {
    const { items, board, project } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    items.addRelation(project.id, a.id, b.id);
    expect(items.get(project.id, a.id)?.blocks).toEqual([b.id]);
    expect(items.get(project.id, b.id)?.blocks).toEqual([]);
    items.removeRelation(project.id, a.id, b.id);
    expect(items.get(project.id, a.id)?.blocks).toEqual([]);
  });

  it("blocks edit through update: logged, versioned, and normalized", async () => {
    const { items, oplog, board, project } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    const updated = items.update(project.id, a.id, { blocks: [b.id, b.id, a.id] }, "human", { baseVersion: 1 });
    expect(updated.blocks).toEqual([b.id]);
    expect(updated.version).toBe(2);
    expect(items.get(project.id, a.id)?.blocks).toEqual([b.id]);
    const entry = oplog.historyFor(project.id, "item", a.id, 1)[0];
    expect((entry.before as { blocks: string[] }).blocks).toEqual([]);
    expect((entry.after as { blocks: string[] }).blocks).toEqual([b.id]);
    expect(items.update(project.id, a.id, { blocks: [] }, "human").blocks).toEqual([]);
    expect(items.get(project.id, a.id)?.blocks).toEqual([]);
  });

  it("a blocks edit that would close a cycle is refused, direct or transitive", async () => {
    const { items, board, project } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    const c = items.create({ projectId: project.id, title: "C", boardId: board.id, by: "human" });
    items.update(project.id, a.id, { blocks: [b.id] }, "human");
    items.update(project.id, b.id, { blocks: [c.id] }, "human");
    expect(() => items.update(project.id, c.id, { blocks: [a.id] }, "human")).toThrow(DependencyCycleError);
    expect(() => items.update(project.id, b.id, { blocks: [c.id, a.id] }, "human")).toThrow(DependencyCycleError);
    expect(items.get(project.id, c.id)?.blocks).toEqual([]);
    // replacing the edge that made the path is fine — the check runs on the proposed graph
    expect(items.update(project.id, a.id, { blocks: [c.id] }, "human").blocks).toEqual([c.id]);
  });

  it("blocks targets must exist in the same project", async () => {
    const { items, projects, board, project } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const elsewhere = projects.create({ name: "Elsewhere", keyPrefix: "ELS" });
    const foreign = items.create({ title: "F", projectId: elsewhere.id, boardId: board.id, by: "human" });
    expect(() => items.update(project.id, a.id, { blocks: ["ghost"] }, "human")).toThrow(NotFoundError);
    expect(() => items.update(project.id, a.id, { blocks: [foreign.id] }, "human")).toThrow(NotFoundError);
  });

  it("undo of a blocks edit restores the edges exactly", async () => {
    const { items, oplog, board, project } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    const c = items.create({ projectId: project.id, title: "C", boardId: board.id, by: "human" });
    items.update(project.id, a.id, { blocks: [b.id] }, "human");
    items.update(project.id, a.id, { blocks: [c.id] }, "human");
    oplog.undoLast(project.id, a.id);
    expect(items.get(project.id, a.id)?.blocks).toEqual([b.id]);
    oplog.undoLast(project.id, a.id);
    expect(items.get(project.id, a.id)?.blocks).toEqual([]);
  });

  it("AI update with correct baseVersion applies and bumps version", async () => {
    const { items, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const updated = items.update(project.id, item.id, { status: "todo" }, "ai:extraction", { baseVersion: 1 });
    expect(updated.status).toBe("todo");
    expect(updated.version).toBe(2);
    expect(updated.updatedBy).toBe("ai:extraction");
    expect(provenanceOf(updated)).toBe("ai");
  });

  it("AI update with stale baseVersion throws ConflictError", async () => {
    const { items, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { status: "todo" }, "human");
    expect(() => items.update(project.id, item.id, { status: "done" }, "ai:mcp", { baseVersion: 1 })).toThrow(ConflictError);
  });

  it("a stale baseVersion is refused whoever asserted it", async () => {
    const { items, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { status: "todo" }, "ai:mcp");
    expect(() => items.update(project.id, item.id, { status: "doing" }, "human", { baseVersion: 1 })).toThrow(ConflictError);
    expect(items.update(project.id, item.id, { status: "doing" }, "human").status).toBe("doing");
  });

  it("AI cannot touch title/body of a human-locked item", async () => {
    const { items, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { humanLocked: true }, "human");
    expect(() => items.update(project.id, item.id, { title: "hacked" }, "ai:mcp", { baseVersion: 2 })).toThrow(HumanLockedError);
    // the lock is checked before staleness, so the error names the real problem
    expect(() => items.update(project.id, item.id, { title: "hacked" }, "ai:mcp", { baseVersion: 1 })).toThrow(HumanLockedError);
    expect(() => items.update(project.id, item.id, { body: "x" }, "ai:extraction", { baseVersion: 2 })).toThrow(HumanLockedError);
    expect(provenanceOf(items.get(project.id, item.id)!)).toBe("locked");
  });

  it("humanLocked is human-only", async () => {
    const { items, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    expect(() => items.update(project.id, item.id, { humanLocked: true }, "ai:mcp", { baseVersion: 1 })).toThrow(HumanLockedError);
  });

  it("human edits on a locked item are still allowed", async () => {
    const { items, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { humanLocked: true }, "human");
    const edited = items.update(project.id, item.id, { title: "New title" }, "human");
    expect(edited.title).toBe("New title");
    expect(edited.humanLocked).toBe(true);
  });

  it("status + rank can be updated together (board drag semantics)", async () => {
    const { items, board, project } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    const moved = items.update(project.id, a.id, { status: "doing", rank: b.rank + 1 }, "human", { baseVersion: 1 });
    expect(moved.status).toBe("doing");
    expect(moved.rank).toBe(b.rank + 1);
    expect(moved.version).toBe(2);
  });

  it("delete removes the item and records it in the oplog", async () => {
    const { items, oplog, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.delete(project.id, item.id, "human");
    expect(items.get(project.id, item.id)).toBeNull();
    expect(oplog.recent(project.id, 10).some((o) => o.op === "delete" && o.entityId === item.id)).toBe(true);
  });

  it("undo restores the previous state, and undo of create removes the item", async () => {
    const { items, oplog, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { status: "doing" }, "human");
    oplog.undoLast(project.id, item.id);
    expect(items.get(project.id, item.id)?.status).toBe("backlog");
    oplog.undoLast(project.id, item.id);
    expect(items.get(project.id, item.id)).toBeNull();
  });

  it("undo restores labels alongside the rest of the snapshot", async () => {
    const { items, oplog, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, labels: ["ui"], by: "human" });
    items.update(project.id, item.id, { labels: ["core", "ui"] }, "ai:mcp", { baseVersion: 1 });
    oplog.undoLast(project.id);
    expect(items.get(project.id, item.id)?.labels).toEqual(["ui"]);
  });

  it("oplog records every mutation with provenance", async () => {
    const { items, oplog, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { status: "todo" }, "ai:extraction", { baseVersion: 1 });
    const log = oplog.historyFor(project.id, "item", item.id, 10);
    expect(log.map((o) => o.op + ":" + o.by).join(",")).toBe("update:ai:extraction,create:human");
    expect(log[0].baseVersion).toBe(1);
    expect(log[1].baseVersion).toBeNull();
  });

  it("write/committed announces every landed write and no refused one", async () => {
    const { ctx, items, board, project } = await fresh();
    const seen: string[] = [];
    ctx.on("write/committed", (intent) => seen.push(`${intent.entity}:${intent.op}`));
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { status: "todo" }, "human");
    expect(() => items.update(project.id, item.id, { status: "done" }, "ai:mcp", { baseVersion: 1 })).toThrow(ConflictError);
    expect(seen).toEqual(["item:create", "item:update"]);
  });

  it("undo of a delete restores the blocks relations in both directions", async () => {
    const { items, oplog, board, project } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    const c = items.create({ projectId: project.id, title: "C", boardId: board.id, by: "human" });
    items.addRelation(project.id, a.id, b.id);
    items.addRelation(project.id, c.id, a.id);
    items.delete(project.id, a.id, "human");
    expect(items.get(project.id, c.id)?.blocks).toEqual([]);
    oplog.undoLast(project.id);
    expect(items.get(project.id, a.id)?.blocks).toEqual([b.id]);
    expect(items.get(project.id, a.id)?.blockedBy).toEqual([c.id]);
    expect(items.get(project.id, c.id)?.blocks).toEqual([a.id]);
  });

  it("deleting an epic releases its children rather than orphaning them", async () => {
    const { items, board, project } = await fresh();
    const epic = items.create({ projectId: project.id, title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const child = items.create({ projectId: project.id, title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    items.delete(project.id, epic.id, "human");
    expect(items.get(project.id, child.id)?.parentId).toBeNull();
  });

  it("creating into a project that does not exist is refused", async () => {
    const { items, board, project } = await fresh();
    expect(() => items.create({ title: "A", projectId: "ghost", boardId: board.id, by: "human" })).toThrow(NotFoundError);
  });

  it("update on missing item throws NotFoundError", async () => {
    const { items, project } = await fresh();
    expect(() => items.update(project.id, "nope", { status: "done" }, "human")).toThrow(NotFoundError);
  });
});

describe("items (permanent purge)", () => {
  it("purge removes the item and leaves a tombstone carrying no snapshot", async () => {
    const { items, oplog, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.purge(project.id, item.id, "human");
    expect(items.get(project.id, item.id)).toBeNull();
    const tomb = oplog.recent(project.id, 10).find((o) => o.entityId === item.id);
    expect(tomb?.op).toBe("purge");
    expect(tomb?.after).toBeNull();
    expect(tomb?.before).toEqual({ key: item.key, title: "A", projectId: item.projectId, releasedChildren: [] });
  });

  it("purge takes the item's own history with it", async () => {
    const { items, oplog, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { status: "doing" }, "ai:mcp", { baseVersion: 1 });
    expect(oplog.historyFor(project.id, "item", item.id, 10).length).toBe(2);
    items.purge(project.id, item.id, "human");
    expect(oplog.historyFor(project.id, "item", item.id, 10).map((o) => o.op)).toEqual(["purge"]);
  });

  it("no amount of undo brings a purged item back", async () => {
    const { items, oplog, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { status: "doing" }, "human", { baseVersion: 1 });
    items.update(project.id, item.id, { priority: 4 }, "human", { baseVersion: 2 });
    items.purge(project.id, item.id, "human");
    for (let i = 0; i < 6; i += 1) oplog.undoLast(project.id);
    expect(items.get(project.id, item.id)).toBeNull();
    expect(oplog.undoLast(project.id, item.id)).toBeNull();
  });

  it("undo walks past the tombstone to the write before it, and leaves it in the log", async () => {
    const { items, oplog, board, project } = await fresh();
    const keep = items.create({ projectId: project.id, title: "Keep", boardId: board.id, by: "human" });
    items.update(project.id, keep.id, { status: "doing" }, "human", { baseVersion: 1 });
    const doomed = items.create({ projectId: project.id, title: "Doomed", boardId: board.id, by: "human" });
    items.purge(project.id, doomed.id, "human");
    const result = oplog.undoLast(project.id);
    expect(result?.entry.entityId).toBe(keep.id);
    expect(items.get(project.id, keep.id)?.status).toBe("backlog");
    expect(oplog.recent(project.id, 10).some((o) => o.op === "purge" && o.entityId === doomed.id)).toBe(true);
  });

  it("purging an epic releases its children and names them on the tombstone", async () => {
    const { items, oplog, board, project } = await fresh();
    const epic = items.create({ projectId: project.id, title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const a = items.create({ projectId: project.id, title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "Schedule", parentId: epic.id, boardId: board.id, by: "human" });
    items.purge(project.id, epic.id, "human");
    expect(items.get(project.id, a.id)?.parentId).toBeNull();
    const tomb = oplog.recent(project.id, 10).find((o) => o.op === "purge");
    expect((tomb?.before as { releasedChildren: string[] }).releasedChildren.sort()).toEqual([a.id, b.id].sort());
  });

  it("an agent may not purge — the reversible delete is the only destroy it gets", async () => {
    const { items, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    expect(() => items.purge(project.id, item.id, "ai:mcp")).toThrow(PurgeNotPermittedError);
    expect(items.get(project.id, item.id)).not.toBeNull();
  });

  it("a stale confirmation is refused rather than destroying work the human never saw", async () => {
    const { items, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "Fix login", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { title: "Fix SSO redirect loop" }, "ai:mcp", { baseVersion: 1 });
    expect(() => items.purge(project.id, item.id, "human", { baseVersion: 1 })).toThrow(ConflictError);
    expect(items.get(project.id, item.id)?.title).toBe("Fix SSO redirect loop");
    items.purge(project.id, item.id, "human", { baseVersion: 2 });
    expect(items.get(project.id, item.id)).toBeNull();
  });

  it("a soft-deleted epic still round-trips: only a purge drops the link", async () => {
    const { items, oplog, board, project } = await fresh();
    const epic = items.create({ projectId: project.id, title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const child = items.create({ projectId: project.id, title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    items.update(project.id, child.id, { parentId: null }, "human", { baseVersion: 1 });
    items.delete(project.id, epic.id, "ai:mcp");
    oplog.undoLast(project.id, child.id);
    oplog.undoLast(project.id, epic.id);
    expect(items.get(project.id, epic.id)).not.toBeNull();
    expect(items.get(project.id, child.id)?.parentId).toBe(epic.id);
  });

  it("purge cuts the blocks relations in both directions", async () => {
    const { items, board, project } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    const c = items.create({ projectId: project.id, title: "C", boardId: board.id, by: "human" });
    items.addRelation(project.id, a.id, b.id);
    items.addRelation(project.id, c.id, a.id);
    items.purge(project.id, a.id, "human");
    expect(items.get(project.id, b.id)?.blockedBy).toEqual([]);
    expect(items.get(project.id, c.id)?.blocks).toEqual([]);
  });

  it("undoing an older write never restores an edge to, or a parent that is, a purged item", async () => {
    const { items, oplog, board, project } = await fresh();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    items.addRelation(project.id, b.id, a.id);
    // addRelation is a logged update now, so b is at version 2
    items.update(project.id, b.id, { status: "doing" }, "human", { baseVersion: 2 });
    items.purge(project.id, a.id, "human");
    oplog.undoLast(project.id, b.id);
    expect(items.get(project.id, b.id)?.status).toBe("backlog");
    expect(items.get(project.id, b.id)?.blocks).toEqual([]);

    const epic = items.create({ projectId: project.id, title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
    const child = items.create({ projectId: project.id, title: "Export", parentId: epic.id, boardId: board.id, by: "human" });
    items.update(project.id, child.id, { status: "doing" }, "human", { baseVersion: 1 });
    items.purge(project.id, epic.id, "human");
    oplog.undoLast(project.id, child.id);
    expect(items.get(project.id, child.id)?.status).toBe("backlog");
    expect(items.get(project.id, child.id)?.parentId).toBeNull();
  });

  it("a purged key is never handed out again", async () => {
    const { items, board, project } = await fresh();
    const first = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.purge(project.id, first.id, "human");
    const next = items.create({ title: "B", boardId: board.id, projectId: project.id, by: "human" });
    expect(next.key).not.toBe(first.key);
  });

  it("a purge tombstone does not outlive the project it names", async () => {
    const { ctx, items, projects, board, project } = await fresh();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.purge(project.id, item.id, "human");
    projects.remove(project.id);
    // the project's file is gone, and its history with it
    expect(ctx.db.has(project.id)).toBe(false);
    expect(items.get(project.id, item.id)).toBeNull();
  });

  it("an item needs a project: nothing defaults it any more", async () => {
    const { items, board } = await fresh();
    expect(() => items.create({ title: "A", boardId: board.id, by: "human" })).toThrow(NotFoundError);
  });

  it("purging a missing item throws NotFoundError", async () => {
    const { items, project } = await fresh();
    expect(() => items.purge(project.id, "nope", "human")).toThrow(NotFoundError);
  });
});
