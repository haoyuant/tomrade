import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const quit = vi.hoisted(() => ({ leaving: false, approved: false }));
const notices = vi.hoisted(() => ({ shown: 0 }));
vi.mock("electron", () => ({
  app: { dock: { hide: vi.fn(), show: vi.fn(async () => {}) } },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ setTemplateImage: () => {} }) },
  Notification: class {
    static isSupported = () => true;
    show = () => void notices.shown++;
  },
  shell: {},
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    destroy() {}
  }
}));
vi.mock("../src/quit.js", () => ({ leaving: () => quit.leaving, quitApproved: () => quit.approved }));

const { app } = await import("electron");
const { autostartEntry, autostartState, macAgent, withExec, xdgAutostart, BACKGROUND_FLAG } = await import("../src/login-item.js");
const { background, cameBack, launchMode, readPrefs, relaunchArgs, writePrefs } = await import("../src/background.js");

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

describe("the Dock icon", () => {
  const platform = process.platform;
  let disposers: (() => void)[] = [];
  const dock = app.dock as unknown as { hide: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn> };
  const window = () => new EventEmitter() as never;
  const close = (win: never) => (win as EventEmitter).emit("closed");
  const start = (keepRunning: boolean) => {
    const file = path.join(dir, "background.json");
    writePrefs(file, { keepRunning, noticed: false });
    const ctx = {
      logger: () => ({ warn: () => {} }),
      get: () => undefined,
      on: () => {},
      ipc: { handle: () => {}, send: () => {} },
      effect: (fn: () => () => void) => void disposers.push(fn())
    };
    background.apply(ctx as never, { file });
  };

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    dock.hide.mockClear();
    dock.show.mockClear();
    notices.shown = 0;
    quit.leaving = quit.approved = false;
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    for (const dispose of disposers.splice(0)) dispose();
  });

  it("stays while a plugin's own window is open after the last Tomrade window closes", () => {
    start(true);
    const main = window();
    const terminal = window();
    cameBack(main);
    cameBack(terminal);
    close(main);
    expect(dock.hide).not.toHaveBeenCalled();
    close(terminal);
    expect(dock.hide).toHaveBeenCalledOnce();
    expect(notices.shown).toBe(1);
  });

  it("comes back when a window opens with the app in the background", () => {
    start(true);
    const terminal = window();
    cameBack(terminal);
    expect(dock.show).toHaveBeenCalledOnce();
    cameBack(terminal);
    expect(dock.show).toHaveBeenCalledOnce();
    close(terminal);
  });

  it("is left alone during a quit and with background running off", () => {
    start(true);
    const quitting = window();
    cameBack(quitting);
    quit.approved = true;
    close(quitting);
    quit.approved = false;
    const leaving = window();
    cameBack(leaving);
    quit.leaving = true;
    close(leaving);
    quit.leaving = false;
    for (const dispose of disposers.splice(0)) dispose();
    start(false);
    const last = window();
    cameBack(last);
    close(last);
    expect(dock.hide).not.toHaveBeenCalled();
  });
});
