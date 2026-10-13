import type { TurnMetrics } from "./evaluation.js";

/**
 * A run's tokens the one way a ticket's conversation and the Usage pane both
 * show them. Input is every prompt token the model read: new (uncached) +
 * cache read + cache write, so the three parts always add up to it. Engines
 * that report no cache counters count all their input as new.
 */
export interface TokenBreakdown {
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export const NO_TOKENS: TokenBreakdown = { inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

export function runTokens(usage: { inputTokens?: number; outputTokens?: number } | null | undefined, metrics?: Pick<TurnMetrics, "cacheReadTokens" | "cacheWriteTokens"> | null): TokenBreakdown | null {
  if (!usage) return null;
  const inputTokens = usage.inputTokens ?? 0;
  // Cache counters can come from a narrower slice of the turn than the input total; never let them exceed it.
  const cacheReadTokens = Math.min(inputTokens, metrics?.cacheReadTokens ?? 0);
  const cacheWriteTokens = Math.min(inputTokens - cacheReadTokens, metrics?.cacheWriteTokens ?? 0);
  return { inputTokens, uncachedInputTokens: inputTokens - cacheReadTokens - cacheWriteTokens, cacheReadTokens, cacheWriteTokens, outputTokens: usage.outputTokens ?? 0 };
}

export const addTokens = (a: TokenBreakdown, b: TokenBreakdown | null): TokenBreakdown =>
  b
    ? {
        inputTokens: a.inputTokens + b.inputTokens,
        uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
        outputTokens: a.outputTokens + b.outputTokens
      }
    : a;
