import { afterEach, describe, expect, it, vi } from "vitest";

const showMessageBoxSync = vi.fn(() => 0);
const fakeWindow = (visible = true) => {
  const win = { visible, destroyed: false, focused: 0 };
  return Object.assign(win, {
    isVisible: () => win.visible,
    isDestroyed: () => win.destroyed,
    hide: () => void (win.visible = false),
    showInactive: () => void (win.visible = true),
    focus: () => void win.focused++
  });
};
let windows: ReturnType<typeof fakeWindow>[] = [];
vi.mock("electron", () => ({
  app: { hide: () => {}, show: () => {} },
  BrowserWindow: { getAllWindows: () => windows, getFocusedWindow: () => windows[0] ?? null },
  dialog: { showMessageBoxSync: (...args: unknown[]) => showMessageBoxSync(...(args as [])) }
}));

async function load() {
  vi.resetModules();
  return import("../src/quit.js");
}

const context = (opts: { runs?: number; flush?: () => Promise<void>; throws?: boolean } = {}) => {
  const flushAll = vi.fn(opts.flush ?? (async () => {}));
  const agent = {
    activeRuns: () => {
      if (opts.throws) throw new Error("agent store closed");
      return Array.from({ length: opts.runs ?? 0 }, () => ({ thread: { itemId: null } }));
    }
  };
  const ctx = { get: (name: string) => (name === "agent" ? agent : name === "storage" ? { flushAll } : undefined) };
  return { ctx: ctx as never, flushAll };
};

describe("preparing to quit", () => {
  afterEach(() => {
    showMessageBoxSync.mockReset().mockReturnValue(0);
    windows = [];
  });

  it("asks about runs in flight, flushes, and remembers the answer", async () => {
    const quit = await load();
    const { ctx, flushAll } = context({ runs: 2 });
    expect(await quit.prepareToQuit(ctx)).toBe(true);
    expect(showMessageBoxSync).toHaveBeenCalledOnce();
    expect(flushAll).toHaveBeenCalledWith("quit");
    expect(quit.quitApproved()).toBe(true);
    expect(await quit.prepareToQuit(ctx)).toBe(true);
    expect(showMessageBoxSync).toHaveBeenCalledOnce();
  });

  it("keeps the app open when the person cancels, without flushing", async () => {
    const quit = await load();
    windows = [fakeWindow()];
    showMessageBoxSync.mockReturnValue(1);
    const { ctx, flushAll } = context({ runs: 1 });
    expect(await quit.prepareToQuit(ctx)).toBe(false);
    expect(flushAll).not.toHaveBeenCalled();
    expect(quit.quitApproved()).toBe(false);
    expect(windows[0].visible).toBe(true);
    expect(quit.leaving()).toBe(false);
  });

  it("puts the windows away before the flush, so the wait happens out of sight", async () => {
    const quit = await load();
    const [main, pet, hidden] = (windows = [fakeWindow(), fakeWindow(), fakeWindow(false)]);
    let seen: boolean[] = [];
    const { ctx } = context({ flush: async () => void (seen = windows.map((w) => w.visible)) });
    expect(await quit.prepareToQuit(ctx)).toBe(true);
    expect(seen).toEqual([false, false, false]);
    expect(quit.leaving()).toBe(true);

    // An install that never quit brings back exactly what was showing.
    quit.cancelQuit();
    expect([main.visible, pet.visible, hidden.visible]).toEqual([true, true, false]);
    expect(main.focused).toBe(1);
    expect(quit.leaving()).toBe(false);
  });

  it("gives two quits asked at once one question and one flush", async () => {
    const quit = await load();
    let finish: () => void = () => {};
    const { ctx, flushAll } = context({ runs: 1, flush: () => new Promise<void>((resolve) => (finish = resolve)) });
    const first = quit.prepareToQuit(ctx);
    const second = quit.prepareToQuit(ctx);
    finish();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(showMessageBoxSync).toHaveBeenCalledOnce();
    expect(flushAll).toHaveBeenCalledOnce();
  });

  it("never holds the app open over a fault", async () => {
    const quit = await load();
    expect(await quit.prepareToQuit(context({ throws: true }).ctx)).toBe(true);
  });

  it("asks and flushes again after a quit that didn't happen", async () => {
    const quit = await load();
    const { ctx, flushAll } = context();
    await quit.prepareToQuit(ctx);
    quit.cancelQuit();
    expect(quit.quitApproved()).toBe(false);
    await quit.prepareToQuit(ctx);
    expect(flushAll).toHaveBeenCalledTimes(2);
  });
});
