import { z } from "zod";

/**
 * When a template runs on its own, in this machine's local time: every day,
 * on weekdays, on some days of the week, every N days (watering the plants), on
 * a day of the month, or every N hours. Times are wall-clock, so a daylight-saving change moves the instant,
 * never the hour on the clock.
 */
export const Cadence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
  z.object({ kind: z.literal("weekdays"), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
  z.object({
    kind: z.literal("weekly"),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /** 1 = Monday … 7 = Sunday. */
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7)
  }),
  z.object({
    kind: z.literal("monthly"),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /** Up to 28, so every month has it. */
    day: z.number().int().min(1).max(28)
  }),
  z.object({
    kind: z.literal("days"),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    every: z.number().int().min(2).max(90),
    /** The first day it counts from, YYYY-MM-DD; the day it was set up when left out. */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  }),
  z.object({ kind: z.literal("hourly"), every: z.number().int().min(1).max(24) })
]);
export type Cadence = z.infer<typeof Cadence>;

/** YYYY-MM-DD on this machine's calendar. */
export const localDate = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const clock = (at: string) => at.split(":").map(Number) as [number, number];
/** JavaScript's Sunday-first day as 1 = Monday … 7 = Sunday. */
const isoDay = (d: Date) => ((d.getDay() + 6) % 7) + 1;

/** The first time strictly after `after` that the cadence names. */
export function nextRun(cadence: Cadence, after: number): number {
  if (cadence.kind === "hourly") {
    // on the hour, every N hours counted from midnight, so "every 6 hours" is 00, 06, 12, 18
    const d = new Date(after);
    d.setMinutes(0, 0, 0);
    for (let i = 0; i < 49; i++) {
      d.setHours(d.getHours() + 1);
      if (d.getTime() > after && d.getHours() % cadence.every === 0) return d.getTime();
    }
    return after + cadence.every * 3_600_000;
  }
  const [hour, minute] = clock(cadence.at);
  const start = new Date(after);
  for (let offset = 0; offset < 400; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, hour, minute, 0, 0);
    if (day.getTime() <= after) continue;
    if (cadence.kind === "daily") return day.getTime();
    if (cadence.kind === "weekdays" && isoDay(day) <= 5) return day.getTime();
    if (cadence.kind === "weekly" && cadence.days.includes(isoDay(day))) return day.getTime();
    if (cadence.kind === "monthly" && day.getDate() === cadence.day) return day.getTime();
    if (cadence.kind === "days") {
      const [y, m, d] = (cadence.from ?? localDate(after)).split("-").map(Number) as [number, number, number];
      // whole calendar days, so a daylight-saving change does not shift the count
      const since = Math.round((Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) - Date.UTC(y, m - 1, d)) / 86_400_000);
      if (since >= 0 && since % cadence.every === 0) return day.getTime();
    }
  }
  throw new Error("this cadence never comes round");
}

/** The most recent time at or before `now` the cadence named, for telling a missed run from one not yet due. */
export function lastDue(cadence: Cadence, since: number, now: number): number | null {
  let t = nextRun(cadence, since);
  if (t > now) return null;
  for (let i = 0; i < 10_000; i++) {
    const next = nextRun(cadence, t);
    if (next > now) return t;
    t = next;
  }
  return t;
}
