import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, dialog: {} }));
vi.mock("electron-updater", () => ({ default: {} }));
import { Updates, updatesSection, type UpdateSource, type UpdateStatus } from "../src/updater.js";

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
    expect(updatesSection("0.3.0-beta.1").defaults).toEqual({ autoCheck: true, channel: "beta" });
    expect(updatesSection("0.3.0+abc").defaults).toEqual({ autoCheck: true, channel: "stable" });
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

  it("stops listening when the plugin unloads", () => {
    const { feed, updates } = setup();
    expect(feed.listenerCount("error")).toBe(1);
    updates.dispose();
    expect(feed.listenerCount("error")).toBe(0);
  });
});
