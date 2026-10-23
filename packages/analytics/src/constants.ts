/**
 * The timing rules, frozen into the client build.
 *
 * These are not settings and there is no remote configuration: changing one
 * changes what "five minutes of use" means, so it ships only with a release
 * and analyses split by the client version's major.minor.
 */

/** Timer resolution. */
export const TICK_MS = 1000;
/** How often the system's idle time is sampled; the worst idle error is this. */
export const IDLE_SAMPLE_MS = 5000;
/** Idle this long pauses timing, backdated to the last input. */
export const IDLE_PAUSE_MS = 60_000;
/** Idle this long ends the session. */
export const IDLE_END_MS = 300_000;
/** Coming back within this window after losing focus continues the same use. */
export const RETURN_COALESCE_MS = 30_000;
/** A session with less active time is not worth recording. */
export const MIN_SESSION_MS = 2_000;
/** One segment may not exceed four hours; past it the segment is cut, the session stays. */
export const SEGMENT_MAX_MS = 14_400_000;
/** A session's wall clock may not exceed a day; past it the session is cut and a new one starts. */
export const SESSION_MAX_MS = 86_400_000;
/** How often a session snapshot is written for crash recovery. */
export const HEARTBEAT_MS = 30_000;
/** How often the queue is sent. */
export const FLUSH_MS = 900_000;
/** The queue sends at this many events even before its timer. */
export const FLUSH_BATCH = 200;
/** Local queue limits. */
export const QUEUE_MAX_EVENTS = 20_000;
export const QUEUE_MAX_BYTES = 20 * 1024 * 1024;
export const QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** The anonymous id rotates after this long. */
export const ANON_ROTATE_MS = 365 * 24 * 60 * 60_000;
/** Retry delays, in order; the last repeats until the queue's age limit. */
export const RETRY_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;
/** The largest batch a server accepts. */
export const MAX_BATCH_EVENTS = 500;
