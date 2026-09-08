import { describe, expect, it } from "vitest";
import { Contributions } from "@tomrade/contributions";
import { fresh } from "@tomrade/testkit";

describe("contributions", () => {
  it("a plugin contributes commands, badges, status items and sections as data, and they leave with it", async () => {
    const { ctx, items, board, project } = await fresh({ plugins: [Contributions] });
    const item = items.create({ title: "Needs attention", boardId: board.id, labels: ["bug"], by: "human" });
    const acked: string[] = [];
    const fiber = await ctx.plugin({
      name: "demo",
      inject: ["contributions"],
      apply(ctx) {
        ctx.contributions.command({ id: "demo.ack", title: "Acknowledge", run: ({ itemId }) => (itemId ? (acked.push(itemId), { toast: "Acknowledged" }) : { toast: "Select an issue" }) });
        ctx.contributions.badge({ id: "demo", compute: (items) => Object.fromEntries(items.filter((i) => i.labels.includes("bug")).map((i) => [i.id, [{ id: "bug", label: "bug!" }]])) });
        ctx.contributions.statusItem({ id: "demo", text: () => (acked.length ? `${acked.length} acked` : null) });
        ctx.contributions.section({ id: "demo", title: "Demo", render: (item) => (item.labels.includes("bug") ? { rows: [{ label: "Severity", value: "high" }] } : null) });
      }
    });

    expect(ctx.contributions.commands()).toEqual([{ id: "demo.ack", title: "Acknowledge" }]);
    expect(ctx.contributions.badgesFor(project.id)).toEqual({ [item.id]: [{ id: "bug", label: "bug!" }] });
    expect(ctx.contributions.statusItems({ projectId: project.id })).toEqual([]);
    expect(await ctx.contributions.run("demo.ack", { projectId: project.id, itemId: item.id })).toEqual({ toast: "Acknowledged" });
    expect(ctx.contributions.statusItems({ projectId: project.id })).toEqual([{ id: "demo", text: "1 acked" }]);
    expect(ctx.contributions.sectionsFor(item.id)).toEqual([{ id: "demo", title: "Demo", rows: [{ label: "Severity", value: "high" }], text: undefined }]);

    await fiber.dispose();
    expect(ctx.contributions.commands()).toEqual([]);
    expect(ctx.contributions.badgesFor(project.id)).toEqual({});
    await expect(ctx.contributions.run("demo.ack", {})).rejects.toThrow(/Unknown command/);
  });
});
