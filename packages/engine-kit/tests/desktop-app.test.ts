import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Context } from "cordis";
import { Mcp } from "@tomradex/mcp";
import { Tools } from "@tomradex/tools";
import { desktopAppPaths, localAvailability, localCli } from "@tomradex/engine-kit";
import { CliLocator, machineHost } from "../src/locate.js";

it("knows where a desktop app may be installed on each system", () => {
  expect(desktopAppPaths({ title: "Antigravity", mac: ["Antigravity"] }, { platform: "darwin", env: {}, home: "/Users/a" }))
    .toEqual(["/Applications/Antigravity.app", "/Users/a/Applications/Antigravity.app"]);
  expect(desktopAppPaths({ title: "Claude", windows: ["AnthropicClaude"] }, { platform: "win32", env: { LocalAppData: "C:\\Users\\a\\AppData\\Local", ProgramFiles: "C:\\Program Files" }, home: "C:\\Users\\a" }))
    .toEqual(["C:\\Users\\a\\AppData\\Local\\AnthropicClaude", "C:\\Program Files\\AnthropicClaude"]);
  expect(desktopAppPaths({ title: "X", mac: ["X"], paths: ["/opt/x"] }, { platform: "linux", env: {}, home: "/home/a" })).toEqual(["/opt/x"]);
});

it("says the desktop app is there but not its CLI, and only then", async () => {
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-desktop-app-"));
    const app = path.join(dir, "Antigravity.app");
    const engine = (paths: string[]) => localAvailability(ctx, { engineId: "nope", title: "Antigravity CLI", cli: localCli("tomrade-no-such-cli-xyz"), install: "install it", desktopApp: { title: "Antigravity", paths } });
    const without = await engine([app])({ fresh: true });
    expect(without).toMatchObject({ ok: false, need: "install", cli: { state: "missing" } });
    expect(without.cli?.desktopApp).toBeUndefined();
    fs.mkdirSync(app);
    const withApp = await engine([app])({ fresh: true });
    expect(withApp).toMatchObject({ ok: false, need: "install", cli: { state: "missing", desktopApp: "Antigravity" } });
    expect(withApp.reason).toBe("Antigravity CLI: the Antigravity app is installed, but not its command-line tool tomrade-no-such-cli-xyz, which Tomrade runs — install it");
  } finally { await ctx.fiber.dispose(); }
}, 60_000);

it.skipIf(process.platform === "win32")("names the desktop app whose own copy of the CLI it found", async () => {
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-desktop-app-"));
    const bin = path.join(dir, "WorkBuddy.app", "Contents", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "tomrade-bundled-cli"), '#!/bin/sh\necho "1.0.0"\n', { mode: 0o755 });
    const host = { ...machineHost(), env: { PATH: `${bin}:/usr/bin:/bin` }, freshPath: async () => [] };
    const engine = (paths: string[]) => localAvailability(ctx, { engineId: "wb", title: "WorkBuddy", cli: new CliLocator("tomrade-bundled-cli", host), install: "install it", desktopApp: { title: "WorkBuddy", paths } });
    expect((await engine([path.join(dir, "WorkBuddy.app")])({ fresh: true })).cli).toMatchObject({ state: "ready", insideApp: "WorkBuddy" });
    expect((await engine([path.join(dir, "Other.app")])({ fresh: true })).cli?.insideApp).toBeUndefined();
  } finally { await ctx.fiber.dispose(); }
}, 60_000);
