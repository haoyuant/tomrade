import { z } from "zod";

const id = z.string().min(1).max(256);
export const ImSettings = z.object({
  connections: z.array(z.object({ id, adapterId: id, enabled: z.boolean().default(true), label: z.string().max(80).optional(),
    /** The adapter's `setup.fields`; the whole map is sealed by the OS keychain in settings.json. */
    credentials: z.record(z.string(), z.string().max(8192)).default({}) })).default([]),
  /** IM identities paired from the desktop, offered as the people a newly allowed group admits. */
  identities: z.array(z.object({ connectionId: id, tenantId: id, actorId: id, name: z.string().max(256).optional(), pairedAt: z.number() })).default([]),
  routes: z.array(z.object({
    id, connectionId: id, tenantId: id, conversationId: id,
    projectId: id, boardId: id.nullable().default(null), engine: id.optional(),
    /** Engine option overrides for threads this route opens (model, effort…). */
    options: z.record(z.string(), z.unknown()).optional(),
    /** A route explicitly grants these people use of this project's assistant. */
    allowedActors: z.array(id).min(1),
    allowDirectMessages: z.boolean().default(true),
    allowGroups: z.boolean().default(false),
    /** In a group: `mention` only @; `reply` @ or a reply to the bot; `all` every message the adapter sees. */
    groupActivation: z.enum(["mention", "reply", "all"]).default("reply"),
    /** `final` sends answers and questions only; `progress` also shows progress and growing replies; `verbose` adds a line per tool call. */
    output: z.enum(["final", "progress", "verbose"]).default("progress")
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
});
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
    permalink: z.url().max(2048).optional(), replyTo: id.optional() }),
  z.object({ ...common, kind: z.literal("retract"), messageId: id }),
  z.object({ ...common, kind: z.literal("edit"), messageId: id }),
  z.object({ ...common, kind: z.literal("action"), token: id, value: z.union([z.string().max(32_000), z.array(z.string().max(512)).max(24)]).optional() })
]);
