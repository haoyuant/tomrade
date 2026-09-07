import { describe, expect, it } from "vitest";
import { Contributions, type GraphEdge } from "@tomrade/contributions";
import { fresh } from "@tomrade/testkit";
import depsGraph from "@tomrade/deps-graph";

async function boot() {
  const world = await fresh({ plugins: [Contributions] });
  const fiber = await world.ctx.plugin(depsGraph);
  return { ...world, fiber };
}

describe("deps-graph plugin", () => {
  it("contributes the Dependencies graph, and it leaves with the plugin", async () => {
    const { ctx, items, board, project, fiber } = await boot();
    const a = items.create({ projectId: project.id, title: "Schema", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "API", boardId: board.id, by: "human" });
    items.update(project.id, a.id, { blocks: [b.id] }, "human");

    expect(ctx.contributions.graphs()).toEqual([{ id: "deps", title: "Dependencies", icon: "i-graph", edits: "blocks" }]);
    const edges = ctx.contributions.graphEdges("deps", { projectId: project.id });
    expect(edges).toEqual([{ from: a.id, to: b.id, tone: "strong", title: `${a.key} blocks ${b.key}` }]);

    await fiber.dispose();
    expect(ctx.contributions.graphs()).toEqual([]);
    expect(() => ctx.contributions.graphEdges("deps", { projectId: project.id })).toThrow(/Unknown graph/);
  });

  it("tones edges: satisfied when the blocker is done, danger on a cycle", async () => {
    const { ctx, items, board, project, dbFor } = await boot();
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    const c = items.create({ projectId: project.id, title: "C", boardId: board.id, by: "human" });
    items.update(project.id, a.id, { blocks: [b.id], status: "done" }, "human");
    // the guarded write refuses cycles, but imported data can still hold one —
    // the lens must show it, so the edges are seeded past the guard
    const raw = dbFor(project.id);
    raw.prepare("INSERT INTO item_relations (from_item_id, to_item_id, kind) VALUES (?, ?, 'blocks')").run(b.id, c.id);
    raw.prepare("INSERT INTO item_relations (from_item_id, to_item_id, kind) VALUES (?, ?, 'blocks')").run(c.id, b.id);

    const tones = new Map((ctx.contributions.graphEdges("deps", { projectId: project.id }) as GraphEdge[]).map((e) => [`${e.from}->${e.to}`, e.tone]));
    expect(tones.get(`${a.id}->${b.id}`)).toBe("faint");
    expect(tones.get(`${b.id}->${c.id}`)).toBe("danger");
    expect(tones.get(`${c.id}->${b.id}`)).toBe("danger");
  });

  it("badges an open issue whose blocker is unfinished, and only that one", async () => {
    const { ctx, items, board, project } = await boot();
    const blocker = items.create({ projectId: project.id, title: "Blocker", boardId: board.id, by: "human" });
    const waiting = items.create({ projectId: project.id, title: "Waiting", boardId: board.id, by: "human" });
    const done = items.create({ projectId: project.id, title: "Done", boardId: board.id, status: "done", by: "human" });
    items.update(project.id, blocker.id, { blocks: [waiting.id, done.id] }, "human");

    const badges = ctx.contributions.badgesFor(project.id);
    expect(badges[waiting.id]).toEqual([{ id: "blocked", label: "blocked", tone: "strong", title: `Blocked by ${blocker.key}` }]);
    expect(badges[done.id]).toBeUndefined();

    items.update(project.id, blocker.id, { status: "done" }, "human");
    expect(ctx.contributions.badgesFor(project.id)[waiting.id]).toBeUndefined();
  });
});
