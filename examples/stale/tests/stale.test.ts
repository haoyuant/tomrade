/**
 * The example plugin edits no first-party file: it owns its table, its
 * settings card, a tool, a badge, a status item, a section and a command.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import stale from "@tomrade/example-stale";
import { Contributions } from "@tomrade/contributions";
import { Settings } from "@tomrade/settings";
import { Tools } from "@tomrade/tools";
import { fresh } from "@tomrade/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-stale-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("example plugin: stale", () => {
  it("badges idle issues, counts them, lists them for agents, and clears an acknowledgement on the next write", async () => {
    const { ctx, db, items, board, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Contributions, stale] });
    const old = items.create({ title: "Forgotten", boardId: board.id, by: "human" });
    const fresh_ = items.create({ title: "Fresh", boardId: board.id, by: "human" });
    db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(Date.now() - 20 * 86_400_000, old.id);

    expect(ctx.settings.sections().map((s) => s.id)).toContain("stale");
    expect((db.prepare("SELECT version FROM plugin_migrations WHERE namespace = 'stale'").get() as { version: number }).version).toBe(1);

    expect(Object.keys(ctx.contributions.badgesFor(project.id))).toEqual([old.id]);
    expect(ctx.contributions.statusItems({ projectId: project.id })).toEqual([{ id: "stale", text: "1 stale" }]);
    expect(ctx.contributions.sectionsFor(old.id)[0]?.rows[0]).toEqual({ label: "Idle", value: "20 days" });
    expect(ctx.contributions.sectionsFor(fresh_.id)).toEqual([]);
    expect(((await ctx.tools.execute("list_stale_items", {}, { by: "ai:mcp", projectId: project.id })) as { id: string }[]).map((i) => i.id)).toEqual([old.id]);

    expect(await ctx.contributions.run("stale.ack", { projectId: project.id, itemId: old.id })).toMatchObject({ toast: expect.stringMatching(/Acknowledged/) });
    expect(ctx.contributions.badgesFor(project.id)).toEqual({});

    items.update(old.id, { status: "todo" }, "ai:mcp", { baseVersion: 1 });
    db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(Date.now() - 20 * 86_400_000, old.id);
    expect(Object.keys(ctx.contributions.badgesFor(project.id))).toEqual([old.id]);

    ctx.settings.set({ ...ctx.settings.get(), stale: { days: 30 } });
    expect(ctx.contributions.badgesFor(project.id)).toEqual({});
  });
});
