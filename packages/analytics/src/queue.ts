import fs from "node:fs";
import path from "node:path";
import type { AnalyticsEvent } from "./events.js";
import { QUEUE_MAX_AGE_MS, QUEUE_MAX_BYTES, QUEUE_MAX_EVENTS } from "./constants.js";

/**
 * The unsent events, as JSON Lines. Written before the event is considered
 * collected, so a quit or a crash loses at most the moment in progress.
 * Compacted when the oldest rows are dropped or an upload succeeds.
 */
export class EventQueue {
  private events: AnalyticsEvent[] = [];
  private bytes = 0;

  constructor(
    readonly file: string,
    private readonly limits = { events: QUEUE_MAX_EVENTS, bytes: QUEUE_MAX_BYTES, ageMs: QUEUE_MAX_AGE_MS }
  ) {
    this.load();
  }

  get size(): number {
    return this.events.length;
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  push(event: AnalyticsEvent): void {
    this.events.push(event);
    this.bytes += lineBytes(event);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    this.trim();
  }

  /** The oldest `limit` events, without removing them. */
  peek(limit: number): AnalyticsEvent[] {
    return this.events.slice(0, Math.max(0, limit));
  }

  all(): readonly AnalyticsEvent[] {
    return this.events;
  }

  /** Removes events the server accepted; the file is compacted. */
  remove(ids: ReadonlySet<string>): void {
    const kept = this.events.filter((event) => !ids.has(event.event_id));
    if (kept.length === this.events.length) return;
    this.replace(kept);
  }

  clear(): void {
    this.events = [];
    this.bytes = 0;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, "");
  }

  /** Drops events older than the retention window, and whatever exceeds the limits. */
  prune(now = Date.now()): void {
    const cutoff = now - this.limits.ageMs;
    const kept = this.events.filter((event) => event.ts >= cutoff);
    if (kept.length !== this.events.length) this.replace(kept);
  }

  private load(): void {
    try {
      const text = fs.readFileSync(this.file, "utf8");
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as AnalyticsEvent;
          if (event && typeof event.event_id === "string") this.events.push(event);
        } catch {
          // A half-written last line after a crash is not worth keeping, nor worth failing over.
        }
      }
      this.bytes = this.events.reduce((sum, event) => sum + lineBytes(event), 0);
      this.trim();
    } catch {
      this.events = [];
      this.bytes = 0;
    }
  }

  private trim(): void {
    let rewrite = false;
    while (this.events.length > this.limits.events || (this.bytes > this.limits.bytes && this.events.length > 1)) {
      const dropped = this.events.shift();
      if (!dropped) break;
      this.bytes -= lineBytes(dropped);
      rewrite = true;
    }
    if (rewrite) this.replace(this.events);
  }

  private replace(events: AnalyticsEvent[]): void {
    this.events = events;
    this.bytes = events.reduce((sum, event) => sum + lineBytes(event), 0);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""));
    fs.renameSync(tmp, this.file);
  }
}

const lineBytes = (event: AnalyticsEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
