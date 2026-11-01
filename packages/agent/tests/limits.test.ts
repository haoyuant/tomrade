import { describe, expect, it } from "vitest";
import { limitCause, looksOutOfBalance, looksRateLimited, resetTime } from "../src/limits.js";

// 2026-10-12 21:30 in Shanghai (UTC+8, no daylight saving)
const NOW = Date.UTC(2026, 9, 12, 13, 30);
const shanghai = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 8, minute);

describe("limitCause", () => {
  it("tells a balance that ran out from a limit that lifts", () => {
    for (const error of [
      "Credit balance is too low",
      "Your credit balance is too low to access the Anthropic API.",
      "Insufficient Balance",
      "insufficient_quota",
      "You exceeded your current quota, please check your plan and billing details.",
      "out of credits",
      "402 Payment Required",
      "LLM request failed 402: no money",
      "API error 402",
      "账户余额不足，请充值",
      "您的账户已欠费",
      "stopped: billing_error"
    ]) {
      expect(looksOutOfBalance(error), error).toBe(true);
      expect(limitCause({ error }), error).toEqual({ kind: "balance" });
    }
    expect(limitCause({ error: "rate limited" })).toEqual({ kind: "wait", until: null });
    expect(limitCause({ error: "You've hit your limit", limit: { until: 123 } })).toEqual({ kind: "wait", until: 123 });
    expect(limitCause({ error: "usage limit reached", limit: { until: null } })).toEqual({ kind: "wait", until: null });
  });

  it("a time the engine gave is a wait, whatever else it says", () => {
    expect(limitCause({ error: "credit balance low", limit: { until: 123 } })).toEqual({ kind: "wait", until: 123 });
    expect(limitCause({ error: "credit balance low", limit: { until: null } })).toEqual({ kind: "balance" });
  });

  it("leaves ordinary failures alone, money words in passing included", () => {
    for (const error of [undefined, null, "", "LLM request failed 401: invalid api key", "Could not edit src/billing.ts", "compile failed at line 402", "build #1402 broke"]) {
      expect(looksOutOfBalance(error), String(error)).toBe(false);
      expect(limitCause({ error }), String(error)).toBeNull();
    }
  });
});

describe("looksRateLimited", () => {
  it("knows the ways agents say it", () => {
    for (const text of [
      "rate_limit",
      "Claude AI usage limit reached|1791900000",
      "You've hit your limit · resets 8pm (Asia/Shanghai)",
      "5-hour limit reached ∙ resets 3:45am",
      "You've hit your usage limit. Upgrade to Pro or try again in 4 days 3 hours.",
      "LLM request failed 429: {\"error\":\"Too Many Requests\"}",
      "RESOURCE_EXHAUSTED: quota exceeded for this project",
      "Rate limited. Please try again later."
    ])
      expect(looksRateLimited(text), text).toBe(true);
  });

  it("does not take other failures, or an empty purse, for a wait", () => {
    for (const text of [null, "", "exit 1", "LLM request failed 401: invalid api key", "Insufficient Balance", "402 Payment Required", "billing_error: credit balance too low"])
      expect(looksRateLimited(text), String(text)).toBe(false);
  });
});

describe("resetTime", () => {
  it("reads a clock time in the zone it names, next time it comes round", () => {
    expect(resetTime("You've hit your limit · resets 11pm (Asia/Shanghai)", NOW)).toBe(shanghai(12, 23));
    // 1am is past for today: tomorrow's
    expect(resetTime("5-hour limit reached ∙ resets 1:15am (Asia/Shanghai)", NOW)).toBe(shanghai(13, 1, 15));
    expect(resetTime("retry after 20:00 (UTC)", NOW)).toBe(Date.UTC(2026, 9, 12, 20, 0));
    expect(resetTime("Try again at 9:05 PM (America/Los_Angeles)", NOW)).toBe(Date.UTC(2026, 9, 13, 4, 5));
  });

  it("reads a weekly reset with its date", () => {
    expect(resetTime("You've hit your weekly limit · resets Oct 15, 9am (America/Los_Angeles)", NOW)).toBe(Date.UTC(2026, 9, 15, 16, 0));
  });

  it("reads epoch stamps, ISO times, durations and Retry-After seconds", () => {
    expect(resetTime("Claude AI usage limit reached|1791900000", NOW)).toBe(1791900000 * 1000);
    expect(resetTime('{"resetsAt": 1791900000123}', NOW)).toBe(1791900000123);
    expect(resetTime("limit resets at 2026-10-13T02:00:00Z", NOW)).toBe(Date.UTC(2026, 9, 13, 2, 0));
    expect(resetTime("try again in 4 days 3 hours", NOW)).toBe(NOW + (4 * 24 + 3) * 3_600_000);
    expect(resetTime("Please try again in 1 hour and 20 minutes.", NOW)).toBe(NOW + 80 * 60_000);
    expect(resetTime("429 Too Many Requests; retry-after: 30", NOW)).toBe(NOW + 30_000);
  });

  it("takes a time with no zone as this machine's", () => {
    const t = resetTime("resets 11:45pm", NOW)!;
    const d = new Date(t);
    expect([d.getHours(), d.getMinutes()]).toEqual([23, 45]);
    expect(t).toBeGreaterThan(NOW);
    expect(t - NOW).toBeLessThanOrEqual(86_400_000);
  });

  it("says nothing it cannot stand behind", () => {
    for (const text of [null, "rate limited", "resets 5", "retry after a while", "resets at 1999-01-01T00:00:00Z", "Claude AI usage limit reached|1000000000", "try again in 30 days"])
      expect(resetTime(text, NOW), String(text)).toBeNull();
  });

  it("ignores an unknown zone rather than failing", () => {
    expect(resetTime("resets 11pm (Mars/Olympus)", NOW)).not.toBeNull();
  });
});
