import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, dialog: {} }));
vi.mock("electron-updater", () => ({ default: {} }));
import { feedOrder, inMainlandChina, UPDATE_FEEDS, Updates, updatesSection, withInstallerWindow, type UpdateFeeds, type UpdateSource, type UpdateStatus } from "../src/updater.js";

class FakeFeed extends EventEmitter {
  channel: string | null = null;
  allowDowngrade = true;
  latest = { version: "0.3.0", releaseDate: "2026-11-01T08:00:00.000Z" };
  running = "0.2.0";
  checkError: Error | null = null;
  downloadError: Error | null = null;
  installs: [boolean, boolean][] = [];
  checks = 0;

  checkForUpdates = vi.fn(async () => {
    this.checks += 1;
    if (this.checkError) {
      this.emit("error", this.checkError, `Cannot check for updates: ${this.checkError.stack}`);
      throw this.checkError;
    }
    return { isUpdateAvailable: this.latest.version !== this.running, updateInfo: this.latest, versionInfo: this.latest } as never;
  });

  downloadUpdate = vi.fn(async () => {
    this.emit("download-progress", { percent: 42 });
    if (this.downloadError) {
      this.emit("error", this.downloadError);
      throw this.downloadError;
    }
    this.emit("update-downloaded", { version: this.latest.version });
    return ["/tmp/update.zip"];
  });

  quitAndInstall = vi.fn((silent: boolean, runAfter: boolean) => void this.installs.push([silent, runAfter]));
}

function setup(opts: { quit?: boolean; blocked?: "checkout"; squirrel?: EventEmitter } = {}) {
  const feed = new FakeFeed();
  const seen: UpdateStatus[] = [];
  const cancelQuit = vi.fn();
  const prepareToQuit = vi.fn(async () => opts.quit ?? true);
  const updates = new Updates(opts.blocked ? null : (feed as unknown as UpdateSource), {
    version: "0.2.0",
    blocked: opts.blocked ?? null,
    staging: opts.squirrel,
    emit: (s) => seen.push(s),
    prepareToQuit,
    cancelQuit
  });
  return { feed, seen, updates, prepareToQuit, cancelQuit };
}

describe("updates", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("announces a newer release and downloads nothing on its own", async () => {
    const { feed, updates } = setup();
    const status = await updates.check();
    expect(status.phase).toEqual({ kind: "available", version: "0.3.0", date: "2026-11-01T08:00:00.000Z" });
    expect(status.checkedAt).not.toBeNull();
    expect(feed.downloadUpdate).not.toHaveBeenCalled();
  });

  it("says the build is current when the feed names it", async () => {
    const { feed, updates } = setup();
    feed.latest = { version: "0.2.0", releaseDate: "2026-10-11T08:00:00.000Z" };
    expect((await updates.check()).phase).toEqual({ kind: "current", latest: "0.2.0" });
  });

  it("downloads on request, reporting progress, then waits to be installed", async () => {
    const { updates, seen } = setup();
    await updates.check();
    const status = await updates.download();
    expect(seen.map((s) => s.phase.kind)).toContain("downloading");
    expect(seen.some((s) => s.phase.kind === "downloading" && s.phase.percent === 42)).toBe(true);
    expect(status.phase).toEqual({ kind: "ready", version: "0.3.0" });
  });

  it("downloads only what a check announced", async () => {
    const { feed, updates } = setup();
    await updates.download();
    expect(feed.downloadUpdate).not.toHaveBeenCalled();
  });

  it("installs only after the quit is granted, silently and relaunching", async () => {
    const { feed, updates, prepareToQuit } = setup();
    expect(await updates.install()).toBe(false);
    await updates.check();
    await updates.download();
    expect(await updates.install()).toBe(true);
    expect(prepareToQuit).toHaveBeenCalledOnce();
    expect(feed.installs).toEqual([[true, true]]);
  });

  it("keeps the app open when the person declines the quit", async () => {
    const { feed, updates } = setup({ quit: false });
    await updates.check();
    await updates.download();
    expect(await updates.install()).toBe(false);
    expect(feed.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.status().phase.kind).toBe("ready");
  });

  it("hands the quit back when the install fails after it was granted", async () => {
    const { feed, updates, cancelQuit } = setup();
    await updates.check();
    await updates.download();
    await updates.install();
    feed.emit("error", new Error("Code signature did not match"));
    expect(cancelQuit).toHaveBeenCalledOnce();
    expect(updates.status().phase).toEqual({ kind: "failed", message: "Code signature did not match" });
  });

  it("reports a failed download and a failed check the person asked for", async () => {
    const { feed, updates } = setup();
    await updates.check();
    feed.downloadError = new Error("net::ERR_INTERNET_DISCONNECTED");
    expect((await updates.download()).phase).toEqual({ kind: "failed", message: "net::ERR_INTERNET_DISCONNECTED" });
    feed.checkError = new Error("404");
    expect((await updates.check()).phase).toEqual({ kind: "failed", message: "404" });
  });

  it("checks at start and hourly, and a failing background check keeps what was known", async () => {
    const { feed, updates } = setup();
    updates.configure({ autoCheck: true, channel: "stable" });
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.checks).toBe(1);
    expect(updates.status().phase.kind).toBe("available");
    feed.checkError = new Error("offline");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(feed.checks).toBe(2);
    expect(updates.status().phase.kind).toBe("available");
  });

  it("checks on the timer without passing through 'checking'", async () => {
    const { feed, updates, seen } = setup();
    updates.configure({ autoCheck: true, channel: "stable" });
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.checks).toBe(1);
    expect(seen.map((s) => s.phase.kind)).toEqual(["available"]);
  });

  it("doesn't let a check that was already out undo a download started meanwhile", async () => {
    const { feed, updates } = setup();
    await updates.check();
    let answer: (value: unknown) => void = () => {};
    feed.checkForUpdates.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never);
    const late = updates.check(false);
    await updates.download();
    answer({ isUpdateAvailable: true, updateInfo: feed.latest });
    await late;
    expect(updates.status().phase).toEqual({ kind: "ready", version: "0.3.0" });
  });

  it("never asks the feed on its own when automatic checks are off", async () => {
    const { feed, updates } = setup();
    updates.configure({ autoCheck: false, channel: "stable" });
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(feed.checks).toBe(0);
    await updates.check();
    expect(feed.checks).toBe(1);
  });

  it("follows the channel without ever allowing a downgrade, and forgets the other channel's answer", async () => {
    const { feed, updates } = setup();
    updates.configure({ autoCheck: false, channel: "beta" });
    expect(feed.channel).toBe("beta");
    expect(feed.allowDowngrade).toBe(false);
    await updates.check();
    feed.allowDowngrade = true;
    updates.configure({ autoCheck: false, channel: "stable" });
    expect(feed.channel).toBe("latest");
    expect(feed.allowDowngrade).toBe(false);
    expect(updates.status().phase).toEqual({ kind: "idle" });
  });

  it("does nothing in a checkout", async () => {
    const { updates } = setup({ blocked: "checkout" });
    updates.configure({ autoCheck: true, channel: "stable" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await updates.check()).toMatchObject({ blocked: "checkout", phase: { kind: "idle" } });
  });

  it("puts a beta build on the beta channel by default", () => {
    expect(updatesSection("0.3.0-beta.1").defaults).toEqual({ autoCheck: true, channel: "beta", source: "auto" });
    expect(updatesSection("0.3.0+abc").defaults).toEqual({ autoCheck: true, channel: "stable", source: "auto" });
  });

  it("on a Mac, offers the restart only once Squirrel has taken the download in", async () => {
    const squirrel = new EventEmitter();
    const { updates } = setup({ squirrel });
    await updates.check();
    expect((await updates.download()).phase).toEqual({ kind: "downloading", version: "0.3.0", percent: 100 });
    expect(await updates.install()).toBe(false);
    squirrel.emit("update-downloaded");
    expect(updates.status().phase).toEqual({ kind: "ready", version: "0.3.0" });
  });

  it("doesn't let a background check's failure fail a finished download", async () => {
    const { feed, updates } = setup();
    await updates.check();
    await updates.download();
    feed.emit("error", new Error("offline"), "Cannot check for updates: Error: offline");
    expect(updates.status().phase).toEqual({ kind: "ready", version: "0.3.0" });
  });

  it("drops an answer that was asked of the channel the person just left", async () => {
    const { feed, updates } = setup();
    updates.configure({ autoCheck: false, channel: "stable" });
    let answer: (value: unknown) => void = () => {};
    feed.checkForUpdates.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never);
    const stale = updates.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.checkForUpdates).toHaveBeenCalledOnce();
    updates.configure({ autoCheck: false, channel: "beta" });
    expect(updates.status().phase).toEqual({ kind: "idle" });
    answer({ isUpdateAvailable: true, updateInfo: { version: "9.9.9", releaseDate: null } });
    await stale;
    expect(updates.status().phase).toEqual({ kind: "idle" });
    feed.latest = { version: "0.2.0", releaseDate: "2026-10-11T08:00:00.000Z" };
    expect((await updates.check()).phase).toEqual({ kind: "current", latest: "0.2.0" });
  });

  it("hands the quit back when an install never quits, and installs once at a time", async () => {
    const { feed, updates, cancelQuit } = setup();
    await updates.check();
    await updates.download();
    expect(await updates.install()).toBe(true);
    expect(await updates.install()).toBe(false);
    expect(feed.quitAndInstall).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cancelQuit).toHaveBeenCalledOnce();
  });

  it("runs the Windows installer with its window, after a restart and on quit alike", () => {
    const calls: [boolean | undefined, boolean | undefined][] = [];
    const updater = { install: (silent?: boolean, runAfter?: boolean) => (calls.push([silent, runAfter]), true) };
    withInstallerWindow(updater);
    expect(updater.install(true, true)).toBe(true);
    updater.install(true, false);
    expect(calls).toEqual([
      [false, true],
      [false, false]
    ]);
  });

  it("stops listening when the plugin unloads", () => {
    const { feed, updates } = setup();
    expect(feed.listenerCount("error")).toBe(1);
    updates.dispose();
    expect(feed.listenerCount("error")).toBe(0);
  });
});

describe("update feeds", () => {
  /** A feed per URL: those in `down` fail their check, the rest answer with the same release. */
  function feeds(opts: { china?: boolean; custom?: string; down?: string[] } = {}) {
    const feed = new FakeFeed();
    const asked: string[] = [];
    let url = "";
    const check = feed.checkForUpdates.getMockImplementation()!;
    feed.checkForUpdates.mockImplementation(async () => {
      asked.push(url);
      if (opts.down?.includes(url)) throw new Error(`getaddrinfo ENOTFOUND ${new URL(url).host}`);
      return check();
    });
    const control: UpdateFeeds = { china: !!opts.china, custom: opts.custom, use: (next) => void (url = next) };
    const seen: UpdateStatus[] = [];
    const updates = new Updates(feed as unknown as UpdateSource, {
      version: "0.2.0",
      blocked: null,
      feeds: control,
      emit: (s) => seen.push(s),
      prepareToQuit: async () => true,
      cancelQuit: vi.fn()
    });
    return { feed, updates, asked, seen };
  }
  const { international, china } = UPDATE_FEEDS;
  const prefs = (source?: "auto" | "international" | "china") => ({ autoCheck: false, channel: "stable" as const, ...(source ? { source } : {}) });

  it("knows the mainland's time zones, and leaves Hong Kong, Macau and Taipei out", () => {
    for (const zone of ["Asia/Shanghai", "Asia/Urumqi", "PRC"]) expect(inMainlandChina(zone)).toBe(true);
    for (const zone of ["Asia/Hong_Kong", "Asia/Macau", "Asia/Taipei", "Europe/Berlin", ""]) expect(inMainlandChina(zone)).toBe(false);
  });

  it("orders the feeds: the chosen one first, then the other", () => {
    expect(feedOrder("auto", { china: true })).toEqual(["china", "international"]);
    expect(feedOrder("auto", { china: false })).toEqual(["international", "china"]);
    expect(feedOrder("international", { china: true })).toEqual(["international", "china"]);
    expect(feedOrder("china", { china: false })).toEqual(["china", "international"]);
    // Automatic keeps to the one that answered; a named source always starts with itself.
    expect(feedOrder("auto", { china: true, answered: "international" })).toEqual(["international", "china"]);
    expect(feedOrder("china", { china: true, answered: "international" })).toEqual(["china", "international"]);
  });

  it("automatic asks the China mirror first in mainland China and the international feed elsewhere", async () => {
    const here = feeds({ china: true });
    here.updates.configure(prefs());
    expect((await here.updates.check()).feed).toEqual({ name: "china", url: china });
    expect(here.asked).toEqual([china]);
    const abroad = feeds();
    abroad.updates.configure(prefs());
    expect((await abroad.updates.check()).feed).toEqual({ name: "international", url: international });
    expect(abroad.asked).toEqual([international]);
  });

  it("falls back to the other feed before reporting an error, and automatic stays with the one that answered", async () => {
    const { updates, asked } = feeds({ china: true, down: [china] });
    updates.configure(prefs());
    const status = await updates.check();
    expect(status.phase.kind).toBe("available");
    expect(status.feed?.name).toBe("international");
    await updates.check();
    expect(asked).toEqual([china, international, international]);
  });

  it("a named source is asked first every time, and the other only when it fails", async () => {
    const { updates, asked } = feeds({ china: false, down: [china] });
    updates.configure(prefs("china"));
    expect((await updates.status()).feed?.name).toBe("china");
    await updates.check();
    await updates.check();
    expect(asked).toEqual([china, international, china, international]);
  });

  it("reports the first feed's error when neither answers", async () => {
    const { updates, asked } = feeds({ china: true, down: [china, international] });
    updates.configure(prefs());
    const status = await updates.check();
    expect(status.phase).toEqual({ kind: "failed", message: "getaddrinfo ENOTFOUND dl.tomrade.cn" });
    expect(asked).toEqual([china, international]);
  });

  it("downloads from the feed whose check announced the update", async () => {
    const { feed, updates } = feeds({ down: [international] });
    let used = "";
    const real = feed.downloadUpdate.getMockImplementation()!;
    feed.downloadUpdate.mockImplementation(async () => ((used = (await updates.status()).feed!.url), real()));
    updates.configure(prefs());
    await updates.check();
    expect((await updates.download()).phase.kind).toBe("ready");
    expect(used).toBe(china);
  });

  it("changing the source starts over from its first feed and says so", async () => {
    const { updates, seen } = feeds({ china: true, down: [china] });
    updates.configure(prefs());
    await updates.check();
    expect(updates.status().feed?.name).toBe("international");
    updates.configure(prefs("china"));
    expect(seen.at(-1)?.feed?.name).toBe("china");
  });

  it("TOMRADE_UPDATE_URL is the only feed, whatever the setting", async () => {
    const custom = "http://127.0.0.1:9999/";
    const { updates, asked } = feeds({ china: true, custom, down: [custom] });
    updates.configure(prefs("china"));
    expect(updates.status().feed).toEqual({ name: "custom", url: custom });
    expect((await updates.check()).phase.kind).toBe("failed");
    expect(asked).toEqual([custom]);
  });

  it("names no feed when the source keeps the one it was built with", () => {
    const { updates } = setup();
    expect(updates.status().feed).toBeNull();
  });

});
