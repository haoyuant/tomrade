import { z } from "zod";

const id = z.string().min(1).max(256);
export const ImSettings = z.object({
  connections: z.array(z.object({ id, adapterId: id, enabled: z.boolean().default(true) })).default([]),
  routes: z.array(z.object({
    id, connectionId: id, tenantId: id, conversationId: id,
    projectId: id, boardId: id.nullable().default(null), engine: id.optional(),
    /** A route explicitly grants these people use of this project's assistant. */
    allowedActors: z.array(id).min(1),
    allowDirectMessages: z.boolean().default(true),
    allowGroups: z.boolean().default(false)
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

export const ImConfig = z.object({
  pollMs: z.number().int().min(10).default(250),
  progressMs: z.number().int().min(100).default(2000),
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
    activation: z.enum(["dm", "mention", "reply"]),
    attachments: z.array(z.object({ id, name: z.string().min(1).max(255), mimeType: z.string().min(1).max(128), size: z.number().int().min(1).max(32 * 1024 * 1024) })).max(8).optional(),
    permalink: z.url().max(2048).optional() }),
  z.object({ ...common, kind: z.literal("action"), token: id, value: z.union([z.string().max(32_000), z.array(z.string().max(512)).max(24)]).optional() })
]);
