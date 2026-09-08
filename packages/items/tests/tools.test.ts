/** Backlog tools, run through the tool registry like an agent would call them. */
import { describe, expect, it } from "vitest";
import { NotFoundError } from "@tomrade/domain";
import { Tools } from "@tomrade/tools";
import { fresh } from "@tomrade/testkit";

async function withTools() {
  const f = await fresh();
  await f.ctx.plugin(Tools);
  await new Promise((r) => setTimeout(r, 0));
  const run = (name: string, args: unknown) => f.ctx.tools.execute(name, args, { by: "ai:test", projectId: f.project.id });
  return { ...f, run };
}

describe("list_items tool", () => {
  it("a boardId naming no real workstream is refused rather than silently matching nothing", async () => {
    const { run, items, board, project } = await withTools();
    items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    await expect(run("list_items", { boardId: "no-such-board" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a real boardId still filters as before", async () => {
    const { run, items, boards, board, project } = await withTools();
    const other = boards.create({ projectId: project.id, name: "Other" });
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.create({ projectId: project.id, title: "B", boardId: other.id, by: "human" });
    expect(((await run("list_items", { boardId: board.id })) as { id: string }[]).map((i) => i.id)).toEqual([a.id]);
  });

  it("no boardId still lists every item in scope", async () => {
    const { run, items, board, project } = await withTools();
    items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    expect(((await run("list_items", {})) as unknown[]).length).toBe(2);
  });
});
