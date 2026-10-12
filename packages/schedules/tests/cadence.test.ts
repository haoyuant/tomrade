import { describe, expect, it } from "vitest";
import { lastDue, nextRun } from "../src/cadence.js";

// Local wall-clock times: the tests read the same wherever they run.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("nextRun", () => {
  it("runs daily at the time, later today or tomorrow", () => {
    expect(nextRun({ kind: "daily", at: "09:00" }, at(2026, 10, 12, 8, 59))).toBe(at(2026, 10, 12, 9));
    expect(nextRun({ kind: "daily", at: "09:00" }, at(2026, 10, 12, 9, 0))).toBe(at(2026, 10, 13, 9));
  });

  it("skips the weekend on weekdays", () => {
    // 2026-10-16 is a Friday
    expect(nextRun({ kind: "weekdays", at: "09:00" }, at(2026, 10, 16, 10))).toBe(at(2026, 10, 19, 9));
  });

  it("runs weekly on the named days, Monday = 1", () => {
    expect(nextRun({ kind: "weekly", at: "17:30", days: [1, 3] }, at(2026, 10, 12, 18))).toBe(at(2026, 10, 14, 17, 30));
    expect(nextRun({ kind: "weekly", at: "08:00", days: [7] }, at(2026, 10, 12))).toBe(at(2026, 10, 18, 8));
  });

  it("runs monthly on the day, rolling into next month", () => {
    expect(nextRun({ kind: "monthly", at: "10:00", day: 1 }, at(2026, 10, 12))).toBe(at(2026, 11, 1, 10));
    expect(nextRun({ kind: "monthly", at: "10:00", day: 28 }, at(2026, 12, 28, 11))).toBe(at(2027, 1, 28, 10));
  });

  it("runs every N days at the time, counted from its first day", () => {
    const water = { kind: "days", at: "09:00", every: 3, from: "2026-10-12" } as const;
    expect(nextRun(water, at(2026, 10, 12, 8))).toBe(at(2026, 10, 12, 9));
    expect(nextRun(water, at(2026, 10, 12, 9))).toBe(at(2026, 10, 15, 9));
    // across a month end
    expect(nextRun(water, at(2026, 10, 30, 10))).toBe(at(2026, 11, 2, 9));
  });

  it("runs every N hours on the hour, counted from midnight", () => {
    expect(nextRun({ kind: "hourly", every: 6 }, at(2026, 10, 12, 13, 5))).toBe(at(2026, 10, 12, 18));
    expect(nextRun({ kind: "hourly", every: 6 }, at(2026, 10, 12, 18, 0))).toBe(at(2026, 10, 13, 0));
    expect(nextRun({ kind: "hourly", every: 1 }, at(2026, 10, 12, 13, 5))).toBe(at(2026, 10, 12, 14));
  });
});

describe("lastDue", () => {
  it("names the latest missed time, or none when nothing came due", () => {
    const daily = { kind: "daily", at: "09:00" } as const;
    expect(lastDue(daily, at(2026, 10, 10, 10), at(2026, 10, 12, 8))).toBe(at(2026, 10, 11, 9));
    expect(lastDue(daily, at(2026, 10, 12, 10), at(2026, 10, 12, 20))).toBeNull();
  });
});
