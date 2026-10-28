import { describe, expect, it } from "vitest";
import type { ReplayRecord } from "@tomradex/code-sessions";
import { clockAt, clockLabel, fitScale, IDLE_CAP_MS, playedBy, playTimes, replayFrom } from "../src/code-sessions/playback";

const r = (t: number): ReplayRecord => ({ t, w: 80, h: 24, full: false, key: false, bytes: new Uint8Array(1) });

describe("replay timing", () => {
  it("plays the catch-up at once and the rest as painted, a long silence taking a second", () => {
    const records = [r(1000), r(1100), r(1500), r(9000), r(9050)];
    expect(playTimes(records, 1)).toEqual([0, 0, 400, 400 + IDLE_CAP_MS, 400 + IDLE_CAP_MS + 50]);
    expect(playTimes(records, 0)).toEqual([0, 100, 500, 500 + IDLE_CAP_MS, 500 + IDLE_CAP_MS + 50]);
    expect(playTimes([], 0)).toEqual([]);
  });

  it("counts the records played by a time, and names the recording's clock there", () => {
    const records = [r(1000), r(1100), r(1500)];
    const times = playTimes(records, 0);
    expect(playedBy(times, -1)).toBe(0);
    expect(playedBy(times, 0)).toBe(1);
    expect(playedBy(times, 100)).toBe(2);
    expect(playedBy(times, 499)).toBe(2);
    expect(playedBy(times, 500)).toBe(3);
    expect(clockAt(records, times, 100)).toBe(1100);
    expect(clockAt(records, times, -1)).toBe(1000);
    expect(clockAt([], [], 0)).toBeNull();
  });

  it("scales a screen down to the box, never up, and writes a play time as a clock", () => {
    expect(fitScale({ width: 400, height: 300 }, { width: 800, height: 300 })).toBe(0.5);
    expect(fitScale({ width: 400, height: 300 }, { width: 200, height: 100 })).toBe(1);
    expect(fitScale({ width: 400, height: 300 }, { width: 0, height: 0 })).toBe(1);
    expect(clockLabel(0)).toBe("0:00");
    expect(clockLabel(65_000)).toBe("1:05");
    expect(clockLabel(3_725_000)).toBe("1:02:05");
  });

  it("writes a replay from the newest keyframe before where it goes, never from the start of a long recording", () => {
    const k = (t: number, w = 80, h = 24): ReplayRecord => ({ ...r(t), key: true, w, h });
    const records = [k(0, 100, 30), r(1), r(2), k(3, 120, 40), r(4), { ...r(5), w: 0, h: 0 }, k(6, 0, 0), r(7)];
    // Opening on the last screen: from the last keyframe, at the last size painted by then (it names none of its own).
    expect(replayFrom(records, 0, records.length)).toEqual({ from: 6, reset: true, size: { w: 80, h: 24 } });
    // Playing on with no keyframe between: straight on.
    expect(replayFrom(records, 4, 6)).toEqual({ from: 4, reset: false, size: null });
    // A keyframe on the way forward starts the screen again there.
    expect(replayFrom(records, 1, 5)).toEqual({ from: 3, reset: true, size: { w: 120, h: 40 } });
    // Back: from the newest keyframe before the target, not from 0.
    expect(replayFrom(records, 8, 3)).toEqual({ from: 0, reset: true, size: { w: 100, h: 30 } });
    expect(replayFrom(records, 8, 5)).toEqual({ from: 3, reset: true, size: { w: 120, h: 40 } });
    // A recording with no keyframe goes back to its start.
    expect(replayFrom([r(0), r(1), r(2)], 3, 2)).toEqual({ from: 0, reset: true, size: { w: 80, h: 24 } });
    expect(replayFrom(records, 0, 0)).toEqual({ from: 0, reset: false, size: null });
  });
});
