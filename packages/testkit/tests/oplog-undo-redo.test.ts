import { describe, expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import type { UndoProvider } from "@tomradex/oplog";
import { StaleUndoError, type UndoRecord } from "@tomradex/domain";

describe("undo and redo", () => {
  it("puts a reverted write back, one step at a time, and a new write empties the redo stack", async () => {
    const { items, oplog, project, board } = await fresh();
    const a = items.create({ projectId: project.id, boardId: board.id, title: "A", by: "human" });
    items.update(project.id, a.id, { status: "doing" }, "human");

    const undone = await oplog.undo(project.id);
    expect(undone?.summary).toBe(`Reverted ${a.key}`);
    expect(items.get(project.id, a.id)?.status).toBe(a.status);

    const redone = await oplog.redo(project.id);
    expect(redone?.summary).toBe(`Re-applied ${a.key}`);
    expect(redone?.record.ref).toBe(undone?.record.ref);
    expect(items.get(project.id, a.id)?.status).toBe("doing");

    await oplog.undo(project.id);
    await oplog.undo(project.id);
    expect(items.get(project.id, a.id)).toBeNull();
    expect((await oplog.timeline(project.id)).filter((r) => r.undoneAt !== null).map((r) => r.op)).toEqual(["update", "create"]);

    expect((await oplog.redo(project.id))?.summary).toBe(`Re-created ${a.key}`);
    expect(items.get(project.id, a.id)?.title).toBe("A");

    // A write is a fork: the status change can no longer be put back.
    items.create({ projectId: project.id, boardId: board.id, title: "B", by: "human" });
    expect(await oplog.redo(project.id)).toBeNull();
    expect((await oplog.timeline(project.id)).some((r) => r.undoneAt !== null)).toBe(false);
  });

  it("takes back the one write a toast names, and refuses once something newer stands", async () => {
    const { items, oplog, project, board } = await fresh();
    const a = items.create({ projectId: project.id, boardId: board.id, title: "A", by: "human" });
    const renamed = items.update(project.id, a.id, { title: "Renamed" }, "human");
    const reprioritised = items.update(project.id, a.id, { priority: 3 }, "human");

    // The rename's toast: the priority change came after it, so it is not the rename's to take back.
    expect(() => oplog.undoEntity(project.id, a.id, renamed.version)).toThrow(StaleUndoError);
    expect(items.get(project.id, a.id)).toMatchObject({ title: "Renamed", priority: 3 });

    // The newest toast takes back exactly its write…
    expect(oplog.undoEntity(project.id, a.id, reprioritised.version)?.summary).toBe(`Reverted ${a.key}`);
    expect(items.get(project.id, a.id)).toMatchObject({ title: "Renamed", priority: a.priority });
    // …after which the rename stands again, and its toast works.
    oplog.undoEntity(project.id, a.id, renamed.version);
    expect(items.get(project.id, a.id)?.title).toBe("A");
    // Without a stamp it is still "the newest write to this", as ⌘Z-on-an-entity always was.
    expect(oplog.undoEntity(project.id, a.id)?.summary).toBe(`Removed ${a.key}`);
  });

  it("restores a deleted issue, deletes it again, and keeps the redone write in the live history", async () => {
    const { items, oplog, project, board } = await fresh();
    const a = items.create({ projectId: project.id, boardId: board.id, title: "doomed", by: "human" });
    items.delete(project.id, a.id, "human");
    expect((await oplog.undo(project.id))?.summary).toBe(`Restored ${a.key}`);
    expect(items.get(project.id, a.id)?.title).toBe("doomed");
    expect((await oplog.redo(project.id))?.summary).toBe(`Deleted again ${a.key}`);
    expect(items.get(project.id, a.id)).toBeNull();
    const [latest] = oplog.recent(project.id, 1);
    expect(latest.op).toBe("delete");
    expect(latest.entityId).toBe(a.id);
  });

  it("never hands out a device_seq a parked row still holds", async () => {
    const { items, oplog, project, board } = await fresh();
    items.create({ projectId: project.id, boardId: board.id, title: "A", by: "human" });
    const seqA = oplog.recent(project.id, 1)[0].deviceSeq!;
    await oplog.undo(project.id);
    items.create({ projectId: project.id, boardId: board.id, title: "B", by: "human" });
    expect(oplog.recent(project.id, 1)[0].deviceSeq).toBe(seqA + 1);
  });

  it("lists the timeline newest first and moves the cursor to a record in either direction", async () => {
    const { items, oplog, project, board } = await fresh();
    const a = items.create({ projectId: project.id, boardId: board.id, title: "A", by: "human" });
    const b = items.create({ projectId: project.id, boardId: board.id, title: "B", by: "human" });
    const c = items.create({ projectId: project.id, boardId: board.id, title: "C", by: "human" });

    let timeline = await oplog.timeline(project.id);
    expect(timeline.slice(0, 3).map((r) => r.label)).toEqual([c.key, b.key, a.key]);
    expect(timeline[0]).toMatchObject({ provider: "oplog", entity: "item", op: "create", undoable: true, undoneAt: null });

    const back = await oplog.rollback(project.id, timeline[2].ref);
    expect(back.stopped).toBeNull();
    expect(back.steps.map((s) => s.record.label)).toEqual([c.key, b.key]);
    expect(items.get(project.id, a.id)).not.toBeNull();
    expect(items.get(project.id, b.id)).toBeNull();
    expect(items.get(project.id, c.id)).toBeNull();

    timeline = await oplog.timeline(project.id);
    expect(timeline.slice(0, 3).map((r) => r.undoneAt !== null)).toEqual([true, true, false]);

    // Forward again, to the newest record: the stack is replayed in the order it was undone.
    const forward = await oplog.rollback(project.id, timeline[0].ref);
    expect(forward.steps.map((s) => s.record.label)).toEqual([b.key, c.key]);
    expect(items.get(project.id, c.id)?.title).toBe("C");
    expect((await oplog.timeline(project.id)).some((r) => r.undoneAt !== null)).toBe(false);
  });

  it("takes back one named record out of order and reports a record it cannot reach", async () => {
    const { items, oplog, project, board } = await fresh();
    const a = items.create({ projectId: project.id, boardId: board.id, title: "A", by: "human" });
    items.create({ projectId: project.id, boardId: board.id, title: "B", by: "human" });
    const aCreate = (await oplog.timeline(project.id)).find((r) => r.label === a.key)!;
    expect((await oplog.revert(project.id, aCreate.ref)).summary).toBe(`Removed ${a.key}`);
    expect(items.get(project.id, a.id)).toBeNull();
    await expect(oplog.revert(project.id, aCreate.ref)).rejects.toThrow(/already undone/);
    await expect(oplog.revert(project.id, "oplog:999")).rejects.toThrow(/no longer/);
  });

  it("steps over purges and other machines' rows, which the timeline shows but never undoes", async () => {
    const { items, oplog, project, board } = await fresh();
    const a = items.create({ projectId: project.id, boardId: board.id, title: "A", by: "human" });
    const b = items.create({ projectId: project.id, boardId: board.id, title: "B", by: "human" });
    items.purge(project.id, b.id, "human");
    oplog.importForeign(project.id, [{ device: "elsewhere", deviceSeq: 1, entity: "item", entityId: "x", op: "create", baseVersion: null, by: "human", at: Date.now() + 5, runId: null, patch: { title: "theirs" } }]);
    const timeline = await oplog.timeline(project.id);
    expect(timeline[0]).toMatchObject({ device: "elsewhere", undoable: false });
    expect(timeline.find((r) => r.op === "purge")?.undoable).toBe(false);
    expect((await oplog.undo(project.id))?.summary).toBe(`Removed ${a.key}`);
  });

  it("merges a plugin's records into one timeline, sends ⌘Z to whichever is newest, and tells it when a write forks history", async () => {
    const { ctx, items, oplog, project, board } = await fresh();
    const log: UndoRecord[] = [];
    let forgotten = 0;
    const note = (id: string, at: number): UndoRecord => ({
      ref: `notes:${id}`,
      provider: "notes",
      id,
      entity: "note",
      entityId: id,
      op: "write",
      label: `note ${id}`,
      target: null,
      by: "human",
      at,
      runId: null,
      device: ctx.hub.deviceId,
      undoable: true,
      undoneAt: null
    });
    const provider: UndoProvider = {
      id: "notes",
      timeline: () => log,
      undo: (_projectId, id) => {
        const record = log.find((r) => r.id === id)!;
        record.undoneAt = Date.now();
        return `Undid ${record.label}`;
      },
      redo: (_projectId, id) => {
        const record = log.find((r) => r.id === id)!;
        record.undoneAt = null;
        return `Redid ${record.label}`;
      },
      forget: () => {
        forgotten += 1;
        for (let i = log.length - 1; i >= 0; i--) if (log[i]!.undoneAt !== null) log.splice(i, 1);
      }
    };
    oplog.provide(provider);
    expect(() => oplog.provide({ ...provider })).toThrow(/already registered/);

    const a = items.create({ projectId: project.id, boardId: board.id, title: "A", by: "human" });
    expect(forgotten).toBe(1);
    log.push(note("1", Date.now() + 1000));

    const timeline = await oplog.timeline(project.id);
    expect(timeline[0].ref).toBe("notes:1");
    expect(timeline[1].label).toBe(a.key);

    expect((await oplog.undo(project.id))?.summary).toBe("Undid note 1");
    expect((await oplog.undo(project.id))?.summary).toBe(`Removed ${a.key}`);
    expect((await oplog.redo(project.id))?.summary).toBe(`Re-created ${a.key}`);
    expect((await oplog.redo(project.id))?.summary).toBe("Redid note 1");

    await oplog.undo(project.id);
    items.create({ projectId: project.id, boardId: board.id, title: "B", by: "human" });
    expect(log).toHaveLength(0);
    expect(await oplog.redo(project.id)).toBeNull();
  });
});
