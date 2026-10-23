import crypto from "node:crypto";
import { Batch, parseEvent, type AnalyticsEvent } from "./events.js";
import { MAX_BATCH_EVENTS, RETRY_MS } from "./constants.js";

/**
 * The one place an event leaves this machine. A batch carries nothing but the
 * three envelope fields and events the registry already validated; opt-out
 * stops the timers, aborts a request in flight and empties the queue, so after
 * it no request can be made.
 */

export interface UploadConfig {
  /** Supabase project URL — the ingest function is a Postgres function reached through PostgREST. */
  url: string;
  /** The publishable key: authorization is RLS and the function's own checks, not a secret. */
  key: string;
  /** `auto` follows the deployment's routing; `global`/`cn` pin a region for a test or an enterprise proxy. */
  endpoint?: "auto" | "global" | "cn";
  /** Region-pinned bases; absent means `url` for both. */
  cnUrl?: string;
  globalUrl?: string;
  fetch?: typeof fetch;
  /** Injected in tests so a retry does not wait. */
  delay?: (ms: number) => Promise<void>;
}

export interface SendResult {
  kind: "ok" | "drop" | "retry" | "split";
  accepted?: number;
  duplicates?: number;
  rejected?: number;
  retryAfterMs?: number;
  status?: number;
  reason?: string;
}

const RETRY_AFTER_MS = 60_000;

/** The RPC path for a region. `auto` posts to the configured project; the edge forwards if it must. */
export function endpointFor(config: UploadConfig): string {
  const base = config.endpoint === "cn" ? config.cnUrl ?? config.url : config.endpoint === "global" ? config.globalUrl ?? config.url : config.url;
  return `${base.replace(/\/+$/, "")}/rest/v1/rpc/tomrade_ingest_analytics`;
}

/** 1 m, 5 m, 15 m, 1 h, 6 h, then 6 h; ±20 % so many machines do not return together. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const base = RETRY_MS[Math.min(attempt - 1, RETRY_MS.length - 1)]!;
  const jitter = 0.8 + random() * 0.4;
  return Math.round(base * jitter);
}

/** Splits a refused batch in two, so one bad row cannot hold the rest. */
export const split = (events: AnalyticsEvent[]): AnalyticsEvent[][] =>
  events.length < 2 ? [events] : [events.slice(0, Math.ceil(events.length / 2)), events.slice(Math.ceil(events.length / 2))];

export class Uploader {
  private readonly doFetch: typeof fetch;
  private readonly delay: (ms: number) => Promise<void>;

  constructor(private readonly config: UploadConfig) {
    this.doFetch = config.fetch ?? fetch;
    this.delay = config.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Sends one batch. 202 accepted; 400 the batch can never be accepted and is
   * dropped; 413 too large to ever fit, so it is split; 421 misconfigured, also
   * dropped; 429 and 5xx are worth another try. A network failure is a retry.
   */
  async send(events: AnalyticsEvent[], signal?: AbortSignal): Promise<SendResult> {
    const batch: Batch = {
      batch_id: crypto.randomUUID(),
      sent_at: Date.now(),
      events: events.slice(0, MAX_BATCH_EVENTS)
    };
    // Parsed again on the way out: the body on the wire is exactly what the schema allows.
    const body = JSON.parse(JSON.stringify(Batch.parse({ ...batch, events: batch.events.map((event) => parseEvent(event)) })));

    let response: Response;
    try {
      response = await this.doFetch(endpointFor(this.config), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.config.key,
          Authorization: `Bearer ${this.config.key}`,
          "X-Tomrade-Analytics": "1"
        },
        body: JSON.stringify({ p_batch: body }),
        signal
      });
    } catch (error) {
      if (signal?.aborted) return { kind: "retry", reason: "aborted" };
      return { kind: "retry", reason: error instanceof Error ? error.message : String(error) };
    }

    if (response.status === 202 || response.status === 200) {
      let result: { accepted?: number; duplicates?: number; rejected?: number } = {};
      try {
        result = (await response.json()) as typeof result;
      } catch {
        // A 202 with no body still means the batch was taken.
      }
      return { kind: "ok", accepted: result.accepted ?? events.length, duplicates: result.duplicates ?? 0, rejected: result.rejected ?? 0, status: response.status };
    }
    if (response.status === 413) return { kind: "split", status: 413 };
    if (response.status === 400 || response.status === 421 || response.status === 422) {
      const text = await response.text().catch(() => "");
      return { kind: "drop", status: response.status, reason: text.slice(0, 200) };
    }
    if (response.status === 429) {
      const header = Number(response.headers.get("retry-after"));
      return { kind: "retry", status: 429, retryAfterMs: Number.isFinite(header) && header > 0 ? header * 1000 : RETRY_AFTER_MS };
    }
    return { kind: "retry", status: response.status, reason: `HTTP ${response.status}` };
  }

  /** The full batch, split on 413 and re-split until every part fits. */
  async sendAll(events: AnalyticsEvent[], signal?: AbortSignal): Promise<{ sent: Set<string>; retry: boolean; retryAfterMs?: number }> {
    const sent = new Set<string>();
    let retry = false;
    let retryAfterMs: number | undefined;
    const queue: AnalyticsEvent[][] = [events];
    while (queue.length) {
      const part = queue.shift()!;
      if (!part.length) continue;
      const result = await this.send(part, signal);
      if (result.kind === "ok" || result.kind === "drop") {
        for (const event of part) sent.add(event.event_id);
      } else if (result.kind === "split") {
        queue.unshift(...split(part));
      } else {
        retry = true;
        retryAfterMs = result.retryAfterMs;
        // The remaining parts are not attempted: the network or the server is unwell.
        break;
      }
    }
    return { sent, retry, retryAfterMs };
  }

  /** Waits out a backoff without holding a caller that cannot wait that long. */
  wait(ms: number): Promise<void> {
    return this.delay(ms);
  }
}
