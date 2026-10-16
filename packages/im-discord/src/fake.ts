import type { Net } from "./gateway.js";

/** A REST call the fake received. */
export interface FakeCall { method: string; path: string; body: Record<string, unknown> | null; files: string[]; at: number }

type Listener = (event: { data?: string; code?: number; reason?: string }) => void;

/**
 * Discord in memory: a Gateway that says hello, takes identify and resume
 * (replaying what a dropped connection missed), acks heartbeats, and REST
 * routes for messages, reactions, typing, interactions and commands. For
 * tests and the plugin's own scenario; never shipped as the adapter.
 */
export class FakeDiscord {
  readonly token = "fake-bot-token";
  readonly bot = { id: "900", username: "tomrade-bot" };
  readonly appId = "800";
  readonly calls: FakeCall[] = [];
  /** Sockets opened, in order, with the URL each used. */
  readonly sockets: { url: string; socket: FakeSocket }[] = [];
  heartbeatMs = 40;
  /** When set, heartbeats go unanswered, as on a dead connection. */
  silent = false;
  private seq = 0;
  private log: { s: number; t: string; d: unknown }[] = [];
  private sessionId = "session-1";
  private ids = 1000;
  private fail: { match: (c: FakeCall) => boolean; status: number; retryAfter?: number; times: number }[] = [];
  readonly messages = new Map<string, { channel: string; body: Record<string, unknown> }>();

  /** The current connection, once identified or resumed. */
  get live() { return this.sockets.at(-1)?.socket.ready ? this.sockets.at(-1)!.socket : null; }

  net(): Net {
    const fake = this;
    class Socket extends FakeSocket { constructor(url: string) { super(fake, url); } }
    return { fetch: (input, init) => this.fetch(String(input), init), WebSocket: Socket as unknown as typeof WebSocket };
  }

  /** Answers the next calls `match` picks with `status` (a 429 carries retry_after seconds). */
  failNext(match: (c: FakeCall) => boolean, status: number, opts: { retryAfter?: number; times?: number } = {}) {
    this.fail.push({ match, status, ...(opts.retryAfter !== undefined ? { retryAfter: opts.retryAfter } : {}), times: opts.times ?? 1 });
  }

  /** Sends an event to the live connection; a dropped connection gets it on resume. */
  dispatch(t: string, d: unknown) {
    const s = ++this.seq;
    this.log.push({ s, t, d });
    this.live?.push({ op: 0, s, t, d });
  }

  /** The connection breaks without a close handshake; the client should resume. */
  drop(code = 1006) { this.sockets.at(-1)?.socket.serverClose(code); }

  id() { return String(++this.ids); }

  user(id: string, name = `user-${id}`) { return { id, username: name, global_name: name }; }

  message(o: { channel: string; author: string; content: string; guild?: string; id?: string; mentions?: boolean; replyTo?: string; attachments?: { id: string; filename: string; size: number; content_type?: string }[] }) {
    const id = o.id ?? this.id();
    const d = { id, type: o.replyTo ? 19 : 0, channel_id: o.channel, ...(o.guild ? { guild_id: o.guild } : {}), content: o.content, author: this.user(o.author),
      mentions: o.mentions ? [this.bot] : [], attachments: (o.attachments ?? []).map(a => ({ ...a, url: `https://cdn.discordapp.com/attachments/${o.channel}/${a.id}/${a.filename}` })),
      ...(o.replyTo ? { message_reference: { message_id: o.replyTo }, referenced_message: { author: this.messages.has(o.replyTo) ? this.bot : this.user("someone") } } : {}) };
    this.dispatch("MESSAGE_CREATE", d);
    return d;
  }

  interaction(o: { type: number; channel: string; user: string; guild?: string; data: Record<string, unknown> }) {
    const id = this.id();
    const d = { id, application_id: this.appId, type: o.type, token: `itoken-${id}`, channel_id: o.channel, ...(o.guild ? { guild_id: o.guild, member: { user: this.user(o.user) } } : { user: this.user(o.user) }), data: o.data };
    this.dispatch("INTERACTION_CREATE", d);
    return d;
  }

  /** Calls whose path matches, in order. */
  where(method: string, path: RegExp) { return this.calls.filter(c => c.method === method && path.test(c.path)); }

  // ── Gateway ──────────────────────────────────────────────────────────

  open(socket: FakeSocket) {
    this.sockets.push({ url: socket.url, socket });
    queueMicrotask(() => { socket.emit("open", {}); socket.push({ op: 10, d: { heartbeat_interval: this.heartbeatMs } }); });
  }

  receive(socket: FakeSocket, p: { op: number; d: Record<string, unknown> }) {
    if (p.op === 1) { if (!this.silent) socket.push({ op: 11 }); return; }
    if (p.op === 2) {
      if (p.d.token !== this.token) { socket.serverClose(4004, "Authentication failed."); return; }
      this.sessionId = `session-${this.sockets.length}`;
      socket.ready = true;
      const s = ++this.seq;
      socket.push({ op: 0, s, t: "READY", d: { session_id: this.sessionId, resume_gateway_url: "wss://resume.discord.gg", user: { ...this.bot, bot: true }, application: { id: this.appId } } });
      return;
    }
    if (p.op === 6) {
      if (p.d.session_id !== this.sessionId) { socket.push({ op: 9, d: false }); return; }
      socket.ready = true;
      for (const e of this.log.filter(e => e.s > Number(p.d.seq ?? 0))) socket.push({ op: 0, s: e.s, t: e.t, d: e.d });
      socket.push({ op: 0, s: ++this.seq, t: "RESUMED", d: {} });
    }
  }

  // ── REST ─────────────────────────────────────────────────────────────

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    if (u.hostname === "cdn.discordapp.com") return new Response(new TextEncoder().encode(`bytes of ${u.pathname.split("/").pop()}`));
    const path = u.pathname.replace(/^\/api\/v10/, "");
    const method = init.method ?? "GET";
    let body: Record<string, unknown> | null = null;
    const files: string[] = [];
    if (init.body instanceof FormData) {
      body = JSON.parse(String(init.body.get("payload_json")));
      for (const [key, value] of init.body.entries()) if (key.startsWith("files[")) files.push((value as File).name);
    } else if (typeof init.body === "string") body = JSON.parse(init.body);
    if ((init.headers as Record<string, string>)?.authorization !== `Bot ${this.token}`) return json({ message: "401: Unauthorized" }, 401);
    const call = { method, path, body, files, at: Date.now() };
    this.calls.push(call);
    const failing = this.fail.find(f => f.times > 0 && f.match(call));
    if (failing) {
      failing.times--;
      return json(failing.status === 429 ? { message: "You are being rate limited.", retry_after: failing.retryAfter ?? 0.05 } : { message: "Failure" }, failing.status);
    }
    let m: RegExpExecArray | null;
    if (method === "POST" && (m = /^\/channels\/(\d+)\/messages$/.exec(path))) {
      // Enforced nonces: the same message twice is the first one.
      const same = [...this.messages.entries()].find(([, v]) => v.body.nonce && v.body.nonce === body?.nonce);
      if (same) return json({ id: same[0], channel_id: m[1] });
      const id = this.id();
      this.messages.set(id, { channel: m[1]!, body: body ?? {} });
      return json({ id, channel_id: m[1] });
    }
    if (method === "PATCH" && (m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) {
      this.messages.set(m[2]!, { channel: m[1]!, body: body ?? {} });
      return json({ id: m[2], channel_id: m[1] });
    }
    if (method === "PATCH" && /^\/webhooks\/\d+\/[^/]+\/messages\/@original$/.test(path)) return json({ id: this.id() });
    if (method === "GET" && (m = /^\/channels\/(\d+)$/.exec(path))) return json({ id: m[1], type: 0 });
    if (/^\/channels\/\d+\/typing$/.test(path) || /\/reactions\//.test(path) || /^\/interactions\//.test(path)) return new Response(null, { status: 204 });
    if (method === "PUT" && /^\/applications\/\d+\/commands$/.test(path)) return json(body);
    return json({ message: "404: Not Found" }, 404);
  }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export class FakeSocket {
  readyState = 1;
  ready = false;
  private listeners = new Map<string, Listener[]>();
  constructor(private readonly fake: FakeDiscord, readonly url: string) { fake.open(this); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  emit(type: string, event: { data?: string; code?: number; reason?: string }) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  push(payload: unknown) { if (this.readyState === 1) this.emit("message", { data: JSON.stringify(payload) }); }
  send(data: string) { if (this.readyState === 1) this.fake.receive(this, JSON.parse(data)); }
  close(code = 1000) { this.serverClose(code); }
  serverClose(code: number, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.ready = false;
    queueMicrotask(() => this.emit("close", { code, reason }));
  }
}
