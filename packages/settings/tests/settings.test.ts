import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Settings, type SettingsSectionView } from "@tomrade/settings";
import { fresh } from "@tomrade/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-settings-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `settings-${n++}.json`);

describe("settings", () => {
  it("returns defaults for registered sections and persists what is set", async () => {
    const p = file();
    const { ctx } = await fresh({ plugins: [[Settings, { path: p }]] });
    expect(ctx.settings.get().theme).toBe("system");
    const changes: string[] = [];
    ctx.on("settings/changed", (next, previous) => changes.push(`${previous.theme}->${next.theme}`));
    ctx.settings.set({ ...ctx.settings.get(), theme: "dark" });
    expect(changes).toEqual(["system->dark"]);
    expect(JSON.parse(fs.readFileSync(p, "utf8")).theme).toBe("dark");

    const reopened = await fresh({ plugins: [[Settings, { path: p }]] });
    expect(reopened.ctx.settings.get().theme).toBe("dark");
  });

  it("a plugin section gets defaults under stored values, validation, and a JSON-schema card", async () => {
    const { ctx } = await fresh({ plugins: [[Settings, { path: file() }]] });
    const fiber = await ctx.plugin({
      name: "demo",
      inject: ["settings"],
      apply(ctx) {
        ctx.settings.register({ id: "demo", title: "Demo", schema: z.object({ days: z.number().int().min(1), label: z.string() }), defaults: { days: 14, label: "stale" } });
      }
    });
    expect(ctx.settings.get().demo).toEqual({ days: 14, label: "stale" });
    ctx.settings.set({ ...ctx.settings.get(), demo: { days: 3, label: "stale" } });
    expect(ctx.settings.get().demo).toEqual({ days: 3, label: "stale" });
    expect(() => ctx.settings.set({ ...ctx.settings.get(), demo: { days: 0, label: "stale" } })).toThrow();

    const card = ctx.settings.sections().find((s) => s.id === "demo") as SettingsSectionView;
    expect(card.title).toBe("Demo");
    expect((card.schema.properties as Record<string, unknown>).days).toMatchObject({ type: "integer" });

    await fiber.dispose();
    expect(ctx.settings.sections().map((s) => s.id)).toEqual(["theme"]);
    expect(ctx.settings.get().demo).toEqual({ days: 3, label: "stale" });
  });
});
