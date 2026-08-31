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
    const entries = oplog.recent(10);
    expect(entries.find((e) => (e.after as { title?: string })?.title === "from a run")?.runId).toBe("run-1");
    expect(entries.find((e) => e.entityId === plain.id)?.runId).toBeNull();
  });

  it("stamps writes made under writeContext directly", async () => {
    const { items, oplog, project, board } = await fresh();
    writeContext.run({ runId: "run-2", author: "ai:agent" }, () => items.create({ projectId: project.id, boardId: board.id, title: "ctx", by: "ai:agent" }));
    expect(oplog.recent(1)[0].runId).toBe("run-2");
  });

  it("reverts a whole run, keeps entities edited afterwards, and reports them", async () => {
    const { items, oplog, project, board } = await fresh();
    const pre = items.create({ projectId: project.id, boardId: board.id, title: "pre-existing", by: "human" });
    const doomed = items.create({ projectId: project.id, boardId: board.id, title: "doomed", by: "human" });

    let a!: string, b!: string;
    writeContext.run({ runId: "r", author: "ai:agent" }, () => {
      a = items.create({ projectId: project.id, boardId: board.id, title: "epic A", by: "ai:agent" }).id;
      b = items.create({ projectId: project.id, boardId: board.id, title: "feature B", by: "ai:agent" }).id;
      items.update(pre.id, { title: "retitled by agent" }, "ai:agent");
      items.delete(doomed.id, "ai:agent");
    });
    // The human edits B after the run — that write must survive the revert.
    items.update(b, { title: "kept by human" }, "human");

    const result = oplog.undoRun("r");
    expect(result.kept).toEqual([expect.objectContaining({ entityId: b, reason: "edited after this run" })]);
    expect(result.reverted).toBe(3);
    expect(items.get(a)).toBeNull();
    expect(items.get(b)?.title).toBe("kept by human");
    expect(items.get(pre.id)?.title).toBe("pre-existing");
    expect(items.get(doomed.id)?.title).toBe("doomed");
    // Consumed entries are gone; ⌘Z next reaches the human edit, not the run's writes.
    expect(oplog.recent(50).filter((e) => e.runId === "r").map((e) => e.entityId)).toEqual([b]);
  });

  it("treats a created row someone already deleted as nothing to do", async () => {
    const { items, oplog, project, board } = await fresh();
    let id!: string;
    writeContext.run({ runId: "r2", author: "ai:agent" }, () => {
      id = items.create({ projectId: project.id, boardId: board.id, title: "gone", by: "ai:agent" }).id;
    });
    items.delete(id, "human");
    const result = oplog.undoRun("r2");
    expect(result.reverted).toBe(1);
    expect(result.kept).toEqual([]);
  });

  it("has nothing to revert after a purge erased the run's history", async () => {
    const { items, oplog, project, board } = await fresh();
    let id!: string;
    writeContext.run({ runId: "r3", author: "ai:agent" }, () => {
      id = items.create({ projectId: project.id, boardId: board.id, title: "purged", by: "ai:agent" }).id;
    });
    items.purge(id, "human");
    expect(oplog.undoRun("r3")).toEqual({ reverted: 0, kept: [] });
  });
});
