import fs from "node:fs";
import path from "node:path";
import { app, autoUpdater as squirrel } from "electron";
import electronUpdater, { type AppUpdater, type BaseUpdater } from "electron-updater";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/settings";
import { cancelQuit, prepareToQuit } from "./quit.js";
import { errorMessage } from "@tomradex/contracts";

export type UpdateChannel = "stable" | "beta";

/** Where checks and downloads go: picked by where the copy seems to be, or one the person names. */
export type UpdateSourceChoice = "auto" | "international" | "china";

/** A feed the updater can ask; custom is TOMRADE_UPDATE_URL, which overrides the rest. */
export type UpdateFeedName = "international" | "china" | "custom";

export interface UpdatePrefs {
  /** Off: the app never asks the feed on its own. Check now still does. */
  autoCheck: boolean;
  channel: UpdateChannel;
  source?: UpdateSourceChoice;
}

/**
 * The same releases in the same layout (manifests at the root, `<version>/` files and blockmaps):
 * download.tomrade.com on Cloudflare R2, and its mainland China mirror on Aliyun OSS, which the
 * site's Deploy workflow refreshes (tomrade-site scripts/mirror-china.mjs).
 */
export const UPDATE_FEEDS = { international: "https://download.tomrade.com", china: "https://dl.tomrade.cn" } as const;

// The mainland's time zones, the old names included; Hong Kong, Macau and Taipei keep the international feed.
const MAINLAND_ZONES = new Set(["Asia/Shanghai", "Asia/Urumqi", "Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "Asia/Kashgar", "PRC"]);

/** Whether this computer's clock is set to a mainland China time zone. */
export function inMainlandChina(timeZone: string | undefined = Intl.DateTimeFormat().resolvedOptions().timeZone): boolean {
  return !!timeZone && MAINLAND_ZONES.has(timeZone);
}

/**
 * The feeds a check tries, in order: the chosen one, then the other before giving up. Automatic starts
 * with the mirror in mainland China and the international feed elsewhere, but once one has answered it
 * goes first, so a feed that is down or blocked from here is not waited on every hour.
 */
export function feedOrder(choice: UpdateSourceChoice, opts: { custom?: boolean; china: boolean; answered?: UpdateFeedName | null }): UpdateFeedName[] {
  if (opts.custom) return ["custom"];
  const first: UpdateFeedName =
    choice === "auto" ? (opts.answered && opts.answered !== "custom" ? opts.answered : opts.china ? "china" : "international") : choice;
  return [first, first === "china" ? "international" : "china"];
}

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; latest: string }
  | { kind: "available"; version: string; date: string | null }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "failed"; message: string };

/**
 * Why this build cannot replace itself: a checkout updates with git; a local build (`--dir`) has no
 * app-update.yml to name its feed; a Mac copy outside Applications cannot be written.
 */
export type UpdateBlock = "checkout" | "local-build" | "location" | "unsupported";

export interface UpdateStatus {
  version: string;
  blocked: UpdateBlock | null;
  phase: UpdatePhase;
  /** When the feed last answered. */
  checkedAt: number | null;
  /** The feed in use: the one that last answered, or else the one the next check asks first. */
  feed: { name: UpdateFeedName; url: string } | null;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "updates.status": () => UpdateStatus;
    /** Asks the feed now, whatever the automatic setting says. */
    "updates.check": () => UpdateStatus;
    /** Only ever on the person's word: nothing downloads by itself. */
    "updates.download": () => UpdateStatus;
    /** Quits through the usual questions and relaunches on the new version. False when the person keeps the app open. */
    "updates.install": () => boolean;
    /** macOS: moves the app into Applications and relaunches it there. False when it stayed. */
    "updates.moveToApplications": () => boolean;
  }
  interface Broadcasts {
    "updates.changed": (status: UpdateStatus) => void;
  }
}

const EVERY_MS = 60 * 60_000;

const isPrerelease = (version: string) => /-/.test(version.split("+")[0]);

export function updatesSection(version: string) {
  return {
    id: "updates",
    title: "Updates",
    schema: z.object({ autoCheck: z.boolean(), channel: z.enum(["stable", "beta"]), source: z.enum(["auto", "international", "china"]) }),
    // A beta build stays on the channel it came from until the person says otherwise.
    defaults: { autoCheck: true, channel: isPrerelease(version) ? "beta" : "stable", source: "auto" } as UpdatePrefs,
    order: 90
  };
}

export type UpdateSource = Pick<AppUpdater, "on" | "off" | "checkForUpdates" | "downloadUpdate" | "quitAndInstall"> & {
  channel: string | null;
  allowDowngrade: boolean;
};

type Emitter = { on(event: string, listener: (...args: never[]) => void): unknown; off(event: string, listener: (...args: never[]) => void): unknown };

/** Points the updater at one feed; the next check, and the download it announces, go there. */
export interface UpdateFeeds {
  /** TOMRADE_UPDATE_URL, which is then the only feed. */
  custom?: string;
  /** Whether automatic picks the China mirror first. */
  china: boolean;
  use(url: string): void;
}

export interface UpdatesOptions {
  version: string;
  blocked: UpdateBlock | null;
  /** Without it the source asks the feed it was built with, and status names none. */
  feeds?: UpdateFeeds;
  /** macOS: Squirrel, whose own update-downloaded is when a restart can install. Elsewhere the download is the staging. */
  staging?: Emitter;
  emit(status: UpdateStatus): void;
  prepareToQuit(): Promise<boolean>;
  cancelQuit(): void;
}

/** Long enough for any install to have quit the app; past it, the granted quit is handed back. */
const INSTALL_GRACE_MS = 30_000;


/**
 * The update flow the person drives: the feed is asked on a timer (or not at
 * all), a newer release is only announced, the download waits for a click, and
 * the restart goes through the same questions as any quit.
 */
export class Updates {
  private phase: UpdatePhase = { kind: "idle" };
  private checkedAt: number | null = null;
  private prefs: UpdatePrefs | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private installing: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by a channel switch, so an answer from the old channel is dropped. */
  private generation = 0;
  private inflight: Promise<unknown> | null = null;
  /** The feed that last answered a check, whose announced update a download fetches. */
  private answered: UpdateFeedName | null = null;
  private readonly listeners: [Emitter, string, (...args: never[]) => void][];

  constructor(
    private readonly source: UpdateSource | null,
    private readonly opts: UpdatesOptions
  ) {
    this.listeners = source
      ? [
          [source, "download-progress", (p: { percent: number }) => this.phase.kind === "downloading" && this.set({ ...this.phase, percent: p.percent })],
          [opts.staging ?? source, "update-downloaded", () => this.phase.kind === "downloading" && this.set({ kind: "ready", version: this.phase.version })],
          // What fails after the person's word: the download, Squirrel taking it in, the install.
          // A check's failure is reported to whoever asked, never over a download.
          [source, "error", (error: unknown, context?: string) => !context?.startsWith("Cannot check for updates") && this.fail(error)]
        ]
      : [];
    for (const [emitter, event, listener] of this.listeners) emitter.on(event, listener);
  }

  status(): UpdateStatus {
    const name = this.opts.feeds ? (this.answered ?? this.order()[0]) : null;
    return { version: this.opts.version, blocked: this.opts.blocked, phase: this.phase, checkedAt: this.checkedAt, feed: name ? { name, url: this.url(name) } : null };
  }

  private order(): UpdateFeedName[] {
    const feeds = this.opts.feeds;
    return feedOrder(this.prefs?.source ?? "auto", { custom: !!feeds?.custom, china: !!feeds?.china, answered: this.answered });
  }

  private url(name: UpdateFeedName): string {
    return name === "custom" ? (this.opts.feeds?.custom ?? "") : UPDATE_FEEDS[name];
  }

  /** Asks each feed in turn until one answers; when none does, the first one's error is the one reported. */
  private async ask(): Promise<Awaited<ReturnType<UpdateSource["checkForUpdates"]>>> {
    const source = this.source!;
    const feeds = this.opts.feeds;
    if (!feeds) return source.checkForUpdates();
    let first: unknown;
    for (const name of this.order()) {
      feeds.use(this.url(name));
      try {
        const result = await source.checkForUpdates();
        this.answered = name;
        return result;
      } catch (error) {
        first ??= error;
      }
    }
    throw first;
  }

  /** The person's settings, at start and whenever they change. A new channel forgets what the old one said. */
  configure(prefs: UpdatePrefs): void {
    const switched = !!this.prefs && this.prefs.channel !== prefs.channel;
    // Another source starts from its own first feed, and the feed shown changes with it.
    const resourced = !!this.prefs && (this.prefs.source ?? "auto") !== (prefs.source ?? "auto");
    if (resourced && !this.fetching()) this.answered = null;
    this.prefs = prefs;
    if (resourced) this.opts.emit(this.status());
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.source) return;
    this.source.channel = prefs.channel === "beta" ? "beta" : "latest";
    // Setting a channel turns downgrades on; leaving beta must never install an older build over newer data.
    this.source.allowDowngrade = false;
    if (switched) {
      this.generation += 1;
      if (!this.fetching()) this.set({ kind: "idle" });
    }
    if (!prefs.autoCheck) return;
    const tick = () => {
      void this.check(false);
      this.timer = setTimeout(tick, EVERY_MS);
    };
    // At launch too: a release that is already out is news the moment the app opens.
    this.timer = setTimeout(tick, 0);
  }

  async check(asked = true): Promise<UpdateStatus> {
    if (!this.source || this.fetching()) return this.status();
    // A check on the timer stays out of sight: a passing "checking" would take down an unanswered notice.
    if (asked) this.set({ kind: "checking" });
    // electron-updater hands a second caller the first one's request, which may have been for the other channel.
    await this.inflight?.catch(() => undefined);
    const generation = this.generation;
    const request = this.ask();
    this.inflight = request;
    try {
      const result = await request;
      // A download started meanwhile outranks the answer, and a switched channel makes it moot.
      if (generation !== this.generation || this.fetching()) return this.status();
      this.checkedAt = Date.now();
      if (!result) this.set({ kind: "idle" });
      else if (result.isUpdateAvailable) this.set({ kind: "available", version: result.updateInfo.version, date: result.updateInfo.releaseDate ?? null });
      else this.set({ kind: "current", latest: result.updateInfo.version });
    } catch (error) {
      // A check nobody asked for fails quietly: offline for an hour is not news.
      if (asked && generation === this.generation && !this.fetching()) this.set({ kind: "failed", message: errorMessage(error) });
    } finally {
      if (this.inflight === request) this.inflight = null;
    }
    return this.status();
  }

  async download(): Promise<UpdateStatus> {
    if (!this.source || this.phase.kind !== "available") return this.status();
    const version = this.phase.version;
    this.set({ kind: "downloading", version, percent: 0 });
    try {
      await this.source.downloadUpdate();
      // Squirrel still has to take the download in; until it says so there is nothing a restart could install.
      if ((this.phase as UpdatePhase).kind === "downloading") this.set(this.opts.staging ? { kind: "downloading", version, percent: 100 } : { kind: "ready", version });
    } catch (error) {
      this.fail(error);
    }
    return this.status();
  }

  async install(): Promise<boolean> {
    if (!this.source || this.phase.kind !== "ready" || this.installing) return false;
    if (!(await this.opts.prepareToQuit())) return false;
    this.installing = setTimeout(() => this.release(), INSTALL_GRACE_MS);
    try {
      // Relaunch everywhere. On Windows the installer shows its window anyway (withInstallerWindow).
      this.source.quitAndInstall(true, true);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.installing);
    for (const [emitter, event, listener] of this.listeners) emitter.off(event, listener);
  }

  private fail(error: unknown): void {
    this.release();
    if (this.fetching()) this.set({ kind: "failed", message: errorMessage(error) });
  }

  /** An install that never quit the app: the next quit asks and flushes again. */
  private release(): void {
    if (!this.installing) return;
    clearTimeout(this.installing);
    this.installing = undefined;
    this.opts.cancelQuit();
  }

  private fetching(): boolean {
    return this.phase.kind === "downloading" || this.phase.kind === "ready";
  }

  private set(phase: UpdatePhase): void {
    this.phase = phase;
    this.opts.emit(this.status());
  }
}

function blockedHere(): UpdateBlock | null {
  if (!app.isPackaged && !process.env.TOMRADE_UPDATE_URL) return "checkout";
  // electron-builder writes the feed file only for installer targets; without it every check fails with ENOENT.
  if (app.isPackaged && !process.env.TOMRADE_UPDATE_URL && !fs.existsSync(path.join(process.resourcesPath, "app-update.yml"))) return "local-build";
  if (process.platform === "darwin" && app.isPackaged && !app.isInApplicationsFolder()) return "location";
  if (process.platform === "linux" && !process.env.APPIMAGE) return "unsupported";
  return null;
}

/** The parts of electron-updater that stamp an install ID on every request; private, so checked before they are touched. */
type StagingInternals = {
  stagingUserIdPromise?: { readonly value: Promise<string> };
  computeFinalHeaders?: (headers: Record<string, unknown>) => Record<string, unknown>;
};
const STAGING_HEADER = "x-user-staging-id";

/**
 * electron-updater sends every check a random ID it keeps in `<userData>/.updaterId`, for staged
 * rollouts. Tomrade stages none, so the feed gets no ID and the file goes. False when this
 * electron-updater no longer looks the way this expects, so the caller can say so.
 */
export function withoutInstallId(updater: AppUpdater, userData: string): boolean {
  fs.rmSync(path.join(userData, ".updaterId"), { force: true });
  updater.isUserWithinRollout = () => true;
  const internals = updater as unknown as StagingInternals;
  const finalHeaders = internals.computeFinalHeaders;
  if (!internals.stagingUserIdPromise || typeof finalHeaders !== "function") return false;
  internals.stagingUserIdPromise = { value: Promise.resolve("") };
  internals.computeFinalHeaders = (headers) => {
    const final = finalHeaders.call(updater, headers);
    delete final[STAGING_HEADER];
    return final;
  };
  return true;
}

/**
 * Windows: the installer removes the old copy before it writes the new one, which can take minutes
 * (from another drive, every file is copied to %TEMP%). Run silently it looks hung, and ending it
 * halfway leaves no Tomrade at all, so every install, the one on quit included, shows its progress.
 */
export function withInstallerWindow(updater: Pick<BaseUpdater, "install">): void {
  const install = updater.install.bind(updater);
  updater.install = (_silent, runAfter) => install(false, runAfter);
}

/** The updater, set up the way Tomrade uses it; which feed it asks is set before each check (UpdateFeeds). */
function feed(ctx: Context): AppUpdater {
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = {
    info: (m) => ctx.logger.info(String(m)),
    warn: (m) => ctx.logger.warn(String(m)),
    error: (m) => ctx.logger.error(String(m)),
    debug: (m) => ctx.logger.debug(m)
  };
  if (!withoutInstallId(autoUpdater, app.getPath("userData"))) ctx.logger.warn("electron-updater changed: update checks may carry its install ID");
  autoUpdater.autoDownload = false;
  // "Later" on a downloaded update means the next ordinary quit installs it.
  autoUpdater.autoInstallOnAppQuit = true;
  if (process.platform === "win32") withInstallerWindow(autoUpdater as BaseUpdater);
  // A checkout has no app-update.yml; pointed at a feed by TOMRADE_UPDATE_URL it uses the dev config instead.
  if (process.env.TOMRADE_UPDATE_URL) autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  return autoUpdater;
}

/** International and the China mirror, or only TOMRADE_UPDATE_URL when it is set, a checkout included. */
function feeds(updater: AppUpdater): UpdateFeeds {
  return {
    custom: process.env.TOMRADE_UPDATE_URL || undefined,
    china: inMainlandChina(),
    use: (url) => updater.setFeedURL({ provider: "generic", url })
  };
}

export const updater = {
  name: "updater",
  inject: ["ipc", "settings"],
  apply(ctx: Context) {
    const version = app.getVersion();
    ctx.settings.register(updatesSection(version));
    const blocked = blockedHere();
    const source = blocked ? null : feed(ctx);
    const updates = new Updates(source, {
      version,
      blocked,
      feeds: source ? feeds(source) : undefined,
      staging: process.platform === "darwin" ? squirrel : undefined,
      emit: (status) => ctx.ipc.send("updates.changed", status),
      prepareToQuit: () => prepareToQuit(ctx),
      cancelQuit
    });
    const prefs = () => ctx.settings.get().updates as UpdatePrefs;
    updates.configure(prefs());
    ctx.on("settings/changed", (next, previous) => {
      if (JSON.stringify(next.updates) !== JSON.stringify(previous.updates)) updates.configure(prefs());
    });
    ctx.effect(() => () => updates.dispose(), "updates");

    ctx.ipc.handle("updates.status", () => updates.status());
    ctx.ipc.handle("updates.check", () => updates.check());
    ctx.ipc.handle("updates.download", () => updates.download());
    ctx.ipc.handle("updates.install", () => updates.install());
    ctx.ipc.handle("updates.moveToApplications", async () => {
      if (blocked !== "location" || !(await prepareToQuit(ctx))) return false;
      try {
        if (app.moveToApplicationsFolder()) return true;
      } catch (error) {
        cancelQuit();
        throw error;
      }
      cancelQuit();
      return false;
    });
  }
};

export default updater;
