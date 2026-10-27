import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const quit = vi.hoisted(() => ({ leaving: false, approved: false }));
const notices = vi.hoisted(() => ({ shown: 0 }));
const trays = vi.hoisted(() => ({ menu: null as unknown, title: "", made: 0 }));
vi.mock("electron", () => ({
  app: { dock: { hide: vi.fn(), show: vi.fn(async () => {}), setIcon: vi.fn(), setMenu: vi.fn() }, quit: vi.fn() },
  Menu: { buildFromTemplate: (template: unknown) => ({ template }) },
  nativeImage: { createFromPath: () => ({ setTemplateImage: () => {} }) },
  Notification: class {
    static isSupported = () => true;
    show = () => void notices.shown++;
  },
  shell: {},
  Tray: class {
    constructor() {
      trays.made++;
    }
    setToolTip() {}
    setTitle(title: string) {
      trays.title = title;
    }
    on() {}
    setContextMenu(menu: unknown) {
      trays.menu = menu;
    }
    destroy() {
      trays.menu = null;
    }
  }
}));
vi.mock("../src/quit.js", () => ({ leaving: () => quit.leaving, quitApproved: () => quit.approved }));

const { app } = await import("electron");
const { autostartEntry, autostartState, macAgent, withExec, xdgAutostart, BACKGROUND_FLAG } = await import("../src/login-item.js");
const { background, cameBack, launchMode, otherOrdinaryWindow, readPrefs, relaunchArgs, whenLastWindowCloses, writePrefs } = await import("../src/background.js");
const { startWindows } = await import("../src/sessions-section.js");
const { appIconPath, currentAppIcon, wearAppIcon } = await import("../src/app-icon.js");

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
  const dock = app.dock as unknown as { hide: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; setIcon: ReturnType<typeof vi.fn> };
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
    wearAppIcon("transparent");
    dock.hide.mockClear();
    dock.show.mockClear();
    dock.setIcon.mockClear();
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

  it("comes back when a window opens with the app in the background, with the chosen icon", async () => {
    wearAppIcon("sun");
    dock.setIcon.mockClear();
    start(true);
    const terminal = window();
    cameBack(terminal);
    expect(dock.show).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(dock.setIcon).toHaveBeenCalledWith(appIconPath(currentAppIcon())));
    expect(dock.setIcon).toHaveBeenCalledWith(appIconPath("sun"));
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

describe("the Dock and tray menus", () => {
  const platform = process.platform;
  let disposers: (() => void)[] = [];
  type Row = { label?: string; type?: string; accelerator?: string; click?: () => void; submenu?: Row[] };
  const rows = (menu: unknown) => (menu as { template: Row[] }).template;
  const labels = (menu: unknown) => rows(menu).map((r) => r.label ?? r.type);
  const dock = app.dock as unknown as { setMenu: ReturnType<typeof vi.fn> };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const start = (opts: { keepRunning?: boolean; terminal?: boolean; openAtStart?: string; services?: Record<string, unknown>; cells?: { sessionId: string; n: number }[] } = {}) => {
    const file = path.join(dir, "background.json");
    writePrefs(file, { keepRunning: !!opts.keepRunning, noticed: true });
    const ran: unknown[][] = [];
    const emitted: unknown[][] = [];
    const serial: unknown[][] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const services: Record<string, unknown> = {
      contributions: { commands: () => (opts.terminal === false ? [] : [{ id: "code-sessions.open" }]), run: async (...args: unknown[]) => (ran.push(args), {}) },
      projects: {
        list: () => [
          { id: "old", name: "Old", archived: false, updatedAt: 1 },
          { id: "new", name: "New", archived: false, updatedAt: 9 },
          { id: "gone", name: "Gone", archived: true, updatedAt: 5 }
        ]
      },
      settings: { get: () => ({ sessions: { openAtStart: opts.openAtStart ?? "main" } }), locale: () => "en" },
      ...opts.services
    };
    const ctx = {
      logger: () => ({ warn: () => {} }),
      get: (name: string) => services[name],
      on: (name: string, fn: (...args: unknown[]) => void) => void listeners.set(name, fn),
      emit: (...args: unknown[]) => void emitted.push(args),
      bail: (name: string) => (name === "codeLink/cells" ? opts.cells : undefined),
      serial: async (...args: unknown[]) => void serial.push(args),
      ipc: { handle: () => {}, send: () => {} },
      effect: (fn: () => () => void) => void disposers.push(fn())
    };
    background.apply(ctx as never, { file });
    return { ran, emitted, serial, listeners };
  };
  const waits = (extra: Record<string, unknown> = {}) => ({ key: "session:s", projectId: "p", threadId: null, itemId: "i", itemKey: "AL-1", kind: "waiting", who: "Claude Code", text: "needs your approval", since: 1, sessionId: "s", ...extra });
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    dock.setMenu.mockClear();
    trays.menu = null;
    trays.title = "";
    trays.made = 0;
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    for (const dispose of disposers.splice(0)) dispose();
  });

  it("offers each project's Terminal window in the Dock menu, newest first, and the main window", () => {
    const { ran } = start();
    const menu = rows(dock.setMenu.mock.calls.at(-1)![0]);
    expect(menu.map((r) => r.label ?? r.type)).toEqual(["Terminal window · New", "Terminal window · Old", "separator", "Open main window"]);
    menu[0].click!();
    expect(ran).toEqual([["code-sessions.open", { projectId: "new" }]]);
  });

  it("offers only the main window where there is no Terminal window", () => {
    start({ terminal: false });
    expect(rows(dock.setMenu.mock.calls.at(-1)![0]).map((r) => r.label)).toEqual(["Open main window"]);
  });

  it("puts the tray up for someone who starts on the Terminal window, background running or not", () => {
    start({ openAtStart: "main" });
    expect(trays.made).toBe(0);
    for (const dispose of disposers.splice(0)) dispose();
    start({ openAtStart: "terminal" });
    expect(trays.made).toBe(1);
    expect(labels(trays.menu).slice(0, 3)).toEqual(["New Terminal window", "Start in a terminal", "Open main window"]);
  });

  it("counts what waits beside the icon, lists it on top and opens it as a notification would", () => {
    const { listeners, emitted } = start({ keepRunning: true });
    expect(trays.title).toBe("");
    const entry = waits();
    listeners.get("attention/changed")!([entry]);
    expect(trays.title).toBe("◆ 1");
    const menu = rows(trays.menu);
    expect(menu[0].label).toBe("◆ AL-1 · Claude Code: needs your approval");
    expect(menu.slice(1, 4).map((r) => r.label ?? r.type)).toEqual(["separator", "New Terminal window", "Start in a terminal"]);
    menu[0].click!();
    expect(emitted).toEqual([["attention/open", entry]]);
    listeners.get("attention/changed")!([]);
    expect(trays.title).toBe("");
  });

  it("opens a new Terminal window on the key the person bound, and a new terminal in a project's window", () => {
    const { ran, serial } = start({ keepRunning: true });
    const menu = rows(trays.menu);
    expect(menu[0].accelerator).toBe("CommandOrControl+Shift+T");
    menu[0].click!();
    expect(ran).toEqual([["code-sessions.open", {}]]);
    expect(menu[1].submenu!.map((r) => r.label)).toEqual(["New", "Old"]);
    menu[1].submenu![1].click!();
    expect(serial).toEqual([["codeLink/new-terminal", "old"]]);
  });

  it("allows a terminal session's prompt from the tray only while its screen shows one, and opens it once the screen moved on", async () => {
    const answers: unknown[][] = [];
    let screen = "Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently";
    let answer = "answered";
    const codeLink = {
      sessionPanel: () => ({ pane: "w1:p1", input: "ok", approval: true }),
      sessionTail: async () => screen,
      sessionAnswer: async (...args: unknown[]) => (answers.push(args), answer)
    };
    const { listeners, emitted } = start({ keepRunning: true, services: { codeLink } });
    const entry = waits();
    listeners.get("attention/changed")!([entry]);
    await flush();
    let menu = rows(trays.menu);
    expect(menu.slice(0, 2).map((r) => r.label?.trim())).toEqual(["◆ AL-1 · Claude Code: needs your approval", "Allow"]);
    menu[1].click!();
    await flush();
    expect(answers).toEqual([["p", "s", "allow"]]);
    expect(emitted).toEqual([]);
    // the screen changed before the click: nothing pressed, the session opens to be answered there
    answer = "notPrompt";
    menu[1].click!();
    await flush();
    expect(emitted).toEqual([["attention/open", entry]]);
    // a shell, or a folder's trust: nothing to allow from here
    screen = "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit";
    listeners.get("attention/changed")!([{ ...entry }]);
    await flush();
    menu = rows(trays.menu);
    expect(menu[1].type).toBe("separator");
  });

  it("allows the assistant's permission by its first option, named as it is", async () => {
    const sent: unknown[][] = [];
    const agent = {
      activities: () => [{ projectId: "p", threadId: "t", run: null, pending: { threadId: "t", kind: "permission", workflow: null, accepts: "options", question: { id: "q", text: "Run npm test?", options: ["Allow once", "Allow for this turn", "Deny"] } } }],
      send: (...args: unknown[]) => (sent.push(args), { runId: "r" }),
      activeRuns: () => []
    };
    const { listeners } = start({ keepRunning: true, services: { agent } });
    listeners.get("attention/changed")!([waits({ key: "thread:t", threadId: "t", kind: "permission", itemId: null, itemKey: null, who: null, text: "Run npm test?", sessionId: undefined })]);
    await flush();
    const menu = rows(trays.menu);
    expect(menu[1].label?.trim()).toBe("Allow once");
    menu[1].click!();
    await flush();
    expect(sent).toEqual([["p", "t", { kind: "answer", questionId: "q", value: "Allow once" }]]);
  });

  it("lists the terminal sessions running, with their cell while the Terminal window shows them", () => {
    const sessionsOf = () => [
      { id: "s1", state: "running", itemIds: ["i1"], threadId: null, title: "fix it", branch: "tom-634/x" },
      { id: "s2", state: "running", itemIds: [], threadId: null, title: null, branch: "spike" },
      { id: "s3", state: "waiting", itemIds: [], threadId: null, title: null, branch: "other" }
    ];
    const services = { codeLink: { sessionsOf }, db: { openIds: () => ["p"] }, items: { get: (_p: string, id: string) => (id === "i1" ? { key: "TOM-634" } : null) } };
    const { emitted } = start({ keepRunning: true, services, cells: [{ sessionId: "s1", n: 1 }] });
    const menu = rows(trays.menu);
    expect(menu.slice(0, 3).map((r) => r.label ?? r.type)).toEqual(["● TOM-634 running · cell 1", "● spike running", "separator"]);
    menu[0].click!();
    expect(emitted).toEqual([["attention/open", { projectId: "p", threadId: null, itemId: "i1", sessionId: "s1" }]]);
  });
});

describe("starting on the Terminal window", () => {
  it("opens the main window unless the person chose the Terminal window alone and there is one", () => {
    expect(startWindows("main", true)).toEqual({ main: true, terminal: false });
    expect(startWindows("terminal", true)).toEqual({ main: false, terminal: true });
    expect(startWindows("both", true)).toEqual({ main: true, terminal: true });
    // no Terminal window in this app: the main window, whatever was chosen
    expect(startWindows("terminal", false)).toEqual({ main: true, terminal: false });
  });

  it("quits when the last window closes with background running off, and knows another window is still open", () => {
    const file = path.join(dir, "background.json");
    writePrefs(file, { keepRunning: false, noticed: true });
    const disposers: (() => void)[] = [];
    background.apply({ logger: () => ({ warn: () => {} }), get: () => undefined, on: () => {}, ipc: { handle: () => {}, send: () => {} }, effect: (fn: () => () => void) => void disposers.push(fn()) } as never, { file });
    const closes: number[] = [];
    whenLastWindowCloses(() => void closes.push(1));
    const make = () => Object.assign(new EventEmitter(), { isDestroyed: () => false }) as never;
    const terminal = make();
    const main = make();
    cameBack(terminal);
    cameBack(main);
    expect(otherOrdinaryWindow(main)).toBe(true);
    (main as EventEmitter).emit("closed");
    expect(closes).toEqual([]);
    expect(otherOrdinaryWindow(terminal)).toBe(false);
    (terminal as EventEmitter).emit("closed");
    expect(closes).toEqual([1]);
    whenLastWindowCloses(null);
    for (const dispose of disposers) dispose();
  });
});
