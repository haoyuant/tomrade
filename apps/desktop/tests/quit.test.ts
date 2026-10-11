import { afterEach, describe, expect, it, vi } from "vitest";

const showMessageBoxSync = vi.fn(() => 0);
vi.mock("electron", () => ({ dialog: { showMessageBoxSync: (...args: unknown[]) => showMessageBoxSync(...(args as [])) } }));

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
  afterEach(() => showMessageBoxSync.mockReset().mockReturnValue(0));

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
    showMessageBoxSync.mockReturnValue(1);
    const { ctx, flushAll } = context({ runs: 1 });
    expect(await quit.prepareToQuit(ctx)).toBe(false);
    expect(flushAll).not.toHaveBeenCalled();
    expect(quit.quitApproved()).toBe(false);
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
