import { z } from "zod";

const id = z.string().min(1).max(256);

/** What reaches a conversation besides its own turns. */
export const NOTIFY_KINDS = ["tickets", "code", "presence", "routines", "attention"] as const;
export type ImNotifyKind = typeof NOTIFY_KINDS[number];
/** A route's own choices, before the shared ones applied; older settings stored every kind. */
const LEGACY_NOTIFY: Partial<Record<string, boolean>> = { tickets: true, code: true, routines: false, attention: true };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Settings from before the shared choices: `announcePresence` becomes the shared presence, and a route keeps only what it changed. */
function upgrade(value: unknown): unknown {
  if (!isRecord(value) || !("announcePresence" in value)) return value;
  const { announcePresence, ...rest } = value;
  const routes = Array.isArray(rest.routes) ? rest.routes.map(r => {
    if (!isRecord(r) || !isRecord(r.notify)) return r;
    const notify = Object.fromEntries(Object.entries(r.notify).filter(([k, v]) => LEGACY_NOTIFY[k] !== v));
    const { notify: _old, ...route } = r;
    return Object.keys(notify).length ? { ...route, notify } : route;
  }) : rest.routes;
  return { ...rest, notify: { ...(isRecord(rest.notify) ? rest.notify : {}), presence: announcePresence === true }, routes };
}

export const ImSettings = z.preprocess(upgrade, z.object({
  connections: z.array(z.object({ id, adapterId: id, enabled: z.boolean().default(true), label: z.string().max(80).optional(),
    /** The adapter's `setup.fields`; the whole map is sealed by the OS keychain in settings.json. */
    credentials: z.record(z.string(), z.string().max(8192)).default({}) })).default([]),
  /** IM identities paired from the desktop, offered as the people a newly allowed group admits. */
  identities: z.array(z.object({ connectionId: id, tenantId: id, actorId: id, name: z.string().max(256).optional(), pairedAt: z.number() })).default([]),
  /** What reaches every conversation besides its own turns, unless its route says otherwise. */
  notify: z.object({
    /** Status changes of every ticket in the conversation's project. */
    tickets: z.boolean().default(true),
    /** Pull requests, merges and git's status proposals for the tickets a conversation saw or started. */
    code: z.boolean().default(true),
    /** In each paired direct chat, when Tomrade comes online and goes offline on this computer; a group only when its own route says so. */
    presence: z.boolean().default(false),
    /** Scheduled templates as they run. */
    routines: z.boolean().default(false),
    /** Questions, approvals and failures that wait on the person while they are away. */
    attention: z.boolean().default(true)
  }).prefault({}),
  routes: z.array(z.object({
    id, connectionId: id, tenantId: id, conversationId: id,
    projectId: id, boardId: id.nullable().default(null), engine: id.optional(),
    /** Engine option overrides for threads this route opens (model, effort…). */
    options: z.record(z.string(), z.unknown()).optional(),
    /** The permission mode threads this route opens start in, when the engine has modes. */
    permissionMode: id.optional(),
    /** A route explicitly grants these people use of this project's assistant. */
    allowedActors: z.array(id).min(1),
    allowDirectMessages: z.boolean().default(true),
    allowGroups: z.boolean().default(false),
    /** In a group: `mention` only @; `reply` @ or a reply to the bot; `all` every message the adapter sees. */
    groupActivation: z.enum(["mention", "reply", "all"]).default("reply"),
    /** `final` sends answers and questions only; `progress` also shows progress and growing replies; `verbose` adds a line per tool call. */
    output: z.enum(["final", "progress", "verbose"]).default("progress"),
    /** In a direct chat, turns started on the desktop show here too. A group only ever shows turns started from IM, or shared from the desktop. */
    desktopTurns: z.boolean().default(true),
    /** In a group, where the platform can, each ticket being worked gets a topic of its own for its news. */
    ticketTopics: z.boolean().default(true),
    /** This conversation's own answers to the shared `notify`; a kind left out follows it. */
    notify: z.partialRecord(z.enum(NOTIFY_KINDS), z.boolean()).optional(),
    /** In a group, keep its recent messages on this computer and show them to the Agent when it is woken. Off unless set. */
    groupContext: z.object({
      enabled: z.boolean().default(false),
      messages: z.number().int().min(1).max(100).default(20),
      retentionHours: z.number().int().min(1).max(720).default(24)
    }).optional()
  })).default([])
}).superRefine((value, ctx) => {
  for (const key of ["connections", "routes"] as const) {
    const ids = value[key].map(row => row.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: `Duplicate ${key} id`, path: [key] });
  }
  const keys = value.routes.map(r => JSON.stringify([r.connectionId, r.tenantId, r.conversationId]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Only one route per connection, tenant and conversation", path: ["routes"] });
  for (const [i, route] of value.routes.entries()) {
    if (!value.connections.some(c => c.id === route.connectionId)) ctx.addIssue({ code: "custom", message: "Unknown connection", path: ["routes", i, "connectionId"] });
  }
}));
export type ImSettings = z.infer<typeof ImSettings>;
export type ImRoute = ImSettings["routes"][number];
export type ImConnection = ImSettings["connections"][number];
export type ImIdentity = ImSettings["identities"][number];

export const ImConfig = z.object({
  pollMs: z.number().int().min(10).default(250),
  progressMs: z.number().int().min(100).default(1500),
  retryMs: z.number().int().min(10).default(1000),
  actionTtlMs: z.number().int().min(100).default(24 * 60 * 60 * 1000),
  operationTimeoutMs: z.number().int().min(10).default(30_000),
  /** Thread projection runs on Agent events; this sweep catches anything missed. */
  sweepMs: z.number().int().min(10).default(5_000),
  /** Finished inbox/outbox records are kept this long; older replays fall back to Agent input receipts. */
  retentionMs: z.number().int().min(1_000).default(30 * 24 * 60 * 60 * 1000)
}).prefault({});
export type ImConfig = z.infer<typeof ImConfig>;

const address = z.object({ tenantId: id, conversationId: id, topicId: id.optional() });
const common = { eventId: id, address, actor: z.object({ id, name: z.string().max(256).optional(), isBot: z.boolean() }) };
export const InboundSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("message"), messageId: id, text: z.string().max(32_000),
    activation: z.enum(["dm", "mention", "reply", "ambient"]),
    attachments: z.array(z.object({ id, name: z.string().min(1).max(255), mimeType: z.string().min(1).max(128), size: z.number().int().min(1).max(32 * 1024 * 1024) })).max(8).optional(),
    permalink: z.url().max(2048).optional(), replyTo: id.optional(),
    context: z.array(z.object({ role: z.enum(["quoted", "root"]), messageId: id,
      author: z.object({ id, name: z.string().max(256).optional(), isBot: z.boolean() }), text: z.string().max(32_000) })).max(4).optional() }),
  z.object({ ...common, kind: z.literal("retract"), messageId: id }),
  z.object({ ...common, kind: z.literal("edit"), messageId: id }),
  z.object({ ...common, kind: z.literal("action"), token: id, value: z.union([z.string().max(32_000), z.array(z.string().max(512)).max(24)]).optional() })
]);
