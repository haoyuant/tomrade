/**
 * One registry. Domain plugins contribute their tools when ctx.tools exists,
 * every call is validated and gated the same way, and a plugin's tools leave
 * with it. A tool without a project in scope refuses rather than guessing.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConflictError } from "@tomrade/domain";
import { fresh } from "@tomrade/testkit";
import { Tools, ToolInputError, UnknownToolError, defineTool } from "@tomrade/tools";

const BACKLOG_TOOLS = [
  "change_status",
  "create_field",
  "create_item",
  "create_workstream",
  "delete_item",
  "get_item",
  "list_fields",
  "list_items",
  "list_projects",
  "list_workstreams",
  "remove_workstream",
  "update_item",
  "update_workstream"
];

describe("tool registry", () => {
  it("the backlog tools register themselves once ctx.tools exists", async () => {
    const { ctx } = await fresh({ plugins: [Tools] });
    expect(ctx.tools.list().map((t) => t.name).sort()).toEqual(BACKLOG_TOOLS);
    expect(ctx.tools.describe().every((t) => typeof t.inputSchema === "object")).toBe(true);
  });

  it("validates arguments against the tool's schema and rejects unknown tools", async () => {
    const { ctx, project } = await fresh({ plugins: [Tools] });
    await expect(ctx.tools.execute("create_item", {}, { by: "ai:mcp", projectId: project.id })).rejects.toBeInstanceOf(ToolInputError);
    await expect(ctx.tools.execute("nope", {}, { by: "ai:mcp" })).rejects.toBeInstanceOf(UnknownToolError);
  });

  it("list_projects names the ids every other tool takes", async () => {
    const { ctx, projects, project } = await fresh({ plugins: [Tools] });
    const other = projects.create({ name: "Other" });
    const listed = (await ctx.tools.execute("list_projects", {}, { by: "ai:mcp" })) as { id: string; name: string }[];
    expect(listed.map((p) => p.id).sort()).toEqual([project.id, other.id].sort());
  });

  it("a write tool with no project in scope is refused, naming list_projects", async () => {
    const { ctx, items } = await fresh({ plugins: [Tools] });
    await expect(ctx.tools.execute("create_item", { title: "Nowhere" }, { by: "ai:mcp" })).rejects.toThrow(/list_projects/);
    expect(items.list().length).toBe(0);
  });

  it("create_item lands on the project's first board and carries the caller as author", async () => {
    const { ctx, items, board, project } = await fresh({ plugins: [Tools] });
    const created = (await ctx.tools.execute("create_item", { title: "From MCP" }, { by: "ai:mcp", projectId: project.id })) as { id: string };
    const item = items.get(project.id, created.id)!;
    expect(item.boardId).toBe(board.id);
    expect(item.updatedBy).toBe("ai:mcp");
  });

  it("list_items scopes to the caller's project and filters by search", async () => {
    const { ctx, items, boards, projects, board, project } = await fresh({ plugins: [Tools] });
    const other = projects.create({ name: "Other" });
    items.create({ projectId: project.id, title: "Dark mode", boardId: board.id, by: "human" });
    items.create({ projectId: project.id, title: "Light mode", boardId: board.id, by: "human" });
    items.create({ title: "Elsewhere", projectId: other.id, boardId: boards.defaultFor(other.id).id, by: "human" });
    const all = (await ctx.tools.execute("list_items", {}, { by: "ai:assistant", projectId: project.id })) as unknown[];
    const dark = (await ctx.tools.execute("list_items", { search: "dark" }, { by: "ai:assistant", projectId: project.id })) as { title: string }[];
    expect(all.length).toBe(2);
    expect(dark.map((i) => i.title)).toEqual(["Dark mode"]);
  });

  it("a write tool without baseVersion asserts the version it reads; a stale one is refused", async () => {
    const { ctx, items, board, project } = await fresh({ plugins: [Tools] });
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const moved = (await ctx.tools.execute("change_status", { id: item.id, status: "todo" }, { by: "ai:assistant", projectId: project.id })) as { version: number };
    expect(moved.version).toBe(2);
    await expect(ctx.tools.execute("update_item", { id: item.id, patch: { title: "x" }, baseVersion: 1 }, { by: "ai:mcp", projectId: project.id })).rejects.toBeInstanceOf(ConflictError);
  });

  it("tools/pre-execute gates every call and tools/result reports the outcome", async () => {
    const { ctx, items, board, project } = await fresh({ plugins: [Tools] });
    const item = items.create({ projectId: project.id, title: "Keep", boardId: board.id, by: "human" });
    const outcomes: boolean[] = [];
    ctx.on("tools/pre-execute", (call, next) => {
      if (call.name === "delete_item") throw new Error("deletes need approval");
      return next();
    });
    ctx.on("tools/result", (_call, outcome) => outcomes.push(outcome.ok));
    await expect(ctx.tools.execute("delete_item", { id: item.id }, { by: "ai:mcp", projectId: project.id })).rejects.toThrow(/approval/);
    expect(items.get(project.id, item.id)).not.toBeNull();
    await ctx.tools.execute("get_item", { id: item.id }, { by: "ai:mcp", projectId: project.id });
    expect(outcomes).toEqual([false, true]);
  });

  it("a plugin's tools are removed when it unloads, and a name cannot be taken twice", async () => {
    const { ctx } = await fresh({ plugins: [Tools] });
    const echo = defineTool({ name: "echo", title: "Echo", description: "Echo the input.", input: z.object({ text: z.string() }), execute: ({ text }) => text });
    const fiber = await ctx.plugin({ name: "echo-plugin", inject: ["tools"], apply: (ctx) => void ctx.tools.register(echo) });
    expect(await ctx.tools.execute("echo", { text: "hi" }, { by: "ai:test" })).toBe("hi");
    expect(() => ctx.tools.register(echo)).toThrow(/already registered/);
    await fiber.dispose();
    expect(ctx.tools.has("echo")).toBe(false);
  });
});
