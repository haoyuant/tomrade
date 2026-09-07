import { describe, expect, it } from "vitest";
import { fresh } from "@tomrade/testkit";
import { Tools, defineTool, type RunHandle } from "@tomrade/tools";
import { writeContext } from "@tomrade/write";
import { z } from "zod";

const runHandle = (id: string, projectId: string): RunHandle => ({
  id,
  threadId: "t1",
  projectId,
  author: "ai:agent",
  ledger: { all: () => [], find: () => undefined },
  waivers: new Set(),
  scratch: new Map()
});

describe("run-scoped oplog", () => {
  it("stamps writes made inside a run-bound tool execution", async () => {
    const { ctx, items, oplog, project, board } = await fresh({ plugins: [Tools] });
    ctx.tools.register(
      defineTool({
        name: "make",
        title: "make",
        description: "test",
        input: z.object({ title: z.string() }),
        execute: ({ title }, inv) => ctx.items.create({ projectId: inv.projectId!, boardId: board.id, title, by: inv.by })
      })
    );
    await ctx.tools.execute("make", { title: "from a run" }, { by: "ai:agent", projectId: project.id, run: runHandle("run-1", project.id) });
    const plain = items.create({ projectId: project.id, boardId: board.id, title: "outside", by: "human" });
    const entries = oplog.recent(project.id, 10);
    expect(entries.find((e) => (e.after as { title?: string })?.title === "from a run")?.runId).toBe("run-1");
    expect(entries.find((e) => e.entityId === plain.id)?.runId).toBeNull();
  });

  it("stamps writes made under writeContext directly", async () => {
    const { items, oplog, project, board } = await fresh();
    writeContext.run({ runId: "run-2", author: "ai:agent" }, () => items.create({ projectId: project.id, boardId: board.id, title: "ctx", by: "ai:agent" }));
    expect(oplog.recent(project.id, 1)[0].runId).toBe("run-2");
  });

  it("every row carries this machine's id, its place in this machine's own sequence, and the fields it changed", async () => {
    const { items, oplog, hub, project, board } = await fresh();
    const a = items.create({ projectId: project.id, boardId: board.id, title: "A", by: "human" });
    items.update(project.id, a.id, { status: "doing" }, "human");
    const [update, create] = oplog.recent(project.id, 2);
    expect(create.device).toBe(hub.deviceId);
    expect(update.deviceSeq).toBe(create.deviceSeq! + 1);
    expect((create.patch as { title?: string }).title).toBe("A");
    expect(update.patch).toMatchObject({ status: "doing", version: 2 });
    expect(update.patch).not.toHaveProperty("title");
  });

  it("reverts a whole run, keeps entities edited afterwards, and reports them", async () => {
    const { items, oplog, project, board } = await fresh();
    const pre = items.create({ projectId: project.id, boardId: board.id, title: "pre-existing", by: "human" });
    const doomed = items.create({ projectId: project.id, boardId: board.id, title: "doomed", by: "human" });

    let a!: string, b!: string;
    writeContext.run({ runId: "r", author: "ai:agent" }, () => {
      a = items.create({ projectId: project.id, boardId: board.id, title: "epic A", by: "ai:agent" }).id;
      b = items.create({ projectId: project.id, boardId: board.id, title: "feature B", by: "ai:agent" }).id;
      items.update(project.id, pre.id, { title: "retitled by agent" }, "ai:agent");
      items.delete(project.id, doomed.id, "ai:agent");
    });
    // The human edits B after the run — that write must survive the revert.
    items.update(project.id, b, { title: "kept by human" }, "human");

    const result = oplog.undoRun(project.id, "r");
    expect(result.kept).toEqual([expect.objectContaining({ entityId: b, reason: "edited after this run" })]);
    expect(result.reverted).toBe(3);
    expect(items.get(project.id, a)).toBeNull();
    expect(items.get(project.id, b)?.title).toBe("kept by human");
    expect(items.get(project.id, pre.id)?.title).toBe("pre-existing");
    expect(items.get(project.id, doomed.id)?.title).toBe("doomed");
    // Consumed entries are gone; ⌘Z next reaches the human edit, not the run's writes.
    expect(oplog.recent(project.id, 50).filter((e) => e.runId === "r").map((e) => e.entityId)).toEqual([b]);
  });

  it("treats a created row someone already deleted as nothing to do", async () => {
    const { items, oplog, project, board } = await fresh();
    let id!: string;
    writeContext.run({ runId: "r2", author: "ai:agent" }, () => {
      id = items.create({ projectId: project.id, boardId: board.id, title: "gone", by: "ai:agent" }).id;
    });
    items.delete(project.id, id, "human");
    const result = oplog.undoRun(project.id, "r2");
    expect(result.reverted).toBe(1);
    expect(result.kept).toEqual([]);
  });

  it("has nothing to revert after a purge erased the run's history", async () => {
    const { items, oplog, project, board } = await fresh();
    let id!: string;
    writeContext.run({ runId: "r3", author: "ai:agent" }, () => {
      id = items.create({ projectId: project.id, boardId: board.id, title: "purged", by: "ai:agent" }).id;
    });
    items.purge(project.id, id, "human");
    expect(oplog.undoRun(project.id, "r3")).toEqual({ reverted: 0, kept: [] });
  });

  it("undo is per project: a write in one project never reaches the other's ⌘Z", async () => {
    const { items, oplog, projects, boards, project, board } = await fresh();
    const other = projects.create({ name: "Other" });
    const mine = items.create({ projectId: project.id, boardId: board.id, title: "mine", by: "human" });
    items.create({ projectId: other.id, boardId: boards.defaultFor(other.id).id, title: "theirs", by: "human" });
    expect(oplog.undoLast(project.id)?.entry.entityId).toBe(mine.id);
    expect(items.list({ projectId: other.id }).length).toBe(1);
    expect(oplog.recent(project.id, 10)).toEqual([]);
  });

  it("a row imported from another machine is history, not something ⌘Z reverts", async () => {
    const { items, oplog, project, board } = await fresh();
    const a = items.create({ projectId: project.id, boardId: board.id, title: "A", by: "human" });
    const imported = oplog.importForeign(project.id, [
      { device: "k2a9", deviceSeq: 7, entity: "item", entityId: a.id, op: "update", baseVersion: 1, by: "human", at: Date.now(), patch: { status: "doing" } },
      { device: "k2a9", deviceSeq: 7, entity: "item", entityId: a.id, op: "update", baseVersion: 1, by: "human", at: Date.now(), patch: { status: "doing" } }
    ]);
    expect(imported).toBe(1);
    expect(oplog.historyFor(project.id, "item", a.id).map((e) => e.device)).toContain("k2a9");
    // ⌘Z reaches our own create, stepping over the foreign row
    expect(oplog.undoLast(project.id)?.entry.op).toBe("create");
  });

  it("keeps this machine's sequence going after a rebuild renumbered the rows", async () => {
    const { items, oplog, hub, project, board } = await fresh();
    // A rebuilt cache holds our own history read back from the folder: fresh row ids, the old device_seq values.
    oplog.importForeign(
      project.id,
      [7, 8, 9].map((n) => ({ device: hub.deviceId, deviceSeq: n, entity: "item" as const, entityId: "x", op: "update" as const, baseVersion: 1, by: "human" as const, at: n, patch: { status: "doing" } })),
      { includeOwn: true }
    );
    const a = items.create({ projectId: project.id, boardId: board.id, title: "After rebuild", by: "human" });
    const create = oplog.historyFor(project.id, "item", a.id)[0];
    expect(create.deviceSeq).toBe(10);
    expect(create.seq).not.toBe(create.deviceSeq);
    expect(() => items.update(project.id, a.id, { status: "doing" }, "human")).not.toThrow();
  });
});
