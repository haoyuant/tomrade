/** Workstreams are a field's options, so agents get the full set: list, create, rename, remove-with-move. */
import { describe, expect, it } from "vitest";
import { InUseError } from "@tomradex/domain";
import { Tools, ToolInputError } from "@tomradex/tools";
import { fresh } from "@tomradex/testkit";

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
    const created = (await run("create_workstream", { name: "Docs" })) as { id: string; name: string };
    expect(boards.list(project.id).map((b) => b.name)).toEqual(["Main", "Docs"]);
    expect(oplog.historyFor(project.id, "board", created.id, 1)[0]?.by).toBe("ai:test");
    const renamed = (await run("update_workstream", { id: created.id, patch: { name: "Documentation" } })) as { name: string };
    expect(renamed.name).toBe("Documentation");
    expect(((await run("list_workstreams", {})) as { name: string }[]).map((b) => b.name)).toEqual(["Main", "Documentation"]);
    oplog.undoLast(project.id, created.id);
    expect(boards.get(project.id, created.id)?.name).toBe("Docs");
  });

  it("stores repoPath as a folder in the repository and refuses a path on this machine", async () => {
    const { run, boards, project } = await withTools();
    const created = (await run("create_workstream", { name: "Web", repoPath: "apps\\web\\" })) as { id: string; repoPath: string };
    expect(created.repoPath).toBe("apps/web");
    expect(((await run("update_workstream", { id: created.id, patch: { repoPath: "packages//ui/" } })) as { repoPath: string }).repoPath).toBe("packages/ui");
    await expect(run("create_workstream", { name: "Goods", repoPath: "D:\\codexApp\\goods-list" })).rejects.toThrow(/relative to its root/);
    await expect(run("update_workstream", { id: created.id, patch: { repoPath: "\\\\nas\\code\\app" } })).rejects.toThrow(/not a path on this machine/);
    expect(boards.get(project.id, created.id)?.repoPath).toBe("packages/ui");
  });

  it("remove refuses a workstream that holds issues unless told where they go", async () => {
    const { run, boards, items, board, project } = await withTools();
    const docs = (await run("create_workstream", { name: "Docs" })) as { id: string };
    const a = items.create({ projectId: project.id, title: "A", boardId: docs.id, by: "human" });
    await expect(run("remove_workstream", { id: docs.id })).rejects.toBeInstanceOf(InUseError);
    const result = (await run("remove_workstream", { id: docs.id, moveTo: board.id })) as { moved: number };
    expect(result.moved).toBe(1);
    expect(items.get(project.id, a.id)?.boardId).toBe(board.id);
    expect(boards.list(project.id).map((b) => b.name)).toEqual(["Main"]);
    await expect(run("remove_workstream", { id: board.id })).rejects.toBeInstanceOf(InUseError);
  });

  it("without a project in scope, a tool refuses rather than guessing", async () => {
    const { ctx } = await withTools();
    await expect(ctx.tools.execute("list_workstreams", {}, { by: "ai:test" })).rejects.toBeInstanceOf(ToolInputError);
    await expect(ctx.tools.execute("list_workstreams", {}, { by: "ai:test" })).rejects.toThrow(/list_projects/);
  });

  it("keeps a caller bound to a project inside it, and lets an unbound caller name any project", async () => {
    const { ctx, projects, boards } = await withTools();
    const mine = projects.create({ name: "Mine" });
    const other = projects.create({ name: "Other" });
    await expect(ctx.tools.execute("create_workstream", { projectId: other.id, name: "Theirs" }, { by: "ai:test", projectId: mine.id })).rejects.toThrow("is another project");
    expect(boards.list(other.id).map((b) => b.name)).not.toContain("Theirs");
    const created = (await ctx.tools.execute("create_workstream", { projectId: other.id, name: "Theirs" }, { by: "ai:test" })) as { id: string };
    expect(boards.get(other.id, created.id)?.name).toBe("Theirs");
  });
});
