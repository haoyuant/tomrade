import { createHash, randomBytes } from "node:crypto";
import { Context, Service } from "cordis";
import type {} from "@tomradex/agent";
import { MAX_MEDIA_BYTES, type AgentEvent, type Block, type PendingView, type UserInput } from "@tomradex/agent";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/oplog";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/settings";
import { resolveImCapabilities, type ImAdapter, type ImAdapterSetup, type ImCapabilities, type Localized, type ImAdapterSession, type ImAddress, type ImCommand, type ImContent, type ImConnectionState, type ImElement, type ImInbound, type ImReaction, type ResolvedImCapabilities } from "@tomradex/plugin-sdk";
import { ImConfig, ImSettings, InboundSchema, type ImConnection, type ImNotifyKind, type ImRoute } from "./config.js";
import { fromAdapter, withContext, type ContextLine } from "./context.js";
import { prepare } from "./render.js";
import { IM_WORDS, type ImPlainWord } from "./words.js";
import { FILE_HANDLE, statusText, awaitingReview, codeNews, codeSeen, deliveryCard, links, proposalText, renderBlock, reviewOutcome, ticket, toolLine, type CodeLookup, type CodeSeen, type Delivered, type ItemLookup, type RenderScope } from "./rich.js";
import { ImStore, MIGRATIONS, TABLES, type Action, type Binding, type Inbox, type Outbox, type Topic, type Watch, type WindowRow } from "./store.js";

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
/** What a start from IM settles, carried in the tokens of its card; `card` is that card's outbox id. */
interface StartDraft { itemId: string; card: string; engine?: string; options?: Record<string, string>; permissionMode?: string; playbook?: string; allowBlocked?: boolean; releaseBranch?: boolean; task?: string }
type StartOutcome =
  | { ok: false; gate: string; message: string; blockers?: string[]; board?: { name: string }; cause?: { code: string; repoId?: string; branch?: string; heldAt?: string; releasable?: boolean } }
  | { ok: true; continued: boolean; threadId: string; runId?: string; engine: string; waitingOn?: string; warnings?: string[] };
/** The part of `ctx.codeLink` IM uses; code link is optional and never imported. */
interface CodeHost extends CodeLookup {
  resolve(projectId: string, proposalId: string, accept: boolean): { state: string };
  start(projectId: string, itemId: string, opts: { mode: "run"; engine?: string; options?: Record<string, unknown>; permissionMode?: string; playbook?: string; allowBlocked?: boolean; releaseBranch?: boolean; message?: string; source?: Record<string, string> }): Promise<StartOutcome>;
  startDefaults(): { engine?: string; options?: Record<string, unknown>; permissionMode?: string; playbook?: string } | null;
}
/** A ticket as a start needs it. */
interface Startable { id: string; key: string; title: string; status: string; kind: string; workType: string; playbookId: string | null }
/** What a gate means, in the person's language; where the word is empty, the gate's own message. */
const GATE: Partial<Record<string, ImPlainWord>> = {
  locked: "gateLocked", workstream: "gateWorkstream", checkout: "gateCheckout",
  remote: "gateRemote", readiness: "gateReadiness", engine: "gateEngine", mcp: "gateMcp"
};
/** The part of `ctx.items` a delivery card reads and settles, the service review_delivery records through. */
interface ReviewHost {
  get(projectId: string, id: string): (Delivered & { id: string; version: number }) | null;
  reviewDelivery(projectId: string, id: string, input: { submissionId: string; decision: "accepted" | "changes-requested"; comment: string }, baseVersion: number): unknown;
}
/** The part of a scheduled template's run IM tells about. */
interface RoutineRun { id: string; ok: boolean; itemIds: string[]; threadId: string | null; error: string | null }
/** A write that moved a ticket's status, as its oplog entry recorded it. */
interface StatusMove { from: string; to: string; version: number }
function statusMove(entry: { op: string; before: unknown; after: unknown }): StatusMove | null {
  const before = entry.before as { status?: unknown } | null;
  const after = entry.after as { status?: unknown; version?: unknown } | null;
  if (entry.op !== "update" || typeof before?.status !== "string" || typeof after?.status !== "string" || typeof after.version !== "number") return null;
  return before.status === after.status ? null : { from: before.status, to: after.status, version: after.version };
}
interface Pairing { connectionId: string; code: string; projectId: string; expiresAt: number; failures: number; claim?: ImPairingView["claim"] }

declare module "cordis" {
  interface Context { im: Im }
  interface Events {
    "im/registered"(id: string): void;
    "im/unregistered"(id: string): void;
    /** Emitted by code link, when it is loaded. */
    "codeLink/changed"(projectId: string): void;
    /** Emitted by schedules, when it is loaded. */
    "schedules/ran"(projectId: string, run: RoutineRun, name: string): void;
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
  private settings: ImSettings = { connections: [], identities: [], routes: [], notify: { tickets: true, code: true, presence: false, routines: false, attention: true } };
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
    // Settings from before the shared `notify` are written back once in its shape, so the renderer reads them that way too.
    const stored: unknown = this.home.settings.get().im;
    if (stored && typeof stored === "object" && "announcePresence" in stored) this.save(ImSettings.parse(stored));
    this.home.on("settings/changed", () => this.reload());
    this.home.on("agent/event", (threadId, event) => this.onAgentEvent(threadId, event));
    this.home.on("codeLink/changed", projectId => this.onCode(projectId));
    this.home.on("schedules/ran", (projectId, run, name) => this.onRoutine(projectId, run, name));
    // After the write that appended it has committed.
    this.home.on("oplog/appended", (projectId, entry) => { if (entry.entity === "item") queueMicrotask(() => this.onItem(projectId, entry.entityId, entry.runId, statusMove(entry))); });
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
      title: () => this.w("imConnections"),
      text: () => {
        const views = this.views();
        return views.length ? views.map(v => `${v.id}: ${this.stateWord(v.state)}${v.uncertain ? this.w("uncertain", { n: v.uncertain }) : ""}`).join(" · ") : null;
      } }));
    this.reload();
    const timer = setInterval(() => this.tick(), this.config.pollMs);
    return async () => {
      this.stopped = true;
      clearInterval(timer);
      for (const pending of this.progressTimers.values()) clearTimeout(pending);
      if (this.announces()) await Promise.all([...this.connections.values()].map(c => this.presence(c, false)));
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
        if (this.announces()) await Promise.all([...this.connections.values()].filter(c => c.adapterId === adapter.id).map(c => this.presence(c, false)));
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
    if (c) this.tell(c, { tenantId: claim.tenantId, conversationId: claim.conversationId }, this.w("paired"));
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
      allowDirectMessages: kind === "dm", allowGroups: kind === "group", groupActivation: "reply", output: "progress", desktopTurns: true, ticketTopics: true });
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
  private tell(c: Connection, address: ImAddress, text: string) {
    const caps = this.caps.get(c.adapterId);
    if (!caps || !c.session || c.state !== "connected") return;
    const [content] = prepare({ text }, caps, this.w);
    this.bestEffort(c.session.deliver({ operationId: `notice:${token()}`, address, content }));
  }

  private changed() { for (const notify of this.watchers) notify(); }

  /** The book in the desktop's language. */
  private get w() { return IM_WORDS(this.home.settings.locale()); }

  /** The plain-text commands, for adapters that register them natively. */
  private commands(): ImCommand[] {
    const { w } = this;
    return [
      { name: "stop", description: w("cmdStop") },
      { name: "status", description: w("cmdStatus") },
      { name: "new", description: w("cmdNew") },
      { name: "answer", description: w("cmdAnswer"), args: w("argsAnswer") },
      { name: "steer", description: w("cmdSteer"), args: w("argsSteer") },
      { name: "queue", description: w("cmdQueue") },
      { name: "sessions", description: w("cmdSessions") },
      { name: "switch", description: w("cmdSwitch"), args: "N" },
      { name: "archive", description: w("cmdArchive") },
      { name: "engine", description: w("cmdEngine"), args: w("argsEngine") },
      { name: "model", description: w("cmdModel"), args: w("argsModel") },
      { name: "effort", description: w("cmdEffort"), args: w("argsEffort") },
      { name: "mode", description: w("cmdMode"), args: w("argsMode") },
      { name: "start", description: w("cmdStart"), args: w("argsStart") },
      { name: "unqueue", description: w("cmdUnqueue"), args: "N" },
      { name: "help", description: w("cmdHelp") }
    ];
  }

  /** `/help`: every command the conversation takes, from the same list registered natively, and where it goes. */
  private help(b: Binding): string {
    const { thread } = this.home.agent.thread(b.project_id, b.thread_id);
    const engine = this.home.agent.engineOf(thread.engine);
    const project = this.home.projects.get(b.project_id)?.name ?? b.project_id;
    return [
      this.w("helpHead", { project, engine: engine?.title ?? thread.engine }),
      ...this.commands().map(c => `/${c.name}${c.args ? ` ${c.args}` : ""} — ${c.description}`),
      engine?.steers ? this.w("helpSteers") : this.w("helpNoSteer")
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
      case "connecting": return this.w("stateConnecting");
      case "connected": return this.w("stateConnected");
      case "offline": return this.w("stateOffline");
      case "error": return this.w("stateError");
      case "unconfigured": return this.w("stateUnconfigured");
    }
  }

  /** A refusal shown to the IM user, in the desktop's language. */
  private refuse(text: string): never { throw new Error(text); }

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
    for (let b of this.store.bindings()) {
      if (!this.authorizedBinding(b) || !this.home.db.has(b.project_id)) continue;
      if (!this.processing.has(b.thread_id)) {
        try { b = this.leaveArchived(b); } catch { continue; }
      }
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
          c.detail = state === "error" ? this.w("connectionFailed") : undefined;
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
      if (this.announces() && !this.announced.has(c.id)) { this.announced.add(c.id); void this.presence(c, true); }
      if (this.caps.get(c.adapterId)?.nativeCommands && session.commands) this.bestEffort(session.commands(this.commands()));
    } catch {
      if (!active()) return;
      c.state = "error";
      c.detail = this.w("connectionFailed");
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
    // The first message in a ticket's topic gives the topic a conversation of its own.
    if (event.kind === "message") b = this.ownTopic(b);
    const press = event.kind === "action" ? this.startPress(b, event.token, event.actor.id, true) : null;
    if (press) {
      // Start pressed again before the first press is handled: that one start is all it asks for.
      const first = this.store.get<{ id: string }>("SELECT id FROM plugin_im_inbox WHERE binding_id = ? AND json_extract(event_json, '$.token') = ? AND json_extract(event_json, '$.actor.id') = ? LIMIT 1",
        b.id, (event as { token: string }).token, event.actor.id);
      if (first) return { receiptId: first.id };
    }
    this.store.run("INSERT INTO plugin_im_inbox (id, message_key, binding_id, event_json, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, messageKey, b.id, JSON.stringify(event), fingerprint, Date.now());
    // The card says so before anything slower runs, so the press shows at once and its buttons go.
    if (press) this.settleStart(b, press.card, this.startingText(b, press.item));
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
    const about = root ? undefined : this.topicRoot(b);
    return withContext(event.text, {
      ...(quoted ? { quoted: fromAdapter(quoted) } : kept ? { quoted: line(kept) } : {}),
      ...(root && root.messageId !== quotedId ? { root: fromAdapter(root) } : about ? { root: about } : {}),
      recent
    }, this.home.settings.locale());
  }

  /** A `/pair` code in a direct chat. The desktop confirms who it was; a wrong code counts toward withdrawing it. */
  private claim(c: Connection, event: ImInbound, code: string) {
    const pairing = this.pairings.get(c.id);
    const address = { tenantId: event.address.tenantId, conversationId: event.address.conversationId };
    if (!pairing || pairing.expiresAt < Date.now() || pairing.claim || pairing.code !== code) {
      if (pairing && !pairing.claim && ++pairing.failures >= PAIR_TRIES) this.pairings.delete(c.id);
      this.tell(c, address, this.w("pairWrong"));
      this.changed();
      return;
    }
    pairing.claim = { ...address, actorId: event.actor.id, ...(event.actor.name ? { name: event.actor.name } : {}), at: Date.now() };
    this.tell(c, address, this.w("pairReceived"));
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
        this.receipt(b, row, this.w("withdrawn"), anchor, true);
      }
      return;
    }
    if (row.state !== "queued" && row.state !== "accepted") return;
    this.enqueue(b, `edited:${row.id}:${event.eventId}`, { text: row.state === "queued"
      ? this.w("editQueued") : this.w("editRan") }, { anchor });
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
      // An open question holds nothing: as on the desktop, the agent reads the next message as its answer or as moving on.
      const row = rows.find(row => {
        const e = JSON.parse(row.event_json) as ImInbound;
        return e.kind === "action" || (e.kind === "message" && (isControl(row, e) || (!row.input_json && steering(e))));
      }) ?? (!busy ? rows[0] : undefined);
      if (busy) {
        const queue = this.waiting(rows).filter(r => r !== row);
        for (const [i, q] of queue.entries()) {
          this.receipt(b, q, this.w("queued", { n: i + 1 }),
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
        if (cmd === "spent") { this.accept(row); return; }
        if (cmd) { await this.choose(b, row, event.actor.id, cmd.kind, cmd.value ?? String([event.value ?? ""].flat()[0] ?? ""), reply, undefined, [event.value ?? ""].flat()[0]); return; }
        if (this.leftBehind(b, row, event.token, reply)) return;
        input = this.answer(b, event.token, event.actor.id, event.value);
      } else {
        const text = event.text.trim();
        const queue = this.waiting(rows).filter(r => r !== row);
        if (text === "/status") {
          const doing = this.activity.get(b.thread_id);
          const lines = [detail.pending ? this.w("waitingAnswer", { question: detail.pending.question.text })
            : busy ? (doing ? this.w("workingOn", { doing }) : this.w("working")) : this.w("noTask")];
          if (queue.length) lines.push(this.w("waitingCount", { n: queue.length }));
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
            : this.w("nothingWaiting") }, reply);
          this.accept(row); return;
        }
        const unqueue = /^\/unqueue\s+(\d+)$/.exec(text);
        if (unqueue) {
          const target = queue[Number(unqueue[1]) - 1];
          if (!target) this.refuse(this.w("noWaitingMessage", { n: unqueue[1] }));
          if ((JSON.parse(target.event_json) as ImInbound).actor.id !== event.actor.id) this.refuse(this.w("onlySenderWithdraws"));
          this.store.run("UPDATE plugin_im_inbox SET state = 'cancelled' WHERE id = ? AND state = 'queued'", target.id);
          if (this.capsOf(b)?.edit) this.receipt(b, target, this.w("withdrawn"), anchorOf(JSON.parse(target.event_json) as ImInbound), true);
          this.enqueue(b, `unqueue:${row.id}`, { text: this.w("withdrawnPreview", { preview: preview(target) }) }, reply);
          this.accept(row); return;
        }
        const steer = /^\/steer\s+([\s\S]+)$/.exec(text)?.[1].trim() ?? (!row.input_json && steering(event) ? text : null);
        if (steer !== null && running) {
          const engine = this.home.agent.engineOf(running.thread.engine);
          if (engine?.steers && await this.home.agent.steer(b.project_id, b.thread_id, `im:${row.id}`, steer)) {
            this.react(b, event.messageId, "received");
            if (!this.capsOf(b)?.reactions) this.enqueue(b, `steered:${row.id}`, { text: this.w("steered") }, reply);
            this.accept(row); return;
          }
          // Not taken: it waits for the turn to end like any message, and says so.
          this.store.run("UPDATE plugin_im_inbox SET input_json = ? WHERE id = ?", JSON.stringify({ kind: "text", text: steer }), row.id);
          this.enqueue(b, `steer-queued:${row.id}`, { text: engine?.steers
            ? this.w("steerBusy") : this.w("steerUnsupported") }, reply);
          return;
        }
        if (text === "/stop") {
          const run = this.home.agent.activeRuns().find(r => r.thread.id === b.thread_id);
          if ((run || detail.pending) && b.actor_id !== event.actor.id) this.refuse(this.w("onlyInitiatorStops"));
          const stopped = run ? this.home.agent.cancel(run.run.id) : this.home.agent.cancelWaiting(b.project_id, b.thread_id);
          this.store.run("UPDATE plugin_im_inbox SET state = 'cancelled' WHERE binding_id = ? AND state = 'queued' AND id != ?", b.id, row.id);
          this.enqueue(b, `stop:${row.id}`, { text: stopped ? this.w("stopRequested") : this.w("stoppedNothing") }, reply);
          this.accept(row); return;
        }
        if (text === "/new") {
          const th = this.openThread(this.settings.routes.find(r => r.id === b.route_id)!);
          this.rebind(b, th.id, 0, event.actor.id, rebound => {
            this.accept(row);
            this.enqueue(rebound, `new:${row.id}`, { text: this.w("newStarted") }, reply);
          });
          return;
        }
        if (await this.option(b, row, event, text, reply)) return;
        const match = /^\/answer\s+(\S+)(?:\s+([\s\S]+))?$/.exec(text);
        if (match && this.remoteAnswer(b, row, match[1], event.actor.id, match[2])) return;
        const cmd = match && this.commandOf(b, match[1], event.actor.id);
        if (cmd === "spent") { this.accept(row); return; }
        if (cmd) { await this.choose(b, row, event.actor.id, cmd.kind, cmd.value ?? match![2]?.trim() ?? "", reply, undefined, match![2]?.trim()); return; }
        if (match && this.leftBehind(b, row, match[1], reply)) return;
        if (match) input = this.answer(b, match[1], event.actor.id, match[2]);
        else {
          if (!text && !event.attachments?.length) this.refuse(this.w("emptyMessage"));
          if (row.input_json) input = JSON.parse(row.input_json) as UserInput;
          else if (steer !== null) input = { kind: "text", text: steer };
          else {
          const attachments = [];
          for (const ref of event.attachments ?? []) {
            const c = this.connections.get(b.connection_id);
            const adapter = c && this.adapters.get(c.adapterId);
            if (!adapter?.capabilities.inboundFiles || !c?.session?.download) this.refuse(this.w("noAttachments"));
            if (ref.size > Math.min(adapter.capabilities.maxFileBytes, MAX_MEDIA_BYTES)) this.refuse(this.w("attachmentTooLarge"));
            let bytes: Uint8Array;
            try { bytes = await deadline(c.session.download(ref), this.config.operationTimeoutMs); }
            catch { this.refuse(this.w("attachmentFailed")); }
            if (!this.current(c) || !this.authorizedBinding(b)) this.refuse(this.w("authChanged"));
            if (bytes.byteLength !== ref.size) this.refuse(this.w("attachmentSizeMismatch"));
            attachments.push(this.home.agent.uploadMedia(b.project_id, b.thread_id, { name: ref.name, mime: ref.mimeType, base64: Buffer.from(bytes).toString("base64") }));
          }
          input = { kind: "text", text: this.contextual(b, row, event), ...(attachments.length ? { attachments } : {}) };
          this.store.run("UPDATE plugin_im_inbox SET input_json = ? WHERE id = ?", JSON.stringify(input), row.id);
          }
        }
      }
      // A desktop turn may have started while attachment bytes were being downloaded.
      if (input.kind === "text" && this.home.agent.activeRuns().some(r => r.thread.id === b.thread_id)) return;
      // Identity is provenance, never a forged human author or a policy bypass.
      const { runId } = this.home.agent.send(b.project_id, b.thread_id, input, { requestId: `im:${row.id}`, source: {
        connection: b.connection_id, tenant: event.address.tenantId, conversation: event.address.conversationId,
        actor: event.actor.id, event: event.eventId
      } });
      if (input.kind === "text") this.store.run("UPDATE plugin_im_bindings SET actor_id = ?, anchor = ? WHERE id = ?", event.actor.id, reply.anchor, b.id);
      if (event.kind === "message") this.react(b, event.messageId, "received");
      if (input.kind === "text" && this.capsOf(b)?.edit && this.store.get("SELECT 1 FROM plugin_im_outbox WHERE id = ?", `queued:${row.id}`)) {
        this.replace(b, `queued:${row.id}`, { text: this.w("runningNow") });
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
        // A Start press shown as under way, then refused, says on its card that nothing started.
        const press = event.kind === "action" ? this.startPress(b, event.token, event.actor.id, false) : null;
        if (press) this.settleStart(b, press.card, this.w("notStarted", { key: press.item.key }));
        // In a group, a refusal is for the sender only where the platform can say so privately.
        if (this.authorizedBinding(b)) this.enqueue(b, `input-error:${row.id}`, { text: this.w("cannotProcess", { error: errorText(e) }) },
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
    return this.store.bindings().filter(b => b.project_id === projectId && b.thread_id === threadId && this.authorizedBinding(b) && this.topicOf(b)?.own !== 0).map(b => ({
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
    // Whoever started the IM conversation or watches its ticket, or everyone who paired with the desktop for a thread only the desktop knows.
    const itemId = this.home.agent.store.thread(n.projectId, n.threadId)?.itemId;
    const watching = itemId ? this.store.all<Watch>("SELECT * FROM plugin_im_watch WHERE project_id = ? AND item_id = ?", n.projectId, itemId)
      .map(w => this.store.binding(w.binding_id)).filter((b): b is Binding => !!b && this.authorizedBinding(b)) : [];
    const known = [...bound, ...watching];
    const people = known.length ? known.map(b => [b.connection_id, b.actor_id] as const)
      : this.settings.identities.map(i => [i.connectionId, i.actorId] as const);
    const pending = n.kind === "stuck" ? null : detail.pending;
    let reached = false;
    for (const [connectionId, actorId] of new Map(people.map(p => [p.join("\u0000"), p])).values()) {
      const dm = this.directChat(connectionId, actorId);
      if (!dm || !this.notifies(dm, "attention")) continue;
      const head = `**${n.title}**${n.body ? `\n${n.body}` : ""}\n[${this.w("openInTomrade")}](${links.thread(n.projectId, n.threadId)})`;
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
    if (question.freeText || (pending.accepts === "text" && !options.length)) elements.push({ type: "input", token: issue(null), label: this.w("yourAnswer") });
    return { text: `${head}\n\n${question.text}`, actions, ...(elements.length ? { elements } : {}) };
  }

  /** An answer from a reminder's buttons. True when the token was a reminder's. */
  private remoteAnswer(b: Binding, row: Inbox, actionToken: string, actorId: string, value?: string | string[]): boolean {
    const a = this.store.get<Action>("SELECT * FROM plugin_im_actions WHERE token = ?", actionToken);
    const [, projectId, questionId] = /^remind:([^:]+):(.+)$/.exec(a?.question_id ?? "") ?? [];
    if (!a || !projectId) return false;
    const pending = this.home.db.has(projectId) ? this.home.agent.thread(projectId, a.thread_id).pending : null;
    if (a.binding_id !== b.id || a.actor_id !== actorId || a.expires_at < Date.now() || a.consumed || pending?.question.id !== questionId) {
      this.refuse(this.w("questionGone"));
    }
    let answer: unknown = a.value_json === null ? value : JSON.parse(a.value_json);
    if (pending.question.multiple && typeof answer === "string") {
      try { answer = JSON.parse(answer); } catch { this.refuse(this.w("jsonArray")); }
    }
    const options = pending.question.options ?? [];
    const valid = pending.question.multiple
      ? Array.isArray(answer) && answer.every(v => typeof v === "string" && (pending.question.freeText || options.includes(v)))
      : typeof answer === "string" && (pending.accepts === "text" || pending.question.freeText || options.includes(answer));
    if (!valid) this.refuse(this.w("invalidAnswer"));
    const event = JSON.parse(row.event_json) as ImInbound;
    this.home.agent.send(projectId, a.thread_id, { kind: "answer", questionId, value: answer as string | string[] }, { requestId: `im:${row.id}`, source: {
      connection: b.connection_id, tenant: event.address.tenantId, conversation: event.address.conversationId, actor: actorId, event: event.eventId
    } });
    this.store.run("UPDATE plugin_im_actions SET consumed = 1, retired = 1 WHERE binding_id = ? AND question_id = ?", b.id, a.question_id);
    const said = Array.isArray(answer) ? answer.join(", ") : String(answer);
    this.enqueue(b, `remind-answered:${row.id}`, { text: this.w("answered", { said }) }, { anchor: null });
    this.accept(row);
    return true;
  }

  /** "Online" or "going offline" in each direct chat on the connection; best effort. */
  private async presence(c: Connection, online: boolean) {
    const caps = this.caps.get(c.adapterId);
    if (!caps || !c.session || c.state !== "connected") return;
    const chats = new Map(this.store.bindings().filter(b => b.connection_id === c.id && !this.isGroup(b) && this.authorizedBinding(b) && this.notifies(b, "presence"))
      .map(b => [b.address_json, JSON.parse(b.address_json) as ImAddress]));
    const { w } = this;
    const text = online ? w("online") : w("goingOffline");
    const [content] = prepare({ text }, caps, w);
    await Promise.all([...chats.values()].map(address =>
      deadline(c.session!.deliver({ operationId: `presence:${token()}`, address, content }), Math.min(2_000, this.config.operationTimeoutMs)).catch(() => {})));
  }

  /** A new conversation the way the route opens one: its engine, options and permission mode. */
  private openThread(route: ImRoute, title?: string) {
    const th = this.home.agent.newThread(route.projectId, route.engine, route.boardId, { surface: "assistant", ...(title ? { title } : {}), ...(route.options ? { options: route.options } : {}) });
    if (route.permissionMode) {
      try { this.home.agent.setPermissionMode(route.projectId, th.id, route.permissionMode); } catch { /* the engine changed since the route was saved; its default applies */ }
    }
    return th;
  }

  /**
   * Points the IM conversation at another thread. Only what that thread says from now on is sent; its history stays on the desktop.
   * `home` is the conversation to go back to once a ticket's thread is archived.
   */
  private rebind(b: Binding, threadId: string, cursor: number, actorId: string, also: (rebound: Binding) => void, opts: { home?: string } = {}) {
    this.store.db.transaction(() => {
      this.store.run("UPDATE plugin_im_outbox SET state = 'cancelled' WHERE binding_id = ? AND state IN ('queued', 'uncertain', 'failed')", b.id);
      this.store.run("UPDATE plugin_im_actions SET consumed = max(consumed, 1), retired = 1 WHERE binding_id = ?", b.id);
      this.store.run("UPDATE plugin_im_bindings SET thread_id = ?, cursor = ?, actor_id = ?, anchor = NULL, home_thread = ? WHERE id = ?", threadId, cursor, actorId, opts.home ?? null, b.id);
      // An open question's card stops offering choices and says where it waits. The edit is its own row on the new
      // thread, so the card's row stays the old thread's and lights up again on a /switch back.
      const asked = this.capsOf(b)?.cardUpdate ? this.home.agent.store.pending(b.project_id, b.thread_id)?.question : undefined;
      if (asked) this.store.run(`INSERT INTO plugin_im_outbox (id, binding_id, thread_id, content_json, created_at, anchor, visible_to, message_ids_json)
        SELECT ?, binding_id, ?, ?, ?, anchor, visible_to, message_ids_json FROM plugin_im_outbox WHERE id = ? AND message_ids_json != '[]'`,
        `left:${b.id}:${asked.id}:${token()}`, threadId, JSON.stringify({ text: `${asked.text}\n\n${this.waitsIn(b, b.thread_id)}` }), Date.now(), `question:${b.id}:${asked.id}`);
      // What says so goes out on the new thread; one queued on the old would be dropped as stale.
      also(this.store.binding(b.id)!);
    });
    this.listed.delete(b.id);
  }

  /** Where a question this conversation moved away from still waits. */
  private waitsIn(b: Binding, threadId: string): string {
    const thread = this.home.agent.store.thread(b.project_id, threadId);
    const title = thread?.title || this.w("untitled");
    return this.w(thread?.archived ? "questionArchived" : "questionStays", { title });
  }

  /** A choice from a question left open in a conversation this one moved away from: says where it waits instead of refusing it. */
  private leftBehind(b: Binding, row: Inbox, actionToken: string, reply: { anchor: string | null }): boolean {
    const a = this.store.get<Action>("SELECT * FROM plugin_im_actions WHERE token = ?", actionToken);
    if (!a || a.binding_id !== b.id || a.thread_id === b.thread_id || /^(cmd|remind):/.test(a.question_id)) return false;
    if (this.home.agent.store.pending(b.project_id, a.thread_id)?.question.id !== a.question_id) return false;
    this.enqueue(b, `left:${row.id}`, { text: this.waitsIn(b, a.thread_id) }, reply);
    this.accept(row);
    return true;
  }

  /**
   * The thread this conversation follows was archived — its ticket done, or put away on the desktop. It goes back to
   * the conversation it left for the ticket, or a new one, and says so; messages waiting go to that one.
   */
  private leaveArchived(b: Binding): Binding {
    const left = this.home.agent.store.thread(b.project_id, b.thread_id);
    if (left && !left.archived) return b;
    // A ticket's topic goes back to holding the group's conversation; the next message there opens a new one.
    const topic = this.topicOf(b);
    if (topic) return topic.own ? this.release(b, topic) : b;
    const back = b.home_thread ? this.home.agent.store.thread(b.project_id, b.home_thread) : undefined;
    const target = back && !back.archived && back.surface === "assistant" ? back : this.openThread(this.settings.routes.find(r => r.id === b.route_id)!);
    const cursor = target === back ? this.home.agent.thread(b.project_id, target.id).messages.at(-1)?.seq ?? 0 : 0;
    const item = left?.itemId ? this.items()?.get(b.project_id, left.itemId) : null;
    const { w } = this;
    const was = item ? (item.status === "done" ? w("itemDone", { key: item.key }) : w("itemSessionArchived", { key: item.key }))
      : w("threadArchived", { title: left?.title || w("untitled") });
    const title = target.title || w("untitled");
    let rebound = b;
    this.rebind(b, target.id, cursor, b.actor_id, r => {
      rebound = r;
      this.enqueue(r, `home:${b.id}:${b.thread_id}`, { text: target === back ? w("backTo", { was, title }) : w("newAfterArchive", { was }) }, { anchor: null });
    });
    return rebound;
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
  private commandOf(b: Binding, actionToken: string, actorId: string): { kind: string; value?: string } | "spent" | null {
    const a = this.store.get<Action>("SELECT * FROM plugin_im_actions WHERE token = ?", actionToken);
    if (!a?.question_id.startsWith("cmd:")) return null;
    // A delivery is reviewed by whoever the conversation started with, or by anyone paired with this computer.
    const mine = a.actor_id === actorId || (a.question_id === "cmd:delivery" && this.paired(b, actorId));
    // A second click on a card that is starting, or started, already has its answer on the card.
    if (a.binding_id === b.id && mine && a.consumed === 2) return "spent";
    if (a.binding_id !== b.id || a.thread_id !== b.thread_id || !mine || a.expires_at < Date.now() || a.consumed) {
      this.refuse(this.w("choiceExpired"));
    }
    // A start card's selects stay live while it shows; Start spends them all.
    if (!a.question_id.startsWith("cmd:start-set:")) this.store.run("UPDATE plugin_im_actions SET consumed = 1, retired = 1 WHERE token = ?", actionToken);
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

  /** `/sessions`, `/switch`, `/archive`, `/engine`, `/model`, `/effort`, `/mode`, `/start`. True when the message was one. */
  private async option(b: Binding, row: Inbox, event: ImInbound & { kind: "message" }, text: string, reply: { anchor: string | null }): Promise<boolean> {
    const [, name, arg = ""] = /^\/(sessions|switch|archive|engine|model|effort|mode|start)(?:\s+([\s\S]+))?$/.exec(text) ?? [];
    if (!name) return false;
    const actor = event.actor.id;
    if (name === "start") {
      const [key, ...args] = arg.trim().split(/\s+/).filter(Boolean);
      if (!key) this.refuse(this.w("nameTicket"));
      if (!this.code()) this.refuse(this.w("needsCodeLink"));
      if (this.isGroup(b) && actor !== b.actor_id) this.refuse(this.w("onlyOwnerStarts"));
      const item = this.startable(b.project_id, key.toUpperCase());
      if (!item) this.refuse(this.w("noTicket", { key }));
      let draft = await this.draftFor(item, `start:${b.id}:${item.id}:${row.id}`);
      if (args.length) draft = await this.withArgs(b.project_id, item, draft, args);
      // Named settings in a direct chat are the start itself; a group, or a bare /start, sees what will run first.
      if (args.length && !this.isGroup(b)) await this.startNow(b, row, actor, draft, reply);
      else { await this.startCard(b, actor, draft, reply); this.accept(row); }
      return true;
    }
    const { thread } = this.home.agent.thread(b.project_id, b.thread_id);
    if (name === "sessions") {
      const threads = this.home.agent.store.threads(b.project_id, "assistant").slice(0, 20);
      this.listed.set(b.id, threads.map(t => t.id));
      const running = new Set(this.home.agent.activeRuns().map(r => r.thread.id));
      const { w } = this;
      const lines = threads.map((t, i) => `${i + 1}. ${t.title || w("untitled")} · ${this.home.agent.engineOf(t.engine)?.title ?? t.engine} · ${this.ago(t.updatedAt)}`
        + (t.id === b.thread_id ? w("here") : running.has(t.id) ? w("running") : ""));
      this.choices(b, `sessions:${row.id}`, actor, "switch", lines.length
        ? [...lines, w("switchHint")].join("\n")
        : w("noConversations"),
        threads.filter(t => t.id !== b.thread_id).map(t => ({ label: t.title || w("untitled"), value: t.id })), reply);
      this.accept(row); return true;
    }
    if (name === "switch") {
      const [, n, confirm] = /^(\d+)(\s+confirm)?$/i.exec(arg.trim()) ?? [];
      const ids = this.listed.get(b.id) ?? this.home.agent.store.threads(b.project_id, "assistant").slice(0, 20).map(t => t.id);
      const target = n ? ids[Number(n) - 1] : undefined;
      if (!target) this.refuse(this.w("pickNumber"));
      await this.choose(b, row, actor, confirm ? "switch!" : "switch", target, reply, n);
      return true;
    }
    if (name === "archive") {
      if (this.home.agent.activeRuns().some(r => r.thread.id === b.thread_id)) this.refuse(this.w("stopBeforeArchive"));
      this.home.agent.archiveThread(b.project_id, b.thread_id);
      const th = this.openThread(this.settings.routes.find(r => r.id === b.route_id)!);
      this.rebind(b, th.id, 0, actor, rebound => {
        this.accept(row);
        this.enqueue(rebound, `archive:${row.id}`, { text: this.w("archived", { title: thread.title || this.w("untitled") }) }, reply);
      });
      return true;
    }
    const engine = this.home.agent.engineOf(thread.engine);
    if (name === "engine") {
      if (!arg) {
        const views = (await this.home.agent.engineViews()).filter(v => v.ok && !v.terminalOnly);
        this.choices(b, `engine:${row.id}`, actor, "engine",
          [this.w("currentAssistant", { engine: engine?.title ?? thread.engine }), ...views.map(v => `- ${v.title} (${v.id})`), this.w("engineHint")].join("\n"),
          views.filter(v => v.id !== thread.engine).map(v => ({ label: v.title, value: v.id })), reply);
        this.accept(row); return true;
      }
      await this.choose(b, row, actor, "engine", arg.trim(), reply); return true;
    }
    if (name === "mode") {
      const modes = engine?.permissionModes;
      if (!modes) this.refuse(this.w("noModes"));
      if (!arg) {
        const current = thread.permissionMode ?? modes.default;
        this.choices(b, `mode:${row.id}`, actor, "mode",
          [this.w("currentMode", { mode: modes.choices.find(c => c.value === current)?.label ?? current }),
            ...modes.choices.map(c => `- ${c.label} (${c.value})`), this.w("modeHint")].join("\n"),
          modes.choices.map(c => ({ label: c.label, value: c.value })), reply);
        this.accept(row); return true;
      }
      await this.choose(b, row, actor, "mode", arg.trim(), reply); return true;
    }
    // model, effort: the engine's own picks.
    const pick = engine?.picks?.().find(p => p.key === name);
    if (!pick) this.refuse(name === "model" ? this.w("noModelChoice") : this.w("noEffortChoice"));
    if (!arg) {
      const current = thread.options?.[name];
      this.choices(b, `${name}:${row.id}`, actor, name,
        [`${pick.title}: ${typeof current === "string" ? current : this.w("default")}`, ...pick.choices.map(c => `- ${c.label ?? c.value}${c.label ? ` (${c.value})` : ""}`),
          this.w("pickHint", { name })].join("\n"),
        [{ label: this.w("defaultOption"), value: "default" }, ...pick.choices.map(c => ({ label: c.label ?? c.value, value: c.value }))], reply);
      this.accept(row); return true;
    }
    await this.choose(b, row, actor, name, arg.trim(), reply); return true;
  }

  /** Applies a choice, from a typed command or from the select or button it offered; `picked` is what a select carrying its own value was set to. */
  private async choose(b: Binding, row: Inbox, actorId: string, kind: string, value: string, reply: { anchor: string | null }, n?: string, picked?: string) {
    const { thread } = this.home.agent.thread(b.project_id, b.thread_id);
    const running = this.home.agent.activeRuns().some(r => r.thread.id === b.thread_id);
    const when = running ? this.w("appliesNextTurn") : "";
    const done = (text: string, on = b) => { this.enqueue(on, `${kind}:${row.id}`, { text }, reply); this.accept(row); };
    if (kind === "proposal") {
      const [, verdict, projectId, proposalId] = /^(accept|reject):([^:]+):(.+)$/.exec(value) ?? [];
      const code = this.code();
      if (!verdict || !code || projectId !== b.project_id) this.refuse(this.w("choiceGone"));
      // Settled from here, so the change it causes is not news of a settlement elsewhere; a ticket's topic hears through its group.
      for (const w of this.store.all<Watch>("SELECT * FROM plugin_im_watch WHERE binding_id IN (?, ?)", b.id, this.topicOf(b)?.parent_id ?? b.id)) {
        const seen = JSON.parse(w.seen_json) as CodeSeen;
        if (seen.proposals.includes(proposalId)) this.store.run("UPDATE plugin_im_watch SET seen_json = ? WHERE binding_id = ? AND item_id = ?",
          JSON.stringify({ ...seen, proposals: seen.proposals.filter(id => id !== proposalId) }), w.binding_id, w.item_id);
      }
      const settled = code.resolve(projectId, proposalId, verdict === "accept");
      this.settleProposal(b, proposalId, settled.state === "accepted" ? this.w("proposalAccepted")
        : settled.state === "rejected" ? this.w("proposalDismissed") : this.w("proposalGone"));
      this.accept(row);
      return;
    }
    if (kind === "delivery" || kind.startsWith("delivery-changes:")) {
      const [verdict, projectId, itemId, submissionId] = kind === "delivery" ? value.split(":") : ["changes!", ...kind.slice("delivery-changes:".length).split(":")];
      const host = this.reviews();
      const item = host && projectId === b.project_id ? host.get(projectId, itemId) : null;
      if (!host || !item) this.refuse(this.w("choiceGone"));
      if (awaitingReview(item)?.id !== submissionId) {
        this.settleDelivery(b, submissionId, reviewOutcome(this.w, item, submissionId));
        this.refuse(this.w("deliveryGone"));
      }
      if (verdict === "changes") {
        const t = this.offer(b, `delivery-changes:${projectId}:${itemId}:${submissionId}`, actorId);
        const ask = this.w("whatShouldChange", { key: item.key });
        const input = this.capsOf(b)?.textInput;
        this.enqueue(b, `delivery-ask:${b.id}:${submissionId}:${row.id}`, input
          ? { text: ask, elements: [{ type: "input", token: t, label: this.w("changesLabel") }] }
          : { text: `${ask}\n${this.w("changesHint", { token: t })}` }, { ...reply, visibleTo: reply.anchor ? actorId : null });
        this.accept(row); return;
      }
      const said = value.trim();
      if (verdict === "changes!" && !said) this.refuse(this.w("sayWhatChanges"));
      const who = this.who(b, actorId);
      // Their own words, as review_delivery keeps them, and who gave the verdict from where.
      const comment = verdict === "accept" ? `Accepted in IM by ${who}` : `${said}\n\nRequested in IM by ${who}`;
      host.reviewDelivery(projectId, item.id, { submissionId, decision: verdict === "accept" ? "accepted" : "changes-requested", comment }, item.version);
      this.settleDelivery(b, submissionId, verdict === "accept" ? this.w("acceptedBy", { who })
        : this.w("changesBy", { who, said }));
      this.accept(row);
      return;
    }
    if (kind === "follow") { this.follow(b, row, actorId, value, reply); return; }
    if (kind === "start" || kind === "start-adjust" || kind === "start!" || kind.startsWith("start-set:")) {
      const given = JSON.parse(value) as Partial<StartDraft> & { itemId: string };
      const item = this.code() ? this.startable(b.project_id, given.itemId) : null;
      if (!item) this.refuse(this.w("choiceGone"));
      if (kind === "start!") { await this.startNow(b, row, actorId, given as StartDraft, reply); return; }
      if (kind.startsWith("start-set:")) {
        const knob = kind.slice("start-set:".length);
        const draft = given as StartDraft;
        const chosen = picked?.trim() ?? "";
        if (!chosen) this.refuse(this.w("pickValue"));
        await this.startCard(b, actorId, await this.withArgs(b.project_id, item, draft, [`${knob}=${chosen}`]), reply, true);
        this.accept(row); return;
      }
      // A group sees what will run before it runs; so does the person who asked to adjust it.
      const now = kind === "start" && !this.isGroup(b);
      // Started at once, the card clicked is the one that says so.
      const drafted = await this.draftFor(item, now && given.card ? given.card : `start:${b.id}:${item.id}:${row.id}`);
      const draft = given.task ? { ...drafted, task: given.task } : drafted;
      if (now) await this.startNow(b, row, actorId, draft, reply);
      else { await this.startCard(b, actorId, draft, reply); this.accept(row); }
      return;
    }
    if (kind === "switch" || kind === "switch!") {
      const target = this.home.agent.store.thread(b.project_id, value);
      if (!target || target.archived || target.surface !== "assistant") this.refuse(this.w("cantContinue"));
      if (target.id === b.thread_id) { done(this.w("alreadyHere")); return; }
      if (this.home.agent.activeRuns().some(r => r.thread.id === target.id)) this.refuse(this.w("conversationRunning"));
      if (running) this.refuse(this.w("stopFirst"));
      const title = target.title || this.w("untitled");
      // In a group, the conversation's history becomes visible to everyone there; the person who asked confirms.
      if (kind === "switch" && this.isGroup(b)) {
        const caps = this.capsOf(b);
        const confirm = caps?.buttons ? [{ label: this.w("continueHere"), token: this.offer(b, "switch!", actorId), style: "primary" as const }] : [];
        // The button carries the conversation in its own row, as a select would.
        if (confirm.length) this.store.run("UPDATE plugin_im_actions SET value_json = ? WHERE token = ?", JSON.stringify(target.id), confirm[0].token);
        this.enqueue(b, `switch-confirm:${row.id}`, { text: this.w("switchConfirm", { title, reply: confirm.length ? "" : this.w("switchConfirmReply", { n: n ?? "" }) }), actions: confirm }, { ...reply, visibleTo: reply.anchor ? actorId : null });
        this.accept(row); return;
      }
      const cursor = this.home.agent.thread(b.project_id, target.id).messages.at(-1)?.seq ?? 0;
      this.rebind(b, target.id, cursor, actorId, rebound => done(this.w("continuingHere", { title }), rebound));
      return;
    }
    if (kind === "engine") {
      const views = (await this.home.agent.engineViews()).filter(v => v.ok && !v.terminalOnly);
      const target = views.find(v => v.id === value || v.title.toLowerCase() === value.toLowerCase());
      if (!target) this.refuse(this.w("noAssistant", { value }));
      if (running) this.refuse(this.w("engineBusy"));
      this.home.agent.setEngine(b.project_id, b.thread_id, target.id);
      done(this.w("assistantSet", { engine: target.title })); return;
    }
    if (kind === "mode") {
      const choice = this.home.agent.engineOf(thread.engine)?.permissionModes?.choices.find(c => c.value === value || c.label.toLowerCase() === value.toLowerCase());
      if (!choice) this.refuse(this.w("noMode", { value }));
      this.home.agent.setPermissionMode(b.project_id, b.thread_id, choice.value);
      done(this.w("modeSet", { mode: choice.label, when })); return;
    }
    const pick = this.home.agent.engineOf(thread.engine)?.picks?.().find(p => p.key === kind);
    if (!pick) this.refuse(this.w("choiceGone"));
    const { [kind]: _old, ...rest } = thread.options ?? {};
    let options: Record<string, unknown> = rest;
    if (value.toLowerCase() !== "default") {
      const chosen = pick.choices.find(c => c.value === value || c.label?.toLowerCase() === value.toLowerCase())?.value ?? (pick.freeText ? value : undefined);
      if (!chosen) this.refuse(this.w("noPickValue", { title: pick.title, value, kind }));
      options = { ...rest, [kind]: chosen };
    }
    try { this.home.agent.setOptions(b.project_id, b.thread_id, Object.keys(options).length ? options : null); }
    catch { this.refuse(this.w("pickRefused", { title: pick.title })); }
    const set = options[kind];
    done(this.w("pickSet", { title: pick.title, value: typeof set === "string" ? set : this.w("default"), when }));
  }

  /** A ticket that can be started here, by id or key. */
  private startable(projectId: string, idOrKey: string): Startable | null {
    const items = this.home.get("items") as { get(projectId: string, id: string): Startable | null; getByKey(projectId: string, key: string): Startable | null } | undefined;
    const item = items?.get(projectId, idOrKey) ?? items?.getByKey(projectId, idOrKey) ?? null;
    return item?.kind === "ticket" ? item : null;
  }

  /** Engines that can run headless here, as the Start dialog offers them. */
  private async headless() { return (await this.home.agent.engineViews()).filter(v => v.ok && !v.terminalOnly); }

  /** The methods a General ticket can be delivered with, as the Start dialog lists them. */
  private methods(projectId: string) {
    return this.home.agent.playbookIndex(projectId)
      .filter(p => !p.id.startsWith("backlog.") && !p.id.startsWith("code.") && (p.workTypes?.length ? p.workTypes.includes("general") : p.source !== "plugin"));
  }

  /** A ticket's start by default: what this computer last started with, where it still fits. */
  private async draftFor(item: Startable, card: string): Promise<StartDraft> {
    const remembered = this.code()?.startDefaults() ?? null;
    const engines = await this.headless();
    const engine = engines.find(e => e.id === remembered?.engine)?.id ?? engines[0]?.id;
    const same = !!engine && engine === remembered?.engine;
    const options = Object.fromEntries(Object.entries(same ? remembered?.options ?? {} : {}).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1]));
    const playbook = item.workType === "general" ? item.playbookId ?? remembered?.playbook : undefined;
    return { itemId: item.id, card, ...(engine ? { engine } : {}), ...(Object.keys(options).length ? { options } : {}),
      ...(same && remembered?.permissionMode && item.workType !== "general" ? { permissionMode: remembered.permissionMode } : {}), ...(playbook ? { playbook } : {}) };
  }

  /** `engine=… model=… effort=… mode=… playbook=…` over a draft; a new engine starts from its own defaults. */
  private async withArgs(projectId: string, item: Startable, draft: StartDraft, args: string[]): Promise<StartDraft> {
    const engines = await this.headless();
    const pairs = args.map(a => { const [k, ...v] = a.split("="); return [k.toLowerCase(), v.join("=")] as const; });
    let next: StartDraft = { ...draft, ...(draft.options ? { options: { ...draft.options } } : {}) };
    for (const [k, v] of [...pairs.filter(p => p[0] === "engine"), ...pairs.filter(p => p[0] !== "engine")]) {
      if (!v) this.refuse(this.w("giveValue", { k }));
      if (k === "engine") {
        const target = engines.find(e => e.id === v || e.title.toLowerCase() === v.toLowerCase());
        if (!target) this.refuse(this.w("noEngineHere", { value: v }));
        if (target.id !== next.engine) next = { itemId: next.itemId, card: next.card, engine: target.id, ...(next.playbook ? { playbook: next.playbook } : {}), ...(next.task ? { task: next.task } : {}) };
        continue;
      }
      const engine = engines.find(e => e.id === next.engine);
      if (k === "mode") {
        const choice = item.workType === "general" ? undefined : engine?.permissionModes?.choices.find(c => c.value === v || c.label.toLowerCase() === v.toLowerCase());
        if (!choice) this.refuse(this.w("noStartMode", { value: v }));
        next.permissionMode = choice.value; continue;
      }
      if (k === "playbook") {
        const method = item.workType === "general" ? this.methods(projectId).find(m => m.id === v || m.title.toLowerCase() === v.toLowerCase()) : undefined;
        if (!method) this.refuse(this.w("noMethod", { value: v }));
        next.playbook = method.id; continue;
      }
      const pick = engine?.picks?.find(p => p.key === k);
      if (!pick) this.refuse(this.w("noSetting", { k }));
      const { [k]: _old, ...rest } = next.options ?? {};
      if (v.toLowerCase() === "default") { next.options = rest; continue; }
      const chosen = pick.choices.find(c => c.value === v || c.label?.toLowerCase() === v.toLowerCase())?.value ?? (pick.freeText ? v : undefined);
      if (!chosen) this.refuse(this.w("noPick", { title: pick.title, value: v }));
      next.options = { ...rest, [k]: chosen };
    }
    if (next.options && !Object.keys(next.options).length) delete next.options;
    return next;
  }

  /**
   * What a start will run with, and Start. Where the platform has selects,
   * one per setting changes it in place; elsewhere `/start KEY k=v` does. In a
   * group this card is also the confirmation that the group will see the work.
   */
  private async startCard(b: Binding, actorId: string, draft: StartDraft, reply: { anchor: string | null }, update = false) {
    const item = this.startable(b.project_id, draft.itemId);
    if (!item) this.refuse(this.w("cantStart"));
    const engines = await this.headless();
    const engine = engines.find(e => e.id === draft.engine);
    const general = item.workType === "general";
    const picks = engine?.picks ?? [];
    const modes = general ? undefined : engine?.permissionModes;
    const methods = general ? this.methods(b.project_id) : [];
    const continuing = this.continuing(b, item.id);
    const { w } = this;
    const lines = [continuing ? w("startContinue", { key: item.key, title: item.title }) : w("startStart", { key: item.key, title: item.title }),
      `${w("agent")}: ${engine?.title ?? w("noAgentHere")}`];
    for (const p of picks) {
      const v = draft.options?.[p.key];
      lines.push(`${p.title}: ${v ? p.choices.find(c => c.value === v)?.label ?? v : w("default")}`);
    }
    if (modes) {
      const v = draft.permissionMode ?? modes.default;
      lines.push(`${w("permissionMode")}: ${modes.choices.find(c => c.value === v)?.label ?? v}`);
    }
    if (general) lines.push(`${w("method")}: ${methods.find(m => m.id === draft.playbook)?.title ?? draft.playbook ?? w("ticketsMethod")}`);
    if (draft.task) lines.push(w("startTask", { task: draft.task }));
    if (this.isGroup(b)) lines.push(w("groupSeesWork"));
    // A card changed in place keeps its tokens, each now carrying the new settings, so a choice made before the edit shows still applies.
    const live = new Map(this.store.all<Action>("SELECT * FROM plugin_im_actions WHERE binding_id = ? AND question_id LIKE 'cmd:start%' AND consumed = 0 AND value_json LIKE ?", b.id, `%${draft.card}%`)
      .map(a => [a.question_id.slice("cmd:".length), a.token]));
    const used = new Set<string>();
    const value = JSON.stringify(draft);
    const keep = (kind: string) => {
      const t = live.get(kind) ?? this.offer(b, kind, actorId);
      used.add(t);
      this.store.run("UPDATE plugin_im_actions SET value_json = ?, expires_at = ? WHERE token = ?", JSON.stringify(value), Date.now() + this.config.actionTtlMs, t);
      return t;
    };
    const set = (knob: string) => keep(`start-set:${knob}`);
    const selects: ImElement[] = [];
    if (this.capsOf(b)?.select) {
      if (engines.length > 1) selects.push({ type: "select", token: set("engine"), placeholder: w("agent"), options: engines.slice(0, 24).map(e => ({ label: e.title, value: e.id })) });
      for (const p of picks) selects.push({ type: "select", token: set(p.key), placeholder: p.title,
        options: [{ label: w("defaultOption"), value: "default" }, ...p.choices.map(c => ({ label: c.label ?? c.value, value: c.value }))].slice(0, 24) });
      if (modes) selects.push({ type: "select", token: set("mode"), placeholder: w("permissionMode"), options: modes.choices.slice(0, 24).map(c => ({ label: c.label, value: c.value })) });
      if (methods.length > 1) selects.push({ type: "select", token: set("playbook"), placeholder: w("method"), options: methods.slice(0, 24).map(m => ({ label: m.title, value: m.id })) });
    } else {
      const knobs = ["engine=…", ...picks.map(p => `${p.key}=…`), ...(modes ? ["mode=…"] : []), ...(general ? ["playbook=…"] : [])].join(" ");
      lines.push(w("changeHint", { key: item.key, knobs }));
    }
    const content: ImContent = { text: lines.join("\n"), ...(selects.length ? { elements: selects } : {}),
      actions: engine ? [{ label: continuing ? w("continue") : w("start"), token: keep("start!"), style: "primary" }] : [] };
    for (const t of live.values()) if (!used.has(t)) this.store.run("UPDATE plugin_im_actions SET consumed = 1, retired = 1 WHERE token = ?", t);
    if (update) this.replace(b, draft.card, content);
    else this.enqueue(b, draft.card, content, { ...reply, visibleTo: reply.anchor ? actorId : null });
  }

  /** Whether a ticket already has work to pick up, so Start reads as Continue. */
  private continuing(b: Binding, itemId: string): boolean {
    try { const code = this.code()?.summary(b.project_id, itemId); return !!code && (!!code.session || code.links.length > 0); } catch { return false; }
  }

  /** Start and Adjust settings on a start card, for the person this conversation is with. */
  private startActions(b: Binding, content: ImContent, block: Block, card: string): ImContent {
    const data = block.type === "card" && block.schema === "start" ? (block.data ?? {}) as Record<string, unknown> : null;
    if (!data || typeof data.itemId !== "string" || !this.code()) return content;
    const value = JSON.stringify({ itemId: data.itemId, card, ...(typeof data.task === "string" && data.task ? { task: data.task } : {}) });
    return { ...content, actions: [
      { label: this.continuing(b, data.itemId) ? this.w("continue") : this.w("start"), token: this.offerValue(b, "start", b.actor_id, value), style: "primary" },
      { label: this.w("adjust"), token: this.offerValue(b, "start-adjust", b.actor_id, value) }
    ] };
  }

  /** The start card a Start press belongs to, when pressing it starts the work rather than showing the settings first. `fresh` asks for a press not yet handled. */
  private startPress(b: Binding, actionToken: string, actorId: string, fresh: boolean): { card: string; item: { id: string; key: string } } | null {
    const a = this.store.get<Action>("SELECT * FROM plugin_im_actions WHERE token = ?", actionToken);
    if (!a?.value_json || a.binding_id !== b.id || a.actor_id !== actorId || a.thread_id !== b.thread_id) return null;
    if (fresh && (a.consumed || a.expires_at < Date.now())) return null;
    if (a.question_id !== "cmd:start!" && (a.question_id !== "cmd:start" || this.isGroup(b))) return null;
    let given: Partial<StartDraft>;
    try { given = JSON.parse(JSON.parse(a.value_json) as string) as Partial<StartDraft>; } catch { return null; }
    const item = given.itemId && given.card ? this.items()?.get(b.project_id, given.itemId) : null;
    return item ? { card: given.card!, item } : null;
  }

  private startingText(b: Binding, item: { id: string; key: string }): string {
    return this.continuing(b, item.id) ? this.w("continuingKey", { key: item.key }) : this.w("startingKey", { key: item.key });
  }

  /** The card, where this platform can change a message it sent. */
  private editableCard(b: Binding, card: string): string | null {
    return (this.capsOf(b)?.cardUpdate || this.capsOf(b)?.edit) && this.store.get("SELECT 1 FROM plugin_im_outbox WHERE id = ? AND binding_id = ?", card, b.id) ? card : null;
  }

  /** No working folder, said by its cause with what names the fix — never the bare "no folder". */
  private workdirReason(result: Extract<StartOutcome, { ok: false }>): string {
    const { w } = this;
    const board = result.board?.name ?? "";
    const cause = result.cause;
    switch (cause?.code) {
      case "no-board": return w("workdirNoBoard");
      case "no-board-repo": return w("workdirNoBoardRepo", { board });
      case "unknown-repo": return w("workdirUnknownRepo", { board, repo: cause.repoId ?? "?" });
      case "no-hub": return w("workdirNoHub");
      case "branch-in-use": if (cause.branch && cause.heldAt) return w(cause.releasable ? "workdirBranchReleasable" : "workdirBranchInUse", { branch: cause.branch, at: cause.heldAt }); break;
    }
    return w("gateWorkdir", { detail: result.message });
  }

  /** The start card says how the start stands, with no buttons left. */
  private settleStart(b: Binding, card: string, text: string) {
    if (this.editableCard(b, card)) this.replace(b, card, { text });
  }

  /**
   * Starts the ticket headless on this computer. A gate it stops at is said
   * here — a ticket waiting on others can be started anyway; the rest are
   * fixed on the desktop. Once it runs, this conversation stays where it is
   * and watches the ticket; Follow here moves it onto the ticket's thread.
   */
  private async startNow(b: Binding, row: Inbox, actorId: string, draft: StartDraft, reply: { anchor: string | null }) {
    const code = this.code();
    const item = this.startable(b.project_id, draft.itemId);
    if (!code || !item) this.refuse(this.w("cantStart"));
    if (this.isGroup(b) && actorId !== b.actor_id) this.refuse(this.w("onlyOwnerStarts"));
    if (this.home.agent.activeRuns().some(r => r.thread.id === b.thread_id)) this.refuse(this.w("stopFirst"));
    const address = JSON.parse(b.address_json) as ImAddress;
    const general = item.workType === "general";
    // The card clicked says at once that the start is under way, and takes no more clicks.
    this.store.run("UPDATE plugin_im_actions SET consumed = 2, retired = 1 WHERE binding_id = ? AND question_id LIKE 'cmd:start%' AND value_json LIKE ?", b.id, `%${draft.card}%`);
    const { w } = this;
    const settle = (on: Binding, text: string) => this.settleStart(on, draft.card, text);
    settle(b, this.startingText(b, item));
    let result: StartOutcome;
    try {
      result = await code.start(b.project_id, item.id, { mode: "run",
        ...(draft.engine ? { engine: draft.engine } : {}), ...(draft.options ? { options: draft.options } : {}),
        ...(draft.permissionMode && !general ? { permissionMode: draft.permissionMode } : {}), ...(draft.playbook && general ? { playbook: draft.playbook } : {}),
        ...(draft.allowBlocked ? { allowBlocked: true } : {}), ...(draft.releaseBranch ? { releaseBranch: true } : {}), ...(draft.task ? { message: draft.task } : {}),
        source: { connection: b.connection_id, tenant: address.tenantId, conversation: address.conversationId, actor: actorId } });
    } catch (e) { settle(b, w("notStarted", { key: item.key })); throw e; }
    if (!result.ok) {
      settle(b, w("notStarted", { key: item.key }));
      if (result.gate === "blocked") {
        const on = (result.blockers ?? []).join(", ");
        this.enqueue(b, `start-blocked:${row.id}`, { text: w("startBlocked", { key: item.key, on }),
          actions: [{ label: w("startAnyway"), token: this.offerValue(b, "start!", actorId, JSON.stringify({ ...draft, allowBlocked: true })), style: "primary" }] }, reply);
      } else {
        const gate = GATE[result.gate];
        const reason = result.gate === "workdir" ? this.workdirReason(result) : (gate && w(gate)) || result.message;
        // A branch held where nothing would be lost is freed by the person's say-so, here.
        const free = result.cause?.code === "branch-in-use" && result.cause.releasable;
        this.enqueue(b, `start-gate:${row.id}`, { text: w(free ? "startGateHere" : "startGate", { key: item.key, reason }),
          ...(free ? { actions: [{ label: w("freeAndStart"), token: this.offerValue(b, "start!", actorId, JSON.stringify({ ...draft, releaseBranch: true })), style: "primary" as const }] } : {}),
          elements: [{ type: "links", links: [{ label: w("openInTomrade"), url: links.item(b.project_id, item.key) }] }] }, reply);
      }
      this.accept(row); return;
    }
    const title = (await this.headless()).find(e => e.id === result.engine)?.title ?? result.engine;
    // The conversation stays where it is; it hears about the ticket, and follows its session only when asked.
    settle(b, result.continued ? w("continuedTicket", { key: item.key, title: item.title }) : w("startedTicket", { key: item.key, title: item.title }));
    this.watchItem(b, item.id);
    this.accept(row);
    const said = [
      result.continued ? w("continuingWith", { key: item.key, engine: title }) : w("startedWith", { key: item.key, engine: title }),
      ...(result.waitingOn ? [w("waitsOnAnswer", { question: result.waitingOn })] : []),
      ...(result.warnings ?? []).map(warning => `⚠ ${warning}`)
    ];
    // In a group with ticket topics the session shows in the ticket's topic, not here.
    if (this.topical(b) && this.toTopic(b, item.id, result.threadId, result.runId ?? null)) {
      this.enqueue(b, `started:${row.id}`, { text: [...said, w("followInTopic")].join("\n") }, reply);
      return;
    }
    const follow = this.offerValue(b, "follow", actorId, JSON.stringify({ threadId: result.threadId, runId: result.runId ?? null }));
    this.enqueue(b, `started:${row.id}`, { text: [...said, w("followHint")].join("\n"), actions: [{ label: w("followHere"), token: follow, style: "primary" }] }, reply);
  }

  /** This conversation follows a ticket's session from now on, and goes back once that session is archived. */
  private follow(b: Binding, row: Inbox, actorId: string, value: string, reply: { anchor: string | null }) {
    const { threadId, runId } = JSON.parse(value) as { threadId: string; runId: string | null };
    const target = this.home.agent.store.thread(b.project_id, threadId);
    if (!target || target.archived) this.refuse(this.w("sessionEnded"));
    if (target.id === b.thread_id) { this.enqueue(b, `follow:${row.id}`, { text: this.w("alreadyHere") }, reply); this.accept(row); return; }
    if (this.home.agent.activeRuns().some(r => r.thread.id === b.thread_id)) this.refuse(this.w("stopFirst"));
    const cursor = this.home.agent.thread(b.project_id, threadId).messages.at(-1)?.seq ?? 0;
    // Back to where this began once the ticket's thread is archived; from one ticket's thread, where that one began.
    const home = this.home.agent.store.thread(b.project_id, b.thread_id)?.itemId ? b.home_thread ?? undefined : b.thread_id;
    const key = target.itemId ? this.items()?.get(b.project_id, target.itemId)?.key : undefined;
    this.rebind(b, threadId, cursor, actorId, rebound => {
      if (runId) this.store.run("INSERT OR IGNORE INTO plugin_im_runs (binding_id, run_id) VALUES (?, ?)", rebound.id, runId);
      this.accept(row);
      this.enqueue(rebound, `follow:${row.id}`, { text: [
        key ? this.w("followingKey", { key }) : this.w("followingSession"),
        this.w("sessionsBack")
      ].join("\n") }, reply);
    }, home ? { home } : {});
  }

  private ago(at: number): string {
    const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
    if (m < 1) return this.w("justNow");
    if (m < 60) return this.w("minAgo", { n: m });
    const h = Math.round(m / 60);
    return h < 24 ? this.w("hAgo", { n: h }) : this.w("dAgo", { n: Math.round(h / 24) });
  }

  private accept(row: Inbox) { this.store.run("UPDATE plugin_im_inbox SET state = 'accepted' WHERE id = ?", row.id); }

  private answer(b: Binding, actionToken: string, actorId: string, value?: string | string[]): UserInput {
    const a = this.store.get<Action>("SELECT * FROM plugin_im_actions WHERE token = ?", actionToken);
    const current = this.home.agent.thread(b.project_id, b.thread_id);
    const pending = current.pending;
    if (!a || a.binding_id !== b.id || a.thread_id !== b.thread_id || a.run_id !== current.runs.at(-1)?.id || a.actor_id !== actorId || a.expires_at < Date.now() || a.consumed || pending?.question.id !== a.question_id) this.refuse(this.w("questionGone"));
    let answer = a.value_json === null ? value : JSON.parse(a.value_json) as string;
    if (pending.question.multiple && typeof answer === "string") {
      try { answer = JSON.parse(answer) as string[]; } catch { this.refuse(this.w("jsonArray")); }
    }
    if (typeof answer !== "string" && (!Array.isArray(answer) || answer.some(v => typeof v !== "string"))) this.refuse(this.w("invalidAnswer"));
    if (answer === undefined || (Array.isArray(answer) && !pending.question.multiple) ||
      (pending.accepts === "options" && !pending.question.freeText && [answer].flat().some(v => !pending.question.options?.includes(v)))) this.refuse(this.w("invalidAnswer"));
    return { kind: "answer", questionId: a.question_id, value: answer };
  }

  private project(b: Binding) {
    const detail = this.home.agent.thread(b.project_id, b.thread_id);
    this.store.db.transaction(() => {
      for (const message of detail.messages.filter(m => m.seq > b.cursor)) {
        const rendered = message.role === "agent" && this.visible(b, message.runId) ? this.render(b, message.block) : null;
        const streamed = rendered && this.store.get<{ id: string }>("SELECT id FROM plugin_im_outbox WHERE binding_id = ? AND stream_of = ?", b.id, message.id);
        const id = streamed?.id ?? `message:${b.id}:${message.id}`;
        const content = rendered && this.startActions(b, rendered, message.block, id);
        if (content) this.watch(b, message.block);
        if (streamed && content) this.replace(b, id, content, { final: true });
        else if (content) this.enqueue(b, id, content);
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
        const text = this.w("questionHandled");
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
    if (question.freeText || (pending.accepts === "text" && !options.length)) elements.push({ type: "input", token: issue(null), label: this.w("yourAnswer") });
    this.replace(b, id, { text: question.text, actions, ...(elements.length ? { elements } : {}) });
  }

  private render(b: Binding, block: Block): ImContent | null {
    const detail = this.settings.routes.find(r => r.id === b.route_id)?.output === "verbose";
    return renderBlock(this.scope(b), block, detail);
  }

  private scope(b: Binding): RenderScope {
    const items = this.items();
    const code = this.code();
    return { projectId: b.project_id, threadId: b.thread_id, w: this.w, ...(items ? { items } : {}), ...(code ? { code } : {}) };
  }

  private items() { return this.home.get("items") as ItemLookup | undefined; }
  private code() { return this.home.get("codeLink") as CodeHost | undefined; }
  private reviews() { return this.home.get("items") as ReviewHost | undefined; }

  /** Tickets a conversation was shown, so what happens to their code and deliveries reaches it; seeing one again keeps it watched. */
  private watch(b: Binding, block: Block) {
    const data = block.type === "card" ? (block.data ?? {}) as Record<string, unknown> : {};
    const keys = block.type === "changes" ? (block.items ?? []).filter(i => i.op !== "deleted").map(i => i.key)
      : block.type === "card" && block.schema === "start" && typeof data.key === "string" ? [data.key] : [];
    const items = this.items();
    if (!keys.length || !items) return;
    for (const key of keys) {
      const item = items.getByKey(b.project_id, key);
      if (item) this.watchItem(b, item.id);
    }
  }

  private watchItem(b: Binding, itemId: string) {
    const code = this.code();
    let seen: CodeSeen = { pr: null, merged: false, blocked: false, proposals: [] };
    try { if (code) seen = codeSeen(code.summary(b.project_id, itemId)); } catch { return; }
    this.store.run(`INSERT INTO plugin_im_watch (binding_id, project_id, item_id, seen_json, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (binding_id, item_id) DO UPDATE SET at = excluded.at`, b.id, b.project_id, itemId, JSON.stringify(seen), Date.now());
  }

  /**
   * A ticket changed. A delivery submitted for review reaches each
   * conversation that saw the ticket, or whose turn submitted it, as a card
   * with Accept and Request changes; a card whose delivery stopped waiting
   * (reviewed elsewhere, replaced, moved on) loses its buttons and says why.
   */
  private onItem(projectId: string, itemId: string, runId: string | null, move: StatusMove | null) {
    const host = this.reviews();
    if (this.stopped || !this.store || !host || !this.home.db.has(projectId)) return;
    let item: ReturnType<ReviewHost["get"]>;
    try { item = host.get(projectId, itemId); } catch { return; }
    if (item && move) this.onStatus(projectId, item, move);
    if (!item?.evidence) return;
    const open = awaitingReview(item);
    const thread = runId ? this.home.agent.store.run(projectId, runId)?.threadId : undefined;
    for (const b of this.store.bindings()) {
      if (b.project_id !== projectId || !this.authorizedBinding(b)) continue;
      // A ticket's topic hears its own ticket through the group it opened under, and only settles its cards.
      const own = this.topicOf(b)?.item_id === itemId;
      const watched = !!this.store.get("SELECT 1 FROM plugin_im_watch WHERE binding_id = ? AND item_id = ?", b.id, itemId);
      const live = this.store.all<Action>("SELECT * FROM plugin_im_actions WHERE binding_id = ? AND question_id = 'cmd:delivery' AND retired = 0 AND value_json LIKE ?", b.id, `%:${itemId}:%`);
      const ours = !!thread && thread === b.thread_id && this.visible(b, runId);
      if (!watched && !ours && !live.length) continue;
      this.store.db.transaction(() => {
        for (const sid of new Set(live.map(a => (JSON.parse(a.value_json!) as string).split(":")[3]))) {
          if (sid !== open?.id) this.settleDelivery(b, sid, reviewOutcome(this.w, item, sid));
        }
        if (own || !open || (!watched && !ours)) return;
        const to = this.newsTo(b, item.id, true);
        if (!to || this.store.get("SELECT 1 FROM plugin_im_outbox WHERE id = ?", `delivery:${to.id}:${open.id}`)) return;
        this.watchItem(b, item.id);
        const choice = (verdict: "accept" | "changes") => this.offerValue(to, "delivery", to.actor_id, `${verdict}:${projectId}:${item.id}:${open.id}`);
        this.enqueue(to, `delivery:${to.id}:${open.id}`, { ...deliveryCard(this.scope(to), item, open), actions: [
          { label: this.w("accept"), token: choice("accept"), style: "primary" },
          { label: this.w("requestChanges"), token: choice("changes") }
        ] }, { anchor: null });
      });
    }
  }

  /**
   * A ticket moved: each conversation of its project hears where to, unless it turned that off. A group with ticket
   * topics hears it in the ticket's topic, opened once the ticket is worked; the topic's title follows the ticket.
   */
  private onStatus(projectId: string, item: { id: string; key: string; title: string }, move: StatusMove) {
    const opens = move.to === "doing" || move.to === "verifying";
    for (const b of this.store.bindings().filter(b => b.project_id === projectId && this.authorizedBinding(b) && this.notifies(b, "tickets") && !this.topicOf(b))) {
      const to = this.newsTo(b, item.id, opens);
      if (to) this.enqueue(to, `item-status:${to.id}:${item.id}:${move.version}`, { text: `${item.key}: ${statusText(this.w, move.from)} → ${statusText(this.w, move.to)}`,
        elements: ticket(this.scope(to), item.key, item.title) }, { anchor: null });
    }
    // Done or Cancelled closes the topic once what it was told is out; moving back opens it again.
    this.store.run("UPDATE plugin_im_topics SET title = ?, closed = ? WHERE project_id = ? AND item_id = ?",
      this.topicTitle({ ...item, status: move.to }), ended(move.to) ? 1 : 0, projectId, item.id);
  }

  /** A scheduled template ran: each conversation of its project that asked to hear about routines does. */
  private onRoutine(projectId: string, run: RoutineRun, name: string) {
    if (this.stopped || !this.store || !this.home.db.has(projectId)) return;
    const keys = run.itemIds.map(id => this.items()?.get(projectId, id)?.key).filter((k): k is string => !!k);
    for (const b of this.store.bindings().filter(b => b.project_id === projectId && this.authorizedBinding(b) && this.notifies(b, "routines") && !this.topicOf(b))) {
      const { w } = this;
      const text = !run.ok ? w("routineFailed", { name, error: run.error ?? w("unknownError") })
        : keys.length ? w("routineMade", { name, keys: keys.join(w("listSep")) })
        : w("routineRan", { name });
      const open = run.threadId ? [{ type: "links" as const, links: [{ label: w("openInTomrade"), url: links.thread(projectId, run.threadId) }] }] : [];
      this.enqueue(b, `routine:${b.id}:${run.id}`, { text, ...(open.length ? { elements: open } : {}) }, { anchor: null });
    }
  }

  /** Whether this conversation opens a topic per ticket: a group's main conversation, on a platform that can, unless its route said no. */
  private topical(b: Binding): boolean {
    if (!this.isGroup(b) || (JSON.parse(b.address_json) as ImAddress).topicId) return false;
    return !!this.capsOf(b)?.topics && this.settings.routes.find(r => r.id === b.route_id)?.ticketTopics !== false;
  }

  /** The ticket topic this conversation is, if it is one. */
  private topicOf(b: Binding): Topic | undefined {
    return this.store.get<Topic>("SELECT * FROM plugin_im_topics WHERE binding_id = ?", b.id);
  }

  /**
   * Where news of a ticket goes from a group conversation: into the ticket's topic once it is open, nowhere while it
   * opens (its first card shows the ticket as it then is, and the rest follows), or here as before. `opens` lets this
   * news ask for the topic.
   */
  private newsTo(b: Binding, itemId: string, opens: boolean): Binding | null {
    if (!this.topical(b)) return b;
    const t = this.store.get<Topic>("SELECT * FROM plugin_im_topics WHERE parent_id = ? AND item_id = ?", b.id, itemId);
    if (!t) return opens && this.openTopic(b, itemId) ? null : b;
    if (t.state === "opening") return null;
    const topic = t.state === "open" && t.binding_id ? this.store.binding(t.binding_id) : undefined;
    return topic && this.authorizedBinding(topic) ? topic : b;
  }

  /** Asks for the ticket's topic, opened on the next flush; the group watches the ticket from now on. */
  private openTopic(b: Binding, itemId: string, session?: { threadId: string; runId: string | null }): boolean {
    const item = this.items()?.get(b.project_id, itemId);
    if (!item) return false;
    this.store.run(`INSERT INTO plugin_im_topics (id, parent_id, project_id, item_id, title, closed, thread_id, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (parent_id, item_id) DO NOTHING`, hash([b.id, itemId]), b.id, b.project_id, itemId, this.topicTitle(item), ended(item.status) ? 1 : 0,
      session?.threadId ?? null, session?.runId ?? null, Date.now());
    this.watchItem(b, itemId);
    return true;
  }

  private topicTitle(item: { key: string; title: string; status: string }): string {
    return `${item.key} · ${statusText(this.w, item.status)} · ${item.title}`;
  }

  /** What a ticket's topic is about, for a message there whose platform did not hand its first message. */
  private topicRoot(b: Binding): ContextLine | undefined {
    const t = this.topicOf(b);
    const item = t && this.items()?.get(b.project_id, t.item_id);
    return item ? { author: { id: "tomrade", name: "Tomrade", isBot: true }, text: this.w("topicOpened", { key: `${item.key} ${item.title}` }) } : undefined;
  }

  /** A ticket topic's conversation becomes `threadId`: what it was about to say still goes out, and its cards keep working. */
  private retarget(t: Binding, threadId: string, cursor: number) {
    this.store.db.transaction(() => {
      this.store.run("UPDATE plugin_im_outbox SET thread_id = ? WHERE binding_id = ?", threadId, t.id);
      this.store.run("UPDATE plugin_im_actions SET thread_id = ? WHERE binding_id = ? AND question_id LIKE 'cmd:%'", threadId, t.id);
      this.store.run("UPDATE plugin_im_bindings SET thread_id = ?, cursor = ?, anchor = NULL WHERE id = ?", threadId, cursor, t.id);
    });
    this.listed.delete(t.id);
  }

  private lastSeq(projectId: string, threadId: string): number {
    try { return this.home.agent.thread(projectId, threadId).messages.at(-1)?.seq ?? 0; } catch { return 0; }
  }

  /** A ticket topic someone writes in gets a conversation of its own, named after its ticket. */
  private ownTopic(b: Binding): Binding {
    const t = this.topicOf(b);
    const route = this.settings.routes.find(r => r.id === b.route_id);
    if (!t || t.own || !route) return b;
    const item = this.items()?.get(b.project_id, t.item_id);
    const th = this.openThread(route, item ? `${item.key} ${item.title}` : undefined);
    this.retarget(b, th.id, 0);
    this.store.run("UPDATE plugin_im_topics SET own = 1, thread_id = ?, run_id = NULL WHERE id = ?", th.id, t.id);
    return this.store.binding(b.id)!;
  }

  /** Its conversation was archived: the topic holds the group's again, showing none of it, until someone writes there. */
  private release(b: Binding, t: Topic): Binding {
    const parent = this.store.binding(t.parent_id);
    if (!parent) return b;
    this.retarget(b, parent.thread_id, this.lastSeq(b.project_id, parent.thread_id));
    this.store.run("UPDATE plugin_im_topics SET own = 0, thread_id = NULL, run_id = NULL WHERE id = ?", t.id);
    return this.store.binding(b.id)!;
  }

  /** The ticket's topic shows a session started from its group: once it opens, or now. False when the ticket has no topic to show it in. */
  private toTopic(b: Binding, itemId: string, threadId: string, runId: string | null): boolean {
    const t = this.store.get<Topic>("SELECT * FROM plugin_im_topics WHERE parent_id = ? AND item_id = ?", b.id, itemId);
    if (!t) return this.openTopic(b, itemId, { threadId, runId });
    if (t.state === "failed") return false;
    if (t.state === "opening") {
      this.store.run("UPDATE plugin_im_topics SET thread_id = ?, run_id = ? WHERE id = ?", threadId, runId, t.id);
      return true;
    }
    const topic = t.binding_id ? this.store.binding(t.binding_id) : undefined;
    if (!topic || !this.authorizedBinding(topic)) return false;
    // Someone is at work in the topic's own conversation: the session is followed from the group instead.
    if (t.own && topic.thread_id !== threadId && (this.processing.has(topic.thread_id) || this.home.agent.activeRuns().some(r => r.thread.id === topic.thread_id))) return false;
    if (topic.thread_id !== threadId) this.retarget(topic, threadId, 0);
    this.store.run("UPDATE plugin_im_topics SET own = 1, thread_id = ?, run_id = ? WHERE id = ?", threadId, runId, t.id);
    if (runId) this.store.run("INSERT OR IGNORE INTO plugin_im_runs (binding_id, run_id) VALUES (?, ?)", topic.id, runId);
    return true;
  }

  /**
   * The topic operation due on this connection: opening one, or telling the platform a topic's new title and whether
   * it is closed, once everything queued for it is out.
   */
  private topicDue(c: Connection): Topic | undefined {
    return this.store.get<Topic>(`SELECT t.* FROM plugin_im_topics t JOIN plugin_im_bindings p ON p.id = t.parent_id
      WHERE p.connection_id = ? AND t.retry_at <= ? AND (t.state = 'opening' OR (t.state = 'open'
        AND (t.synced IS NULL OR t.synced != json_array(t.title, t.closed))
        AND NOT EXISTS (SELECT 1 FROM plugin_im_outbox o WHERE o.binding_id = t.binding_id AND o.state IN ('queued', 'sending'))))
      ORDER BY t.created_at LIMIT 1`, c.id, Date.now());
  }

  /** Runs a due topic operation. False when it did not, so the flush goes on to messages. */
  private async topicWork(c: Connection, t: Topic): Promise<boolean> {
    const session = c.session!;
    const parent = this.store.binding(t.parent_id)!;
    const later = (e: unknown) => {
      const retryAfter = (e as { retryAfterMs?: number } | null)?.retryAfterMs;
      this.store.run("UPDATE plugin_im_topics SET attempts = attempts + 1, retry_at = ? WHERE id = ?",
        Date.now() + (Number.isFinite(retryAfter) ? Math.max(0, retryAfter!) : Math.min(60_000, this.config.retryMs * 2 ** Math.min(t.attempts, 6))), t.id);
    };
    const retryable = (e: unknown) => (e as { disposition?: string } | null)?.disposition === "retryable";
    if (t.state === "opening") {
      // Its group is not let in right now: asked again later, without holding up the others.
      if (!this.authorizedBinding(parent)) { this.store.run("UPDATE plugin_im_topics SET retry_at = ? WHERE id = ?", Date.now() + 60_000, t.id); return false; }
      try {
        if (!session.topics) throw new Error("Adapter opens no topics");
        const { topicId } = await deadline(session.topics.open({ operationId: `topic:${t.id}`, address: JSON.parse(parent.address_json) as ImAddress, title: t.title }), this.config.operationTimeoutMs);
        if (!topicId) throw new Error("Adapter returned no topic id");
        if (this.stopped) return true;
        this.topicOpened(parent, t, topicId);
      } catch (e) {
        if (this.stopped) return true;
        // A topic that may exist already is not opened twice; its news goes to the group as before.
        if (retryable(e) && t.attempts < 6) later(e);
        else this.topicSettled(t.project_id, t.item_id, () => {
          this.store.run("UPDATE plugin_im_topics SET state = 'failed' WHERE id = ?", t.id);
          // What asked for it is told here instead, as the ticket now stands.
          const item = this.items()?.get(t.project_id, t.item_id);
          if (item && this.notifies(parent, "tickets")) this.enqueue(parent, `topic-failed:${t.id}`, { text: `${item.key}: ${statusText(this.w, item.status)}`,
            elements: ticket(this.scope(parent), item.key, item.title) }, { anchor: null });
        });
      }
      return true;
    }
    const topic = this.store.binding(t.binding_id!);
    const synced = () => this.store.run("UPDATE plugin_im_topics SET synced = json_array(?, ?), attempts = 0 WHERE id = ?", t.title, t.closed, t.id);
    if (!topic || !session.topics) { synced(); return true; }
    try {
      await deadline(session.topics.update({ address: JSON.parse(topic.address_json) as ImAddress & { topicId: string }, title: t.title, closed: !!t.closed }), this.config.operationTimeoutMs);
      synced();
    } catch (e) {
      // A title or an archive is cosmetic: given up on once it cannot be sent.
      if (retryable(e) && t.attempts < 6) later(e);
      else synced();
    }
    return true;
  }

  /** The platform made the topic: it gets its conversation, its first card, and the ticket's news that waited. */
  private topicOpened(parent: Binding, t: Topic, topicId: string) {
    const address: ImAddress = { ...(JSON.parse(parent.address_json) as ImAddress), topicId };
    // As `receive` names the conversation people write in there.
    const id = hash([parent.connection_id, address, parent.route_hash]);
    const own = !!t.thread_id && !!this.home.agent.store.thread(t.project_id, t.thread_id);
    const threadId = own ? t.thread_id! : parent.thread_id;
    this.topicSettled(t.project_id, t.item_id, () => {
      this.store.run(`INSERT OR IGNORE INTO plugin_im_bindings (id, route_id, route_hash, connection_id, address_json, project_id, thread_id, actor_id, cursor, created_at, grp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, id, parent.route_id, parent.route_hash, parent.connection_id, JSON.stringify(address), parent.project_id,
        threadId, parent.actor_id, own ? 0 : this.lastSeq(t.project_id, threadId), Date.now());
      if (own && t.run_id) this.store.run("INSERT OR IGNORE INTO plugin_im_runs (binding_id, run_id) VALUES (?, ?)", id, t.run_id);
      this.store.run("UPDATE plugin_im_topics SET state = 'open', topic_id = ?, binding_id = ?, own = ?, synced = json_array(title, 0), attempts = 0 WHERE id = ?", topicId, id, own ? 1 : 0, t.id);
      const topic = this.store.binding(id)!;
      const item = this.items()?.get(t.project_id, t.item_id);
      if (item) this.enqueue(topic, `topic-card:${t.id}`, { text: this.w("topicOpened", { key: item.key }), elements: ticket(this.scope(topic), item.key, item.title) }, { anchor: null });
    });
  }

  /** A topic opened or could not be: the ticket's news that waited for it goes out, there or to the group. */
  private topicSettled(projectId: string, itemId: string, settle: () => void) {
    this.store.db.transaction(settle);
    this.onCode(projectId);
    this.onItem(projectId, itemId, null, null);
  }

  /** Whether this conversation hears about `kind`: its route's own choice, else the shared one. */
  private notifies(b: Binding, kind: ImNotifyKind): boolean {
    return this.settings.routes.find(r => r.id === b.route_id)?.notify?.[kind] ?? this.settings.notify[kind];
  }

  /** Whether any conversation hears when Tomrade comes online or goes offline. */
  private announces(): boolean {
    return this.settings.routes.some(r => r.notify?.presence ?? this.settings.notify.presence);
  }

  /** A delivery's buttons stop working; its card, and any open request for changes, say how it ended. */
  private settleDelivery(b: Binding, submissionId: string, text: string) {
    this.store.run("UPDATE plugin_im_actions SET consumed = 1, retired = 1 WHERE binding_id = ? AND ((question_id = 'cmd:delivery' AND value_json LIKE ?) OR question_id LIKE ?)",
      b.id, `%:${submissionId}"`, `cmd:delivery-changes:%:${submissionId}`);
    const updates = this.capsOf(b)?.cardUpdate || this.capsOf(b)?.edit;
    const id = `delivery:${b.id}:${submissionId}`;
    const row = this.store.get<Outbox>("SELECT * FROM plugin_im_outbox WHERE id = ?", id);
    if (row && (JSON.parse(row.content_json) as ImContent).actions?.length) {
      const head = (JSON.parse(row.content_json) as ImContent).text.split("\n")[0];
      if (updates) this.replace(b, id, { text: `${head}\n${text}` });
      else this.enqueue(b, `settled:${id}`, { text: `${head}\n${text}` }, { anchor: null });
    }
    for (const ask of this.store.all<Outbox>("SELECT * FROM plugin_im_outbox WHERE binding_id = ? AND id LIKE ?", b.id, `delivery-ask:${b.id}:${submissionId}:%`)) {
      const content = JSON.parse(ask.content_json) as ImContent;
      if (updates && content.elements?.length) this.replace(b, ask.id, { text: `${content.text.split("\n")[0]}\n${text}` });
    }
  }

  /** The IM person's paired name, for the verdict they give here. */
  private who(b: Binding, actorId: string): string {
    const tenant = (JSON.parse(b.address_json) as ImAddress).tenantId;
    const id = this.settings.identities.find(i => i.connectionId === b.connection_id && i.tenantId === tenant && i.actorId === actorId);
    return id?.name ? `${id.name} (${actorId})` : actorId;
  }

  private paired(b: Binding, actorId: string): boolean {
    const tenant = (JSON.parse(b.address_json) as ImAddress).tenantId;
    return this.settings.identities.some(i => i.connectionId === b.connection_id && i.tenantId === tenant && i.actorId === actorId);
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
      // A ticket's topic hears its own ticket through the group it opened under.
      if (this.topicOf(b)?.item_id === item.id) continue;
      let summary: ReturnType<CodeHost["summary"]>;
      try { summary = code.summary(projectId, item.id); } catch { continue; }
      const was = JSON.parse(w.seen_json) as CodeSeen;
      const now = codeSeen(summary);
      if (JSON.stringify(was) === JSON.stringify(now)) continue;
      const news = codeNews(this.w, was, now, summary);
      const tell = this.notifies(b, "code");
      const fresh = tell ? summary.proposals.filter(p => p.kind === "propose" && !was.proposals.includes(p.id)) : [];
      // News opens the ticket's topic; while it opens, the watch keeps what it last told, so the news follows it there.
      const to = this.newsTo(b, item.id, tell && (news.length > 0 || fresh.length > 0));
      if (!to) continue;
      this.store.db.transaction(() => {
        this.store.run("UPDATE plugin_im_watch SET seen_json = ? WHERE binding_id = ? AND item_id = ?", JSON.stringify(now), w.binding_id, w.item_id);
        if (news.length && tell) this.enqueue(to, `code:${to.id}:${item.id}:${hash(now).slice(0, 16)}`, { text: news.join("\n"), elements: ticket(this.scope(to), item.key, item.title) }, { anchor: null });
        for (const p of fresh) {
          const choice = (verdict: "accept" | "reject") => this.offerValue(to, "proposal", to.actor_id, `${verdict}:${projectId}:${p.id}`);
          this.enqueue(to, `proposal:${to.id}:${p.id}`, { text: proposalText(this.w, item.key, p), actions: [
            { label: this.w("accept"), token: choice("accept"), style: "primary" },
            { label: this.w("notThisTime"), token: choice("reject") }
          ] }, { anchor: null });
        }
        for (const id of was.proposals.filter(id => !now.proposals.includes(id))) {
          this.settleProposal(to, id, this.w("handledInTomrade"));
          // One asked here before the topic opened.
          if (to !== b) this.settleProposal(b, id, this.w("handledInTomrade"));
        }
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
    const retry = turn?.retry ? this.w("retrying", { attempt: turn.retry.attempt, of: turn.retry.max ? this.w("retryOf", { max: turn.retry.max }) : "" }) : "";
    return [retry || head, toolLine(turn?.tools ?? [])].filter(Boolean).join("\n");
  }

  private finished(status: string): string {
    return status === "error" ? this.w("executionFailed") : status === "cancelled" ? this.w("executionStopped")
      : status === "asked" ? this.w("waitingForAnswer") : this.w("turnFinished");
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
        const text = this.progressText(threadId, event.type === "progress" ? event.activity || this.w("working") : this.w("writingReply"));
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
      // Messages are picked in the same tick as before: awaiting first would let a stream be settled before it starts.
      const topic = this.topicDue(c);
      if (topic && await this.topicWork(c, topic)) return;
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
        parts = prepare(JSON.parse(row.content_json) as ImContent, caps, this.w);
        // A growing reply shows what fits one message; the final version carries the rest.
        if (row.stream) parts = parts.slice(0, 1);
        // Clear obsolete segments when an edited question or status became shorter.
        if (caps.edit) while (parts.length < messageIds.length) parts.push({ text: this.w("superseded") });
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
  return !row.input_json && (/^\/(stop|status|queue|help|sessions|archive|engine|model|effort|mode)$/.test(text) || /^\/(answer|steer|unqueue|switch|engine|model|effort|mode|start)\s/.test(text));
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

const ended = (status: string) => status === "done" || status === "cancelled";

/** Group replies attach to the message that asked; a direct chat needs no anchor. */
function anchorOf(event: ImInbound): string | null {
  return event.kind === "message" && event.activation !== "dm" ? event.messageId : null;
}

async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("IM operation timed out; remote outcome unknown")), ms); })]); }
  finally { clearTimeout(timer!); }
}
