import { GATEWAY, INTENTS, type DUser } from "./wire.js";

export interface Net {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

/** The runtime's network, read when a connection opens, so a test can stand in for Discord. */
export const net = (): Net => ({ fetch: globalThis.fetch.bind(globalThis), WebSocket: globalThis.WebSocket });

export interface Ready { sessionId: string; user: DUser; applicationId: string }

/** Close codes after which trying again cannot help: a bad token, or intents the bot may not have. */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Close codes after which the session cannot be resumed and must identify again. */
const FRESH = new Set([4007, 4009]);

export class GatewayError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

/**
 * One Discord Gateway session: identify, heartbeat (a missed ack is a dead
 * connection), and resume after a drop so missed events are replayed rather
 * than lost — the common layer drops the ones it already has. A fatal close
 * ends it for good; the common layer then reopens with backoff.
 */
export class Gateway {
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private session: { id: string; url: string } | null = null;
  private beat: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private acked = true;
  private attempts = 0;
  private stopped = false;
  private firstReady: { resolve(r: Ready): void; reject(e: Error): void } | null = null;

  constructor(private readonly token: string, private readonly net: Net, private readonly on: {
    dispatch(type: string, data: unknown): void;
    /** Reconnecting (`connecting`), back (`connected`), or given up (`error`). */
    state(state: "connecting" | "connected" | "error", detail?: string): void;
  }, private readonly opts: { backoffMs?: number; intents?: number } = {}) {}

  start(): Promise<Ready> {
    return new Promise((resolve, reject) => {
      this.firstReady = { resolve, reject };
      this.connect();
    });
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    try { this.ws?.close(1000); } catch { /* already closed */ }
    this.ws = null;
  }

  private clearTimers() {
    if (this.beat) clearTimeout(this.beat);
    if (this.retry) clearTimeout(this.retry);
    this.beat = this.retry = null;
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(payload));
  }

  private connect() {
    if (this.stopped) return;
    const resume = this.session;
    const ws = new this.net.WebSocket(resume ? `${resume.url.replace(/\/?(\?.*)?$/, "")}/?v=10&encoding=json` : GATEWAY);
    this.ws = ws;
    ws.addEventListener("message", event => {
      if (this.ws !== ws) return;
      let packet: { op: number; d: unknown; s?: number | null; t?: string | null };
      try { packet = JSON.parse(String(event.data)); } catch { return; }
      this.handle(packet);
    });
    ws.addEventListener("close", event => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.closed(event.code, event.reason);
    });
    ws.addEventListener("error", () => { /* a close follows */ });
  }

  private handle(p: { op: number; d: unknown; s?: number | null; t?: string | null }) {
    switch (p.op) {
      case 10: {
        const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval;
        this.acked = true;
        // The first beat is jittered so many clients reconnecting together don't beat in step.
        this.schedule(interval * Math.random(), interval);
        if (this.session) this.send({ op: 6, d: { token: this.token, session_id: this.session.id, seq: this.seq } });
        else this.send({ op: 2, d: { token: this.token, intents: this.opts.intents ?? INTENTS, properties: { os: "tomrade", browser: "tomrade", device: "tomrade" } } });
        return;
      }
      case 11: this.acked = true; return;
      case 1: this.send({ op: 1, d: this.seq }); return;
      case 7: this.drop(4000); return;
      case 9:
        // Invalid session: resumable or not, wait a moment as Discord asks.
        if (!p.d) { this.session = null; this.seq = null; }
        this.drop(4000, 1000 + Math.random() * 4000);
        return;
      case 0: {
        if (typeof p.s === "number") this.seq = p.s;
        if (p.t === "READY") {
          const d = p.d as { session_id: string; resume_gateway_url: string; user: DUser; application: { id: string } };
          this.session = { id: d.session_id, url: d.resume_gateway_url };
          this.ready();
          this.firstReady?.resolve({ sessionId: d.session_id, user: d.user, applicationId: d.application.id });
          this.firstReady = null;
        } else if (p.t === "RESUMED") this.ready();
        if (p.t) this.on.dispatch(p.t, p.d);
      }
    }
  }

  private ready() {
    this.attempts = 0;
    this.on.state("connected");
  }

  private schedule(firstMs: number, interval: number) {
    if (this.beat) clearTimeout(this.beat);
    this.beat = setTimeout(() => {
      // No ack since the last beat: the connection is a zombie. Drop it and resume.
      if (!this.acked) { this.drop(4000); return; }
      this.acked = false;
      this.send({ op: 1, d: this.seq });
      this.schedule(interval, interval);
    }, firstMs);
  }

  /** Closes this socket on purpose; `closed` reconnects. */
  private drop(code: number, delayMs?: number) {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(code); } catch { /* already closed */ }
    this.closed(code, "", delayMs);
  }

  private closed(code: number, reason: string, delayMs?: number) {
    this.clearTimers();
    if (this.stopped) return;
    if (FATAL.has(code)) {
      const message = code === 4004 ? "Discord refused the bot token" : `Discord closed the connection (${code}${reason ? `: ${reason}` : ""})`;
      this.stopped = true;
      if (this.firstReady) { this.firstReady.reject(new GatewayError(message, code)); this.firstReady = null; }
      else this.on.state("error", message);
      return;
    }
    if (FRESH.has(code)) { this.session = null; this.seq = null; }
    const base = this.opts.backoffMs ?? 1000;
    const wait = delayMs ?? Math.min(30_000, base * 2 ** Math.min(this.attempts++, 5));
    if (!this.firstReady) this.on.state("connecting");
    this.retry = setTimeout(() => this.connect(), wait);
  }
}
