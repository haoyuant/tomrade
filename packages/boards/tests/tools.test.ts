/** Workstreams are a field's options, so agents get the full set: list, create, rename, remove-with-move. */
import { describe, expect, it } from "vitest";
import { InUseError } from "@tomrade/domain";
import { Tools } from "@tomrade/tools";
import { fresh } from "@tomrade/testkit";

async function withTools() {
  const f = await fresh();
  await f.ctx.plugin(Tools);
  await new Promise((r) => setTimeout(r, 0));
  const run = (name: string, args: unknown) => f.ctx.tools.execute(name, args, { by: "ai:test", projectId: f.project.id });
  return { ...f, run };
}

describe("workstream tools", () => {
  it("create, update and list are attributed to the agent and undoable", async () => {
    const { run, boards, oplog, project } = await withTools();
    const created = (await run("create_workstream", { name: "Docs", subtitle: "docs/" })) as { id: string; name: string };
    expect(boards.list(project.id).map((b) => b.name)).toEqual(["Main", "Docs"]);
    expect(oplog.historyFor("board", created.id, 1)[0]?.by).toBe("ai:test");
    const renamed = (await run("update_workstream", { id: created.id, patch: { name: "Documentation" } })) as { name: string };
    expect(renamed.name).toBe("Documentation");
    expect(((await run("list_workstreams", {})) as { name: string }[]).map((b) => b.name)).toEqual(["Main", "Documentation"]);
    oplog.undoLast(created.id);
    expect(boards.get(created.id)?.name).toBe("Docs");
  });

  it("remove refuses a workstream that holds issues unless told where they go", async () => {
    const { run, boards, items, board, project } = await withTools();
    const docs = (await run("create_workstream", { name: "Docs" })) as { id: string };
    const a = items.create({ title: "A", boardId: docs.id, by: "human" });
    await expect(run("remove_workstream", { id: docs.id })).rejects.toBeInstanceOf(InUseError);
    const result = (await run("remove_workstream", { id: docs.id, moveTo: board.id })) as { moved: number };
    expect(result.moved).toBe(1);
    expect(items.get(a.id)?.boardId).toBe(board.id);
    expect(boards.list(project.id).map((b) => b.name)).toEqual(["Main"]);
    await expect(run("remove_workstream", { id: board.id })).rejects.toBeInstanceOf(InUseError);
  });
});
