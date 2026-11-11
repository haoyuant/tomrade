import { z } from "zod";
import { featureById, dimAllowed } from "./features.js";

/** The envelope version. Adding an optional field leaves it; a new event or a required field raises it. */
export const SCHEMA_VERSION = 1;

const uuid = z.uuid();
const ms = z.number().int();

const envelope = {
  schema: z.literal(SCHEMA_VERSION),
  registry: z.number().int().positive(),
  event: z.enum(["app.start", "feature.activate", "feature.session"]),
  /** Idempotency key: a retry keeps it. */
  event_id: uuid,
  /** 26 characters of base32 (a-z, 2-7), never a secret. */
  anon_id: z.string().regex(/^[a-z2-7]{26}$/),
  /** Monotonic within one anonymous id; restarts at 1 after a rotation. */
  install_seq: z.number().int().positive(),
  ts: ms,
  /** The app's semver. */
  client: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  platform: z.enum(["macos", "windows", "linux"])
};

/**
 * The version a build reports. TOMRADE_ANALYTICS_INTERNAL=1 marks the maintainer's own release builds with
 * `+internal` build metadata, which every server already accepts; a prerelease or checkout version reads as internal anyway.
 */
export const reportedClient = (version: string, env: NodeJS.ProcessEnv = process.env): string =>
  env.TOMRADE_ANALYTICS_INTERNAL === "1" && /^\d+\.\d+\.\d+$/.test(version) ? `${version}+internal` : version;

export const AppStartEvent = z
  .object({
    ...envelope,
    event: z.literal("app.start"),
    feature_id: z.null(),
    action: z.null().optional(),
    dim: z.null().optional(),
    /** True within 24 hours of installation. */
    first_run: z.boolean().optional()
  })
  .strict();

export const ActivateEvent = z
  .object({
    ...envelope,
    event: z.literal("feature.activate"),
    feature_id: z.string().min(1).max(40),
    action: z.string().min(1).max(40),
    dim: z.string().max(40).nullish()
  })
  .strict();

export const SessionEvent = z
  .object({
    ...envelope,
    event: z.literal("feature.session"),
    feature_id: z.string().min(1).max(40),
    action: z.null().optional(),
    dim: z.null().optional(),
    session_id: uuid,
    started_at: ms,
    ended_at: ms,
    /** The only trusted duration field. */
    active_ms: z.number().int().nonnegative().max(86_400_000),
    idle_ms: z.number().int().nonnegative(),
    segments: z.number().int().positive(),
    end_reason: z.enum(["switch", "blur", "idle", "lock", "suspend", "quit", "crash", "cap"])
  })
  .strict();

export const AnalyticsEvent = z.discriminatedUnion("event", [AppStartEvent, ActivateEvent, SessionEvent]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;
export type AppStartEvent = z.infer<typeof AppStartEvent>;
export type ActivateEvent = z.infer<typeof ActivateEvent>;
export type SessionEvent = z.infer<typeof SessionEvent>;

/** The body of one upload. Nothing but these three fields is allowed. */
export const Batch = z
  .object({
    batch_id: uuid,
    sent_at: ms,
    events: z.array(AnalyticsEvent).min(1).max(500)
  })
  .strict();
export type Batch = z.infer<typeof Batch>;

/**
 * Registry checks the shape cannot do: a known feature, one of its actions, a
 * dimension in its closed set. A bad action rejects the row; a bad dimension
 * only drops the dimension. An unknown feature is kept (a client may ship
 * before the server knows it) and flagged at ingest.
 */
export function checkSemantics(event: AnalyticsEvent): { ok: true; event: AnalyticsEvent } | { ok: false; reason: string } {
  if (event.event === "app.start") return { ok: true, event };
  const feature = featureById(event.feature_id);
  if (!feature) return { ok: true, event };
  if (event.event === "feature.activate" && !feature.actions.some((a) => a.name === event.action)) {
    return { ok: false, reason: `${event.feature_id} has no action ${event.action}` };
  }
  if (event.event === "feature.activate" && event.dim != null && event.dim !== "" && !dimAllowed(feature, event.dim)) {
    return { ok: true, event: { ...event, dim: null } };
  }
  if (event.event === "feature.session" && event.active_ms > event.ended_at - event.started_at) {
    return { ok: false, reason: "active_ms exceeds the session's wall clock" };
  }
  return { ok: true, event };
}

/** Parse and check one event, as the client emits and the server reads it. */
export function parseEvent(input: unknown): AnalyticsEvent {
  const parsed = AnalyticsEvent.parse(input);
  const checked = checkSemantics(parsed);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.event;
}
