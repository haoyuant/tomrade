import { describe, expect, it } from "vitest";
import { Contributions } from "@tomradex/contributions";
import { fresh } from "@tomradex/testkit";

describe("contributions", () => {
  it("a plugin contributes commands, badges, status items and sections as data, and they leave with it", async () => {
    const { ctx, items, board, project } = await fresh({ plugins: [Contributions] });
    const item = items.create({ projectId: project.id, title: "Needs attention", boardId: board.id, labels: ["bug"], by: "human" });
    const acked: string[] = [];
    const fiber = await ctx.plugin({
      name: "demo",
      inject: ["contributions"],
      apply(ctx) {
        ctx.contributions.command({ id: "demo.ack", title: "Acknowledge", run: ({ itemId }) => (itemId ? (acked.push(itemId), { toast: "Acknowledged" }) : { toast: "Select an issue" }) });
        ctx.contributions.badge({ id: "demo", compute: (items) => Object.fromEntries(items.filter((i) => i.labels.includes("bug")).map((i) => [i.id, [{ id: "bug", label: "bug!" }]])) });
        ctx.contributions.statusItem({ id: "demo", text: () => (acked.length ? `${acked.length} acked` : null) });
        ctx.contributions.section({ id: "demo", title: "Demo", render: (item) => (item.labels.includes("bug") ? { rows: [{ label: "Severity", value: "high" }] } : null) });
        ctx.contributions.assistantAccessory({
          id: "demo.pet",
          kind: "animated-pet",
          title: "Demo pet",
          stateChannel: "demo.pet.state",
          changedChannel: "demo.pet.changed",
          width: 32,
          height: 24,
          animations: { idle: { source: "data:image/png;base64,demo", type: "image/png", box: { x: 0, y: 2, width: 32, height: 20 } } }
        });
      }
    });

    expect(ctx.contributions.commands()).toEqual([{ id: "demo.ack", title: "Acknowledge" }]);
    expect((await ctx.contributions.badgesFor(project.id))).toEqual({ [item.id]: [{ id: "bug", label: "bug!" }] });
    expect((await ctx.contributions.statusItems({ projectId: project.id }))).toEqual([]);
    expect(await ctx.contributions.run("demo.ack", { projectId: project.id, itemId: item.id })).toEqual({ toast: "Acknowledged" });
    expect((await ctx.contributions.statusItems({ projectId: project.id }))).toEqual([{ id: "demo", text: "1 acked" }]);
    expect((await ctx.contributions.sectionsFor(project.id, item.id))).toEqual([{ id: "demo", title: "Demo", rows: [{ label: "Severity", value: "high" }], text: undefined }]);
    expect(ctx.contributions.assistantAccessories()).toEqual([
      {
        id: "demo.pet",
        kind: "animated-pet",
        title: "Demo pet",
        stateChannel: "demo.pet.state",
        changedChannel: "demo.pet.changed",
        width: 32,
        height: 24,
        animations: { idle: { source: "data:image/png;base64,demo", type: "image/png", box: { x: 0, y: 2, width: 32, height: 20 } } }
      }
    ]);

    await fiber.dispose();
    expect(ctx.contributions.commands()).toEqual([]);
    expect((await ctx.contributions.badgesFor(project.id))).toEqual({});
    expect(ctx.contributions.assistantAccessories()).toEqual([]);
    await expect(ctx.contributions.run("demo.ack", {})).rejects.toThrow(/Unknown command/);
  });

  it("a plugin adds sidebar modules: a door alone, or rows per project, and a module whose rows fail is left out", async () => {
    const { ctx, project } = await fresh({ plugins: [Contributions] });
    const fiber = await ctx.plugin({
      name: "demo",
      inject: ["contributions"],
      apply(ctx) {
        ctx.contributions.sidebarModule({ id: "demo.door", title: () => "Door", icon: "i-plug", command: "demo.open" });
        ctx.contributions.sidebarModule({ id: "demo.list", title: "List", rows: ({ projectId }) => [{ id: "a", label: projectId, count: 2, detail: "first" }] });
        ctx.contributions.sidebarModule({ id: "demo.hidden", title: "Hidden", rows: () => null });
        ctx.contributions.sidebarModule({ id: "demo.broken", title: "Broken", rows: () => { throw new Error("boom"); } });
      }
    });

    expect(await ctx.contributions.sidebarModules(project.id)).toEqual([
      { id: "demo.door", title: "Door", icon: "i-plug", command: "demo.open" },
      { id: "demo.list", title: "List", rows: [{ id: "a", label: project.id, count: 2, detail: "first" }] }
    ]);
    await fiber.dispose();
    expect(await ctx.contributions.sidebarModules(project.id)).toEqual([]);
  });
});
