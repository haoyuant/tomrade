import { createHash, randomBytes } from "node:crypto";
import { Context, Service } from "cordis";
import type {} from "@tomradex/agent";
import { MAX_MEDIA_BYTES, type AgentEvent, type Block, type PendingView, type UserInput } from "@tomradex/agent";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/settings";
import { resolveImCapabilities, type ImAdapter, type ImAdapterSetup, type ImCapabilities, type Localized, type ImAdapterSession, type ImAddress, type ImCommand, type ImContent, type ImConnectionState, type ImElement, type ImInbound, type ImReaction, type ResolvedImCapabilities } from "@tomradex/plugin-sdk";
import { ImConfig, ImSettings, InboundSchema, type ImConnection, type ImRoute } from "./config.js";
import { fromAdapter, withContext, type ContextLine } from "./context.js";
import { prepare } from "./render.js";
import { FILE_HANDLE, codeNews, codeSeen, links, proposalText, renderBlock, ticket, toolLine, type CodeLookup, type CodeSeen, type ItemLookup, type RenderScope } from "./rich.js";
import { ImStore, MIGRATIONS, TABLES, type Action, type Binding, type Inbox, type Outbox, type Watch, type WindowRow } from "./store.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const token = () => randomBytes(24).toString("hex");
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
/** Platforms drop a typing indicator after a few seconds; refresh it while the run works. */
const TYPING_MS = 4_000;
const PAIR_MS = 10 * 60 * 1000;
/** Wrong codes a connection takes before its pairing code is withdrawn. */
const PAIR_TRIES = 5;

export interface ImConnectionView {
  id: string; adapterId: string; label?: string; state: ImConnectionState | "unconfigured";
  detail?: string; pending: number; uncertain: number; failed: number;
  /** The bot the credentials signed in as, once the adapter has checked them. */
  identity?: { id: string; name?: string };
  /** Required credential fields still empty. */
  missing: string[];
}
/** An adapter as the settings wizard shows it, in the desktop's language. */
export interface ImAdapterView {
  id: string; title: string; capabilities: ImCapabilities;
  setup: { fields: { key: string; label: string; secret: boolean; optional: boolean; placeholder?: string; help?: string }[];
    steps: string[]; permissions: string[]; manifest?: ImAdapterSetup["manifest"]; docsUrl?: string } | null;
}
/** A message that was not let in. Never its text. */
export interface ImIgnoredView {
  id: string; at: number; connectionId: string; tenantId: string; conversationId: string;
  actorId: string; actorName?: string; group: boolean;
  reason: "actor" | "conversation" | "activation" | "bot";
}
export interface ImPairingView {
  connectionId: string; code: string; projectId: string; expiresAt: number;
  /** Who sent the code, waiting for the desktop to confirm. */
  claim?: { tenantId: string; conversationId: string; actorId: string; name?: string; at: number };
}
export interface ImDeliveryView {
  id: string; connectionId: string; conversationId: string; state: "uncertain" | "failed";
  error: string | null; attempts: number; createdAt: number; preview: string;
}
export interface ImThreadBinding {
  id: string; connectionId: string; conversationId: string; group: boolean;
  /** The next desktop turn will reach this group too. */
  shareNext: boolean;
}
/** Something waiting on the person, as the desktop's attention row decided it; reaches them in their direct chat. */
export interface ImReminder {
  projectId: string; threadId: string | null; kind: "permission" | "question" | "waiting" | "stuck";
  title: string; body: string;
}
export interface ImAllowRequest {
  /** An ignored message's id. */
  ignoredId: string;
  /** `person` lets the sender in; `group` opens the conversation to the paired people, and the sender. */
  scope: "person" | "group";
  /** For a conversation with no route yet. */
  projectId?: string;
}
interface Connection {
  id: string; adapterId: string; controller: AbortController;
  session?: ImAdapterSession; opening: boolean; flushing: boolean;
  state: ImConnectionState; detail?: string; retryAt: number; attempts: number;
  /** The credentials it was opened with; a change reopens it. */
  credentials: string;
}
/** The part of `ctx.codeLink` IM uses; code link is optional and never imported. */
interface CodeHost extends CodeLookup { resolve(projectId: string, proposalId: string, accept: boolean): { state: string } }
interface Pairing { connectionId: string; code: string; projectId: string; expiresAt: number; failures: number; claim?: ImPairingView["claim"] }

declare module "cordis" {
  interface Context { im: Im }
  interface Events {
    "im/registered"(id: string): void;
    "im/unregistered"(id: string): void;
    /** Emitted by code link, when it is loaded. */
    "codeLink/changed"(projectId: string): void;
  }
}
declare module "@tomradex/ipc" {
  interface Channels {
    "im.connections": () => ImConnectionView[];
    "im.adapters": () => ImAdapterView[];
    "im.ignored": () => ImIgnoredView[];
    "im.allow": (request: ImAllowRequest) => boolean;
    "im.deliveries": () => ImDeliveryView[];
    /** A person explicitly retries an uncertain operation; it may have reached IM already. */
    "im.retry": (operationId: string) => boolean;
    "im.discard": (operationId: string) => boolean;
    "im.pairings": () => ImPairingView[];
    "im.pairStart": (connectionId: string, projectId: string) => ImPairingView;
    "im.pairConfirm": (connectionId: string) => boolean;
    "im.pairCancel": (connectionId: string) => void;
    /** Takes a paired identity off the connection's allow lists. */
    "im.revoke": (connectionId: string, tenantId: string, actorId: string) => void;
    /** The IM conversations a thread is bound to, for the panel to say where its turns go. */
    "im.threadBindings": (projectId: string, threadId: string) => ImThreadBinding[];
    /** Sends the thread's next desktop turn to a group conversation too, or stops it. */
    "im.shareNext": (bindingId: string, on: boolean) => boolean;
    /** Deletes the group messages kept on this computer, for one route or all of them; returns how many. */
    "im.clearContext": (routeId?: string) => number;
  }
  interface Broadcasts {
    /** Connections, pairings, ignored messages or deliveries changed; the settings panel refetches. */
    "im.changed": () => void;
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
  private readonly caps = new Map<string, ResolvedImCapabilities>();
  private readonly connections = new Map<string, Connection>();
  private readonly processing = new Set<string>();
  private readonly progressAt = new Map<string, number>();
  private readonly progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly typingAt = new Map<string, number>();
  /** The conversations `/sessions` last listed per binding, so `/switch N` means what the person saw. */
  private readonly listed = new Map<string, string[]>();
  /** What each running thread last said it was doing, for `/status`. */
  private readonly activity = new Map<string, string>();
  /** Per running thread: the tools called and the model retry in progress, for its progress message. */
  private readonly turns = new Map<string, { tools: { tool: string; ok: boolean }[]; retry: { attempt: number; max?: number } | null }>();
  /** The reply being streamed per binding and run; the text is what the Agent has written so far. */
  private readonly streams = new Map<string, { id: string; text: string; at: number }>();
  /** Recent sends per binding, for adapters that declare a rate limit. */
  private readonly sentAt = new Map<string, number[]>();
  /** Threads whose history changed since they were last projected. */
  private readonly dirty = new Set<string>();
  private sweptAt = 0;
  private stopped = false;
  private settings: ImSettings = { connections: [], identities: [], routes: [], announcePresence: false };
  /** Connections that have said "online" since this start. */
  private readonly announced = new Set<string>();
  private ignored: ImIgnoredView[] = [];
  private readonly pairings = new Map<string, Pairing>();
  /** The settings panel and the status bar, told when connections, pairings or stuck deliveries change. */
  private readonly watchers = new Set<() => void>();

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
    this.home.on("codeLink/changed", projectId => this.onCode(projectId));
    this.home.inject(["ipc"], ctx => {
      ctx.ipc.handle("im.connections", () => this.views());
      ctx.ipc.handle("im.adapters", () => this.adapterViews());
      ctx.ipc.handle("im.ignored", () => this.ignoredMessages());
      ctx.ipc.handle("im.allow", request => this.allow(request));
      ctx.ipc.handle("im.deliveries", () => this.deliveries());
      ctx.ipc.handle("im.retry", id => this.retry(id));
      ctx.ipc.handle("im.discard", id => this.discard(id));
      ctx.ipc.handle("im.pairings", () => this.pairingViews());
      ctx.ipc.handle("im.pairStart", (connectionId, projectId) => this.pairStart(connectionId, projectId));
      ctx.ipc.handle("im.pairConfirm", connectionId => this.pairConfirm(connectionId));
      ctx.ipc.handle("im.pairCancel", connectionId => { this.pairings.delete(connectionId); this.changed(); });
      ctx.ipc.handle("im.revoke", (connectionId, tenantId, actorId) => this.revoke(connectionId, tenantId, actorId));
      ctx.ipc.handle("im.threadBindings", (projectId, threadId) => this.threadBindings(projectId, threadId));
      ctx.ipc.handle("im.shareNext", (bindingId, on) => this.shareNext(bindingId, on));
      ctx.ipc.handle("im.clearContext", routeId => this.clearContext(routeId));
      const notify = () => ctx.ipc.send("im.changed");
      this.watchers.add(notify);
      return () => { this.watchers.delete(notify); };
    });
    this.home.inject(["contributions"], ctx => {
      const notify = () => ctx.contributions.changed();
      this.watchers.add(notify);
      return () => { this.watchers.delete(notify); };
    });
    this.home.inject(["contributions"], ctx => ctx.contributions.statusItem({ id: "im", icon: "message-circle", opens: "settings:im",
      title: () => this.say("IM connections", "IM 连接"),
      text: () => {
        const views = this.views();
        return views.length ? views.map(v => `${v.id}: ${this.stateWord(v.state)}${v.uncertain ? this.say(` (${v.uncertain} uncertain)`, ` (${v.uncertain} 待确认)`) : ""}`).join(" · ") : null;
      } }));
    this.reload();
    const timer = setInterval(() => this.tick(), this.config.pollMs);
    return async () => {
      this.stopped = true;
      clearInterval(timer);
      for (const pending of this.progressTimers.values()) clearTimeout(pending);
      if (this.settings.announcePresence) await Promise.all([...this.connections.values()].map(c => this.presence(c, false)));
      await Promise.all([...this.connections.values()].map(c => this.close(c)));
      this.connections.clear();
    };
  }

  register(adapter: ImAdapter): () => void {
    if (this.adapters.has(adapter.id)) throw new Error(`IM adapter ${adapter.id} already registered`);
    let caps: ResolvedImCapabilities;
    try { caps = resolveImCapabilities(adapter.capabilities); } catch { throw new Error(`Invalid IM adapter capabilities for ${adapter.id}`); }
    return this.ctx.effect(() => {
      this.adapters.set(adapter.id, adapter);
      this.caps.set(adapter.id, caps);
      this.home.emit("im/registered", adapter.id);
      this.tick();
      this.changed();
      return async () => {
        // At shutdown the adapter's plugin goes first: say goodbye while its connections still stand.
        if (this.settings.announcePresence) await Promise.all([...this.connections.values()].filter(c => c.adapterId === adapter.id).map(c => this.presence(c, false)));
        this.adapters.delete(adapter.id);
        this.caps.delete(adapter.id);
        await Promise.all([...this.connections.values()].filter(c => c.adapterId === adapter.id).map(async c => {
          this.connections.delete(c.id);
          await this.close(c);
        }));
        this.home.emit("im/unregistered", adapter.id);
        this.changed();
      };
    }, `im.register(${adapter.id})`);
  }

  views(): ImConnectionView[] {
    return this.settings.connections.map(spec => {
      const c = this.connections.get(spec.id);
      const counts = this.store.get<{ pending: number; uncertain: number; failed: number }>(`SELECT
        SUM(CASE WHEN o.state IN ('queued', 'sending') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN o.state = 'uncertain' THEN 1 ELSE 0 END) AS uncertain,
        SUM(CASE WHEN o.state = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM plugin_im_outbox o JOIN plugin_im_bindings b ON b.id = o.binding_id WHERE b.connection_id = ?`, spec.id);
      const missing = this.missing(spec);
      const identity = c?.state === "connected" ? c.session?.identity : undefined;
      return { id: spec.id, adapterId: spec.adapterId, ...(spec.label ? { label: spec.label } : {}),
        state: c?.state ?? (this.adapters.has(spec.adapterId) && !missing.length ? "offline" : "unconfigured"),
        detail: c?.detail, pending: counts?.pending ?? 0, uncertain: counts?.uncertain ?? 0, failed: counts?.failed ?? 0,
        ...(identity ? { identity: { id: identity.id, ...(identity.name ? { name: identity.name } : {}) } } : {}), missing };
    });
  }

  adapterViews(): ImAdapterView[] {
    return [...this.adapters.values()].map(a => ({ id: a.id, title: a.title, capabilities: a.capabilities,
      setup: a.setup ? {
        fields: a.setup.fields.map(f => ({ key: f.key, label: this.word(f.label), secret: !!f.secret, optional: !!f.optional,
          ...(f.placeholder ? { placeholder: f.placeholder } : {}), ...(f.help ? { help: this.word(f.help) } : {}) })),
        steps: a.setup.steps.map(step => this.word(step)), permissions: a.setup.permissions ?? [],
        ...(a.setup.manifest ? { manifest: a.setup.manifest } : {}), ...(a.setup.docsUrl ? { docsUrl: a.setup.docsUrl } : {})
      } : null }));
  }

  /** Redacted, bounded diagnostics; rejected message bodies are not retained. */
  ignoredMessages(): ImIgnoredView[] { return this.ignored.map(row => ({ ...row })); }

  deliveries(): ImDeliveryView[] {
    return this.store.all<Outbox & { connection_id: string; address_json: string }>(`SELECT o.*, b.connection_id, b.address_json FROM plugin_im_outbox o
      JOIN plugin_im_bindings b ON b.id = o.binding_id WHERE o.state IN ('uncertain', 'failed') ORDER BY o.seq LIMIT 100`).map(row => ({
      id: row.id, connectionId: row.connection_id, conversationId: (JSON.parse(row.address_json) as ImAddress).conversationId,
      state: row.state as "uncertain" | "failed", error: row.error, attempts: row.attempts, createdAt: row.created_at,
      preview: (JSON.parse(row.content_json) as ImContent).text.slice(0, 120)
    }));
  }

  retry(operationId: string): boolean {
    const done = this.store.run("UPDATE plugin_im_outbox SET state = 'queued', retry_at = 0, error = NULL WHERE id = ? AND state IN ('uncertain', 'failed')", operationId).changes > 0;
    if (done) this.changed();
    return done;
  }

  discard(operationId: string): boolean {
    const done = this.store.run("UPDATE plugin_im_outbox SET state = 'cancelled' WHERE id = ? AND state IN ('uncertain', 'failed')", operationId).changes > 0;
    if (done) this.changed();
    return done;
  }

  pairingViews(): ImPairingView[] {
    return [...this.pairings.values()].filter(p => p.expiresAt > Date.now() || p.claim)
      .map(({ failures: _failures, ...p }) => ({ ...p, ...(p.claim ? { claim: { ...p.claim } } : {}) }));
  }

  /** A one-time code the person sends the bot in a direct message; a new one replaces the last. */
  pairStart(connectionId: string, projectId: string): ImPairingView {
    if (!this.settings.connections.some(c => c.id === connectionId)) throw new Error(`Unknown IM connection ${connectionId}`);
    if (!this.home.projects.get(projectId)) throw new Error(`Unknown project ${projectId}`);
    const code = String(100_000 + (randomBytes(4).readUInt32BE() % 900_000));
    const pairing: Pairing = { connectionId, code, projectId, expiresAt: Date.now() + PAIR_MS, failures: 0 };
    this.pairings.set(connectionId, pairing);
    this.changed();
    return { connectionId, code, projectId, expiresAt: pairing.expiresAt };
  }

  /** Lets the person who sent the code in: their direct chat goes to the chosen project. */
  pairConfirm(connectionId: string): boolean {
    const pairing = this.pairings.get(connectionId);
    const claim = pairing?.claim;
    if (!pairing || !claim) return false;
    this.pairings.delete(connectionId);
    const im = this.snapshot();
    im.identities = [...im.identities.filter(i => !(i.connectionId === connectionId && i.tenantId === claim.tenantId && i.actorId === claim.actorId)),
      { connectionId, tenantId: claim.tenantId, actorId: claim.actorId, ...(claim.name ? { name: claim.name } : {}), pairedAt: Date.now() }];
    this.admit(im, { connectionId, tenantId: claim.tenantId, conversationId: claim.conversationId }, [claim.actorId], "dm", pairing.projectId);
    this.save(im);
    const c = this.connections.get(connectionId);
    if (c) this.tell(c, { tenantId: claim.tenantId, conversationId: claim.conversationId }, "Paired with Tomrade. Send a message to start.", "已与 Tomrade 配对，发消息即可开始。");
    this.changed();
    return true;
  }

  revoke(connectionId: string, tenantId: string, actorId: string) {
    const im = this.snapshot();
    im.identities = im.identities.filter(i => !(i.connectionId === connectionId && i.tenantId === tenantId && i.actorId === actorId));
    im.routes = im.routes.map(r => r.connectionId === connectionId && r.tenantId === tenantId ? { ...r, allowedActors: r.allowedActors.filter(a => a !== actorId) } : r)
      .filter(r => r.allowedActors.length);
    this.save(im);
    this.changed();
  }

  /** One click on an ignored message: the sender, or the group with the paired people in it, may use the assistant there. */
  allow(request: ImAllowRequest): boolean {
    const row = this.ignored.find(r => r.id === request.ignoredId);
    if (!row || row.reason === "bot") return false;
    const im = this.snapshot();
    const where = { connectionId: row.connectionId, tenantId: row.tenantId, conversationId: row.conversationId };
    const paired = im.identities.filter(i => i.connectionId === row.connectionId && i.tenantId === row.tenantId).map(i => i.actorId);
    const actors = request.scope === "group" ? [...new Set([...paired, row.actorId])] : [row.actorId];
    const projectId = request.projectId ?? im.routes.find(r => r.connectionId === row.connectionId && r.tenantId === row.tenantId)?.projectId;
    if (!im.routes.some(r => r.connectionId === where.connectionId && r.tenantId === where.tenantId && r.conversationId === where.conversationId) && !projectId) return false;
    this.admit(im, where, actors, row.group ? "group" : "dm", projectId);
    this.save(im);
    this.ignored = this.ignored.filter(r => !(r.connectionId === row.connectionId && r.tenantId === row.tenantId && r.conversationId === row.conversationId
      && (request.scope === "group" || r.actorId === row.actorId)));
    this.changed();
    return true;
  }

  /** Adds people to a conversation's route, opening the way they wrote in; makes the route when there is none. */
  private admit(im: ImSettings, where: { connectionId: string; tenantId: string; conversationId: string }, actors: string[], kind: "dm" | "group", projectId?: string) {
    const i = im.routes.findIndex(r => r.connectionId === where.connectionId && r.tenantId === where.tenantId && r.conversationId === where.conversationId);
    if (i >= 0) {
      const r = im.routes[i];
      im.routes[i] = { ...r, allowedActors: [...new Set([...r.allowedActors, ...actors])], ...(kind === "dm" ? { allowDirectMessages: true } : { allowGroups: true }) };
      return;
    }
    if (!projectId) throw new Error("Choose a project for this conversation");
    im.routes.push({ id: `${kind}-${hash([where, Date.now()]).slice(0, 12)}`, ...where, projectId, boardId: null, allowedActors: actors,
      allowDirectMessages: kind === "dm", allowGroups: kind === "group", groupActivation: "reply", output: "progress", desktopTurns: true });
  }

  private snapshot(): ImSettings { return structuredClone(ImSettings.parse(this.home.settings.get().im)); }

  private save(im: ImSettings) {
    this.home.settings.set({ ...this.home.settings.get(), im: ImSettings.parse(im) });
  }

  private missing(spec: ImConnection): string[] {
    return (this.adapters.get(spec.adapterId)?.setup?.fields ?? []).filter(f => !f.optional && !spec.credentials[f.key]?.trim()).map(f => f.key);
  }

  /** A word an adapter supplies, in the desktop's language. */
  private word(text: Localized): string {
    return typeof text === "string" ? text : text[this.home.settings.locale()] ?? text.en;
  }

  /** A direct reply outside any conversation, e.g. about pairing. Best effort, never queued. */
  private tell(c: Connection, address: ImAddress, en: string, zh: string) {
    const caps = this.caps.get(c.adapterId);
    if (!caps || !c.session || c.state !== "connected") return;
    const [content] = prepare({ text: this.say(en, zh) }, caps, (a, b) => this.say(a, b));
    this.bestEffort(c.session.deliver({ operationId: `notice:${token()}`, address, content }));
  }

  private changed() { for (const notify of this.watchers) notify(); }

  private say(en: string, zh: string): string { return this.home.settings.locale() === "zh" ? zh : en; }

  /** The plain-text commands, for adapters that register them natively. */
  private commands(): ImCommand[] {
    return [
      { name: "stop", description: this.say("Stop the current run and clear queued messages", "停止当前执行并清空等待消息") },
      { name: "status", description: this.say("Show what the assistant is doing", "查看助手当前状态") },
      { name: "new", description: this.say("Start a new conversation", "开始新会话") },
      { name: "answer", description: this.say("Answer the open question", "回答当前问题"), args: this.say("token answer", "令牌 回答") },
      { name: "steer", description: this.say("Send into the running turn; the assistant reads it after its current step", "插话：送进正在运行的这一轮，助手做完当前这一步就会读到"), args: this.say("message", "内容") },
      { name: "queue", description: this.say("List messages waiting for the current turn", "列出等待当前这一轮结束的消息") },
      { name: "sessions", description: this.say("List this project's recent conversations", "列出本项目最近的会话") },
      { name: "switch", description: this.say("Continue a conversation from /sessions here", "在这里继续 /sessions 中的某个会话"), args: "N" },
      { name: "archive", description: this.say("Archive this conversation and start a new one", "归档当前会话并开始新会话") },
      { name: "engine", description: this.say("Show or change the assistant", "查看或切换助手"), args: this.say("[name]", "[名称]") },
      { name: "model", description: this.say("Show or change the model", "查看或切换模型"), args: this.say("[model]", "[模型]") },
      { name: "effort", description: this.say("Show or change the reasoning effort", "查看或切换推理强度"), args: this.say("[level]", "[强度]") },
      { name: "mode", description: this.say("Show or change the permission mode", "查看或切换权限模式"), args: this.say("[mode]", "[模式]") },
      { name: "unqueue", description: this.say("Withdraw a waiting message", "撤回一条等待中的消息"), args: "N" },
      { name: "help", description: this.say("Show these commands", "显示这些指令") }
    ];
  }

  /** `/help`: every command the conversation takes, from the same list registered natively, and where it goes. */
  private help(b: Binding): string {
    const { thread } = this.home.agent.thread(b.project_id, b.thread_id);
    const engine = this.home.agent.engineOf(thread.engine);
    const project = this.home.projects.get(b.project_id)?.name ?? b.project_id;
    return [
      this.say(`Project: ${project} · Assistant: ${engine?.title ?? thread.engine}`, `项目：${project} · 助手：${engine?.title ?? thread.engine}`),
      ...this.commands().map(c => `/${c.name}${c.args ? ` ${c.args}` : ""} — ${c.description}`),
      engine?.steers ? this.say("Replying to the progress message also steers.", "回复进度消息也算插话。")
        : this.say("This assistant can't take messages mid-turn: /steer queues instead.", "当前助手不支持运行中插话：/steer 会改为排队。")
    ].join("\n");
  }

  private capsOf(b: Binding): ResolvedImCapabilities | undefined {
    const adapterId = this.settings.connections.find(c => c.id === b.connection_id)?.adapterId;
    return adapterId ? this.caps.get(adapterId) : undefined;
  }

  /** A connected session, for best-effort extras that are never queued. */
  private liveSession(b: Binding): ImAdapterSession | undefined {
    const c = this.connections.get(b.connection_id);
    return c && c.state === "connected" && this.current(c) ? c.session : undefined;
  }

  /** Indicators and reactions are cosmetic: a failure is dropped, never retried or surfaced as an error. */
  private bestEffort(work: Promise<unknown>) { void deadline(work, this.config.operationTimeoutMs).catch(() => {}); }

  private react(b: Binding, messageId: string, reaction: ImReaction) {
    const session = this.liveSession(b);
    if (this.capsOf(b)?.reactions && session?.react) this.bestEffort(session.react({ address: JSON.parse(b.address_json) as ImAddress, messageId, reaction }));
  }

  private indicate(b: Binding, state: "typing" | "idle") {
    const session = this.liveSession(b);
    if (!this.capsOf(b)?.typing || !session?.indicate) return;
    const address = JSON.parse(b.address_json) as ImAddress;
    const threadId = address.topicId ?? (b.anchor && this.capsOf(b)?.threads ? b.anchor : undefined);
    this.bestEffort(session.indicate({ address, ...(threadId ? { threadId } : {}), state }));
  }

  private stateWord(state: ImConnectionView["state"]): string {
    switch (state) {
      case "connecting": return this.say("connecting", "连接中");
      case "connected": return this.say("connected", "已连接");
      case "offline": return this.say("disconnected", "已断开");
      case "error": return this.say("connection failed", "连接失败");
      case "unconfigured": return this.say("not configured", "未配置");
    }
  }

  /** A refusal shown to the IM user, in the desktop's language. */
  private refuse(en: string, zh: string): never { throw new Error(this.say(en, zh)); }

  private reload() {
    if (this.stopped) return;
    this.settings = ImSettings.parse(this.home.settings.get().im);
    for (const c of this.connections.values()) {
      const spec = this.settings.connections.find(s => s.id === c.id && s.enabled && s.adapterId === c.adapterId);
      if (!spec || JSON.stringify(spec.credentials) !== c.credentials || this.missing(spec).length) { this.connections.delete(c.id); void this.close(c); }
    }
    for (const id of this.pairings.keys()) if (!this.settings.connections.some(c => c.id === id)) this.pairings.delete(id);
    if (this.store) this.pruneWindow();
    this.tick();
    this.changed();
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
      if (!this.adapters.has(spec.adapterId) || this.missing(spec).length) continue;
      let c = this.connections.get(spec.id);
      if (!c) {
        c = { id: spec.id, adapterId: spec.adapterId, controller: new AbortController(), opening: false, flushing: false, state: "offline", retryAt: 0, attempts: 0,
          credentials: JSON.stringify(spec.credentials) };
        this.connections.set(c.id, c);
      }
      if (!c.session && !c.opening && c.retryAt <= Date.now()) void this.open(c);
      if (c.session && c.state === "connected" && !c.flushing) void this.flush(c);
    }
    const sweep = Date.now() - this.sweptAt >= this.config.sweepMs;
    if (sweep) {
      this.sweptAt = Date.now();
      this.store.prune(Date.now() - this.config.retentionMs);
      this.pruneWindow();
    }
    const dirty = new Set(this.dirty);
    this.dirty.clear();
    for (const b of this.store.bindings()) {
      if (!this.authorizedBinding(b) || !this.home.db.has(b.project_id)) continue;
      if (sweep || dirty.has(b.thread_id)) {
        try { this.project(b); } catch { continue; }
      }
      if (!this.processing.has(b.thread_id) && this.store.get("SELECT 1 FROM plugin_im_inbox WHERE binding_id = ? AND state = 'queued'", b.id)) void this.process(b);
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
      const opening = adapter.open(c.id, {
        signal: c.controller.signal,
        credentials: JSON.parse(c.credentials) as Record<string, string>,
        receive: event => active() ? this.receive(c, event) : Promise.reject(new Error("IM connection is no longer active")),
        status: (state) => {
          if (!active()) return;
          if (c.state !== state) this.changed();
          c.state = state;
          c.detail = state === "error" ? this.say("Connection failed; check adapter configuration", "连接失败，请检查适配器配置") : undefined;
          if (c.session && (state === "offline" || state === "error")) {
            c.retryAt = Date.now() + Math.min(60_000, this.config.retryMs * 2 ** Math.min(c.attempts++, 6));
            void this.close(c);
          }
        },
        readOutboundFile: id => active() ? this.readFile(c, id) : Promise.reject(new Error("Connection closed"))
      });
      void opening.then(session => { if (!active()) return session.close(); }).catch(() => {});
      const session = await deadline(opening, this.config.operationTimeoutMs);
      if (!active()) return;
      c.session = session;
      c.state = "connected";
      c.detail = undefined;
      c.attempts = 0;
      this.changed();
      if (this.settings.announcePresence && !this.announced.has(c.id)) { this.announced.add(c.id); void this.presence(c, true); }
      if (this.caps.get(c.adapterId)?.nativeCommands && session.commands) this.bestEffort(session.commands(this.commands()));
    } catch {
      if (!active()) return;
      c.state = "error";
      c.detail = this.say("Connection failed; check adapter configuration", "连接失败，请检查适配器配置");
      c.retryAt = Date.now() + Math.min(60_000, this.config.retryMs * 2 ** Math.min(c.attempts++, 6));
      controller.abort();
      this.changed();
    } finally { c.opening = false; }
  }

  /** What the conversation is bound to. Who may use it and where it activates are checked live, so editing them keeps the thread. */
  private routeHash(route: ImRoute) {
    return hash([route.id, route.connectionId, route.tenantId, route.conversationId, route.projectId, route.boardId, route.engine ?? null,
      this.settings.connections.find(c => c.id === route.connectionId)?.adapterId,
      // Appended only when set, so routes saved before options keep their threads.
      ...(route.options && Object.keys(route.options).length ? [route.options] : [])]);
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
    const pair = event.kind === "message" && event.activation === "dm" && !event.actor.isBot ? /^\/pair\s+(\d{6})$/.exec(event.text.trim()) : null;
    if (pair) { this.claim(c, event, pair[1]); return { receiptId: `pair:${id}` }; }
    const route = this.settings.routes.find(r => r.connectionId === c.id && r.tenantId === event.address.tenantId && r.conversationId === event.address.conversationId);
    const reason: ImIgnoredView["reason"] | null = event.actor.isBot ? "bot" : !route ? "conversation" : !route.allowedActors.includes(event.actor.id) ? "actor"
      : event.kind === "message" && !activates(route, event.activation) ? "activation" : null;
    if (reason) {
      // What the Agent is not handed as a message of its own may still be the discussion it is asked about.
      if (route && event.kind === "message") this.remember(c, route, event);
      // Ambient group chatter is not addressed to the bot; recording it would bury the messages that were.
      if (event.kind === "message" && event.activation === "ambient" && reason !== "activation") return { receiptId: `ignored:${id}` };
      // Withdrawing or editing a message is not a message to the bot.
      if (event.kind === "retract" || event.kind === "edit") return { receiptId: `ignored:${id}` };
      const group = event.kind === "message" ? event.activation !== "dm" : true;
      this.ignored = [{ id, at: Date.now(), connectionId: c.id, tenantId: event.address.tenantId, conversationId: event.address.conversationId,
        actorId: event.actor.id, ...(event.actor.name ? { actorName: event.actor.name } : {}), group, reason },
        ...this.ignored.filter(r => !(r.connectionId === c.id && r.tenantId === event.address.tenantId && r.conversationId === event.address.conversationId && r.actorId === event.actor.id))].slice(0, 20);
      this.changed();
      return { receiptId: `ignored:${id}` };
    }
    if (event.kind === "retract" || event.kind === "edit") { this.amend(c, event); return { receiptId: `${event.kind}:${id}` }; }
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
      const th = this.openThread(route!);
      this.store.run("INSERT INTO plugin_im_bindings (id, route_id, route_hash, connection_id, address_json, project_id, thread_id, actor_id, created_at, grp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        bindingId, route!.id, this.routeHash(route!), c.id, JSON.stringify(event.address), route!.projectId, th.id, event.actor.id, Date.now(),
        event.kind === "message" ? (event.activation === "dm" ? 0 : 1) : null);
      b = this.store.binding(bindingId)!;
    }
    this.store.run("INSERT INTO plugin_im_inbox (id, message_key, binding_id, event_json, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, messageKey, b.id, JSON.stringify(event), fingerprint, Date.now());
    return { receiptId: id };
  }

  private windowed(route: ImRoute | undefined): route is ImRoute & { groupContext: { enabled: true; messages: number; retentionHours: number } } {
    return !!route?.allowGroups && !!route.groupContext?.enabled;
  }

  /** A group message the Agent was not handed, kept on this computer only where its route turned the window on. */
  private remember(c: Connection, route: ImRoute, event: ImInbound & { kind: "message" }) {
    if (!this.windowed(route) || event.activation === "dm" || event.actor.isBot || !event.text.trim()) return;
    this.store.run("INSERT OR IGNORE INTO plugin_im_window (route_id, place, message_key, message_id, author_json, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      route.id, placeOf(c.id, event.address), hash([c.id, event.address.tenantId, event.address.conversationId, event.messageId]), event.messageId,
      JSON.stringify({ id: event.actor.id, ...(event.actor.name ? { name: event.actor.name } : {}), isBot: false }), event.text, Date.now());
  }

  /** Past retention, beyond the route's count, or no longer turned on: gone. */
  private pruneWindow() {
    const on = this.settings.routes.filter(r => this.windowed(r));
    this.store.db.transaction(() => {
      this.store.run(`DELETE FROM plugin_im_window WHERE route_id NOT IN (${on.map(() => "?").join(", ")})`, ...on.map(r => r.id));
      for (const r of on) {
        this.store.run("DELETE FROM plugin_im_window WHERE route_id = ? AND created_at < ?", r.id, Date.now() - r.groupContext!.retentionHours * 3_600_000);
        this.store.run(`DELETE FROM plugin_im_window WHERE seq IN (SELECT seq FROM (SELECT seq, ROW_NUMBER() OVER (PARTITION BY place ORDER BY seq DESC) AS n
          FROM plugin_im_window WHERE route_id = ?) WHERE n > ?)`, r.id, r.groupContext!.messages);
      }
    });
  }

  clearContext(routeId?: string): number {
    const n = routeId ? this.store.run("DELETE FROM plugin_im_window WHERE route_id = ?", routeId).changes : this.store.run("DELETE FROM plugin_im_window").changes;
    this.changed();
    return n;
  }

  /**
   * The message as the Agent reads it: what it replies to and its thread's
   * first message where the adapter has them, and in a windowed group the
   * discussion since the conversation's last turn, each line with its author.
   */
  private contextual(b: Binding, row: Inbox, event: ImInbound & { kind: "message" }): string {
    const route = this.settings.routes.find(r => r.id === b.route_id);
    const windowed = event.activation !== "dm" && this.windowed(route);
    const place = placeOf(b.connection_id, event.address);
    const line = (w: WindowRow): ContextLine => ({ author: JSON.parse(w.author_json) as ContextLine["author"], text: w.text });
    const given = (role: "quoted" | "root") => event.context?.find(m => m.role === role);
    const kept = event.replyTo && windowed ? this.store.get<WindowRow>("SELECT * FROM plugin_im_window WHERE place = ? AND message_id = ?", place, event.replyTo) : undefined;
    const quotedId = given("quoted")?.messageId ?? kept?.message_id;
    let recent: ContextLine[] = [];
    if (windowed) {
      const since = this.store.get<{ at: number | null }>("SELECT MAX(created_at) AS at FROM plugin_im_inbox WHERE binding_id = ? AND run_id IS NOT NULL AND id != ?", b.id, row.id)?.at ?? 0;
      const from = Math.max(since, Date.now() - route.groupContext.retentionHours * 3_600_000);
      recent = this.store.all<WindowRow>("SELECT * FROM plugin_im_window WHERE place = ? AND created_at > ? AND message_id NOT IN (?, ?) ORDER BY seq DESC LIMIT ?",
        place, from, event.messageId, quotedId ?? "", route.groupContext.messages).reverse().map(line);
    }
    const quoted = given("quoted");
    const root = given("root");
    return withContext(event.text, {
      ...(quoted ? { quoted: fromAdapter(quoted) } : kept ? { quoted: line(kept) } : {}),
      ...(root && root.messageId !== quotedId ? { root: fromAdapter(root) } : {}),
      recent
    }, this.home.settings.locale() === "zh" ? "zh" : "en");
  }

  /** A `/pair` code in a direct chat. The desktop confirms who it was; a wrong code counts toward withdrawing it. */
  private claim(c: Connection, event: ImInbound, code: string) {
    const pairing = this.pairings.get(c.id);
    const address = { tenantId: event.address.tenantId, conversationId: event.address.conversationId };
    if (!pairing || pairing.expiresAt < Date.now() || pairing.claim || pairing.code !== code) {
      if (pairing && !pairing.claim && ++pairing.failures >= PAIR_TRIES) this.pairings.delete(c.id);
      this.tell(c, address, "That pairing code is wrong or has expired. Make a new one in Tomrade's IM settings.", "配对码错误或已过期，请在 Tomrade 的 IM 设置中重新生成。");
      this.changed();
      return;
    }
    pairing.claim = { ...address, actorId: event.actor.id, ...(event.actor.name ? { name: event.actor.name } : {}), at: Date.now() };
    this.tell(c, address, "Code received. Confirm the pairing in Tomrade on your computer.", "已收到配对码，请在电脑上的 Tomrade 中确认配对。");
    this.changed();
  }

  /** A message the person withdrew or edited on the platform. Withdrawing a waiting one keeps it from running; an edit never reruns. */
  private amend(c: Connection, event: ImInbound & { kind: "retract" | "edit" }) {
    const row = this.store.get<Inbox>("SELECT * FROM plugin_im_inbox WHERE message_key = ?", hash([c.id, event.address.tenantId, event.address.conversationId, event.messageId]));
    const b = row && this.store.binding(row.binding_id);
    if (!row || !b || !this.authorizedBinding(b) || (JSON.parse(row.event_json) as ImInbound).actor.id !== event.actor.id) return;
    const original = JSON.parse(row.event_json) as ImInbound;
    const anchor = anchorOf(original);
    if (event.kind === "retract") {
      if (this.store.run("UPDATE plugin_im_inbox SET state = 'cancelled' WHERE id = ? AND state = 'queued'", row.id).changes) {
        this.receipt(b, row, this.say("Withdrawn; it won't run.", "已撤回，不会执行。"), anchor, true);
      }
      return;
    }
    if (row.state !== "queued" && row.state !== "accepted") return;
    this.enqueue(b, `edited:${row.id}:${event.eventId}`, { text: row.state === "queued"
      ? this.say("Edits aren't picked up: the original is still waiting. Withdraw it with /unqueue and send the new version.", "编辑不会生效：原消息仍在等待。用 /unqueue 撤回后重新发送。")
      : this.say("Edits don't rerun a message. Send it again if the change should count.", "编辑不会重新执行消息。需要按新内容执行请重新发送。") }, { anchor });
  }

  /** A waiting message's receipt: kept current in place where the platform edits; elsewhere the first one stands and a withdrawal is said once. */
  private receipt(b: Binding, row: Inbox, text: string, anchor: string | null, final = false) {
    const id = `queued:${row.id}`;
    if (this.capsOf(b)?.edit) {
      this.enqueue(b, id, { text }, { anchor });
      this.replace(b, id, { text });
    } else this.enqueue(b, final ? `withdrawn:${row.id}` : id, { text }, { anchor });
  }

  /** Ordinary messages waiting behind a running turn or an open question, oldest first. */
  private waiting(rows: Inbox[]): Inbox[] {
    return rows.filter(row => {
      const e = JSON.parse(row.event_json) as ImInbound;
      return e.kind === "message" && !isControl(row, e);
    });
  }

  /** The messages a reply can quote to steer: what the running turn is showing. */
  private progressMessages(b: Binding, runId: string): string[] {
    return this.store.all<Outbox>("SELECT * FROM plugin_im_outbox WHERE binding_id = ? AND (id = ? OR id LIKE ?)", b.id, `progress:${b.id}:${runId}`, `stream:${b.id}:${runId}:%`)
      .flatMap(o => JSON.parse(o.message_ids_json) as string[]);
  }

  private async process(b: Binding) {
    this.processing.add(b.thread_id);
    let handling: Inbox | undefined;
    try {
      const rows = this.store.all<Inbox>("SELECT * FROM plugin_im_inbox WHERE binding_id = ? AND state = 'queued' ORDER BY seq", b.id);
      const detail = this.home.agent.thread(b.project_id, b.thread_id);
      const busy = this.home.agent.activeRuns().some(r => r.thread.id === b.thread_id);
      const running = this.home.agent.activeRuns().find(r => r.thread.id === b.thread_id);
      const progress = running ? this.progressMessages(b, running.run.id) : [];
      // Replying to what the running turn shows is a steer, like /steer.
      const steering = (e: ImInbound) => !!running && e.kind === "message" && !!e.replyTo && progress.includes(e.replyTo);
      // A control or explicit answer can unblock a run even with ordinary text waiting before it.
      const row = rows.find(row => {
        const e = JSON.parse(row.event_json) as ImInbound;
        return e.kind === "action" || (e.kind === "message" && (isControl(row, e) || (!row.input_json && steering(e))));
      }) ?? (!busy && !detail.pending ? rows[0] : undefined);
      if (busy || detail.pending) {
        const queue = this.waiting(rows).filter(r => r !== row);
        for (const [i, q] of queue.entries()) {
          this.receipt(b, q, detail.pending && !busy
            ? this.say(`Waiting (${i + 1} in line) for the open question to be answered. /queue lists, /unqueue ${i + 1} withdraws.`, `排队中（第 ${i + 1} 位），等待先回答当前问题。/queue 查看，/unqueue ${i + 1} 撤回。`)
            : this.say(`Queued (${i + 1} in line); it runs after the current turn. /queue lists, /unqueue ${i + 1} withdraws.`, `已排队（第 ${i + 1} 位），本轮结束后执行。/queue 查看，/unqueue ${i + 1} 撤回。`),
            anchorOf(JSON.parse(q.event_json) as ImInbound));
        }
      }
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
      // Withdrawals and edits are handled as they arrive and never queued; an old row is only settled.
      if (event.kind === "retract" || event.kind === "edit") { this.accept(row); return; }
      const reply = { anchor: anchorOf(event) };
      let input: UserInput;
      if (event.kind === "action") {
        if (this.remoteAnswer(b, row, event.token, event.actor.id, event.value)) return;
        const cmd = this.commandOf(b, event.token, event.actor.id);
        if (cmd) { await this.choose(b, row, event.actor.id, cmd.kind, cmd.value ?? String([event.value ?? ""].flat()[0] ?? ""), reply); return; }
        input = this.answer(b, event.token, event.actor.id, event.value);
      } else {
        const text = event.text.trim();
        const queue = this.waiting(rows).filter(r => r !== row);
        if (text === "/status") {
          const doing = this.activity.get(b.thread_id);
          const lines = [detail.pending ? this.say(`Waiting for answer: ${detail.pending.question.text}`, `等待回答：${detail.pending.question.text}`)
            : busy ? (doing ? this.say(`Working: ${doing}`, `正在执行：${doing}`) : this.say("Working", "正在执行")) : this.say("No task is running", "当前没有执行中的任务")];
          if (queue.length) lines.push(this.say(`${queue.length} waiting`, `${queue.length} 条等待中`));
          this.enqueue(b, `status:${row.id}`, { text: lines.join("\n") }, reply);
          this.accept(row); return;
        }
        if (text === "/help") {
          this.enqueue(b, `help:${row.id}`, { text: this.help(b) }, reply);
          this.accept(row); return;
        }
        if (text === "/queue") {
          this.enqueue(b, `queue:${row.id}`, { text: queue.length
            ? queue.map((q, i) => `${i + 1}. ${preview(q)}`).join("\n")
            : this.say("Nothing is waiting", "没有等待中的消息") }, reply);
          this.accept(row); return;
        }
        const unqueue = /^\/unqueue\s+(\d+)$/.exec(text);
        if (unqueue) {
          const target = queue[Number(unqueue[1]) - 1];
          if (!target) this.refuse(`No waiting message ${unqueue[1]}; /queue lists them`, `没有第 ${unqueue[1]} 条等待中的消息；/queue 可查看`);
          if ((JSON.parse(target.event_json) as ImInbound).actor.id !== event.actor.id) this.refuse("Only its sender can withdraw that message", "只有发送人可以撤回这条消息");
          this.store.run("UPDATE plugin_im_inbox SET state = 'cancelled' WHERE id = ? AND state = 'queued'", target.id);
          if (this.capsOf(b)?.edit) this.receipt(b, target, this.say("Withdrawn; it won't run.", "已撤回，不会执行。"), anchorOf(JSON.parse(target.event_json) as ImInbound), true);
          this.enqueue(b, `unqueue:${row.id}`, { text: this.say(`Withdrawn: ${preview(target)}`, `已撤回：${preview(target)}`) }, reply);
          this.accept(row); return;
        }
        const steer = /^\/steer\s+([\s\S]+)$/.exec(text)?.[1].trim() ?? (!row.input_json && steering(event) ? text : null);
        if (steer !== null && running) {
          const engine = this.home.agent.engineOf(running.thread.engine);
          if (engine?.steers && await this.home.agent.steer(b.project_id, b.thread_id, `im:${row.id}`, steer)) {
            this.react(b, event.messageId, "received");
            if (!this.capsOf(b)?.reactions) this.enqueue(b, `steered:${row.id}`, { text: this.say("Sent into the current turn", "已送进当前这一轮") }, reply);
            this.accept(row); return;
          }
          // Not taken: it waits for the turn to end like any message, and says so.
          this.store.run("UPDATE plugin_im_inbox SET input_json = ? WHERE id = ?", JSON.stringify({ kind: "text", text: steer }), row.id);
          this.enqueue(b, `steer-queued:${row.id}`, { text: engine?.steers
            ? this.say("The turn couldn't take it right now; it's queued and runs after this turn.", "当前这一轮暂时无法接收，已改为排队，本轮结束后执行。")
            : this.say("This assistant can't take messages mid-turn; it's queued and runs after this turn.", "当前助手不支持运行中插话，已改为排队，本轮结束后执行。") }, reply);
          return;
        }
        if (text === "/stop") {
          const run = this.home.agent.activeRuns().find(r => r.thread.id === b.thread_id);
          if ((run || detail.pending) && b.actor_id !== event.actor.id) this.refuse("Only the initiating user can stop this run", "只有发起人可以停止当前执行");
          const stopped = run ? this.home.agent.cancel(run.run.id) : this.home.agent.cancelWaiting(b.project_id, b.thread_id);
          this.store.run("UPDATE plugin_im_inbox SET state = 'cancelled' WHERE binding_id = ? AND state = 'queued' AND id != ?", b.id, row.id);
          this.enqueue(b, `stop:${row.id}`, { text: stopped ? this.say("Stop requested", "已请求停止执行") : this.say("No task is running; queued messages cleared", "当前没有执行中的任务；已清空等待消息") }, reply);
          this.accept(row); return;
        }
        if (text === "/new") {
          if (detail.pending) this.refuse("Answer or stop the current question before opening a new conversation", "请先回答或停止当前问题，再开始新会话");
          const th = this.openThread(this.settings.routes.find(r => r.id === b.route_id)!);
          this.rebind(b, th.id, 0, event.actor.id, rebound => {
            this.accept(row);
            this.enqueue(rebound, `new:${row.id}`, { text: this.say("New conversation started", "已开始新会话") }, reply);
          });
          return;
        }
        if (await this.option(b, row, event, text, reply)) return;
        const match = /^\/answer\s+(\S+)(?:\s+([\s\S]+))?$/.exec(text);
        if (match && this.remoteAnswer(b, row, match[1], event.actor.id, match[2])) return;
        const cmd = match && this.commandOf(b, match[1], event.actor.id);
        if (cmd) { await this.choose(b, row, event.actor.id, cmd.kind, cmd.value ?? match![2]?.trim() ?? "", reply); return; }
        if (match) input = this.answer(b, match[1], event.actor.id, match[2]);
        else {
          if (!text && !event.attachments?.length) this.refuse("Empty message", "消息为空");
          if (row.input_json) input = JSON.parse(row.input_json) as UserInput;
          else if (steer !== null) input = { kind: "text", text: steer };
          else {
          const attachments = [];
          for (const ref of event.attachments ?? []) {
            const c = this.connections.get(b.connection_id);
            const adapter = c && this.adapters.get(c.adapterId);
            if (!adapter?.capabilities.inboundFiles || !c?.session?.download) this.refuse("This adapter does not accept attachments", "该渠道不支持附件");
            if (ref.size > Math.min(adapter.capabilities.maxFileBytes, MAX_MEDIA_BYTES)) this.refuse("Attachment exceeds supported size", "附件超过支持的大小");
            let bytes: Uint8Array;
            try { bytes = await deadline(c.session.download(ref), this.config.operationTimeoutMs); }
            catch { this.refuse("Attachment download failed; check adapter diagnostics", "附件下载失败，请检查适配器诊断信息"); }
            if (!this.current(c) || !this.authorizedBinding(b)) this.refuse("IM authorization changed during download", "下载期间 IM 授权已变更");
            if (bytes.byteLength !== ref.size) this.refuse("Attachment size does not match its metadata", "附件大小与声明不符");
            attachments.push(this.home.agent.uploadMedia(b.project_id, b.thread_id, { name: ref.name, mime: ref.mimeType, base64: Buffer.from(bytes).toString("base64") }));
          }
          input = { kind: "text", text: this.contextual(b, row, event), ...(attachments.length ? { attachments } : {}) };
          this.store.run("UPDATE plugin_im_inbox SET input_json = ? WHERE id = ?", JSON.stringify(input), row.id);
          }
        }
      }
      // A desktop turn may have started while attachment bytes were being downloaded.
      if (input.kind === "text" && (this.home.agent.activeRuns().some(r => r.thread.id === b.thread_id) || this.home.agent.thread(b.project_id, b.thread_id).pending)) return;
      // Identity is provenance, never a forged human author or a policy bypass.
      const { runId } = this.home.agent.send(b.project_id, b.thread_id, input, { requestId: `im:${row.id}`, source: {
        connection: b.connection_id, tenant: event.address.tenantId, conversation: event.address.conversationId,
        actor: event.actor.id, event: event.eventId
      } });
      if (input.kind === "text") this.store.run("UPDATE plugin_im_bindings SET actor_id = ?, anchor = ? WHERE id = ?", event.actor.id, reply.anchor, b.id);
      if (event.kind === "message") this.react(b, event.messageId, "received");
      if (input.kind === "text" && this.capsOf(b)?.edit && this.store.get("SELECT 1 FROM plugin_im_outbox WHERE id = ?", `queued:${row.id}`)) {
        this.replace(b, `queued:${row.id}`, { text: this.say("Running now", "正在执行") });
      }
      if (input.kind === "answer") this.store.run("UPDATE plugin_im_actions SET consumed = 1 WHERE binding_id = ? AND question_id = ?", b.id, input.questionId);
      this.store.run("UPDATE plugin_im_inbox SET state = 'accepted', run_id = ? WHERE id = ?", runId, row.id);
      this.store.run("INSERT OR IGNORE INTO plugin_im_runs (binding_id, run_id) VALUES (?, ?)", b.id, runId);
    } catch (e) {
      if (this.stopped) return;
      // No silent retries of rejected input or stale decisions.
      const row = handling;
      if (row) {
        this.store.run("UPDATE plugin_im_inbox SET state = 'failed', error = ? WHERE id = ?", errorText(e), row.id);
        const event = JSON.parse(row.event_json) as ImInbound;
        const anchor = anchorOf(event);
        // In a group, a refusal is for the sender only where the platform can say so privately.
        if (this.authorizedBinding(b)) this.enqueue(b, `input-error:${row.id}`, { text: this.say(`Cannot process message: ${errorText(e)}`, `无法处理消息：${errorText(e)}`) },
          { anchor, visibleTo: anchor ? event.actor.id : null });
      }
    } finally { this.processing.delete(b.thread_id); }
  }

  /**
   * Whether a turn shows in this IM conversation. Its own turns always do. A
   * direct chat also shows turns started on the desktop unless the route says
   * not to; a group shows them only when the desktop shared that turn.
   */
  private visible(b: Binding, runId: string | null): boolean {
    if (runId && (this.store.get("SELECT 1 FROM plugin_im_runs WHERE binding_id = ? AND run_id = ?", b.id, runId)
      || this.store.get("SELECT 1 FROM plugin_im_inbox WHERE binding_id = ? AND run_id = ?", b.id, runId))) return true;
    if (this.isGroup(b)) return false;
    return this.settings.routes.find(r => r.id === b.route_id)?.desktopTurns !== false;
  }

  /** The first sight of a turn after the desktop chose to share its next one with this group. */
  private claimShared(b: Binding, runId: string) {
    if (!b.share_next || this.store.get("SELECT 1 FROM plugin_im_inbox WHERE binding_id = ? AND run_id = ?", b.id, runId)) return;
    this.store.db.transaction(() => {
      this.store.run("INSERT OR IGNORE INTO plugin_im_runs (binding_id, run_id) VALUES (?, ?)", b.id, runId);
      this.store.run("UPDATE plugin_im_bindings SET share_next = 0 WHERE id = ?", b.id);
    });
    b.share_next = 0;
    this.changed();
  }

  threadBindings(projectId: string, threadId: string): ImThreadBinding[] {
    return this.store.bindings().filter(b => b.project_id === projectId && b.thread_id === threadId && this.authorizedBinding(b)).map(b => ({
      id: b.id, connectionId: b.connection_id, conversationId: (JSON.parse(b.address_json) as ImAddress).conversationId,
      group: this.isGroup(b), shareNext: !!b.share_next
    }));
  }

  shareNext(bindingId: string, on: boolean): boolean {
    const b = this.store.binding(bindingId);
    if (!b || !this.authorizedBinding(b) || !this.isGroup(b)) return false;
    this.store.run("UPDATE plugin_im_bindings SET share_next = ? WHERE id = ?", on ? 1 : 0, b.id);
    this.changed();
    return true;
  }

  /** A direct chat of this person on this connection, where reminders reach them. */
  private directChat(connectionId: string, actorId: string): Binding | undefined {
    return this.store.bindings().find(x => x.connection_id === connectionId && x.actor_id === actorId && !this.isGroup(x) && this.authorizedBinding(x));
  }

  /**
   * Something waits on the person while they are away from the desktop: a
   * question or approval with its buttons, or a failure, in their direct chat.
   * Nothing is sent where that conversation already shows the turn. True when
   * it reached someone.
   */
  remind(n: ImReminder): boolean {
    if (!n.threadId || (n.kind !== "permission" && n.kind !== "question" && n.kind !== "stuck") || !this.home.db.has(n.projectId)) return false;
    const detail = this.home.agent.thread(n.projectId, n.threadId);
    const runId = detail.runs.at(-1)?.id ?? null;
    const bound = this.store.bindings().filter(b => b.thread_id === n.threadId && this.authorizedBinding(b));
    if (bound.some(b => !this.isGroup(b) && this.visible(b, runId))) return false;
    // Whoever started the IM conversation, or everyone who paired with the desktop for a thread only the desktop knows.
    const people = bound.length ? bound.map(b => [b.connection_id, b.actor_id] as const)
      : this.settings.identities.map(i => [i.connectionId, i.actorId] as const);
    const pending = n.kind === "stuck" ? null : detail.pending;
    let reached = false;
    for (const [connectionId, actorId] of new Map(people.map(p => [p.join("\u0000"), p])).values()) {
      const dm = this.directChat(connectionId, actorId);
      if (!dm) continue;
      const head = `**${n.title}**${n.body ? `\n${n.body}` : ""}\n[${this.say("Open in Tomrade", "在 Tomrade 打开")}](${links.thread(n.projectId, n.threadId)})`;
      const content: ImContent = pending ? this.remoteQuestion(dm, n.projectId, n.threadId, pending, actorId, head) : { text: head };
      this.enqueue(dm, `remind:${dm.id}:${n.threadId}:${pending?.question.id ?? `${n.kind}:${runId}`}`, content, { anchor: null });
      reached = true;
    }
    return reached;
  }

  /** A waiting question of another conversation, answerable from here by the person it was sent to. */
  private remoteQuestion(dm: Binding, projectId: string, threadId: string, pending: PendingView, actorId: string, head: string): ImContent {
    const issue = (value: string | null) => {
      const t = token();
      this.store.run("INSERT INTO plugin_im_actions (token, binding_id, thread_id, question_id, actor_id, run_id, value_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        t, dm.id, threadId, `remind:${projectId}:${pending.question.id}`, actorId, value === null ? null : JSON.stringify(value), Date.now() + this.config.actionTtlMs, Date.now());
      return t;
    };
    const { question } = pending;
    const options = question.options ?? [];
    const actions = question.multiple ? [] : options.map(value => ({ label: value, token: issue(value) }));
    const elements: ImElement[] = [];
    if (question.multiple && options.length) elements.push({ type: "select", token: issue(null), multiple: true, options: options.map(o => ({ label: o, value: o })) });
    if (question.freeText || (pending.accepts === "text" && !options.length)) elements.push({ type: "input", token: issue(null), label: this.say("Your answer", "你的回答") });
    return { text: `${head}\n\n${question.text}`, actions, ...(elements.length ? { elements } : {}) };
  }

  /** An answer from a reminder's buttons. True when the token was a reminder's. */
  private remoteAnswer(b: Binding, row: Inbox, actionToken: string, actorId: string, value?: string | string[]): boolean {
    const a = this.store.get<Action>("SELECT * FROM plugin_im_actions WHERE token = ?", actionToken);
    const [, projectId, questionId] = /^remind:([^:]+):(.+)$/.exec(a?.question_id ?? "") ?? [];
    if (!a || !projectId) return false;
    const pending = this.home.db.has(projectId) ? this.home.agent.thread(projectId, a.thread_id).pending : null;
    if (a.binding_id !== b.id || a.actor_id !== actorId || a.expires_at < Date.now() || a.consumed || pending?.question.id !== questionId) {
      this.refuse("Question already handled, expired, or not yours to answer", "问题已处理、已失效，或不由你回答");
    }
    let answer: unknown = a.value_json === null ? value : JSON.parse(a.value_json);
    if (pending.question.multiple && typeof answer === "string") {
      try { answer = JSON.parse(answer); } catch { this.refuse("Reply with a JSON array of selected values", "请用 JSON 数组回复所选的值"); }
    }
    const options = pending.question.options ?? [];
    const valid = pending.question.multiple
      ? Array.isArray(answer) && answer.every(v => typeof v === "string" && (pending.question.freeText || options.includes(v)))
      : typeof answer === "string" && (pending.accepts === "text" || pending.question.freeText || options.includes(answer));
    if (!valid) this.refuse("Invalid question answer", "回答无效");
    const event = JSON.parse(row.event_json) as ImInbound;
    this.home.agent.send(projectId, a.thread_id, { kind: "answer", questionId, value: answer as string | string[] }, { requestId: `im:${row.id}`, source: {
      connection: b.connection_id, tenant: event.address.tenantId, conversation: event.address.conversationId, actor: actorId, event: event.eventId
    } });
    this.store.run("UPDATE plugin_im_actions SET consumed = 1, retired = 1 WHERE binding_id = ? AND question_id = ?", b.id, a.question_id);
    const said = Array.isArray(answer) ? answer.join(", ") : String(answer);
    this.enqueue(b, `remind-answered:${row.id}`, { text: this.say(`Answered: ${said}`, `已回答：${said}`) }, { anchor: null });
    this.accept(row);
    return true;
  }

  /** "Online" or "going offline" in each direct chat on the connection; best effort. */
  private async presence(c: Connection, online: boolean) {
    const caps = this.caps.get(c.adapterId);
    if (!caps || !c.session || c.state !== "connected") return;
    const chats = new Map(this.store.bindings().filter(b => b.connection_id === c.id && !this.isGroup(b) && this.authorizedBinding(b))
      .map(b => [b.address_json, JSON.parse(b.address_json) as ImAddress]));
    const text = online
      ? this.say("Tomrade is online on your computer.", "电脑上的 Tomrade 已上线。")
      : this.say("Tomrade is going offline on your computer. Messages sent while it is offline may not arrive; send them again once it is back.", "电脑上的 Tomrade 即将下线。离线期间发的消息可能收不到，上线后请重新发送。");
    const [content] = prepare({ text }, caps, (en, zh) => this.say(en, zh));
    await Promise.all([...chats.values()].map(address =>
      deadline(c.session!.deliver({ operationId: `presence:${token()}`, address, content }), Math.min(2_000, this.config.operationTimeoutMs)).catch(() => {})));
  }

  /** A new conversation the way the route opens one: its engine, options and permission mode. */
  private openThread(route: ImRoute) {
    const th = this.home.agent.newThread(route.projectId, route.engine, route.boardId, { surface: "assistant", ...(route.options ? { options: route.options } : {}) });
    if (route.permissionMode) {
      try { this.home.agent.setPermissionMode(route.projectId, th.id, route.permissionMode); } catch { /* the engine changed since the route was saved; its default applies */ }
    }
    return th;
  }

  /** Points the IM conversation at another thread. Only what that thread says from now on is sent; its history stays on the desktop. */
  private rebind(b: Binding, threadId: string, cursor: number, actorId: string, also: (rebound: Binding) => void) {
    this.store.db.transaction(() => {
      this.store.run("UPDATE plugin_im_outbox SET state = 'cancelled' WHERE binding_id = ? AND state IN ('queued', 'uncertain', 'failed')", b.id);
      this.store.run("UPDATE plugin_im_actions SET consumed = 1, retired = 1 WHERE binding_id = ?", b.id);
      this.store.run("UPDATE plugin_im_bindings SET thread_id = ?, cursor = ?, actor_id = ?, anchor = NULL WHERE id = ?", threadId, cursor, actorId, b.id);
      // What says so goes out on the new thread; one queued on the old would be dropped as stale.
      also(this.store.binding(b.id)!);
    });
    this.listed.delete(b.id);
  }

  /** A button or select a command offered; only the person it was offered to can use it. */
  private offer(b: Binding, kind: string, actorId: string): string {
    const t = token();
    this.store.run("INSERT INTO plugin_im_actions (token, binding_id, thread_id, question_id, actor_id, run_id, value_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
      t, b.id, b.thread_id, `cmd:${kind}`, actorId, Date.now() + this.config.actionTtlMs, Date.now());
    return t;
  }

  /** A button that carries its own value, as a select's option would. */
  private offerValue(b: Binding, kind: string, actorId: string, value: string): string {
    const t = this.offer(b, kind, actorId);
    this.store.run("UPDATE plugin_im_actions SET value_json = ? WHERE token = ?", JSON.stringify(value), t);
    return t;
  }

  /** The command an offered token stands for, and the value it carries, or null when the token is a question's. */
  private commandOf(b: Binding, actionToken: string, actorId: string): { kind: string; value?: string } | null {
    const a = this.store.get<Action>("SELECT * FROM plugin_im_actions WHERE token = ?", actionToken);
    if (!a?.question_id.startsWith("cmd:")) return null;
    if (a.binding_id !== b.id || a.thread_id !== b.thread_id || a.actor_id !== actorId || a.expires_at < Date.now() || a.consumed) {
      this.refuse("That choice has expired or isn't yours", "该选项已失效，或不由你选择");
    }
    this.store.run("UPDATE plugin_im_actions SET consumed = 1, retired = 1 WHERE token = ?", actionToken);
    return { kind: a.question_id.slice("cmd:".length), ...(a.value_json ? { value: JSON.parse(a.value_json) as string } : {}) };
  }

  /** Whether this conversation is a group: its people see whatever the bound thread says. */
  private isGroup(b: Binding): boolean {
    if (b.grp !== null && b.grp !== undefined) return b.grp === 1;
    const last = this.store.all<Inbox>("SELECT * FROM plugin_im_inbox WHERE binding_id = ? ORDER BY seq DESC LIMIT 20", b.id)
      .map(r => JSON.parse(r.event_json) as ImInbound).find(e => e.kind === "message");
    return last?.kind === "message" && last.activation !== "dm";
  }

  /** A list to pick from: numbered text everywhere, and a select where the platform has one. */
  private choices(b: Binding, id: string, actorId: string, kind: string, text: string, options: { label: string; value: string }[], reply: { anchor: string | null }) {
    const select = this.capsOf(b)?.select && options.length
      ? [{ type: "select" as const, token: this.offer(b, kind, actorId), options: options.slice(0, 24) }] : [];
    this.enqueue(b, id, { text, ...(select.length ? { elements: select } : {}) }, { ...reply, visibleTo: reply.anchor ? actorId : null });
  }

  /** `/sessions`, `/switch`, `/archive`, `/engine`, `/model`, `/effort`, `/mode`. True when the message was one. */
  private async option(b: Binding, row: Inbox, event: ImInbound & { kind: "message" }, text: string, reply: { anchor: string | null }): Promise<boolean> {
    const [, name, arg = ""] = /^\/(sessions|switch|archive|engine|model|effort|mode)(?:\s+([\s\S]+))?$/.exec(text) ?? [];
    if (!name) return false;
    const actor = event.actor.id;
    const { thread } = this.home.agent.thread(b.project_id, b.thread_id);
    if (name === "sessions") {
      const threads = this.home.agent.store.threads(b.project_id, "assistant").slice(0, 20);
      this.listed.set(b.id, threads.map(t => t.id));
      const running = new Set(this.home.agent.activeRuns().map(r => r.thread.id));
      const lines = threads.map((t, i) => `${i + 1}. ${t.title || this.say("Untitled", "未命名")} · ${this.home.agent.engineOf(t.engine)?.title ?? t.engine} · ${this.ago(t.updatedAt)}`
        + (t.id === b.thread_id ? this.say(" ← here", " ← 当前") : running.has(t.id) ? this.say(" · running", " · 运行中") : ""));
      this.choices(b, `sessions:${row.id}`, actor, "switch", lines.length
        ? [...lines, this.say("Reply /switch N to continue one here.", "回复 /switch N 在这里继续该会话。")].join("\n")
        : this.say("No conversations yet", "还没有会话"),
        threads.filter(t => t.id !== b.thread_id).map(t => ({ label: t.title || this.say("Untitled", "未命名"), value: t.id })), reply);
      this.accept(row); return true;
    }
    if (name === "switch") {
      const [, n, confirm] = /^(\d+)(\s+confirm)?$/i.exec(arg.trim()) ?? [];
      const ids = this.listed.get(b.id) ?? this.home.agent.store.threads(b.project_id, "assistant").slice(0, 20).map(t => t.id);
      const target = n ? ids[Number(n) - 1] : undefined;
      if (!target) this.refuse("Pick a number from /sessions", "请从 /sessions 的列表里选一个序号");
      await this.choose(b, row, actor, confirm ? "switch!" : "switch", target, reply, n);
      return true;
    }
    if (name === "archive") {
      if (this.home.agent.activeRuns().some(r => r.thread.id === b.thread_id) || this.home.agent.thread(b.project_id, b.thread_id).pending) {
        this.refuse("Stop the current turn or answer its question before archiving", "请先停止当前执行或回答问题，再归档");
      }
      this.home.agent.archiveThread(b.project_id, b.thread_id);
      const th = this.openThread(this.settings.routes.find(r => r.id === b.route_id)!);
      this.rebind(b, th.id, 0, actor, rebound => {
        this.accept(row);
        this.enqueue(rebound, `archive:${row.id}`, { text: this.say(`Archived “${thread.title || "Untitled"}”; new conversation started`, `已归档“${thread.title || "未命名"}”，已开始新会话`) }, reply);
      });
      return true;
    }
    const engine = this.home.agent.engineOf(thread.engine);
    if (name === "engine") {
      if (!arg) {
        const views = (await this.home.agent.engineViews()).filter(v => v.ok && !v.terminalOnly);
        this.choices(b, `engine:${row.id}`, actor, "engine",
          [this.say(`Assistant: ${engine?.title ?? thread.engine}`, `当前助手：${engine?.title ?? thread.engine}`), ...views.map(v => `- ${v.title} (${v.id})`), this.say("Reply /engine <name> to switch.", "回复 /engine <名称> 切换。")].join("\n"),
          views.filter(v => v.id !== thread.engine).map(v => ({ label: v.title, value: v.id })), reply);
        this.accept(row); return true;
      }
      await this.choose(b, row, actor, "engine", arg.trim(), reply); return true;
    }
    if (name === "mode") {
      const modes = engine?.permissionModes;
      if (!modes) this.refuse("This assistant has no permission modes", "当前助手没有权限模式可选");
      if (!arg) {
        const current = thread.permissionMode ?? modes.mainDefault ?? modes.default;
        this.choices(b, `mode:${row.id}`, actor, "mode",
          [this.say(`Permission mode: ${modes.choices.find(c => c.value === current)?.label ?? current}`, `权限模式：${modes.choices.find(c => c.value === current)?.label ?? current}`),
            ...modes.choices.map(c => `- ${c.label} (${c.value})`), this.say("Reply /mode <mode> to change it.", "回复 /mode <模式> 切换。")].join("\n"),
          modes.choices.map(c => ({ label: c.label, value: c.value })), reply);
        this.accept(row); return true;
      }
      await this.choose(b, row, actor, "mode", arg.trim(), reply); return true;
    }
    // model, effort: the engine's own picks.
    const pick = engine?.picks?.().find(p => p.key === name);
    if (!pick) this.refuse(`This assistant has no ${name} choice`, `当前助手没有可选的${name === "model" ? "模型" : "推理强度"}`);
    if (!arg) {
      const current = thread.options?.[name];
      this.choices(b, `${name}:${row.id}`, actor, name,
        [`${pick.title}: ${typeof current === "string" ? current : this.say("default", "默认")}`, ...pick.choices.map(c => `- ${c.label ?? c.value}${c.label ? ` (${c.value})` : ""}`),
          this.say(`Reply /${name} <value> to change it, or /${name} default.`, `回复 /${name} <值> 切换，或 /${name} default 恢复默认。`)].join("\n"),
        [{ label: this.say("Default", "默认"), value: "default" }, ...pick.choices.map(c => ({ label: c.label ?? c.value, value: c.value }))], reply);
      this.accept(row); return true;
    }
    await this.choose(b, row, actor, name, arg.trim(), reply); return true;
  }

  /** Applies a choice, from a typed command or from the select or button it offered. */
  private async choose(b: Binding, row: Inbox, actorId: string, kind: string, value: string, reply: { anchor: string | null }, n?: string) {
    const { thread } = this.home.agent.thread(b.project_id, b.thread_id);
    const running = this.home.agent.activeRuns().some(r => r.thread.id === b.thread_id);
    const when = running ? this.say(" It applies from the next turn.", "从下一轮开始生效。") : "";
    const done = (text: string, on = b) => { this.enqueue(on, `${kind}:${row.id}`, { text }, reply); this.accept(row); };
    if (kind === "proposal") {
      const [, verdict, projectId, proposalId] = /^(accept|reject):([^:]+):(.+)$/.exec(value) ?? [];
      const code = this.code();
      if (!verdict || !code || projectId !== b.project_id) this.refuse("That choice is no longer available", "该选项已不可用");
      // Settled from here, so the change it causes is not news of a settlement elsewhere.
      for (const w of this.store.all<Watch>("SELECT * FROM plugin_im_watch WHERE binding_id = ?", b.id)) {
        const seen = JSON.parse(w.seen_json) as CodeSeen;
        if (seen.proposals.includes(proposalId)) this.store.run("UPDATE plugin_im_watch SET seen_json = ? WHERE binding_id = ? AND item_id = ?",
          JSON.stringify({ ...seen, proposals: seen.proposals.filter(id => id !== proposalId) }), w.binding_id, w.item_id);
      }
      const settled = code.resolve(projectId, proposalId, verdict === "accept");
      this.settleProposal(b, proposalId, settled.state === "accepted" ? this.say("Accepted", "已接受")
        : settled.state === "rejected" ? this.say("Dismissed", "已忽略") : this.say("No longer applies", "已不再适用"));
      this.accept(row);
      return;
    }
    if (kind === "switch" || kind === "switch!") {
      const target = this.home.agent.store.thread(b.project_id, value);
      if (!target || target.archived || target.surface !== "assistant") this.refuse("That conversation can't be continued here", "该会话无法在这里继续");
      if (target.id === b.thread_id) { done(this.say("Already here", "已经是当前会话")); return; }
      if (this.home.agent.activeRuns().some(r => r.thread.id === target.id)) this.refuse("That conversation is running; try again when it finishes", "该会话正在运行，结束后再试");
      if (running || this.home.agent.thread(b.project_id, b.thread_id).pending) this.refuse("Stop the current turn or answer its question first", "请先停止当前执行或回答问题");
      const title = target.title || this.say("Untitled", "未命名");
      // In a group, the conversation's history becomes visible to everyone there; the person who asked confirms.
      if (kind === "switch" && this.isGroup(b)) {
        const caps = this.capsOf(b);
        const confirm = caps?.buttons ? [{ label: this.say("Continue it here", "在这里继续"), token: this.offer(b, "switch!", actorId), style: "primary" as const }] : [];
        // The button carries the conversation in its own row, as a select would.
        if (confirm.length) this.store.run("UPDATE plugin_im_actions SET value_json = ? WHERE token = ?", JSON.stringify(target.id), confirm[0].token);
        this.enqueue(b, `switch-confirm:${row.id}`, { text: this.say(`Everyone in this group will be able to read “${title}” and what follows. Continue it here?${confirm.length ? "" : ` Reply /switch ${n ?? ""} confirm.`}`,
          `群里所有人都将能看到“${title}”的历史和后续内容。要在这里继续吗？${confirm.length ? "" : `回复 /switch ${n ?? ""} confirm 确认。`}`), actions: confirm }, { ...reply, visibleTo: reply.anchor ? actorId : null });
        this.accept(row); return;
      }
      const cursor = this.home.agent.thread(b.project_id, target.id).messages.at(-1)?.seq ?? 0;
      this.rebind(b, target.id, cursor, actorId, rebound => done(this.say(`Continuing “${title}” here; the desktop shows the same conversation.`, `已切换到“${title}”，在这里继续；桌面上是同一个会话。`), rebound));
      return;
    }
    if (kind === "engine") {
      const views = (await this.home.agent.engineViews()).filter(v => v.ok && !v.terminalOnly);
      const target = views.find(v => v.id === value || v.title.toLowerCase() === value.toLowerCase());
      if (!target) this.refuse(`No assistant “${value}”; /engine lists them`, `没有名为“${value}”的助手；/engine 可查看`);
      if (running) this.refuse("The assistant can't change while a turn runs; try again when it finishes", "运行中不能切换助手，请在本轮结束后再试");
      this.home.agent.setEngine(b.project_id, b.thread_id, target.id);
      done(this.say(`Assistant: ${target.title}`, `已切换助手：${target.title}`)); return;
    }
    if (kind === "mode") {
      const choice = this.home.agent.engineOf(thread.engine)?.permissionModes?.choices.find(c => c.value === value || c.label.toLowerCase() === value.toLowerCase());
      if (!choice) this.refuse(`No permission mode “${value}”; /mode lists them`, `没有“${value}”这个权限模式；/mode 可查看`);
      this.home.agent.setPermissionMode(b.project_id, b.thread_id, choice.value);
      done(this.say(`Permission mode: ${choice.label}.${when}`, `权限模式：${choice.label}。${when}`)); return;
    }
    const pick = this.home.agent.engineOf(thread.engine)?.picks?.().find(p => p.key === kind);
    if (!pick) this.refuse("That choice is no longer available", "该选项已不可用");
    const { [kind]: _old, ...rest } = thread.options ?? {};
    let options: Record<string, unknown> = rest;
    if (value.toLowerCase() !== "default") {
      const chosen = pick.choices.find(c => c.value === value || c.label?.toLowerCase() === value.toLowerCase())?.value ?? (pick.freeText ? value : undefined);
      if (!chosen) this.refuse(`No ${pick.title} “${value}”; /${kind} lists them`, `没有“${value}”这个${pick.title}；/${kind} 可查看`);
      options = { ...rest, [kind]: chosen };
    }
    try { this.home.agent.setOptions(b.project_id, b.thread_id, Object.keys(options).length ? options : null); }
    catch { this.refuse(`The assistant refused that ${pick.title}`, `助手不接受该${pick.title}`); }
    done(this.say(`${pick.title}: ${typeof options[kind] === "string" ? options[kind] : "default"}.${when}`, `${pick.title}：${typeof options[kind] === "string" ? options[kind] : "默认"}。${when}`));
  }

  private ago(at: number): string {
    const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
    if (m < 1) return this.say("just now", "刚刚");
    if (m < 60) return this.say(`${m} min ago`, `${m} 分钟前`);
    const h = Math.round(m / 60);
    return h < 24 ? this.say(`${h} h ago`, `${h} 小时前`) : this.say(`${Math.round(h / 24)} d ago`, `${Math.round(h / 24)} 天前`);
  }

  private accept(row: Inbox) { this.store.run("UPDATE plugin_im_inbox SET state = 'accepted' WHERE id = ?", row.id); }

  private answer(b: Binding, actionToken: string, actorId: string, value?: string | string[]): UserInput {
    const a = this.store.get<Action>("SELECT * FROM plugin_im_actions WHERE token = ?", actionToken);
    const current = this.home.agent.thread(b.project_id, b.thread_id);
    const pending = current.pending;
    if (!a || a.binding_id !== b.id || a.thread_id !== b.thread_id || a.run_id !== current.runs.at(-1)?.id || a.actor_id !== actorId || a.expires_at < Date.now() || a.consumed || pending?.question.id !== a.question_id) this.refuse("Question already handled, expired, or not yours to answer", "问题已处理、已失效，或不由你回答");
    let answer = a.value_json === null ? value : JSON.parse(a.value_json) as string;
    if (pending.question.multiple && typeof answer === "string") {
      try { answer = JSON.parse(answer) as string[]; } catch { this.refuse("Reply with a JSON array of selected values", "请用 JSON 数组回复所选的值"); }
    }
    if (typeof answer !== "string" && (!Array.isArray(answer) || answer.some(v => typeof v !== "string"))) this.refuse("Invalid question answer", "回答无效");
    if (answer === undefined || (Array.isArray(answer) && !pending.question.multiple) ||
      (pending.accepts === "options" && !pending.question.freeText && [answer].flat().some(v => !pending.question.options?.includes(v)))) this.refuse("Invalid question answer", "回答无效");
    return { kind: "answer", questionId: a.question_id, value: answer };
  }

  private project(b: Binding) {
    const detail = this.home.agent.thread(b.project_id, b.thread_id);
    this.store.db.transaction(() => {
      for (const message of detail.messages.filter(m => m.seq > b.cursor)) {
        const content = message.role === "agent" && this.visible(b, message.runId) ? this.render(b, message.block) : null;
        if (content) this.watch(b, message.block);
        const streamed = content && this.store.get<{ id: string }>("SELECT id FROM plugin_im_outbox WHERE binding_id = ? AND stream_of = ?", b.id, message.id);
        if (streamed) this.replace(b, streamed.id, content, { final: true });
        else if (content) this.enqueue(b, `message:${b.id}:${message.id}`, content);
        this.store.run("UPDATE plugin_im_bindings SET cursor = ? WHERE id = ?", message.seq, b.id);
      }
      this.pending(b, this.visible(b, detail.runs.at(-1)?.id ?? null) ? detail.pending : null);
      // Settles a progress message whose `done` event was missed, e.g. across a restart; never posts a new one.
      for (const run of detail.runs.filter(r => r.status !== "running")) {
        const progress = this.store.get<Outbox>("SELECT * FROM plugin_im_outbox WHERE id = ?", `progress:${b.id}:${run.id}`);
        // One the `done` event settled already keeps its tool line.
        if (progress && !(JSON.parse(progress.content_json) as ImContent).text.startsWith(this.finished(run.status))) this.replace(b, progress.id, { text: this.finished(run.status) });
        // A stream that never became a message (a crash, an engine that stopped mid-reply) keeps what it showed.
        for (const open of this.store.all<Outbox>("SELECT * FROM plugin_im_outbox WHERE binding_id = ? AND stream = 1 AND id LIKE ?", b.id, `stream:${b.id}:${run.id}:%`)) {
          this.replace(b, open.id, JSON.parse(open.content_json) as ImContent, { final: true });
        }
      }
    });
  }

  private pending(b: Binding, pending: PendingView | null) {
    const runId = this.home.agent.store.runs(b.project_id, b.thread_id).at(-1)?.id ?? null;
    const previous = this.store.all<Action>("SELECT * FROM plugin_im_actions WHERE binding_id = ? AND retired = 0 AND question_id NOT LIKE 'cmd:%' AND question_id NOT LIKE 'remind:%'", b.id);
    for (const a of previous) if (a.question_id !== pending?.question.id || a.thread_id !== b.thread_id || a.run_id !== runId || a.expires_at < Date.now()) {
      this.store.run("UPDATE plugin_im_actions SET consumed = 1, retired = 1 WHERE token = ?", a.token);
      const id = `question:${b.id}:${a.question_id}`;
      const row = this.store.get<Outbox>("SELECT * FROM plugin_im_outbox WHERE id = ?", id);
      if (row) {
        const text = this.say("Question handled or expired", "问题已处理或失效");
        if (this.capsOf(b)?.cardUpdate) this.replace(b, id, { text });
        else this.enqueue(b, `resolved:${id}`, { text });
      }
    }
    if (!pending) return;
    const id = `question:${b.id}:${pending.question.id}`;
    if (this.store.get("SELECT 1 FROM plugin_im_actions WHERE binding_id = ? AND question_id = ? AND run_id = ? AND consumed = 0 AND expires_at > ?", b.id, pending.question.id, runId, Date.now())) return;
    // A token with a value is one choice; without, the answer comes from the action or the /answer reply.
    const issue = (value: string | null) => {
      const t = token();
      this.store.run("INSERT INTO plugin_im_actions (token, binding_id, thread_id, question_id, actor_id, run_id, value_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", t, b.id, b.thread_id, pending.question.id, b.actor_id, runId, value === null ? null : JSON.stringify(value), Date.now() + this.config.actionTtlMs, Date.now());
      return t;
    };
    const { question } = pending;
    const options = question.options ?? [];
    const actions = question.multiple ? [] : options.map(value => ({ label: value, token: issue(value) }));
    const elements: ImElement[] = [];
    if (question.multiple && options.length) elements.push({ type: "select", token: issue(null), multiple: true, options: options.map(o => ({ label: o, value: o })) });
    if (question.freeText || (pending.accepts === "text" && !options.length)) elements.push({ type: "input", token: issue(null), label: this.say("Your answer", "你的回答") });
    this.replace(b, id, { text: question.text, actions, ...(elements.length ? { elements } : {}) });
  }

  private render(b: Binding, block: Block): ImContent | null {
    const detail = this.settings.routes.find(r => r.id === b.route_id)?.output === "verbose";
    return renderBlock(this.scope(b), block, detail);
  }

  private scope(b: Binding): RenderScope {
    const items = this.items();
    const code = this.code();
    return { projectId: b.project_id, threadId: b.thread_id, say: (en, zh) => this.say(en, zh), ...(items ? { items } : {}), ...(code ? { code } : {}) };
  }

  private items() { return this.home.get("items") as ItemLookup | undefined; }
  private code() { return this.home.get("codeLink") as CodeHost | undefined; }

  /** Tickets a conversation was shown, so what happens to their code reaches it; seeing one again keeps it watched. */
  private watch(b: Binding, block: Block) {
    const data = block.type === "card" ? (block.data ?? {}) as Record<string, unknown> : {};
    const keys = block.type === "changes" ? (block.items ?? []).filter(i => i.op !== "deleted").map(i => i.key)
      : block.type === "card" && block.schema === "start" && typeof data.key === "string" ? [data.key] : [];
    const items = this.items();
    const code = this.code();
    if (!keys.length || !items || !code) return;
    for (const key of keys) {
      const item = items.getByKey(b.project_id, key);
      if (!item) continue;
      let seen: CodeSeen;
      try { seen = codeSeen(code.summary(b.project_id, item.id)); } catch { continue; }
      this.store.run(`INSERT INTO plugin_im_watch (binding_id, project_id, item_id, seen_json, at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (binding_id, item_id) DO UPDATE SET at = excluded.at`, b.id, b.project_id, item.id, JSON.stringify(seen), Date.now());
    }
  }

  /**
   * A project's code changed: each conversation watching one of its tickets
   * hears what is new (a pull request opened, merged or closed, a merge that
   * waits on the person, a flag), and gets git's status proposals with buttons.
   * A proposal settled elsewhere loses its buttons here.
   */
  private onCode(projectId: string) {
    const items = this.items();
    const code = this.code();
    if (this.stopped || !this.store || !items || !code || !this.home.db.has(projectId)) return;
    for (const w of this.store.all<Watch>("SELECT * FROM plugin_im_watch WHERE project_id = ?", projectId)) {
      const b = this.store.binding(w.binding_id);
      const item = items.get(projectId, w.item_id);
      if (!b || !item || !this.authorizedBinding(b)) continue;
      let summary: ReturnType<CodeHost["summary"]>;
      try { summary = code.summary(projectId, item.id); } catch { continue; }
      const was = JSON.parse(w.seen_json) as CodeSeen;
      const now = codeSeen(summary);
      if (JSON.stringify(was) === JSON.stringify(now)) continue;
      const say = (en: string, zh: string) => this.say(en, zh);
      this.store.db.transaction(() => {
        this.store.run("UPDATE plugin_im_watch SET seen_json = ? WHERE binding_id = ? AND item_id = ?", JSON.stringify(now), w.binding_id, w.item_id);
        const news = codeNews(say, was, now, summary);
        if (news.length) this.enqueue(b, `code:${b.id}:${item.id}:${hash(now).slice(0, 16)}`, { text: news.join("\n"), elements: ticket(this.scope(b), item.key, item.title) }, { anchor: null });
        for (const p of summary.proposals.filter(p => p.kind === "propose" && !was.proposals.includes(p.id))) {
          const choice = (verdict: "accept" | "reject") => this.offerValue(b, "proposal", b.actor_id, `${verdict}:${projectId}:${p.id}`);
          this.enqueue(b, `proposal:${b.id}:${p.id}`, { text: proposalText(say, item.key, p), actions: [
            { label: this.say("Accept", "接受"), token: choice("accept"), style: "primary" },
            { label: this.say("Not this time", "这次不用"), token: choice("reject") }
          ] }, { anchor: null });
        }
        for (const id of was.proposals.filter(id => !now.proposals.includes(id))) this.settleProposal(b, id, this.say("Handled in Tomrade", "已在 Tomrade 处理"));
      });
    }
  }

  /** A proposal's buttons stop working; its card says how it ended, unless it already does. */
  private settleProposal(b: Binding, proposalId: string, text: string) {
    this.store.run("UPDATE plugin_im_actions SET consumed = 1, retired = 1 WHERE binding_id = ? AND question_id = 'cmd:proposal' AND value_json LIKE ?", b.id, `%:${proposalId}"`);
    const id = `proposal:${b.id}:${proposalId}`;
    const row = this.store.get<Outbox>("SELECT * FROM plugin_im_outbox WHERE id = ?", id);
    if (!row || !(JSON.parse(row.content_json) as ImContent).actions?.length) return;
    const head = (JSON.parse(row.content_json) as ImContent).text.split("\n")[0];
    if (this.capsOf(b)?.cardUpdate || this.capsOf(b)?.edit) this.replace(b, id, { text: `${head}\n${text}` });
    else this.enqueue(b, `settled:${id}`, { text: `${head}\n${text}` }, { anchor: null });
  }

  /** The progress message: what the turn is doing, a model retry, and the tools it has called. */
  private progressText(threadId: string, head: string): string {
    const turn = this.turns.get(threadId);
    const retry = turn?.retry ? this.say(`Retrying (attempt ${turn.retry.attempt}${turn.retry.max ? ` of ${turn.retry.max}` : ""})`, `重试中（第 ${turn.retry.attempt}${turn.retry.max ? ` / ${turn.retry.max}` : ""} 次）`) : "";
    return [retry || head, toolLine(turn?.tools ?? [])].filter(Boolean).join("\n");
  }

  private finished(status: string): string {
    return status === "error" ? this.say("Execution failed", "执行失败") : status === "cancelled" ? this.say("Execution stopped", "执行已停止")
      : status === "asked" ? this.say("Waiting for your answer", "等待你的回答") : this.say("Turn finished", "本轮执行结束");
  }

  private onAgentEvent(threadId: string, event: AgentEvent) {
    if (this.stopped) return;
    if (event.type === "done") queueMicrotask(() => this.turns.delete(threadId));
    if (event.type !== "delta" && event.type !== "progress") this.dirty.add(threadId);
    const runId = event.type === "progress" || event.type === "delta" ? event.runId : event.type === "done" ? event.run.id : event.type === "message" ? event.message.runId : null;
    for (const b of this.store.bindings().filter(b => b.thread_id === threadId && this.authorizedBinding(b))) {
      const caps = this.capsOf(b);
      if (!caps) continue;
      if (runId) this.claimShared(b, runId);
      if (runId && !this.visible(b, runId)) continue;
      const quiet = this.settings.routes.find(r => r.id === b.route_id)?.output === "final";
      const streaming = !quiet && this.streamMode(caps, this.connections.get(b.connection_id)?.session) !== "none";
      if (event.type === "progress" && event.activity) this.activity.set(threadId, event.activity);
      if (event.type === "progress" && event.retry !== undefined) {
        const turn = this.turns.get(threadId) ?? { tools: [], retry: null };
        turn.retry = event.retry ? { attempt: event.retry.attempt, ...(event.retry.max ? { max: event.retry.max } : {}) } : null;
        this.turns.set(threadId, turn);
      }
      if (event.type === "message" && event.message.block.type === "trace") {
        const turn = this.turns.get(threadId) ?? { tools: [], retry: null };
        turn.tools.push({ tool: event.message.block.tool, ok: event.message.block.ok });
        this.turns.set(threadId, turn);
      }
      if (event.type === "progress" || event.type === "delta") {
        if (Date.now() - (this.typingAt.get(b.id) ?? 0) >= TYPING_MS) { this.typingAt.set(b.id, Date.now()); this.indicate(b, "typing"); }
        if (quiet) continue;
        if (event.type === "delta" && streaming) { this.stream(b, event.runId, event.text); continue; }
        // Non-editing providers only receive stable output, so token streams don't spam chats.
        if (!caps.edit) continue;
        const text = this.progressText(threadId, event.type === "progress" ? event.activity || this.say("Working", "正在执行") : this.say("Writing a reply", "正在生成回复"));
        const runId = event.runId;
        // Throttled, but the latest state still shows once the interval is up.
        const show = () => {
          this.progressTimers.delete(b.id);
          if (this.stopped || !this.home.agent.activeRuns().some(r => r.run.id === runId)) return;
          this.progressAt.set(b.id, Date.now());
          this.replace(b, `progress:${b.id}:${runId}`, { text });
        };
        clearTimeout(this.progressTimers.get(b.id));
        const wait = this.config.progressMs - (Date.now() - (this.progressAt.get(b.id) ?? 0));
        if (wait > 0) this.progressTimers.set(b.id, setTimeout(show, wait));
        else show();
      } else if (event.type === "message" && event.message.role === "agent" && event.message.block.type === "text" && event.message.runId) {
        // The text that was streaming is now this message; the next delta starts a new stream.
        const open = this.streams.get(`${b.id}:${event.message.runId}`);
        this.streams.delete(`${b.id}:${event.message.runId}`);
        if (open) this.store.run("UPDATE plugin_im_outbox SET stream_of = ? WHERE id = ? AND stream = 1", event.message.id, open.id);
      } else if (event.type === "done") {
        clearTimeout(this.progressTimers.get(b.id));
        this.progressTimers.delete(b.id);
        this.activity.delete(threadId);
        this.streams.delete(`${b.id}:${event.run.id}`);
        this.typingAt.delete(b.id);
        this.indicate(b, "idle");
        // Without edits a routine "finished" line would follow every reply; only report what the reply can't show.
        if ((caps.edit && !quiet) || event.run.status === "error" || event.run.status === "cancelled") this.replace(b, `progress:${b.id}:${event.run.id}`, { text: this.progressText(threadId, this.finished(event.run.status)) });
        const trigger = this.store.get<Inbox>("SELECT * FROM plugin_im_inbox WHERE binding_id = ? AND run_id = ? ORDER BY seq LIMIT 1", b.id, event.run.id);
        const e = trigger && JSON.parse(trigger.event_json) as ImInbound;
        if (e?.kind === "message" && (event.run.status === "error" || event.run.status === "done")) this.react(b, e.messageId, event.run.status === "error" ? "failed" : "done");
      }
    }
  }

  /** Grows the reply's snapshot, at most once per `progressMs`; the final message always follows. */
  private stream(b: Binding, runId: string, delta: string) {
    const key = `${b.id}:${runId}`;
    let open = this.streams.get(key);
    if (!open) {
      const n = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM plugin_im_outbox WHERE binding_id = ? AND id LIKE ?", b.id, `stream:${b.id}:${runId}:%`)!.n;
      open = { id: `stream:${b.id}:${runId}:${n}`, text: "", at: 0 };
      this.streams.set(key, open);
    }
    open.text += delta;
    if (!open.text.trim() || Date.now() - open.at < this.config.progressMs) return;
    open.at = Date.now();
    this.replace(b, open.id, { text: open.text }, { stream: true });
  }

  /** Content is Markdown with every element; `prepare` fits it to the adapter when it is sent. */
  private enqueue(b: Binding, id: string, content: ImContent, opts: { anchor?: string | null; visibleTo?: string | null; stream?: boolean } = {}) {
    this.store.run("INSERT OR IGNORE INTO plugin_im_outbox (id, binding_id, thread_id, content_json, created_at, anchor, visible_to, stream) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, b.id, b.thread_id, JSON.stringify(content), Date.now(), opts.anchor === undefined ? b.anchor : opts.anchor, opts.visibleTo ?? null, opts.stream ? 1 : 0);
  }

  /** `stream` updates a growing reply while it is still open; `final` settles it. */
  private replace(b: Binding, id: string, content: ImContent, opts: { stream?: boolean; final?: boolean } = {}) {
    this.enqueue(b, id, content, { stream: opts.stream });
    const json = JSON.stringify(content);
    // Preserve an in-flight snapshot. Completion schedules the newer revision.
    this.store.run(`UPDATE plugin_im_outbox SET content_json = ?, revision = revision + 1,
      stream = CASE WHEN ? THEN 0 ELSE stream END,
      state = CASE WHEN state IN ('sending', 'uncertain', 'failed') THEN state ELSE 'queued' END,
      parts_json = CASE WHEN state IN ('sending', 'uncertain', 'failed') THEN parts_json ELSE NULL END,
      part = CASE WHEN state IN ('sending', 'uncertain', 'failed') THEN part ELSE 0 END,
      retry_at = CASE WHEN state IN ('sending', 'uncertain', 'failed') THEN retry_at ELSE 0 END
      WHERE id = ? AND state != 'cancelled' AND (content_json != ? OR (? AND stream = 1))${opts.stream ? " AND stream = 1" : ""}`,
      json, opts.final ? 1 : 0, id, json, opts.final ? 1 : 0);
  }

  /** How replies grow on this platform: a native stream, edits of one message, or only the final message. */
  private streamMode(caps: ResolvedImCapabilities, session?: ImAdapterSession): "native" | "edit" | "none" {
    if (caps.stream === "native" && session?.stream) return "native";
    return caps.stream !== "none" && caps.edit ? "edit" : "none";
  }

  private limited(bindingId: string, caps: ResolvedImCapabilities): boolean {
    if (!caps.rateLimit) return false;
    const now = Date.now();
    const recent = (this.sentAt.get(bindingId) ?? []).filter(t => now - t < caps.rateLimit!.windowMs);
    this.sentAt.set(bindingId, recent);
    return recent.length >= caps.rateLimit.messages;
  }

  private async flush(c: Connection) {
    c.flushing = true;
    try {
      const caps = this.caps.get(c.adapterId)!;
      const session = c.session!;
      // A delayed operation holds its target's place, but does not block other conversations.
      // An uncertain or failed one waits for a person and must not silence the conversation meanwhile.
      const rows = this.store.all<Outbox>(`SELECT o.* FROM plugin_im_outbox o JOIN plugin_im_bindings b ON b.id = o.binding_id
        WHERE b.connection_id = ? AND o.state = 'queued' AND o.retry_at <= ?
        AND NOT EXISTS (SELECT 1 FROM plugin_im_outbox earlier WHERE earlier.binding_id = o.binding_id
          AND earlier.seq < o.seq AND earlier.state IN ('queued', 'sending'))
        ORDER BY o.seq LIMIT 50`, c.id, Date.now());
      const row = rows.find(r => !this.limited(r.binding_id, caps));
      if (!row) return;
      const b = this.store.binding(row.binding_id)!;
      if (!this.authorizedBinding(b) || row.thread_id !== b.thread_id) {
        this.store.run("UPDATE plugin_im_outbox SET state = 'cancelled' WHERE id = ?", row.id); return;
      }
      const messageIds = JSON.parse(row.message_ids_json) as string[];
      let parts: ImContent[];
      if (row.parts_json) parts = JSON.parse(row.parts_json) as ImContent[];
      else {
        parts = prepare(JSON.parse(row.content_json) as ImContent, caps, (en, zh) => this.say(en, zh));
        // A growing reply shows what fits one message; the final version carries the rest.
        if (row.stream) parts = parts.slice(0, 1);
        // Clear obsolete segments when an edited question or status became shorter.
        if (caps.edit) while (parts.length < messageIds.length) parts.push({ text: this.say("This message was superseded", "此消息已被更新") });
        row.prepared_revision = row.revision;
        row.part = 0;
        this.store.run("UPDATE plugin_im_outbox SET parts_json = ?, prepared_revision = ?, part = 0 WHERE id = ?", JSON.stringify(parts), row.prepared_revision, row.id);
      }
      const content = parts[row.part];
      this.store.run("UPDATE plugin_im_outbox SET state = 'sending', sending_json = ?, attempts = attempts + 1 WHERE id = ?", JSON.stringify(content), row.id);
      const address = JSON.parse(b.address_json) as ImAddress;
      const threadId = address.topicId ?? (row.anchor && caps.threads ? row.anchor : undefined);
      const operationId = `${row.id}:v${row.prepared_revision}:p${row.part}`;
      const delivery = { operationId, address, content,
        ...(threadId ? { threadId } : row.anchor ? { replyTo: row.anchor } : {}),
        ...(row.visible_to && caps.ephemeral ? { visibleTo: row.visible_to } : {}),
        ...(caps.edit && messageIds[row.part] ? { replaceMessageId: messageIds[row.part] } : {}) };
      const native = this.streamMode(caps, session) === "native" && row.part === 0 ? session.stream! : null;
      let streamed = row.streamed;
      try {
        if (caps.rateLimit) this.sentAt.set(row.binding_id, [...(this.sentAt.get(row.binding_id) ?? []), Date.now()]);
        let result: { messageId: string };
        if (native && row.stream && !messageIds[0]) {
          result = await deadline(native.start(delivery), this.config.operationTimeoutMs);
          streamed = content.text;
        } else if (native && row.stream) {
          // Appending only works while the snapshot extends what was sent; otherwise the final version settles it.
          if (streamed !== null && content.text.length > streamed.length && content.text.startsWith(streamed)) {
            await deadline(native.append({ operationId, address, messageId: messageIds[0], delta: content.text.slice(streamed.length) }), this.config.operationTimeoutMs);
            streamed = content.text;
          }
          result = { messageId: messageIds[0] };
        } else if (native && streamed !== null && messageIds[0]) {
          result = await deadline(native.stop({ operationId, address, messageId: messageIds[0], content }), this.config.operationTimeoutMs);
          streamed = null;
        } else result = await deadline(session.deliver(delivery), this.config.operationTimeoutMs);
        if (!result.messageId) throw new Error("Adapter returned no message id");
        if (this.stopped) return;
        messageIds[row.part] = result.messageId;
        const latest = this.store.get<Outbox>("SELECT * FROM plugin_im_outbox WHERE id = ?", row.id)!;
        const changed = latest.revision !== row.prepared_revision;
        const next = row.part + 1;
        this.store.run(`UPDATE plugin_im_outbox SET state = ?, message_id = ?, message_ids_json = ?,
          parts_json = ?, part = ?, sending_json = NULL, retry_at = 0, error = NULL, streamed = ? WHERE id = ?`,
          changed || next < parts.length ? "queued" : "delivered", messageIds[0], JSON.stringify(messageIds),
          changed ? null : JSON.stringify(parts), changed ? 0 : next, streamed, row.id);
      } catch (e) {
        if (this.stopped) return;
        // A lost append only delays the stream; the final version still settles the message.
        const disposition = native && row.stream && messageIds[0] ? "retryable" : (e as { disposition?: string } | null)?.disposition;
        const retryAfter = (e as { retryAfterMs?: number } | null)?.retryAfterMs;
        const latest = this.store.get<Outbox>("SELECT * FROM plugin_im_outbox WHERE id = ?", row.id)!;
        const superseded = disposition === "retryable" && latest.revision !== row.prepared_revision;
        this.store.run(`UPDATE plugin_im_outbox SET state = ?, error = ?, retry_at = ?, sending_json = NULL,
          parts_json = ?, part = ? WHERE id = ?`,
          disposition === "retryable" ? "queued" : disposition === "permanent" ? "failed" : "uncertain",
          "Delivery failed; check adapter diagnostics", superseded ? 0 : Date.now() + (Number.isFinite(retryAfter) ? Math.max(0, retryAfter!) : Math.min(60_000, this.config.retryMs * 2 ** Math.min(row.attempts, 6))),
          superseded ? null : JSON.stringify(parts), superseded ? 0 : row.part, row.id);
        if (disposition !== "retryable") this.changed();
      }
    } finally { c.flushing = false; }
  }

  private async readFile(c: Connection, id: string): Promise<Uint8Array> {
    if (!this.current(c)) throw new Error("Connection closed");
    for (const b of this.store.bindings().filter(b => b.connection_id === c.id && this.authorizedBinding(b))) {
      const rows = this.store.all<Outbox>("SELECT * FROM plugin_im_outbox WHERE binding_id = ? AND state = 'sending'", b.id);
      if (!rows.some(r => r.thread_id === b.thread_id && r.sending_json && (JSON.parse(r.sending_json) as ImContent).files?.some(f => f.id === id))) continue;
      const version = FILE_HANDLE.exec(id);
      if (!version) return Buffer.from(this.home.agent.readMedia(b.project_id, b.thread_id, id).base64, "base64");
      const files = this.home.get("files") as { readVersion(projectId: string, ref: { fileId: string; versionId: string }): Promise<{ body: string; encoding: "utf8" | "base64"; truncated: boolean } | null> } | undefined;
      const content = await files?.readVersion(b.project_id, { fileId: version[1], versionId: version[2] });
      // A cut-short body would arrive as a broken file; the message's link still reaches it.
      if (!content || content.truncated) throw new Error("File version is unavailable or too large to send");
      return Buffer.from(content.body, content.encoding);
    }
    throw new Error("File is not part of this connection's current delivery");
  }
}

/** Commands that act at once, ahead of ordinary messages waiting for the turn. A demoted /steer carries its text in `input_json`. */
function isControl(row: Inbox, event: ImInbound & { kind: "message" }): boolean {
  const text = event.text.trim();
  return !row.input_json && (/^\/(stop|status|queue|help|sessions|archive|engine|model|effort|mode)$/.test(text) || /^\/(answer|steer|unqueue|switch|engine|model|effort|mode)\s/.test(text));
}

const preview = (row: Inbox) => {
  const e = JSON.parse(row.event_json) as ImInbound;
  const text = e.kind === "message" ? e.text.replace(/\s+/g, " ").trim() : "";
  return [...text].length > 60 ? `${[...text].slice(0, 60).join("")}…` : text;
};

/** Whether a message in this conversation is for the assistant, by how the route lets it be woken. */
function activates(route: ImRoute, activation: "dm" | "mention" | "reply" | "ambient"): boolean {
  if (activation === "dm") return route.allowDirectMessages;
  if (!route.allowGroups) return false;
  return activation === "mention" || (activation === "reply" && route.groupActivation !== "mention") || (activation === "ambient" && route.groupActivation === "all");
}

/** A conversation and topic, as the window keeps them apart. */
function placeOf(connectionId: string, address: ImAddress): string {
  return hash([connectionId, address.tenantId, address.conversationId, address.topicId ?? null]);
}

/** Group replies attach to the message that asked; a direct chat needs no anchor. */
function anchorOf(event: ImInbound): string | null {
  return event.kind === "message" && event.activation !== "dm" ? event.messageId : null;
}

async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("IM operation timed out; remote outcome unknown")), ms); })]); }
  finally { clearTimeout(timer!); }
}
