import { describe, it, expect } from "vitest";
import { summarizeEvaluation, type EvaluationObservation } from "../src/evaluation.js";

describe("A/B reporting", () => {
  it("keeps unavailable counters unknown and separates first and follow-up turns", () => {
    const base: EvaluationObservation = { caseId: "read", repetition: 0, variant: "baseline", turn: 0,
      engine: "codex", elapsedMs: 400, firstVisibleTextMs: 300, firstTokenMs: null,
      toolCalls: 1, toolFailures: 0, stop: "end", success: true, checks: { correct: true },
      inputTokens: 12, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, text: "ok" };
    const report = summarizeEvaluation([base, { ...base, variant: "candidate", turn: 1, firstTokenMs: 12 }]);
    expect(report[0].firstTokenMs).toEqual({ samples: 0, p50: null, p95: null, total: null });
    expect(report[0].costUsd.total).toBeNull();
    expect(report[3].firstTokenMs.p50).toBe(12);
    expect(report[2].successRate).toBeNull();
  });
});
