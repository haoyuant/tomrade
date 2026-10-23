import crypto from "node:crypto";
import {
  IDLE_END_MS,
  IDLE_PAUSE_MS,
  IDLE_SAMPLE_MS,
  MIN_SESSION_MS,
  RETURN_COALESCE_MS,
  SEGMENT_MAX_MS,
  SESSION_MAX_MS,
  TICK_MS
} from "./constants.js";

/**
 * Session timing, in the main process only: it is the one place that knows
 * whether a Tomrade window has focus, how long the system has been idle, and
 * when the screen locks. The renderer reports the surface the person last
 * touched; nothing in the renderer counts time.
 */

export type EndReason = "switch" | "blur" | "idle" | "lock" | "suspend" | "quit" | "crash" | "cap";

/** The host's truth about focus, idle and power. Electron implements it in apps/desktop; tests fake it. */
export interface HostSignals {
  isFocused(): boolean;
  /** Milliseconds since the last system input. */
  idleMs(): number;
  /** Lock, suspend, resume and quit. Returns an unsubscribe. */
  on(event: "lock" | "suspend" | "resume" | "quit", listener: () => void): () => void;
}

export interface Clock {
  /** Wall clock, what an event timestamp says. */
  wall(): number;
  /** Monotonic milliseconds, what durations are measured with. */
  mono(): number;
}

export const realClock: Clock = {
  wall: () => Date.now(),
  mono: () => Number(process.hrtime.bigint() / 1_000_000n)
};

export interface SessionDraft {
  featureId: string;
  sessionId: string;
  startedAt: number;
  endedAt: number;
  activeMs: number;
  idleMs: number;
  segments: number;
  endReason: EndReason;
}

export interface TrackerOut {
  /** The person did a counted action (or one kept for adoption). */
  activate(featureId: string, action: string, dim: string | null, ts: number): void;
  /** A timed session ended and is worth keeping. */
  session(draft: SessionDraft): void;
}

/** What is written every HEARTBEAT_MS so a crash loses at most that much. */
export interface SessionSnapshot {
  featureId: string;
  sessionId: string;
  startedAt: number;
  activeMs: number;
  segments: number;
  /** Wall clock of the last counted moment. */
  at: number;
}

export interface TrackerOptions {
  clock?: Clock;
  /** Called at most every HEARTBEAT_MS while a session is open. */
  heartbeat?: (snapshot: SessionSnapshot) => void;
  /** False stops everything: no session, no event, no timer effect. */
  enabled?: () => boolean;
}

export class Tracker {
  private current: string | null = null;
  private session: {
    id: string;
    featureId: string;
    startedAt: number;
    activeMs: number;
    segments: number;
  } | null = null;
  private segmentStart: number | null = null;
  private paused = false;
  private blurred = false;
  private blurAt = 0;
  private lastOpen = new Map<string, number>();
  private lastHeartbeatAt = 0;
  private timers: (() => void)[] = [];
  private readonly clock: Clock;
  private readonly enabled: () => boolean;

  constructor(
    private readonly host: HostSignals,
    private readonly out: TrackerOut,
    private readonly options: TrackerOptions = {}
  ) {
    this.clock = options.clock ?? realClock;
    this.enabled = options.enabled ?? (() => true);
  }

  /** Starts the once-a-second tick and the idle sampler; returns the stop function. */
  start(): () => void {
    this.timers.push(interval(() => this.tick(), TICK_MS));
    this.timers.push(interval(() => this.sampleIdle(), IDLE_SAMPLE_MS));
    for (const event of ["lock", "suspend"] as const) {
      this.timers.push(this.host.on(event, () => this.powerLost(event)));
    }
    this.timers.push(this.host.on("resume", () => this.tick()));
    return () => {
      for (const stop of this.timers.splice(0)) stop();
    };
  }

  /** The surface the person last touched, from the renderer; null when they left it. */
  reportSurface(next: string | null): void {
    if (!this.enabled()) {
      this.current = next;
      return;
    }
    if (next === this.current) {
      // Back in the same place after a pause: the interaction itself resumes.
      this.resumeIfIdle();
      if (!this.session && next && this.canCount()) {
        this.begin(next);
        this.maybeOpen(next);
      }
      return;
    }
    const now = this.clock.wall();
    if (this.session) this.finish("switch", now, this.clock.mono());
    this.current = next;
    if (!next) return;
    if (!this.canCount()) return;
    this.begin(next);
    this.maybeOpen(next);
  }

  /** A counted action; the person did it, the surface is irrelevant. */
  activate(featureId: string, action: string, dim: string | null = null): void {
    if (!this.enabled()) return;
    const now = this.clock.wall();
    if (action === "open") {
      if (!this.maybeOpen(featureId, now)) return;
      return;
    }
    this.out.activate(featureId, action, dim, now);
  }

  /** A window lost focus: stop counting; 30 seconds later the use is over. */
  blur(): void {
    if (this.blurred) return;
    this.blurred = true;
    this.blurAt = this.clock.wall();
    this.cut(this.clock.mono());
  }

  /** A window regained focus: carry on the session, or begin the next one. */
  focus(): void {
    this.blurred = false;
    if (!this.enabled() || !this.current) return;
    this.resumeIfIdle();
    if (this.session) {
      this.openSegment();
      return;
    }
    if (!this.canCount()) return;
    this.begin(this.current);
    this.maybeOpen(this.current);
  }

  /** Lock or suspend: the use ends now. */
  private powerLost(reason: "lock" | "suspend"): void {
    if (this.session) this.finish(reason, this.clock.wall(), this.clock.mono());
    this.paused = true;
  }

  /** Quit: end the session, so the queue has everything up to the last second. */
  quit(): void {
    if (this.session) this.finish("quit", this.clock.wall(), this.clock.mono());
    this.paused = true;
  }

  /** Drops the open session without recording it: the switch went off mid-use. */
  discard(): void {
    this.session = null;
    this.segmentStart = null;
    this.current = null;
    this.paused = false;
    this.blurred = false;
    this.lastOpen.clear();
  }

  /** The current session, for persistence; null when none is open. */
  snapshot(): SessionSnapshot | null {
    if (!this.session) return null;
    const now = this.clock.mono();
    const open = this.segmentStart != null ? Math.max(0, now - this.segmentStart) : 0;
    return {
      featureId: this.session.featureId,
      sessionId: this.session.id,
      startedAt: this.session.startedAt,
      activeMs: this.session.activeMs + open,
      segments: this.session.segments + (open > 0 ? 1 : 0),
      at: this.clock.wall()
    };
  }

  /**
   * The last run ended without a quit: report what it did up to its last
   * heartbeat as a crashed session, then forget it. Never counts an open.
   */
  recover(snapshot: SessionSnapshot): void {
    if (!this.enabled()) return;
    const endedAt = Math.min(snapshot.at, snapshot.startedAt + SESSION_MAX_MS);
    const activeMs = Math.min(snapshot.activeMs, Math.max(0, endedAt - snapshot.startedAt));
    if (activeMs < MIN_SESSION_MS) return;
    this.out.session({
      featureId: snapshot.featureId,
      sessionId: snapshot.sessionId,
      startedAt: snapshot.startedAt,
      endedAt,
      activeMs,
      idleMs: Math.max(0, endedAt - snapshot.startedAt - activeMs),
      segments: Math.max(1, snapshot.segments),
      endReason: "crash"
    });
  }

  /** Forget the remembered opens, so a new identity does not inherit them. */
  forgetOpens(): void {
    this.lastOpen.clear();
  }

  /** One timing tick; the interval calls it, and a test can too. */
  tick(): void {
    if (!this.enabled()) return;
    const now = this.clock.wall();
    const mono = this.clock.mono();

    // A window that lost focus and did not come back within the window: that use is over.
    if (this.blurred && this.session && now - this.blurAt >= RETURN_COALESCE_MS) {
      this.finish("blur", this.blurAt, mono - (now - this.blurAt));
      this.paused = false;
    } else if (this.blurred && this.session) {
      // Still within the window; the segment stays cut.
      this.resumeIfIdle();
    }

    if (this.session) {
      if (now - this.session.startedAt >= SESSION_MAX_MS) {
        const at = this.session.startedAt + SESSION_MAX_MS;
        const feature = this.session.featureId;
        this.finish("cap", at, mono - (now - at));
        this.begin(feature);
      } else if (this.segmentStart != null && mono - this.segmentStart >= SEGMENT_MAX_MS) {
        this.cut(this.segmentStart + SEGMENT_MAX_MS);
        this.openSegment();
      }
      if (now - this.lastHeartbeatAt >= 30_000) {
        this.lastHeartbeatAt = now;
        const snapshot = this.snapshot();
        if (snapshot) this.options.heartbeat?.(snapshot);
      }
    }

    this.resumeIfIdle();
  }

  /** One idle sample; the interval calls it, and a test can too. */
  sampleIdle(): void {
    if (!this.enabled()) return;
    const idle = this.host.idleMs();
    const wall = this.clock.wall();
    const mono = this.clock.mono();

    if (this.session && !this.paused && idle >= IDLE_PAUSE_MS) {
      // Backdate to the last input: the five seconds up to this sample are not use.
      this.cut(mono - idle);
      this.paused = true;
      if (idle >= IDLE_END_MS) this.finish("idle", wall - idle, mono - idle);
      return;
    }
    if (this.paused && idle < 1_000) {
      this.paused = false;
      if (!this.enabled() || this.blurred || !this.current) return;
      if (this.session) this.openSegment();
      else if (this.canCount()) {
        this.begin(this.current);
        this.maybeOpen(this.current);
      }
    }
  }

  private resumeIfIdle(): void {
    if (!this.paused) return;
    if (this.host.idleMs() >= 1_000) return;
    this.paused = false;
    if (!this.session || this.segmentStart == null) {
      if (!this.session && this.current && this.canCount() && !this.blurred) {
        this.begin(this.current);
        this.maybeOpen(this.current);
      } else {
        this.openSegment();
      }
    }
  }

  private canCount(): boolean {
    return this.enabled() && this.host.isFocused() && !this.blurred && !this.paused;
  }

  private begin(featureId: string): void {
    this.session = {
      id: crypto.randomUUID(),
      featureId,
      startedAt: this.clock.wall(),
      activeMs: 0,
      segments: 0
    };
    this.lastHeartbeatAt = this.clock.wall();
    this.openSegment();
  }

  private openSegment(): void {
    if (this.segmentStart != null) return;
    if (!this.session || !this.canCount()) return;
    this.segmentStart = this.clock.mono();
  }

  private cut(mono: number): void {
    if (this.segmentStart == null || !this.session) return;
    const elapsed = Math.max(0, mono - this.segmentStart);
    this.segmentStart = null;
    if (elapsed === 0) return;
    this.session.activeMs += elapsed;
    this.session.segments += 1;
  }

  private finish(reason: EndReason, endedAt: number, monoAt: number): void {
    if (!this.session) return;
    this.cut(monoAt);
    const session = this.session;
    this.session = null;
    this.segmentStart = null;
    const span = Math.max(0, endedAt - session.startedAt);
    const activeMs = Math.min(session.activeMs, span);
    this.lastHeartbeatAt = endedAt;
    if (activeMs < MIN_SESSION_MS) return;
    this.out.session({
      featureId: session.featureId,
      sessionId: session.id,
      startedAt: session.startedAt,
      endedAt,
      activeMs,
      idleMs: Math.max(0, span - activeMs),
      segments: Math.max(1, session.segments),
      endReason: reason
    });
  }

  /** Emits `open` unless this feature was opened within the coalescing window. */
  private maybeOpen(featureId: string, now = this.clock.wall()): boolean {
    const last = this.lastOpen.get(featureId);
    if (last != null && now - last < RETURN_COALESCE_MS) return false;
    this.lastOpen.set(featureId, now);
    this.out.activate(featureId, "open", null, now);
    return true;
  }
}

/** setInterval as a stop function; unref'd so a background app is not held awake by analytics. */
function interval(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}
