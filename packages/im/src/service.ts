import { createHash, randomBytes } from "node:crypto";
import { Context, Service } from "cordis";
import type {} from "@tomradex/agent";
import { MAX_MEDIA_BYTES, type AgentEvent, type Block, type PendingView, type UserInput } from "@tomradex/agent";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/settings";
import type { ImAdapter, ImAdapterSession, ImAddress, ImContent, ImConnectionState, ImInbound } from "@tomradex/plugin-sdk";
import { ImConfig, ImSettings, InboundSchema, type ImRoute } from "./config.js";
import { ImStore, MIGRATIONS, TABLES, type Action, type Binding, type Inbox, type Outbox } from "./store.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const token = () => randomBytes(24).toString("hex");
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export interface ImConnectionView {
  id: string; adapterId: string; state: ImConnectionState | "unconfigured";
  detail?: string; pending: number; uncertain: number;
}
interface Connection {
  id: string; adapterId: string; controller: AbortController;
  session?: ImAdapterSession; opening: boolean; flushing: boolean;
  state: ImConnectionState; detail?: string; retryAt: number; attempts: number;
}

declare module "cordis" {
  interface Context { im: Im }
  interface Events {
    "im/registered"(id: string): void;
    "im/unregistered"(id: string): void;
  }
}
declare module "@tomradex/ipc" {
  interface Channels {
    "im.connections": () => ImConnectionView[];
    /** A person explicitly retries an uncertain operation; it may have reached IM already. */
    "im.retry": (operationId: string) => boolean;
  }
}

/** Shared ingress and output projection, with no model, ticket or delivery state of its own. */
export class Im extends Service {
  static provide = "im";
  static inject = ["db", "agent", "settings", "projects"];
  static Config = ImConfig;
  store!: ImStore;
  private readonly home: Context;
  private readonly adapters = new Map<string, ImAdapter>();
  private readonly connections = new Map<string, Connection>();
  private readonly processing = new Set<string>();
  private readonly progressAt = new Map<string, number>();
  private stopped = false;
  private settings: ImSettings = { connections: [], routes: [] };
  private ignored: { at: number; connectionId: string; actorId: string; conversationId: string; reason: string }[] = [];

  constructor(ctx: Context, readonly config: ImConfig) {
    super(ctx, "im");
    this.home = ctx;
  }

  [Service.init]() {
    this.home.db.migrate("im", MIGRATIONS, { scope: "hub", tables: TABLES });
    this.store = new ImStore(this.home.db.hub);
    // A crash during network delivery has unknown outcome. Never blindly resend it.
    this.store.run("UPDATE plugin_im_outbox SET state = 'uncertain', error = 'Delivery interrupted; remote outcome unknown' WHERE state = 'sending'");
    this.home.settings.register({ id: "im", title: "IM connections",
      description: "Connect an adapter, select a project and explicitly allow users. Group replies share project information with that conversation.",
      words: { zh: { title: "IM 连接", description: "配置适配器、目标项目和允许用户。群聊回复会向该会话公开项目信息。" } },
      schema: ImSettings, defaults: this.settings, scope: "machine", agent: "none", order: 80 });
    this.home.on("settings/changed", () => this.reload());
    this.home.on("agent/event", (threadId, event) => this.onAgentEvent(threadId, event));
    this.home.inject(["ipc"], ctx => {
      ctx.ipc.handle("im.connections", () => this.views());
      ctx.ipc.handle("im.retry", id => this.retry(id));
    });
    this.home.inject(["contributions"], ctx => ctx.contributions.statusItem({ id: "im", icon: "message-circle",
      title: "IM connections",
      text: () => {
        const views = this.views();
        return views.length ? views.map(v => `${v.id}: ${v.state}${v.uncertain ? ` (${v.uncertain} 待确认)` : ""}`).join(" · ") : null;
      } }));
    this.reload();
    const timer = setInterval(() => this.tick(), this.config.pollMs);
    return async () => {
      this.stopped = true;
      clearInterval(timer);
      await Promise.all([...this.connections.values()].map(c => this.close(c)));
      this.connections.clear();
    };
  }

  register(adapter: ImAdapter): () => void {
    if (this.adapters.has(adapter.id)) throw new Error(`IM adapter ${adapter.id} already registered`);
    const caps = adapter.capabilities;
    if (!Number.isInteger(caps.maxTextLength) || caps.maxTextLength < 128 || !Number.isInteger(caps.maxFileBytes) || caps.maxFileBytes < 0) throw new Error("Invalid IM adapter limits");
    return this.ctx.effect(() => {
      this.adapters.set(adapter.id, adapter);
      this.home.emit("im/registered", adapter.id);
      this.tick();
      return async () => {
        this.adapters.delete(adapter.id);
        await Promise.all([...this.connections.values()].filter(c => c.adapterId === adapter.id).map(async c => {
          this.connections.delete(c.id);
          await this.close(c);
        }));
        this.home.emit("im/unregistered", adapter.id);
      };
    }, `im.register(${adapter.id})`);
  }

  views(): ImConnectionView[] {
    return this.settings.connections.map(spec => {
      const c = this.connections.get(spec.id);
      const counts = this.store.get<{ pending: number; uncertain: number }>(`SELECT
        SUM(CASE WHEN o.state IN ('queued', 'sending') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN o.state = 'uncertain' THEN 1 ELSE 0 END) AS uncertain
        FROM plugin_im_outbox o JOIN plugin_im_bindings b ON b.id = o.binding_id WHERE b.connection_id = ?`, spec.id);
      return { id: spec.id, adapterId: spec.adapterId, state: c?.state ?? (this.adapters.has(spec.adapterId) ? "offline" : "unconfigured"),
        detail: c?.detail, pending: counts?.pending ?? 0, uncertain: counts?.uncertain ?? 0 };
    });
  }

  /** Redacted, bounded diagnostics; rejected message bodies are not retained. */
  ignoredMessages() { return this.ignored.map(row => ({ ...row })); }

  retry(operationId: string): boolean {
    return this.store.run("UPDATE plugin_im_outbox SET state = 'queued', retry_at = 0, error = NULL WHERE id = ? AND state IN ('uncertain', 'failed')", operationId).changes > 0;
  }

  private reload() {
    if (this.stopped) return;
    this.settings = ImSettings.parse(this.home.settings.get().im);
    for (const c of this.connections.values()) {
      const spec = this.settings.connections.find(s => s.id === c.id && s.enabled && s.adapterId === c.adapterId);
      if (!spec) { this.connections.delete(c.id); void this.close(c); }
    }
    this.tick();
  }

  private current(c: Connection) { return !this.stopped && !c.controller.signal.aborted && this.connections.get(c.id) === c; }

  private async close(c: Connection) {
    c.controller.abort();
    c.state = "offline";
    const session = c.session;
    c.session = undefined;
    try { if (session) await deadline(Promise.resolve(session.close()), this.config.operationTimeoutMs); } catch { /* A disconnected provider must not block unload. */ }
  }

  private tick() {
    if (this.stopped || !this.store) return;
    for (const spec of this.settings.connections.filter(c => c.enabled)) {
      if (!this.adapters.has(spec.adapterId)) continue;
      let c = this.connections.get(spec.id);
      if (!c) {
        c = { id: spec.id, adapterId: spec.adapterId, controller: new AbortController(), opening: false, flushing: false, state: "offline", retryAt: 0, attempts: 0 };
        this.connections.set(c.id, c);
      }
      if (!c.session && !c.opening && c.retryAt <= Date.now()) void this.open(c);
      if (c.session && c.state === "connected" && !c.flushing) void this.flush(c);
    }
    for (const b of this.store.bindings()) {
      if (!this.authorizedBinding(b) || !this.home.db.has(b.project_id)) continue;
      try { this.project(b); } catch { continue; }
      if (!this.processing.has(b.thread_id)) void this.process(b);
    }
  }

  private async open(c: Connection) {
    const adapter = this.adapters.get(c.adapterId)!;
    c.opening = true;
    c.controller = new AbortController();
    const controller = c.controller;
    const active = () => this.current(c) && c.controller === controller;
    c.state = "connecting";
    try {
      const session = await adapter.open(c.id, {
        signal: c.controller.signal,
        receive: event => active() ? this.receive(c, event) : Promise.reject(new Error("IM connection is no longer active")),
        status: (state) => {
          if (!active()) return;
          c.state = state;
          c.detail = state === "error" ? "Connection failed; check adapter configuration" : undefined;
          if (c.session && (state === "offline" || state === "error")) {
            c.retryAt = Date.now() + Math.min(60_000, this.config.retryMs * 2 ** Math.min(c.attempts++, 6));
            void this.close(c);
          }
        },
        readOutboundFile: id => active() ? this.readFile(c, id) : Promise.reject(new Error("Connection closed"))
      });
      if (!active()) { await session.close(); return; }
      c.session = session;
      c.state = "connected";
      c.detail = undefined;
      c.attempts = 0;
    } catch {
      if (!active()) return;
      c.state = "error";
      c.detail = "Connection failed; check adapter configuration";
      c.retryAt = Date.now() + Math.min(60_000, this.config.retryMs * 2 ** Math.min(c.attempts++, 6));
    } finally { c.opening = false; }
  }

  private routeHash(route: ImRoute) {
    return hash([route, this.settings.connections.find(c => c.id === route.connectionId)]);
  }

  private authorizedBinding(b: Binding): boolean {
    const r = this.settings.routes.find(r => r.id === b.route_id);
    return !!r && this.routeHash(r) === b.route_hash && r.allowedActors.includes(b.actor_id)
      && this.settings.connections.some(c => c.id === b.connection_id && c.enabled);
  }

  private async receive(c: Connection, raw: ImInbound): Promise<{ receiptId: string }> {
    if (!this.current(c)) throw new Error("IM connection is no longer active");
    const event = InboundSchema.parse(raw);
    const id = hash([c.id, event.address.tenantId, event.eventId]);
    const route = this.settings.routes.find(r => r.connectionId === c.id && r.tenantId === event.address.tenantId && r.conversationId === event.address.conversationId);
    const allowed = route && route.allowedActors.includes(event.actor.id) && !event.actor.isBot
      && (event.kind === "action" || (event.activation === "dm" ? route.allowDirectMessages : route.allowGroups));
    if (!allowed) {
      this.ignored.unshift({ at: Date.now(), connectionId: c.id, actorId: event.actor.id, conversationId: event.address.conversationId, reason: "Not authorized or activation disabled" });
      this.ignored = this.ignored.slice(0, 20);
      return { receiptId: `ignored:${id}` };
    }
    const fingerprint = hash(event);
    const messageKey = event.kind === "message" ? hash([c.id, event.address.tenantId, event.address.conversationId, event.messageId]) : null;
    const existing = this.store.get<Inbox>("SELECT * FROM plugin_im_inbox WHERE id = ? OR message_key = ?", id, messageKey);
    if (existing) {
      // A provider may deliver the same message under a new event id; edits never auto-execute.
      if (existing.id === id && existing.fingerprint !== fingerprint) throw new Error("IM event id reused for different content");
      return { receiptId: existing.id };
    }
    const bindingId = hash([c.id, event.address, this.routeHash(route!)]);
    let b = this.store.binding(bindingId);
    if (event.kind === "action" && !b) throw new Error("Invalid or expired IM action");
    if (!b) {
      if (!this.home.projects.get(route!.projectId) || !this.home.db.has(route!.projectId)) throw new Error("IM target project is unavailable");
      const th = this.home.agent.newThread(route!.projectId, route!.engine, route!.boardId, { surface: "assistant" });
      this.store.run("INSERT INTO plugin_im_bindings (id, route_id, route_hash, connection_id, address_json, project_id, thread_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        bindingId, route!.id, this.routeHash(route!), c.id, JSON.stringify(event.address), route!.projectId, th.id, event.actor.id, Date.now());
      b = this.store.binding(bindingId)!;
    }
    this.store.run("INSERT INTO plugin_im_inbox (id, message_key, binding_id, event_json, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, messageKey, b.id, JSON.stringify(event), fingerprint, Date.now());
    return { receiptId: id };
  }

  private async process(b: Binding) {
    this.processing.add(b.thread_id);
    let handling: Inbox | undefined;
    try {
      const rows = this.store.all<Inbox>("SELECT * FROM plugin_im_inbox WHERE binding_id = ? AND state = 'queued' ORDER BY seq", b.id);
      const detail = this.home.agent.thread(b.project_id, b.thread_id);
      const busy = this.home.agent.activeRuns().some(r => r.thread.id === b.thread_id);
      // A control or explicit answer can unblock a run even with ordinary text waiting before it.
      const row = rows.find(row => {
        const e = JSON.parse(row.event_json) as ImInbound;
        return e.kind === "action" || (e.kind === "message" && (/^\/(stop|status)$/.test(e.text.trim()) || /^\/answer\s/.test(e.text.trim())));
      }) ?? (!busy && !detail.pending ? rows[0] : undefined);
      if (!row) return;
      handling = row;
      const event = JSON.parse(row.event_json) as ImInbound;
      if (!this.authorizedBinding(b) || !this.settings.routes.find(r => r.id === b.route_id)?.allowedActors.includes(event.actor.id)) {
        this.store.run("UPDATE plugin_im_inbox SET state = 'ignored' WHERE id = ?", row.id); return;
      }
      const replay = this.home.agent.store.inputReceipt(b.project_id, `im:${row.id}`);
      if (replay) {
        this.store.run("UPDATE plugin_im_inbox SET state = 'accepted', run_id = ? WHERE id = ?", replay.run_id, row.id); return;
      }
      let input: UserInput;
      if (event.kind === "action") {
        input = this.answer(b, event.token, event.actor.id, event.value);
      } else {
        const text = event.text.trim();
        if (text === "/status") {
          this.enqueue(b, `status:${row.id}`, { text: detail.pending ? `等待回答：${detail.pending.question.text}` : busy ? "正在执行" : "当前没有执行中的任务" });
          this.accept(row); return;
        }
        if (text === "/stop") {
          const run = this.home.agent.activeRuns().find(r => r.thread.id === b.thread_id);
          if (run && b.actor_id !== event.actor.id) throw new Error("Only the initiating user can stop this run");
          if (run) this.home.agent.cancel(run.run.id);
          this.store.run("UPDATE plugin_im_inbox SET state = 'cancelled' WHERE binding_id = ? AND state = 'queued' AND id != ?", b.id, row.id);
          this.enqueue(b, `stop:${row.id}`, { text: run ? "已请求停止执行" : "当前没有执行中的任务；已清空等待消息" });
          this.accept(row); return;
        }
        if (text === "/new") {
          if (detail.pending) throw new Error("Answer or stop the current question before opening a new conversation");
          const route = this.settings.routes.find(r => r.id === b.route_id)!;
          const th = this.home.agent.newThread(b.project_id, route.engine, route.boardId);
          this.store.db.transaction(() => {
            this.store.run("UPDATE plugin_im_outbox SET state = 'cancelled' WHERE binding_id = ? AND state = 'queued'", b.id);
            this.store.run("UPDATE plugin_im_actions SET consumed = 1 WHERE binding_id = ?", b.id);
            this.store.run("UPDATE plugin_im_bindings SET thread_id = ?, cursor = 0, actor_id = ? WHERE id = ?", th.id, event.actor.id, b.id);
            this.accept(row);
            this.enqueue(b, `new:${row.id}`, { text: "已开始新会话" });
          });
          return;
        }
        const match = /^\/answer\s+(\S+)(?:\s+([\s\S]+))?$/.exec(text);
        if (match) input = this.answer(b, match[1], event.actor.id, match[2]);
        else {
          if (!text && !event.attachments?.length) throw new Error("Empty message");
          const attachments = [];
          for (const ref of event.attachments ?? []) {
            const c = this.connections.get(b.connection_id);
            const adapter = c && this.adapters.get(c.adapterId);
            if (!adapter?.capabilities.inboundFiles || !c?.session?.download) throw new Error("This adapter does not accept attachments");
            if (ref.size > Math.min(adapter.capabilities.maxFileBytes, MAX_MEDIA_BYTES)) throw new Error("Attachment exceeds supported size");
            let bytes: Uint8Array;
            try { bytes = await deadline(c.session.download(ref), this.config.operationTimeoutMs); }
            catch { throw new Error("Attachment download failed; check adapter diagnostics"); }
            if (!this.current(c) || !this.authorizedBinding(b)) throw new Error("IM authorization changed during download");
            if (bytes.byteLength !== ref.size) throw new Error("Attachment size does not match its metadata");
            attachments.push(this.home.agent.uploadMedia(b.project_id, b.thread_id, { name: ref.name, mime: ref.mimeType, base64: Buffer.from(bytes).toString("base64") }));
          }
          input = { kind: "text", text: event.text, ...(attachments.length ? { attachments } : {}) };
        }
      }
      // Identity is provenance, never a forged human author or a policy bypass.
      const { runId } = this.home.agent.send(b.project_id, b.thread_id, input, { requestId: `im:${row.id}`, source: {
        connection: b.connection_id, tenant: event.address.tenantId, conversation: event.address.conversationId,
        actor: event.actor.id, event: event.eventId
      } });
      if (input.kind === "text") this.store.run("UPDATE plugin_im_bindings SET actor_id = ? WHERE id = ?", event.actor.id, b.id);
      if (input.kind === "answer") this.store.run("UPDATE plugin_im_actions SET consumed = 1 WHERE binding_id = ? AND question_id = ?", b.id, input.questionId);
      this.store.run("UPDATE plugin_im_inbox SET state = 'accepted', run_id = ? WHERE id = ?", runId, row.id);
    } catch (e) {
      if (this.stopped) return;
      // No silent retries of rejected input or stale decisions.
      const row = handling;
      if (row) {
        this.store.run("UPDATE plugin_im_inbox SET state = 'failed', error = ? WHERE id = ?", errorText(e), row.id);
        this.enqueue(b, `input-error:${row.id}`, { text: `无法处理消息：${errorText(e)}` });
      }
    } finally { this.processing.delete(b.thread_id); }
  }

  private accept(row: Inbox) { this.store.run("UPDATE plugin_im_inbox SET state = 'accepted' WHERE id = ?", row.id); }

  private answer(b: Binding, actionToken: string, actorId: string, value?: string | string[]): UserInput {
    const a = this.store.get<Action>("SELECT * FROM plugin_im_actions WHERE token = ?", actionToken);
    const pending = this.home.agent.thread(b.project_id, b.thread_id).pending;
    if (!a || a.binding_id !== b.id || a.thread_id !== b.thread_id || a.actor_id !== actorId || a.expires_at < Date.now() || a.consumed || pending?.question.id !== a.question_id) throw new Error("Question already handled, expired, or not yours to answer");
    let answer = a.value_json === null ? value : JSON.parse(a.value_json) as string;
    if (pending.question.multiple && typeof answer === "string") {
      try { answer = JSON.parse(answer) as string[]; } catch { throw new Error("Reply with a JSON array of selected values"); }
    }
    if (typeof answer !== "string" && (!Array.isArray(answer) || answer.some(v => typeof v !== "string"))) throw new Error("Invalid question answer");
    if (answer === undefined || (Array.isArray(answer) && !pending.question.multiple) ||
      (pending.accepts === "options" && !pending.question.freeText && [answer].flat().some(v => !pending.question.options?.includes(v)))) throw new Error("Invalid question answer");
    return { kind: "answer", questionId: a.question_id, value: answer };
  }

  private project(b: Binding) {
    const detail = this.home.agent.thread(b.project_id, b.thread_id);
    this.store.db.transaction(() => {
      for (const message of detail.messages.filter(m => m.seq > b.cursor)) {
        const content = message.role === "agent" ? this.render(message.block) : null;
        if (content) this.enqueue(b, `message:${b.id}:${message.id}`, content);
        this.store.run("UPDATE plugin_im_bindings SET cursor = ? WHERE id = ?", message.seq, b.id);
      }
      this.pending(b, detail.pending);
      for (const run of detail.runs.filter(r => r.status !== "running")) {
        this.replace(b, `progress:${b.id}:${run.id}`, { text: run.status === "error" ? "执行失败" : run.status === "cancelled" ? "执行已停止" : run.status === "asked" ? "等待你的回答" : "本轮执行结束" });
      }
    });
  }

  private pending(b: Binding, pending: PendingView | null) {
    const previous = this.store.all<Action>("SELECT * FROM plugin_im_actions WHERE binding_id = ? AND consumed = 0", b.id);
    for (const a of previous) if (a.question_id !== pending?.question.id || a.thread_id !== b.thread_id || a.expires_at < Date.now()) {
      this.store.run("UPDATE plugin_im_actions SET consumed = 1 WHERE token = ?", a.token);
      const id = `question:${b.id}:${a.question_id}`;
      const row = this.store.get<Outbox>("SELECT * FROM plugin_im_outbox WHERE id = ?", id);
      if (row && JSON.parse(row.content_json).actions) {
        const text = "问题已处理或失效";
        const adapterId = this.settings.connections.find(c => c.id === b.connection_id)?.adapterId;
        if (adapterId && this.adapters.get(adapterId)?.capabilities.edit) this.replace(b, id, { text });
        else this.enqueue(b, `resolved:${id}`, { text });
      }
    }
    if (!pending) return;
    const id = `question:${b.id}:${pending.question.id}`;
    if (this.store.get("SELECT 1 FROM plugin_im_outbox WHERE id = ?", id)) return;
    const actions: { label: string; token: string }[] = [];
    for (const value of pending.question.options ?? []) {
      if (pending.question.multiple) break;
      const t = token();
      this.store.run("INSERT INTO plugin_im_actions (token, binding_id, thread_id, question_id, actor_id, value_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", t, b.id, b.thread_id, pending.question.id, b.actor_id, JSON.stringify(value), Date.now() + this.config.actionTtlMs);
      actions.push({ label: value, token: t });
    }
    let text = pending.question.text;
    if (pending.accepts === "text" || pending.question.freeText || pending.question.multiple) {
      const t = token();
      this.store.run("INSERT INTO plugin_im_actions (token, binding_id, thread_id, question_id, actor_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)", t, b.id, b.thread_id, pending.question.id, b.actor_id, Date.now() + this.config.actionTtlMs);
      text += `\n请回复 /answer ${t} 你的回答`;
    }
    this.enqueue(b, id, { text, actions });
  }

  private render(block: Block): ImContent | null {
    switch (block.type) {
      case "text": return { text: block.text };
      case "error": return { text: `执行出错：${block.text}` };
      case "note": return { text: block.text };
      case "changes": return { text: block.items?.map(i => `${i.key} · ${i.label} (${i.op})`).join("\n") || `已变更 ${block.count} 项` };
      case "media": return { text: block.caption ?? block.media.name, files: [{ id: block.media.id, name: block.media.name, mimeType: block.media.mime, size: block.media.size }] };
      case "card": return { text: block.title };
      default: return null;
    }
  }

  private onAgentEvent(threadId: string, event: AgentEvent) {
    if (this.stopped) return;
    for (const b of this.store.bindings().filter(b => b.thread_id === threadId && this.authorizedBinding(b))) {
      if (event.type === "progress" || event.type === "delta") {
        const last = this.progressAt.get(b.id) ?? 0;
        const adapterId = this.settings.connections.find(c => c.id === b.connection_id)?.adapterId;
        // Non-editing providers only receive stable output, so token streams don't spam chats.
        if (!adapterId || !this.adapters.get(adapterId)?.capabilities.edit || Date.now() - last < this.config.progressMs) continue;
        this.progressAt.set(b.id, Date.now());
        const text = event.type === "progress" ? event.activity || "正在执行" : "正在生成回复";
        this.replace(b, `progress:${b.id}:${event.runId}`, { text });
      } else if (event.type === "done") {
        this.replace(b, `progress:${b.id}:${event.run.id}`, { text: event.run.status === "error" ? "执行失败" : event.run.status === "cancelled" ? "执行已停止" : event.run.status === "asked" ? "等待你的回答" : "本轮执行结束" });
      }
    }
  }

  private enqueue(b: Binding, id: string, content: ImContent) {
    this.store.run("INSERT OR IGNORE INTO plugin_im_outbox (id, binding_id, content_json, created_at) VALUES (?, ?, ?, ?)", id, b.id, JSON.stringify(content), Date.now());
  }

  private replace(b: Binding, id: string, content: ImContent) {
    this.enqueue(b, id, content);
    // Do not overwrite an in-flight update. Its final status will be projected on the next tick.
    this.store.run("UPDATE plugin_im_outbox SET content_json = ?, state = 'queued', retry_at = 0 WHERE id = ? AND state NOT IN ('sending', 'uncertain', 'failed') AND content_json != ?", JSON.stringify(content), id, JSON.stringify(content));
  }

  private async flush(c: Connection) {
    c.flushing = true;
    try {
      const adapter = this.adapters.get(c.adapterId)!;
      const row = this.store.get<Outbox>(`SELECT o.* FROM plugin_im_outbox o JOIN plugin_im_bindings b ON b.id = o.binding_id
        WHERE b.connection_id = ? AND o.state = 'queued' AND o.retry_at <= ? ORDER BY o.seq LIMIT 1`, c.id, Date.now());
      if (!row) return;
      const b = this.store.binding(row.binding_id)!;
      if (!this.authorizedBinding(b)) { this.store.run("UPDATE plugin_im_outbox SET state = 'cancelled' WHERE id = ?", row.id); return; }
      const content = JSON.parse(row.content_json) as ImContent;
      if (!adapter.capabilities.buttons && content.actions?.length) {
        content.text += "\n" + content.actions.map(a => `${a.label}：/answer ${a.token}`).join("\n");
        delete content.actions;
      }
      if (content.files?.length && (!adapter.capabilities.outboundFiles || content.files.some(f => f.size > adapter.capabilities.maxFileBytes))) {
        content.text += "\n附件请在 Tomrade 会话中查看";
        delete content.files;
      }
      // Chunk once into durable operations so retry does not repeat earlier segments.
      if (content.text.length > adapter.capabilities.maxTextLength) {
        this.store.db.transaction(() => {
          const chunks = splitText(content.text, adapter.capabilities.maxTextLength);
          chunks.forEach((text, i) => this.enqueue(b, `${row.id}:part:${i}`, i === chunks.length - 1 ? { ...content, text } : { text }));
          this.store.run("UPDATE plugin_im_outbox SET state = 'split' WHERE id = ?", row.id);
        });
        return;
      }
      this.store.run("UPDATE plugin_im_outbox SET state = 'sending', attempts = attempts + 1 WHERE id = ?", row.id);
      try {
        const result = await deadline(c.session!.deliver({ operationId: row.id, address: JSON.parse(b.address_json) as ImAddress,
          ...(adapter.capabilities.edit && row.message_id ? { replaceMessageId: row.message_id } : {}), content }), this.config.operationTimeoutMs);
        if (!result.messageId) throw new Error("Adapter returned no message id");
        if (!this.stopped) this.store.run("UPDATE plugin_im_outbox SET state = 'delivered', message_id = ?, error = NULL WHERE id = ?", result.messageId, row.id);
      } catch (e) {
        if (this.stopped) return;
        const disposition = (e as { disposition?: string } | null)?.disposition;
        const retryAfter = (e as { retryAfterMs?: number } | null)?.retryAfterMs;
        this.store.run("UPDATE plugin_im_outbox SET state = ?, error = ?, retry_at = ? WHERE id = ?",
          disposition === "retryable" ? "queued" : disposition === "permanent" ? "failed" : "uncertain",
          "Delivery failed; check adapter diagnostics", Date.now() + (Number.isFinite(retryAfter) ? Math.max(0, retryAfter!) : Math.min(60_000, this.config.retryMs * 2 ** Math.min(row.attempts, 6))), row.id);
      }
    } finally { c.flushing = false; }
  }

  private async readFile(c: Connection, id: string): Promise<Uint8Array> {
    if (!this.current(c)) throw new Error("Connection closed");
    for (const b of this.store.bindings().filter(b => b.connection_id === c.id && this.authorizedBinding(b))) {
      const rows = this.store.all<Outbox>("SELECT * FROM plugin_im_outbox WHERE binding_id = ? AND state = 'sending'", b.id);
      if (!rows.some(r => (JSON.parse(r.content_json) as ImContent).files?.some(f => f.id === id))) continue;
      return Buffer.from(this.home.agent.readMedia(b.project_id, b.thread_id, id).base64, "base64");
    }
    throw new Error("File is not part of this connection's current delivery");
  }
}

function splitText(text: string, max: number): string[] {
  const chunks: string[] = [];
  while (text.length > max) {
    let end = max;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  chunks.push(text);
  return chunks;
}

async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("IM operation timed out; remote outcome unknown")), ms); })]); }
  finally { clearTimeout(timer!); }
}
