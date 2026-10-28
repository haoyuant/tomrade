import type { ReplayRecord } from "@tomradex/code-sessions";

/** A silence in the recording longer than this plays as this long: a replay never waits out a lunch break. */
export const IDLE_CAP_MS = 1000;
/** How fast a replay may go, as the person picks. */
export const SPEEDS = [1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * When each record plays, in ms from the replay's start: the records before `at` (the catch-up) play at once, the rest
 * as they were painted, long silences capped.
 */
export function playTimes(records: ReplayRecord[], at: number): number[] {
  const times: number[] = [];
  let clock = 0;
  for (let i = 0; i < records.length; i++) {
    if (i <= at) times.push(0);
    else {
      clock += Math.min(IDLE_CAP_MS, Math.max(0, records[i]!.t - records[i - 1]!.t));
      times.push(clock);
    }
  }
  return times;
}

/** How many records are played by `time`: the first whose play time is past it. */
export function playedBy(times: number[], time: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where to write from to show the first `upTo` records, when the first `applied` are in the terminal: on from there,
 * unless a keyframe (which resets the screen) comes at or after it — or `upTo` is behind it — when the newest keyframe
 * before `upTo` is where the screen starts, and nothing before it shows. `size` is the pane's size at that start.
 */
export function replayFrom(records: ReplayRecord[], applied: number, upTo: number): { from: number; reset: boolean; size: { w: number; h: number } | null } {
  let key = -1;
  for (let i = upTo - 1; i >= 0; i--) if (records[i]!.key) { key = i; break; }
  if (upTo >= applied && key < applied) return { from: applied, reset: false, size: null };
  const from = Math.max(0, key);
  let size: { w: number; h: number } | null = null;
  for (let i = from; i >= 0; i--) if (records[i]!.w > 0 && records[i]!.h > 0) { size = { w: records[i]!.w, h: records[i]!.h }; break; }
  return { from, reset: true, size };
}

/** The recording's clock at a play time: what the pane showed then. */
export function clockAt(records: ReplayRecord[], times: number[], time: number): number | null {
  const n = playedBy(times, time);
  return n ? records[n - 1]!.t : (records[0]?.t ?? null);
}

/** The scale that fits a screen of `w` × `h` pixels into a box, never above 1. */
export const fitScale = (box: { width: number; height: number }, screen: { width: number; height: number }): number => (!screen.width || !screen.height ? 1 : Math.min(1, box.width / screen.width, box.height / screen.height));

/** A play time as m:ss or h:mm:ss. */
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
