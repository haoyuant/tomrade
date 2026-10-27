import { describe, expect, it, vi } from "vitest";

const shortcuts = vi.hoisted(() => ({ registered: new Map<string, () => void>(), refuse: new Set<string>() }));
const electron = vi.hoisted(() => ({ quitters: [] as (() => void)[], focused: null as unknown }));
vi.mock("electron", () => ({
  app: { on: (name: string, fn: () => void) => name === "will-quit" && electron.quitters.push(fn), hide: vi.fn(), focus: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => electron.focused },
  globalShortcut: {
    register: (acc: string, fn: () => void) => (shortcuts.refuse.has(acc) ? false : (shortcuts.registered.set(acc, fn), true)),
    unregister: (acc: string) => void shortcuts.registered.delete(acc)
  }
}));

const { accelerator, installGlobalHotkey } = await import("../src/terminal-entries.js");

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
