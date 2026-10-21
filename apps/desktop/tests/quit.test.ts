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
const app = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  return Object.assign(new EventEmitter(), { hide: () => {}, show: () => {}, exit: () => {}, quit: vi.fn() });
});
vi.mock("electron", () => ({
  app,
  BrowserWindow: { getAllWindows: () => windows, getFocusedWindow: () => windows[0] ?? null },
  dialog: { showMessageBoxSync: (...args: unknown[]) => showMessageBoxSync(...(args as [])) }
}));

async function load() {
  vi.resetModules();
  return import("../src/quit.js");
}

type Unsynced = { projectId: string; name: string; count: number }[];
const context = (opts: { runs?: number; flush?: () => Promise<void>; throws?: boolean; unsynced?: Unsynced[]; herdr?: number } = {}) => {
  const flushAll = vi.fn(opts.flush ?? (async () => {}));
  // Each reading takes the next list; the last one stands.
  const readings = [...(opts.unsynced ?? [])];
  const pendingAll = vi.fn(() => (readings.length > 1 ? readings.shift()! : readings[0] ?? []));
  const publish = vi.fn(async () => ({ state: "synced" }));
  const agent = {
    activeRuns: () => {
      if (opts.throws) throw new Error("agent store closed");
      return Array.from({ length: opts.runs ?? 0 }, () => ({ thread: { itemId: null } }));
    }
  };
  // Sessions in herdr panes are herdr's processes: counted as kept, never as interrupted.
  const codeLink = { sessionsOf: () => [...Array.from({ length: opts.herdr ?? 0 }, () => ({ herdrPane: "w1:p1", state: "waiting" })), { herdrPane: "w2:p1", state: "ended" }, { herdrPane: null, state: "running" }] };
  const ctx = { get: (name: string) => (name === "agent" ? agent : name === "storage" ? { flushAll, pendingAll, publish } : name === "codeLink" ? codeLink : name === "db" ? { openIds: () => ["p"] } : undefined) };
  return { ctx: ctx as never, flushAll, pendingAll, publish };
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

  it("says which sessions herdr keeps going, and warns only about the runs that die with the app", async () => {
    const quit = await load();
    const { ctx } = context({ runs: 1, herdr: 2 });
    expect(await quit.prepareToQuit(ctx)).toBe(true);
    expect(showMessageBoxSync).toHaveBeenCalledWith(expect.objectContaining({ message: "1 agent run is in progress", detail: "Quitting interrupts them. 2 sessions in herdr keep going." }));
    const alone = await load();
    await alone.prepareToQuit(context({ runs: 1 }).ctx);
    expect(showMessageBoxSync).toHaveBeenLastCalledWith(expect.objectContaining({ detail: "Quitting interrupts them." }));
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

describe("quitting over writes that have not synced", () => {
  afterEach(() => {
    showMessageBoxSync.mockReset().mockReturnValue(0);
    windows = [];
  });
  const left: Unsynced = [{ projectId: "p1", name: "Tomrade", count: 3 }];

  it("says how many are still only here, and quits on the person's word", async () => {
    const quit = await load();
    showMessageBoxSync.mockReturnValue(1);
    const { ctx, publish } = context({ unsynced: [left] });
    expect(await quit.prepareToQuit(ctx)).toBe(true);
    expect(showMessageBoxSync).toHaveBeenCalledOnce();
    const box = (showMessageBoxSync.mock.calls[0] as unknown as [{ message: string; detail: string; buttons: string[] }])[0];
    expect(box.message).toBe("3 changes have not synced yet");
    expect(box.detail).toContain("Tomrade: 3");
    expect(box.buttons).toEqual(["Wait for sync", "Quit anyway", "Cancel"]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("waits with a full publish, then goes once nothing is left", async () => {
    const quit = await load();
    showMessageBoxSync.mockReturnValue(0);
    const { ctx, publish } = context({ unsynced: [left, []] });
    expect(await quit.prepareToQuit(ctx)).toBe(true);
    expect(publish).toHaveBeenCalledWith("p1", "quit");
    expect(showMessageBoxSync).toHaveBeenCalledOnce();
  });

  it("keeps the app, windows back, when the person cancels", async () => {
    const quit = await load();
    const [main] = (windows = [fakeWindow()]);
    showMessageBoxSync.mockReturnValue(2);
    const { ctx } = context({ unsynced: [left] });
    expect(await quit.prepareToQuit(ctx)).toBe(false);
    expect(main.visible).toBe(true);
    expect(quit.quitApproved()).toBe(false);
  });

  it("asks nothing when everything synced", async () => {
    const quit = await load();
    expect(await quit.prepareToQuit(context({ unsynced: [[]] }).ctx)).toBe(true);
    expect(showMessageBoxSync).not.toHaveBeenCalled();
  });

  it("flushes once on a signal, asking nothing", async () => {
    const quit = await load();
    const { ctx, flushAll } = context({ unsynced: [left] });
    await quit.leaveOnSignal(ctx);
    expect(flushAll).toHaveBeenCalledWith("signal");
    expect(showMessageBoxSync).not.toHaveBeenCalled();
  });
});

describe("an approved quit", () => {
  afterEach(() => {
    vi.useRealTimers();
    app.quit.mockReset();
    app.removeAllListeners();
    windows = [];
  });

  it("brings the windows back when something calls it off, so the next launch is not ignored as mid-quit", async () => {
    vi.useFakeTimers();
    const quit = await load();
    const [main] = (windows = [fakeWindow()]);
    expect(await quit.prepareToQuit(context().ctx)).toBe(true);
    quit.finishQuit();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(quit.leaving()).toBe(true);
    // No will-quit: a window refused to close.
    vi.advanceTimersByTime(15_000);
    expect(quit.leaving()).toBe(false);
    expect(quit.quitApproved()).toBe(false);
    expect(main.visible).toBe(true);
    expect(app.listenerCount("will-quit")).toBe(0);
  });

  it("leaves a quit that goes through alone", async () => {
    vi.useFakeTimers();
    const quit = await load();
    const [main] = (windows = [fakeWindow()]);
    await quit.prepareToQuit(context().ctx);
    quit.finishQuit();
    app.emit("will-quit");
    vi.advanceTimersByTime(60_000);
    expect(quit.leaving()).toBe(true);
    expect(quit.quitApproved()).toBe(true);
    expect(main.visible).toBe(false);
  });
});
