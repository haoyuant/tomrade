import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, Menu: {}, nativeImage: {}, Notification: {}, shell: {}, Tray: class {} }));

const { app } = await import("electron");
const { autostartEntry, autostartState, macAgent, withExec, xdgAutostart, BACKGROUND_FLAG } = await import("../src/login-item.js");
const { launchMode, readPrefs, relaunchArgs, writePrefs } = await import("../src/background.js");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-background-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("launchMode", () => {
  const notAtLogin = { openedAtLogin: () => false };

  it("opens a window on an ordinary start, whatever the preference", () => {
    const file = path.join(dir, "background.json");
    writePrefs(file, { keepRunning: true });
    expect(launchMode(["."], file, notAtLogin)).toBe("window");
  });

  it("comes up hidden at login while background running is on", () => {
    const file = path.join(dir, "background.json");
    writePrefs(file, { keepRunning: true, startAtLogin: true });
    expect(launchMode([BACKGROUND_FLAG], file, notAtLogin)).toBe("hidden");
    expect(launchMode([], file, { openedAtLogin: () => true })).toBe("hidden");
  });

  it("calls a login start stale once background running is off, or the file is gone", () => {
    const file = path.join(dir, "background.json");
    expect(launchMode([BACKGROUND_FLAG], file, notAtLogin)).toBe("stale");
    writePrefs(file, { keepRunning: false });
    expect(launchMode([BACKGROUND_FLAG], file, notAtLogin)).toBe("stale");
  });
});

describe("preferences", () => {
  it("falls back to everything off for a missing or broken file", () => {
    const file = path.join(dir, "background.json");
    expect(readPrefs(file)).toEqual({ keepRunning: false, startAtLogin: false, noticed: false });
    fs.writeFileSync(file, "{not json");
    expect(readPrefs(file).keepRunning).toBe(false);
  });

  it("merges a patch into what is stored", () => {
    const file = path.join(dir, "nested", "background.json");
    writePrefs(file, { keepRunning: true });
    writePrefs(file, { noticed: true });
    expect(readPrefs(file)).toEqual({ keepRunning: true, startAtLogin: false, noticed: true });
  });
});

describe("relaunchArgs", () => {
  it("drops the background flag when nothing keeps the app running", () => {
    expect(relaunchArgs([".", BACKGROUND_FLAG, "--patch", "x.yml"])).toEqual([".", "--patch", "x.yml"]);
  });
});

describe("XDG autostart", () => {
  it("writes an entry that starts the AppImage the person keeps, hidden", () => {
    const text = autostartEntry("/home/me/Apps/Tomrade $1.AppImage");
    expect(text).toContain('Exec="/home/me/Apps/Tomrade \\$1.AppImage" --background');
    expect(text).toContain("Type=Application");
    expect(autostartState(text)).toEqual({ kind: "on" });
  });

  it("reads a desktop's own switch as disabled", () => {
    expect(autostartState(null)).toEqual({ kind: "off" });
    expect(autostartState(`${autostartEntry("/x")}Hidden=true\n`)).toEqual({ kind: "disabled" });
    expect(autostartState(autostartEntry("/x").replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false"))).toEqual({ kind: "disabled" });
  });

  it("repoints a moved AppImage and keeps every other line", () => {
    const before = `${autostartEntry("/old/Tomrade.AppImage")}Hidden=true\n`;
    const after = withExec(before, "/new/Tomrade.AppImage");
    expect(after).toContain('Exec="/new/Tomrade.AppImage" --background');
    expect(after).not.toContain("/old/");
    expect(after).toContain("Hidden=true");
  });

  it("registers, repairs and removes the file under XDG_CONFIG_HOME", () => {
    const env = { XDG_CONFIG_HOME: dir, APPIMAGE: "/a/Tomrade.AppImage" };
    const file = path.join(dir, "autostart", "tomrade-background.desktop");
    const item = xdgAutostart(env, "/tmp/.mount/tomrade");
    expect(item.repair()).toBe(false);
    item.set(true);
    expect(fs.readFileSync(file, "utf8")).toContain('Exec="/a/Tomrade.AppImage" --background');
    expect(item.state()).toEqual({ kind: "on" });
    expect(xdgAutostart({ ...env, APPIMAGE: "/b/Tomrade.AppImage" }).repair()).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain('Exec="/b/Tomrade.AppImage" --background');
    item.set(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(item.state()).toEqual({ kind: "off" });
  });
});

describe("macOS agent service", () => {
  const reports = (status: string) => Object.assign(app, { getLoginItemSettings: () => ({ status }) });

  it("reads a never-registered agent as off while the bundle carries its plist", () => {
    const plist = path.join(dir, "com.tomrade.desktop.background.plist");
    fs.writeFileSync(plist, "<plist/>");
    reports("not-found");
    expect(macAgent(plist).state()).toEqual({ kind: "off" });
  });

  it("says start at login is unsupported only when the plist is missing", () => {
    reports("not-found");
    expect(macAgent(path.join(dir, "missing.plist")).state()).toEqual({ kind: "unavailable", reason: "unsupported" });
  });
});
