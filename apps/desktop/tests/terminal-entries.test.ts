import { afterEach, describe, expect, it, vi } from "vitest";

const shortcuts = vi.hoisted(() => ({ registered: new Map<string, () => void>(), refuse: new Set<string>() }));
const electron = vi.hoisted(() => ({ quitters: [] as (() => void)[], focused: null as unknown, all: [] as unknown[] }));
vi.mock("electron", () => ({
  app: { on: (name: string, fn: () => void) => name === "will-quit" && electron.quitters.push(fn), hide: vi.fn(), focus: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => electron.focused, getAllWindows: () => electron.all },
  screen: { getCursorScreenPoint: () => ({ x: 2000, y: 10 }), getDisplayNearestPoint: () => ({ workArea: { x: 1440, y: 25, width: 1920, height: 1055 } }) },
  globalShortcut: {
    register: (acc: string, fn: () => void) => (shortcuts.refuse.has(acc) ? false : (shortcuts.registered.set(acc, fn), true)),
    unregister: (acc: string) => void shortcuts.registered.delete(acc)
  }
}));

const { accelerator, installGlobalHotkey } = await import("../src/terminal-entries.js");
const { app } = await import("electron");

describe("the key for the whole computer", () => {
  it("writes chords as Electron accelerators", () => {
    expect(accelerator("Mod+Alt+Space")).toBe("CommandOrControl+Alt+Space");
    expect(accelerator("Ctrl+Shift+ArrowUp")).toBe("Control+Shift+Up");
    expect(accelerator("Alt+Enter")).toBe("Alt+Return");
  });

  it("registers nothing by default, takes the chosen key, swaps it on change, says when it is refused, and lets go at quit", async () => {
    let overrides: Record<string, string[]> = {};
    const listeners = new Map<string, () => void>();
    const handlers = new Map<string, () => unknown>();
    const sent: unknown[][] = [];
    const ran: unknown[][] = [];
    const ctx = {
      get: (name: string) =>
        name === "settings" ? { get: () => ({ keybindings: { overrides } }) }
        : name === "ipc" ? { handle: (ch: string, fn: () => unknown) => void handlers.set(ch, fn), send: (...args: unknown[]) => void sent.push(args) }
        : name === "contributions" ? { run: async (...args: unknown[]) => (ran.push(args), {}) }
        : undefined,
      on: (name: string, fn: () => void) => void listeners.set(name, fn),
      logger: () => ({ warn: () => {} })
    };
    installGlobalHotkey(ctx as never);
    expect([...shortcuts.registered.keys()]).toEqual([]);
    expect(handlers.get("keybindings.globalStatus")!()).toEqual([]);

    overrides = { terminalWindowGlobal: ["Alt+Space"] };
    listeners.get("settings/changed")!();
    expect([...shortcuts.registered.keys()]).toEqual(["Alt+Space"]);
    expect(sent.at(-1)).toEqual(["keybindings.globalStatusChanged", [{ command: "terminalWindowGlobal", chord: "Alt+Space", registered: true }]]);
    // pressed from another app: the Terminal window comes up, on the project it showed last
    shortcuts.registered.get("Alt+Space")!();
    await Promise.resolve();
    expect(ran).toEqual([["code-sessions.open", {}]]);

    shortcuts.refuse.add("CommandOrControl+Alt+T");
    overrides = { terminalWindowGlobal: ["Mod+Alt+T"] };
    listeners.get("settings/changed")!();
    expect([...shortcuts.registered.keys()]).toEqual([]);
    expect(handlers.get("keybindings.globalStatus")!()).toEqual([{ command: "terminalWindowGlobal", chord: "Mod+Alt+T", registered: false }]);

    shortcuts.refuse.clear();
    overrides = { terminalWindowGlobal: ["Mod+Alt+K"] };
    listeners.get("settings/changed")!();
    expect([...shortcuts.registered.keys()]).toEqual(["CommandOrControl+Alt+K"]);
    for (const quit of electron.quitters) quit();
    expect([...shortcuts.registered.keys()]).toEqual([]);
  });
});

describe("the Terminal window as a hotkey window", () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    electron.focused = null;
    electron.all = [];
    shortcuts.registered.clear();
  });
  const terminalWindow = () => {
    const calls: unknown[][] = [];
    let bounds = { x: 100, y: 200, width: 1200, height: 760 };
    const win = {
      calls,
      isDestroyed: () => false,
      webContents: { getURL: () => "file:///ui/code-sessions.html" },
      getBounds: () => bounds,
      setBounds: (b: typeof bounds, animate: boolean) => {
        bounds = b;
        calls.push(["bounds", b, animate]);
      },
      setVisibleOnAllWorkspaces: (on: boolean) => void calls.push(["allDesktops", on]),
      minimize: () => void calls.push(["minimize"])
    };
    return win;
  };
  const press = (overrides: Record<string, string[]>) => {
    const ran: unknown[][] = [];
    const ctx = {
      get: (name: string) => (name === "settings" ? { get: () => ({ keybindings: { overrides } }) } : name === "contributions" ? { run: async (...args: unknown[]) => (ran.push(args), {}) } : undefined),
      on: () => {},
      logger: () => ({ warn: () => {} })
    };
    installGlobalHotkey(ctx as never);
    return { ran, fire: async () => shortcuts.registered.get("Alt+Space")!() };
  };

  it("drops from the top of the screen under the pointer, on the desktop in front, and slides back up to its own place", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.useFakeTimers();
    try {
      const win = terminalWindow();
      electron.all = [win];
      const { ran, fire } = press({ terminalWindowGlobal: ["Alt+Space"] });
      fire();
      await vi.advanceTimersByTimeAsync(0);
      // above the screen first, then down to its top, centred: every desktop shows it
      expect(win.calls).toEqual([
        ["allDesktops", true],
        ["bounds", { x: 1800, y: 25 - 760, width: 1200, height: 760 }, false],
        ["bounds", { x: 1800, y: 25, width: 1200, height: 760 }, true]
      ]);
      expect(ran).toEqual([["code-sessions.open", {}]]);
      // pressed in it: up and away, then back where it was, on its own desktop
      win.calls.length = 0;
      electron.focused = win;
      fire();
      await vi.advanceTimersByTimeAsync(300);
      expect(win.calls).toEqual([
        ["bounds", { x: 1800, y: 25 - 760, width: 1200, height: 760 }, true],
        ["allDesktops", false],
        ["bounds", { x: 100, y: 200, width: 1200, height: 760 }, false]
      ]);
      expect(app.hide).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays an ordinary window on Windows and Linux", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const win = terminalWindow();
    electron.all = [win];
    const { ran, fire } = press({ terminalWindowGlobal: ["Alt+Space"] });
    fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toEqual([["code-sessions.open", {}]]);
    electron.focused = win;
    fire();
    expect(win.calls).toEqual([["minimize"]]);
  });
});
