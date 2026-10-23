import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { SettingsSection } from "@tomradex/settings";
import type {} from "@tomradex/ipc";
import { AnonIdentity, type IdentityInfo } from "./anon.js";
import { FEATURE_REGISTRY_VERSION } from "./features.js";
import type { AnalyticsEvent } from "./events.js";
import { parseEvent, SCHEMA_VERSION } from "./events.js";
import { EventQueue } from "./queue.js";
import { Tracker, type HostSignals, type SessionDraft, type SessionSnapshot } from "./tracker.js";
import { ANALYTICS_WORDS } from "./words.js";

export * from "./features.js";
export * from "./constants.js";
export * from "./events.js";
export { AnonIdentity, deriveAnonId, newSecret, type IdentityInfo } from "./anon.js";
export { EventQueue } from "./queue.js";
export { Tracker, type HostSignals, type SessionDraft, type SessionSnapshot } from "./tracker.js";

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
  // Below the account and notifications, above the technical panes.
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

export interface UploadConfig {
  url: string;
  key: string;
  /** `auto` lets the deployment route; `global`/`cn` pin a region for a test or an enterprise proxy. */
  endpoint?: "auto" | "global" | "cn";
  fetch?: typeof fetch;
  /** Injected in tests so retries do not wait. */
  delay?: (ms: number) => Promise<void>;
}

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
 * Collection, the local queue and the anonymous identity. It never blocks the
 * interface: a failure to read a file or to send a batch is logged, and the
 * next tick carries on.
 */
export class Analytics extends Service {
  static provide = "analytics";
  static inject = ["ipc", "settings"];
  static Config = z.object({
    dir: z.string().min(1),
    client: z.string().min(1),
    host: z.custom<HostSignals>((value) => !!value && typeof (value as HostSignals).isFocused === "function")
  });

  private readonly identity: AnonIdentity;
  private readonly queue: EventQueue;
  private readonly snapshotFile: string;
  private readonly tracker: Tracker;
  private stopTracker: (() => void) | null = null;
  private active = false;
  private lastSentAt: number | null = null;

  constructor(ctx: Context, private readonly config: AnalyticsConfig) {
    super(ctx, "analytics");
    this.identity = new AnonIdentity(config.dir);
    this.queue = new EventQueue(path.join(config.dir, "queue.jsonl"));
    this.snapshotFile = path.join(config.dir, "session.json");
    this.tracker = new Tracker(
      config.host,
      {
        activate: (featureId, action, dim, ts) => this.record({ event: "feature.activate", feature_id: featureId, action, dim }, ts),
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

    if (this.enabled()) this.begin();
    return () => this.stop();
  }

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
      lastSentAt: this.lastSentAt,
      endpoint: this.config.upload?.endpoint ?? "auto"
    };
  }

  private enabled(): boolean {
    const section = this.ctx.settings.get().analytics as AnalyticsSettings | undefined;
    return (section ?? ANALYTICS_SECTION.defaults).enabled;
  }

  private begin(): void {
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
    this.recoverCrash();
    this.record({ event: "app.start" }, Date.now(), { first_run: Date.now() - this.identity.info().installedAt < 24 * 60 * 60_000 });
    this.stopTracker = this.tracker.start();
  }

  private stop(): void {
    this.tracker.quit();
    this.stopTracker?.();
    this.stopTracker = null;
    this.active = false;
  }

  /** Off: nothing is collected, nothing waits, and the secret that derived the id is gone. */
  private discard(): void {
    this.tracker.discard();
    this.stopTracker?.();
    this.stopTracker = null;
    this.active = false;
    this.queue.clear();
    this.identity.clear();
    try {
      fs.rmSync(this.snapshotFile, { force: true });
    } catch {
      // Already gone.
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
      this.begin();
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
      try {
        this.identity.reset();
        this.tracker.forgetOpens();
      } catch (error) {
        this.ctx.logger.warn(`analytics: could not reset the identifier: ${String(error)}`);
      }
    }
    this.queue.clear();
    return this.state();
  }

  /** One event, validated before it can reach the queue or a file. */
  private record(partial: Record<string, unknown>, ts = Date.now(), extra: Record<string, unknown> = {}): void {
    if (!this.active || !this.enabled()) return;
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
      return;
    }
    try {
      this.queue.push(event);
    } catch (error) {
      this.ctx.logger.warn(`analytics: could not queue an event: ${String(error)}`);
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
