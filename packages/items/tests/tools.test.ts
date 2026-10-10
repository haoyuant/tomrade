/** Backlog tools, run through the tool registry like an agent would call them. */
import { describe, expect, it } from "vitest";
import { NotFoundError } from "@tomradex/domain";
import { ToolInputError, Tools } from "@tomradex/tools";
import { fresh } from "@tomradex/testkit";

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

  it("a limit caps list_items but never count_items, and survives the scalar filters", async () => {
    const { run, items, board, project } = await withTools();
    for (const title of ["Dark mode toggle", "Dark theme", "Light mode"]) items.create({ projectId: project.id, title, boardId: board.id, status: "todo", by: "human" });
    const titles = async (args: object) => ((await run("list_items", args)) as { title: string }[]).map((i) => i.title);
    expect(await titles({ search: "dark", limit: 1 })).toHaveLength(1);
    expect(await titles({ search: "dark", sort: [{ field: "title", dir: "asc" }], limit: 1 })).toEqual(["Dark mode toggle"]);
    // A scalar filter forces the cut after the JS filter, so it still yields a full page.
    expect(await titles({ status: "todo", sort: [{ field: "title", dir: "asc" }], limit: 2 })).toEqual(["Dark mode toggle", "Dark theme"]);
    expect(await run("count_items", { search: "dark", limit: 1 })).toMatchObject({ count: 2 });
  });

  it("a projectId naming no open project is refused rather than silently matching nothing", async () => {
    const { run } = await withTools();
    await expect(run("list_items", { projectId: "tomrade" })).rejects.toBeInstanceOf(ToolInputError);
    await expect(run("count_items", { projectId: "tomrade" })).rejects.toBeInstanceOf(ToolInputError);
  });

  it("list_items widens a search that matched nothing; count_items stays strict", async () => {
    const { run, items, board, project } = await withTools();
    items.create({ projectId: project.id, title: "Dark mode toggle", body: "Add a dark theme", boardId: board.id, by: "human" });
    items.create({ projectId: project.id, title: "Light mode", body: "Nothing dark here", boardId: board.id, by: "human" });
    expect(((await run("list_items", { search: "toggle nothing" })) as { title: string }[]).map((i) => i.title).sort()).toEqual(["Dark mode toggle", "Light mode"]);
    expect(((await run("list_items", { search: "toggle" })) as unknown[]).length).toBe(1);
    expect(await run("count_items", { search: "toggle nothing" })).toMatchObject({ count: 0 });
  });

  it("lists a page of 50 by default; a larger limit and count_items see everything", async () => {
    const { run, items, board, project } = await withTools();
    for (let i = 0; i < 60; i++) items.create({ projectId: project.id, title: `Ticket ${i}`, boardId: board.id, by: "human" });
    expect(((await run("list_items", {})) as unknown[]).length).toBe(50);
    expect(((await run("list_items", { limit: 100 })) as unknown[]).length).toBe(60);
    expect(await run("count_items", {})).toMatchObject({ count: 60 });
  });

  it("counts tickets exactly and returns compact breakdowns without listing rows", async () => {
    const { run, items, boards, board, project } = await withTools();
    const cloud = boards.create({ projectId: project.id, name: "Cloud" });
    items.create({ projectId: project.id, title: "Backlog ticket", boardId: board.id, kind: "ticket", status: "backlog", by: "human" });
    items.create({ projectId: project.id, title: "Done ticket", boardId: cloud.id, kind: "ticket", status: "done", by: "human" });
    items.create({ projectId: project.id, title: "Epic", boardId: board.id, kind: "epic", status: "backlog", by: "human" });

    expect(await run("count_items", { kind: "ticket" })).toEqual({
      count: 2,
      byKind: { ticket: 2, epic: 0 },
      byStatus: { backlog: 1, todo: 0, doing: 0, verifying: 0, done: 1, cancelled: 0 },
      byWorkstream: { Main: 1, Cloud: 1 }
    });
    expect(await run("count_items", {})).toMatchObject({ count: 3, byKind: { ticket: 2, epic: 1 } });
  });
});
