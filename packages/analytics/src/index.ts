import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { SettingsSection } from "@tomradex/settings";
import type {} from "@tomradex/ipc";
import type { AnalyticsReader } from "@tomradex/contracts";
import { AnonIdentity, type IdentityInfo } from "./anon.js";
import { FEATURE_REGISTRY_VERSION, isOnce } from "./features.js";
import type { AnalyticsEvent } from "./events.js";
import { parseEvent, SCHEMA_VERSION } from "./events.js";
import { EventQueue } from "./queue.js";
import { Tracker, type HostSignals, type SessionDraft, type SessionSnapshot } from "./tracker.js";
import { Uploader, retryDelay, type UploadConfig } from "./upload.js";
import { FLUSH_BATCH, FLUSH_MS, MAX_BATCH_EVENTS } from "./constants.js";
import { ANALYTICS_WORDS } from "./words.js";

export * from "./features.js";
export * from "./constants.js";
export * from "./events.js";
export { AnonIdentity, deriveAnonId, newSecret, type IdentityInfo } from "./anon.js";
export { EventQueue } from "./queue.js";
export { Tracker, type HostSignals, type SessionDraft, type SessionSnapshot } from "./tracker.js";
export { Uploader, endpointFor, retryDelay, split, type SendResult, type UploadConfig } from "./upload.js";

export type Platform = "macos" | "windows" | "linux";

export const platformOf = (value: NodeJS.Platform = process.platform): Platform =>
  value === "darwin" ? "macos" : value === "win32" ? "windows" : "linux";

export interface AnalyticsSettings {
  enabled: boolean;
}

export interface AnalyticsState {
  enabled: boolean;
  /** The id as the cloud sees it; null while statistics are off. */
  anonId: string | null;
  /** When the id rotates. */
  rotatesAt: number | null;
  /** Events waiting to be sent. */
  queued: number;
  /** When the last upload was accepted, or null. */
  lastSentAt: number | null;
  /** The endpoint class in use. */
  endpoint: "auto" | "global" | "cn";
}

const en = ANALYTICS_WORDS("en");
const zh = ANALYTICS_WORDS("zh");

export const ANALYTICS_SECTION: SettingsSection<AnalyticsSettings> = {
  id: "analytics",
  title: en("title"),
  description: en("description"),
  schema: z.object({
    enabled: z.boolean().default(true).meta({ title: en("enabledTitle") }).describe(en("enabledDescription"))
  }),
  defaults: { enabled: true },
  order: 20,
  scope: "user",
  agent: "none",
  words: {
    en: { title: en("title"), description: en("description"), fields: { enabled: { title: en("enabledTitle"), description: en("enabledDescription") } } },
    zh: { title: zh("title"), description: zh("description"), fields: { enabled: { title: zh("enabledTitle"), description: zh("enabledDescription") } } }
  }
};

export interface AnalyticsConfig {
  /** <userData>/analytics: the secret, the state and the unsent queue. Never a project folder. */
  dir: string;
  /** The app's semver, reported with every event. */
  client: string;
  /** The Electron shell's focus, idle and power signals. */
  host: HostSignals;
  /** Where batches go; absent means nothing is uploaded (tests, a build without a backend). */
  upload?: UploadConfig;
}

interface UploadState {
  /** Attempts since the last accepted batch. */
  failures: number;
  /** No attempt before this moment; survives a restart. */
  nextAt: number;
  /** The id the queued events were collected under; a change is a rotation. */
  lastAnonId: string | null;
  lastSentAt: number | null;
}

const UPLOAD_STATE: UploadState = { failures: 0, nextAt: 0, lastAnonId: null, lastSentAt: null };

declare module "cordis" {
  interface Context {
    analytics: Analytics;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** The renderer's most recently touched surface; null when it left the last one. */
    "analytics.surface": (featureId: string | null) => void;
    /** A counted action, or one kept only for adoption. */
    "analytics.activate": (featureId: string, action: string, dim?: string | null) => void;
    "analytics.state": () => AnalyticsState;
    "analytics.setEnabled": (enabled: boolean) => AnalyticsState;
    /** A new secret, a new id, and an empty queue. */
    "analytics.resetId": () => AnalyticsState;
  }
  interface Broadcasts {
    "analytics.changed": (state: AnalyticsState) => void;
  }
}

/**
 * Collection, the local queue, the anonymous identity and the batch upload. It
 * never blocks the interface: a failure to read a file or to send a batch is
 * logged, and the next tick carries on.
 */
export class Analytics extends Service implements AnalyticsReader {
  static provide = "analytics";
  static inject = ["ipc", "settings"];
  static Config = z.object({
    dir: z.string().min(1),
    client: z.string().min(1),
    host: z.custom<HostSignals>((value) => !!value && typeof (value as HostSignals).isFocused === "function"),
    upload: z.custom<UploadConfig>((value) => !!value && typeof (value as UploadConfig).url === "string").optional()
  });

  private readonly identity: AnonIdentity;
  private readonly queue: EventQueue;
  private readonly snapshotFile: string;
  private readonly uploadFile: string;
  private readonly onceFile: string;
  private readonly tracker: Tracker;
  private readonly uploader: Uploader | null;
  private stopTracker: (() => void) | null = null;
  private stopUploads: (() => void) | null = null;
  private abort: AbortController | null = null;
  private flushing = false;
  private active = false;
  private uploadState: UploadState;

  constructor(ctx: Context, private readonly config: AnalyticsConfig) {
    super(ctx, "analytics");
    this.identity = new AnonIdentity(config.dir);
    this.queue = new EventQueue(path.join(config.dir, "queue.jsonl"));
    this.snapshotFile = path.join(config.dir, "session.json");
    this.uploadFile = path.join(config.dir, "upload.json");
    this.onceFile = path.join(config.dir, "once.json");
    this.uploadState = this.readUploadState();
    this.uploader = config.upload ? new Uploader(config.upload) : null;
    this.tracker = new Tracker(
      config.host,
      {
        activate: (featureId, action, dim, ts) => this.recordAction(featureId, action, dim, ts),
        session: (draft) => this.recordSession(draft)
      },
      { enabled: () => this.enabled(), heartbeat: (snapshot) => this.saveSnapshot(snapshot) }
    );
  }

  [Service.init](): () => void {
    this.ctx.settings.register(ANALYTICS_SECTION);
    this.ctx.ipc.handle("analytics.surface", (featureId) => this.tracker.reportSurface(featureId));
    this.ctx.ipc.handle("analytics.activate", (featureId, action, dim) => this.tracker.activate(featureId, action, dim ?? null));
    this.ctx.ipc.handle("analytics.state", () => this.state());
    this.ctx.ipc.handle("analytics.setEnabled", (enabled) => this.setEnabled(enabled));
    this.ctx.ipc.handle("analytics.resetId", () => this.resetId());
    this.ctx.on("settings/changed", (_next, previous) => {
      const before = (previous as Record<string, AnalyticsSettings | undefined>).analytics?.enabled ?? true;
      const after = this.enabled();
      if (before !== after) this.toggle(after);
    });

    if (this.enabled()) void this.begin();
    return () => this.stop();
  }

  /**
   * An action the backend saw (a plan written, a run undone, a claim). The
   * same switch as the renderer's: off, nothing is recorded.
   */
  activate(featureId: string, action: string, dim: string | null = null): void {
    this.tracker.activate(featureId, action, dim);
  }

  /** Where the data stands, for the settings card. */
  state(): AnalyticsState {
    let info: IdentityInfo | null = null;
    try {
      info = this.enabled() ? this.identity.info() : null;
    } catch {
      info = null;
    }
    return {
      enabled: this.enabled(),
      anonId: info?.anonId ?? null,
      rotatesAt: info?.rotatesAt ?? null,
      queued: this.queue.size,
      lastSentAt: this.uploadState.lastSentAt,
      endpoint: this.config.upload?.endpoint ?? "auto"
    };
  }

  /** Sends now, for a test or a shutdown; the switch and the backoff still apply. */
  flushNow(ignoreBackoff = false): Promise<boolean> {
    return this.flush(0, ignoreBackoff);
  }

  /** Ends the open session and gives the queue the few seconds a quit can spare. */
  async shutdown(): Promise<void> {
    this.tracker.quit();
    this.stopTracker?.();
    this.stopTracker = null;
    this.stopUploads?.();
    this.stopUploads = null;
    await this.flush(2_500);
  }

  private enabled(): boolean {
    const section = this.ctx.settings.get().analytics as AnalyticsSettings | undefined;
    return (section ?? ANALYTICS_SECTION.defaults).enabled;
  }

  private async begin(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      this.identity.ensure();
    } catch (error) {
      this.ctx.logger.warn(`analytics: no anonymous identity: ${String(error)}`);
      return;
    }
    try {
      this.queue.prune();
    } catch {
      // An unreadable queue file was reset by the queue itself.
    }
    await this.maybeRotate();
    this.recoverCrash();
    this.record({ event: "app.start", feature_id: null }, Date.now(), { first_run: Date.now() - this.identity.info().installedAt < 24 * 60 * 60_000 });
    this.stopTracker = this.tracker.start();
    this.startUploads();
  }

  /**
   * A year has passed since the id was made: send what the old id collected
   * while that is still possible, then let the new one take over. A failed
   * send drops the old queue rather than putting two ids in one batch.
   */
  private async maybeRotate(): Promise<void> {
    const current = this.identity.current();
    if (!this.uploadState.lastAnonId || this.uploadState.lastAnonId === current) {
      this.uploadState.lastAnonId = current;
      this.saveUploadState();
      return;
    }
    if (this.queue.size > 0 && !(await this.flush(10_000, true))) this.queue.clear();
    this.uploadState.lastAnonId = current;
    this.saveUploadState();
  }

  private startUploads(): void {
    if (!this.uploader || this.stopUploads) return;
    const timer = setInterval(() => void this.flush(), FLUSH_MS);
    timer.unref?.();
    this.stopUploads = () => clearInterval(timer);
  }

  private stop(): void {
    this.tracker.quit();
    this.stopTracker?.();
    this.stopTracker = null;
    this.stopUploads?.();
    this.stopUploads = null;
    this.active = false;
  }

  /** Off: nothing is collected, nothing waits, nothing is in flight, and the secret is gone. */
  private discard(): void {
    this.abort?.abort();
    this.abort = null;
    this.tracker.discard();
    this.stopTracker?.();
    this.stopTracker = null;
    this.stopUploads?.();
    this.stopUploads = null;
    this.active = false;
    this.queue.clear();
    this.identity.clear();
    this.uploadState = { ...UPLOAD_STATE, lastAnonId: null };
    this.saveUploadState();
    for (const file of [this.snapshotFile, this.onceFile]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Already gone.
      }
    }
  }

  private toggle(enabled: boolean): void {
    if (enabled) {
      // A new secret and a new id: what is collected now cannot be joined to what came before.
      try {
        this.identity.restart();
        this.tracker.forgetOpens();
      } catch {
        // begin() below reports what it can; without a secret there is nothing to send under.
      }
      void this.begin();
    } else {
      this.discard();
    }
    this.ctx.ipc.send("analytics.changed", this.state());
  }

  private setEnabled(enabled: boolean): AnalyticsState {
    const settings = this.ctx.settings.get();
    this.ctx.settings.set({ ...settings, analytics: { enabled } });
    return this.state();
  }

  private resetId(): AnalyticsState {
    if (this.enabled()) {
      this.abort?.abort();
      try {
        this.identity.reset();
        this.tracker.forgetOpens();
      } catch (error) {
        this.ctx.logger.warn(`analytics: could not reset the identifier: ${String(error)}`);
      }
    }
    this.queue.clear();
    let lastAnonId: string | null = null;
    try {
      lastAnonId = this.enabled() ? this.identity.current() : null;
    } catch {
      // No secret yet; the next start fills it in.
    }
    this.uploadState = { ...this.uploadState, lastAnonId, failures: 0, nextAt: 0 };
    this.saveUploadState();
    return this.state();
  }

  /** One event, validated before it can reach the queue or a file. */
  private record(partial: Record<string, unknown>, ts = Date.now(), extra: Record<string, unknown> = {}): boolean {
    if (!this.active || !this.enabled()) return false;
    let event: AnalyticsEvent;
    try {
      event = parseEvent({
        schema: SCHEMA_VERSION,
        registry: FEATURE_REGISTRY_VERSION,
        event_id: crypto.randomUUID(),
        anon_id: this.identity.current(),
        install_seq: this.identity.nextSeq(),
        ts,
        client: this.config.client,
        platform: platformOf(),
        ...partial,
        ...extra
      });
    } catch (error) {
      this.ctx.logger.warn(`analytics: dropped an event: ${String(error)}`);
      return false;
    }
    try {
      this.queue.push(event);
    } catch (error) {
      this.ctx.logger.warn(`analytics: could not queue an event: ${String(error)}`);
      return false;
    }
    if (this.queue.size >= FLUSH_BATCH) void this.flush();
    return true;
  }

  /** A milestone goes once per anonymous id: a new id (rotation, reset, switched back on) may record it again. */
  private recordAction(featureId: string, action: string, dim: string | null, ts: number): void {
    if (!isOnce(featureId, action)) {
      this.record({ event: "feature.activate", feature_id: featureId, action, dim }, ts);
      return;
    }
    if (!this.active || !this.enabled()) return;
    let anonId: string;
    try {
      anonId = this.identity.current();
    } catch {
      return;
    }
    const key = `${featureId}/${action}`;
    const done = this.readOnce(anonId);
    if (done.includes(key)) return;
    if (this.record({ event: "feature.activate", feature_id: featureId, action, dim }, ts)) this.saveOnce(anonId, [...done, key]);
  }

  private readOnce(anonId: string): string[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.onceFile, "utf8")) as { anonId?: unknown; done?: unknown };
      return raw.anonId === anonId && Array.isArray(raw.done) ? raw.done.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  }

  private saveOnce(anonId: string, done: string[]): void {
    try {
      fs.mkdirSync(this.config.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.onceFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ anonId, done }));
      fs.renameSync(tmp, this.onceFile);
    } catch {
      // Lost, the milestone is recorded again next time: a duplicate the funnel's distinct count absorbs.
    }
  }

  private recordSession(draft: SessionDraft): void {
    this.record({
      event: "feature.session",
      feature_id: draft.featureId,
      session_id: draft.sessionId,
      started_at: draft.startedAt,
      ended_at: draft.endedAt,
      active_ms: draft.activeMs,
      idle_ms: draft.idleMs,
      segments: draft.segments,
      end_reason: draft.endReason
    }, draft.startedAt);
    // A use that just ended is the natural moment to send what has piled up.
    void this.flush();
  }

  /**
   * Sends the oldest batch. False when the batch was not taken and remains
   * queued. With `withinMs` set, nothing outlives that wait: the request is
   * aborted and the queue keeps the events for next time.
   */
  private async flush(withinMs = 0, ignoreBackoff = false): Promise<boolean> {
    if (!this.uploader || !this.active || !this.enabled() || this.flushing) return false;
    const now = Date.now();
    if (!ignoreBackoff && now < this.uploadState.nextAt) return false;
    this.queue.prune(now);
    const events = this.queue.peek(MAX_BATCH_EVENTS);
    if (!events.length) return true;

    this.flushing = true;
    const controller = new AbortController();
    this.abort = controller;
    const work = this.uploader.sendAll(events, controller.signal);
    let result: Awaited<typeof work>;
    if (withinMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), withinMs);
      });
      const raced = await Promise.race([work, timeout]);
      clearTimeout(timer);
      if (raced === null) {
        controller.abort();
        this.flushing = false;
        this.abort = null;
        return false;
      }
      result = raced;
    } else {
      result = await work;
    }
    this.flushing = false;
    this.abort = null;

    if (result.sent.size) {
      this.queue.remove(result.sent);
      this.uploadState.lastSentAt = Date.now();
    }
    if (result.retry) {
      this.uploadState.failures += 1;
      this.uploadState.nextAt = Date.now() + (result.retryAfterMs ?? retryDelay(this.uploadState.failures));
    } else {
      this.uploadState.failures = 0;
      this.uploadState.nextAt = 0;
    }
    this.saveUploadState();
    this.ctx.ipc.send("analytics.changed", this.state());
    return result.sent.size > 0 || !result.retry;
  }

  private readUploadState(): UploadState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.uploadFile, "utf8")) as Partial<UploadState>;
      return {
        failures: typeof raw.failures === "number" ? raw.failures : 0,
        nextAt: typeof raw.nextAt === "number" ? raw.nextAt : 0,
        lastAnonId: typeof raw.lastAnonId === "string" ? raw.lastAnonId : null,
        lastSentAt: typeof raw.lastSentAt === "number" ? raw.lastSentAt : null
      };
    } catch {
      return { ...UPLOAD_STATE };
    }
  }

  private saveUploadState(): void {
    try {
      fs.mkdirSync(this.config.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.uploadFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.uploadState));
      fs.renameSync(tmp, this.uploadFile);
    } catch {
      // The next attempt is decided in memory; a lost file only skips a backoff once.
    }
  }

  private saveSnapshot(snapshot: SessionSnapshot): void {
    if (!this.enabled()) return;
    try {
      fs.mkdirSync(this.config.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.snapshotFile, JSON.stringify(snapshot));
    } catch {
      // A crash losing the last half minute is the price of a failed write, not a reason to interrupt.
    }
  }

  private recoverCrash(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.snapshotFile, "utf8")) as SessionSnapshot;
      fs.rmSync(this.snapshotFile, { force: true });
      if (raw && typeof raw.featureId === "string" && typeof raw.startedAt === "number") this.tracker.recover(raw);
    } catch {
      // No previous run, or one that left nothing readable.
    }
  }
}

export default Analytics;
