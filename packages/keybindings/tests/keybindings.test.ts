/**
 * Rebound keys are the person's: they ride the Hub's settings file (and the
 * account's sync with it), not this machine's, and only well-formed chords land.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh } from "@tomradex/testkit";
import keybindings, { CHORD } from "@tomradex/keybindings";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-keybindings-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("keybindings", () => {
  it("defaults to no overrides and travels with the Hub and the account", async () => {
    const hubDir = path.join(dir, "hub");
    const machine = path.join(dir, "machine.json");
    const { ctx } = await fresh({ hubDir, plugins: [[Settings, { path: machine }], keybindings] });
    expect(ctx.settings.get().keybindings).toEqual({ overrides: {} });
    expect(ctx.settings.sections().find((s) => s.id === "keybindings")?.scope).toBe("user");

    const overrides = { palette: ["Mod+Shift+P"], newTicket: [] };
    ctx.settings.set({ ...ctx.settings.get(), keybindings: { overrides } });
    const hub = JSON.parse(fs.readFileSync(path.join(hubDir, "settings.json"), "utf8"));
    expect(hub.sections.keybindings.value).toEqual({ overrides });
    expect(ctx.settings.exportUser().sections.keybindings?.value).toEqual({ overrides });
  });

  it("refuses a chord it could never match", async () => {
    const { ctx } = await fresh({ plugins: [[Settings, { path: path.join(dir, "refuse.json") }], keybindings] });
    expect(() => ctx.settings.set({ ...ctx.settings.get(), keybindings: { overrides: { palette: ["Cmd+K"] } } })).toThrow(/keybindings\.overrides/);
    expect(() => ctx.settings.set({ ...ctx.settings.get(), keybindings: { overrides: { palette: ["Mod+"] } } })).toThrow();
  });

  it("knows the chords the renderer writes", () => {
    for (const ok of ["Mod+K", "Mod+Shift+Z", "Ctrl+Tab", "Ctrl+Shift+Tab", "?", "/", "Mod+,", "Mod+Enter", "Alt+ArrowLeft", "N", "Mod+1", "F5", "Mod+["]) expect(CHORD.test(ok), ok).toBe(true);
    for (const bad of ["", "Mod", "Mod+Shift", "k", "Cmd+K", "Mod+KK", "Shift+Mod+"]) expect(CHORD.test(bad), bad).toBe(false);
  });
});
