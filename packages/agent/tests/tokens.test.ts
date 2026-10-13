import { describe, expect, it } from "vitest";
import { NO_TOKENS, addTokens, runTokens } from "@tomradex/agent";

describe("runTokens", () => {
  it("splits input into new, cache read and cache write that add up to it", () => {
    // TOM-84's pi run: almost all of its input was read from the cache
    const t = runTokens({ inputTokens: 7_881_575, outputTokens: 29_766 }, { cacheReadTokens: 7_780_480, cacheWriteTokens: 0 });
    expect(t).toEqual({ inputTokens: 7_881_575, uncachedInputTokens: 101_095, cacheReadTokens: 7_780_480, cacheWriteTokens: 0, outputTokens: 29_766 });
    expect(t!.uncachedInputTokens + t!.cacheReadTokens + t!.cacheWriteTokens).toBe(t!.inputTokens);
  });

  it("counts all input as new when the engine reports no cache counters", () => {
    expect(runTokens({ inputTokens: 500, outputTokens: 20 }, null)).toEqual({ inputTokens: 500, uncachedInputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 });
    expect(runTokens({ inputTokens: 500, outputTokens: 20 }, { cacheReadTokens: 100 })).toMatchObject({ uncachedInputTokens: 400, cacheReadTokens: 100, cacheWriteTokens: 0 });
  });

  it("never lets cache counters exceed the input they are part of", () => {
    const t = runTokens({ inputTokens: 100, outputTokens: 1 }, { cacheReadTokens: 80, cacheWriteTokens: 50 })!;
    expect(t).toMatchObject({ uncachedInputTokens: 0, cacheReadTokens: 80, cacheWriteTokens: 20 });
  });

  it("is null for a run that reported no usage", () => {
    expect(runTokens(null, { cacheReadTokens: 5 })).toBeNull();
  });

  it("adds runs part by part", () => {
    const a = runTokens({ inputTokens: 1000, outputTokens: 10 }, { cacheReadTokens: 700, cacheWriteTokens: 200 });
    const b = runTokens({ inputTokens: 50, outputTokens: 5 }, null);
    expect([a, null, b].reduce((sum, t) => addTokens(sum, t), NO_TOKENS)).toEqual({ inputTokens: 1050, uncachedInputTokens: 150, cacheReadTokens: 700, cacheWriteTokens: 200, outputTokens: 15 });
  });
});
