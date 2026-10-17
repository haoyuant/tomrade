/**
 * Usage and rate limits, read from what an engine said when it stopped. Each
 * agent words it differently — Claude Code's "resets 8pm (Asia/Shanghai)", an
 * API's "retry after 20:00", Codex's "try again in 2 hours" — so this reads
 * the shapes they use rather than any one of them.
 */

import type { WordsLocale } from "@tomradex/domain";
import { AGENT_WORDS } from "./words.js";

const LIMITED = /\b(rate[ _-]?limit(?:ed)?|usage limit|limit reached|hit your (?:\w+ )?limit|too many requests|quota (?:exceeded|exhausted)|resource[_ ]exhausted|usage_?limit_?exceeded)\b|\b429\b/i;
// Out of money is a limit that no clock lifts.
const NOT_A_WAIT = /\b(insufficient (?:balance|credits?|funds)|billing|payment required|credit balance|out of credits|402)\b/i;

/** The engine stopped on a limit that lifts by itself, as far as its words say. */
export const looksRateLimited = (text: string | null | undefined): boolean => !!text && LIMITED.test(text) && !NOT_A_WAIT.test(text);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
/** Past this, a reading is a misreading: no plan's window is longer than a week. */
const FURTHEST_MS = 8 * 86_400_000;

const fields = (t: number, zone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
};

const validZone = (zone: string | undefined): string | undefined => {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
};

/** A wall-clock time in a zone (or this machine's), as epoch ms. */
function wallClock(year: number, month: number, day: number, hour: number, minute: number, zone: string | undefined): number {
  if (!zone) return new Date(year, month, day, hour, minute).getTime();
  const asUtc = Date.UTC(year, month, day, hour, minute);
  const offset = (t: number) => {
    const f = fields(t, zone);
    return Date.UTC(f.year, f.month, f.day, f.hour, f.minute, f.second) - t;
  };
  const first = asUtc - offset(asUtc);
  return asUtc - offset(first);
}

const today = (now: number, zone: string | undefined) => {
  if (zone) return fields(now, zone);
  const d = new Date(now);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
};

const CLOCK =
  /\b(?:resets?|reset at|retry after|try again (?:at|after)|available (?:again )?(?:at|after)|until)\s+(?:at\s+|on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i;
const RELATIVE = /\b(?:in|after)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b(?:\s*,?\s*(?:and\s+)?)?)+)/i;
const RETRY_SECONDS = /\bretry[- ]after["']?\s*[:=]?\s*(\d+)\s*(?:s|secs?|seconds?)?\b(?![:.]\d)/i;
const EPOCH = /(?:\||resets?_?at["']?\s*[:=]\s*)(\d{10}(?:\d{3})?)\b/i;
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/;

/**
 * When a limit lifts, read from an engine's words; null when they do not say.
 * A bare clock time is the next time it comes round — "resets 1am" said at
 * 11pm is two hours away, not twenty-two hours ago.
 */
export function resetTime(text: string | null | undefined, now = Date.now()): number | null {
  if (!text) return null;
  const sane = (t: number | null): number | null => (t !== null && Number.isFinite(t) && t > now - 60_000 && t - now <= FURTHEST_MS ? Math.max(t, now) : null);

  const epoch = EPOCH.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    const t = sane(n < 1e12 ? n * 1000 : n);
    if (t !== null) return t;
  }
  const iso = ISO.exec(text);
  if (iso) {
    const t = sane(Date.parse(iso[0]));
    if (t !== null) return t;
  }
  const clock = CLOCK.exec(text);
  if (clock) {
    const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = clock;
    // "resets 5" says nothing; an hour needs minutes or am/pm to be a time
    if (minuteText !== undefined || meridiem) {
      let hour = Number(hourText);
      const minute = Number(minuteText ?? 0);
      const pm = meridiem && /^p/i.test(meridiem);
      if (meridiem) hour = (hour % 12) + (pm ? 12 : 0);
      if (hour < 24 && minute < 60) {
        const zone = validZone(zoneText);
        const base = today(now, zone);
        if (monthName) {
          const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
          let t = wallClock(base.year, month, Number(dayText), hour, minute, zone);
          if (t < now - 86_400_000) t = wallClock(base.year + 1, month, Number(dayText), hour, minute, zone);
          const found = sane(t);
          if (found !== null) return found;
        } else {
          let t = wallClock(base.year, base.month, base.day, hour, minute, zone);
          if (t <= now) t = wallClock(base.year, base.month, base.day + 1, hour, minute, zone);
          const found = sane(t);
          if (found !== null) return found;
        }
      }
    }
  }
  const relative = RELATIVE.exec(text);
  if (relative) {
    let ms = 0;
    for (const [, n, unit] of relative[1]!.matchAll(/(\d+)\s*([a-z]+)/gi)) ms += Number(n) * (UNIT_MS[unit!.toLowerCase()[0]!] ?? 0);
    const t = sane(now + ms);
    if (ms > 0 && t !== null) return t;
  }
  const seconds = RETRY_SECONDS.exec(text);
  if (seconds) return sane(now + Number(seconds[1]) * 1000);
  return null;
}

const MONTH_KEYS = ["month1", "month2", "month3", "month4", "month5", "month6", "month7", "month8", "month9", "month10", "month11", "month12"] as const;

/** When a limit lifts, as the person reads it on this machine: "20:00", "tomorrow 09:00", "Oct 15 09:00". */
export function untilLabel(t: number, locale: WordsLocale, now = Date.now()): string {
  const w = AGENT_WORDS(locale);
  const d = new Date(t);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const n = new Date(now);
  if (day(d) === day(n)) return time;
  const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  if (day(d) === day(next)) return w("untilTomorrow", { time });
  return w("untilDate", { month: w(MONTH_KEYS[d.getMonth()]!), day: d.getDate(), time });
}
