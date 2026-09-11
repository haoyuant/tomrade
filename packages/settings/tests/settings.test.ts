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
    expect(ctx.settings.get().theme).toBe("light");
    expect(ctx.settings.get().language).toBe("system");
    const changes: string[] = [];
    ctx.on("settings/changed", (next, previous) => changes.push(`${previous.theme}->${next.theme}`));
    ctx.settings.set({ ...ctx.settings.get(), theme: "dark" });
    expect(changes).toEqual(["light->dark"]);
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
    expect(ctx.settings.sections().map((s) => s.id)).toEqual(["theme", "themeAutomation", "customThemes", "language"]);
    expect(ctx.settings.get().demo).toEqual({ days: 3, label: "stale" });
  });

  it("user-scope sections follow the Hub folder; secrets and machine sections stay put", async () => {
    const hubDir = path.join(dir, `hub-${n++}`);
    const machineFile = file();
    const { ctx } = await fresh({ hubDir, plugins: [[Settings, { path: machineFile }]] });
    ctx.settings.register({ id: "token", title: "Token", schema: z.object({ token: z.string().meta({ format: "password" }) }), defaults: { token: "" }, scope: "user" });
    ctx.settings.register({ id: "git", title: "Git", schema: z.object({ binary: z.string() }), defaults: { binary: "git" } });
    const scopes = Object.fromEntries(ctx.settings.sections().map((s) => [s.id, s.scope]));
    expect(scopes).toMatchObject({ theme: "user", language: "user", token: "machine", git: "machine" });

    ctx.settings.set({ ...ctx.settings.get(), theme: "dark", token: { token: "s3cret" }, git: { binary: "/opt/git" } });
    const user = JSON.parse(fs.readFileSync(path.join(hubDir, "settings.json"), "utf8"));
    expect(user.sections.theme.value).toBe("dark");
    expect(typeof user.sections.theme.updatedAt).toBe("number");
    expect(user.sections.token).toBeUndefined();
    expect(user.sections.git).toBeUndefined();
    const machine = JSON.parse(fs.readFileSync(machineFile, "utf8"));
    expect(machine.token.token).toBe("s3cret");

    // Another machine's file arrives: the later stamp wins per section.
    ctx.settings.mergeUser({ v: 1, sections: { theme: { value: "matcha", updatedAt: Date.now() + 1000 }, language: { value: "zh", updatedAt: 1 } } });
    expect(ctx.settings.get().theme).toBe("matcha");
    expect(ctx.settings.get().language).toBe("system");
  });
});
