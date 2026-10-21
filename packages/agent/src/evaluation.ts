import { performance } from "node:perf_hooks";
import type { Engine } from "./engine.js";
import type { Block } from "./thread.js";
import type { TurnInput, TurnIO, TurnResult } from "./turn.js";

/** Provider counters stay separate: cached tokens are context, not free input. */
export interface TurnMetrics {
  transport: "sdk" | "app-server" | "rpc" | "acp" | "http";
  runtime: "cold" | "warm";
  readyMs?: number;
  firstTokenMs?: number;
  /** Unknown provider fields must remain absent, never fabricated as zero. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  uncachedInputTokens?: number;
  compactions?: number;
  providerModel?: string;
  toolCalls?: number;
}

export interface EvaluationObservation {
  caseId: string;
  repetition: number;
  variant: "baseline" | "candidate";
  turn: number;
  engine: string;
  elapsedMs: number;
  firstVisibleTextMs: number | null;
  /** Strict TTFT: only streamed text deltas count, final messages do not. */
  firstTokenMs: number | null;
  toolCalls: number;
  toolFailures: number;
  stop: TurnResult["stop"];
  success: boolean;
  checks: Record<string, boolean>;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  metrics?: TurnMetrics;
  error?: string;
  text: string;
}

/** Runs the production adapter with its real IO; the caller supplies isolated state. */
export async function evaluateTurn(args: {
  engine: Engine;
  input: TurnInput;
  io: TurnIO;
  caseId: string;
  repetition: number;
  variant: EvaluationObservation["variant"];
  turn: number;
  check: (result: TurnResult, blocks: Block[]) => Record<string, boolean> | Promise<Record<string, boolean>>;
}): Promise<{ result: TurnResult; observation: EvaluationObservation }> {
  const start = performance.now();
  let firstTokenMs: number | null = null;
  let firstVisibleTextMs: number | null = null;
  let toolCalls = 0;
  let toolFailures = 0;
  let nativeCalls = 0;
  const blocks: Block[] = [];
  let result: TurnResult;
  try {
    result = await args.engine.turn(args.input, {
      ...args.io,
      delta(text) {
        if (text.length) {
          firstTokenMs ??= performance.now() - start;
          firstVisibleTextMs ??= firstTokenMs;
        }
        args.io.delta(text);
      },
      emit(block) {
        blocks.push(block);
        if (block.type === "text" && block.text.length) firstVisibleTextMs ??= performance.now() - start;
        if (block.type === "trace" && block.summary === "run by Claude Code itself") nativeCalls++;
        args.io.emit(block);
      },
      tools: {
        describe: () => args.io.tools.describe(),
        async execute(name, input) {
          toolCalls++;
          try { return await args.io.tools.execute(name, input); }
          catch (error) { toolFailures++; throw error; }
        }
      }
    });
  } catch (error) {
    result = { stop: args.io.signal.aborted ? "cancelled" : "error", error: String(error) };
  }
  const elapsedMs = performance.now() - start;
  const checks = await args.check(result, blocks);
  return {
    result,
    observation: {
      caseId: args.caseId, repetition: args.repetition, variant: args.variant,
      turn: args.turn, engine: args.engine.id, elapsedMs,
      firstTokenMs: result.metrics?.firstTokenMs ?? firstTokenMs, firstVisibleTextMs,
      toolCalls: result.metrics?.toolCalls ?? toolCalls + nativeCalls, toolFailures,
      stop: result.stop,
      success: (result.stop === "end" || result.stop === "asked") && Object.keys(checks).length > 0 && Object.values(checks).every(Boolean),
      checks, inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      cacheReadTokens: result.metrics?.cacheReadTokens ?? null,
      cacheWriteTokens: result.metrics?.cacheWriteTokens ?? null,
      costUsd: result.costUsd ?? null, metrics: result.metrics, error: result.error,
      text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n")
    }
  };
}

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1]!;
};

export function summarizeEvaluation(rows: EvaluationObservation[]) {
  return ["baseline", "candidate"].flatMap((variant) => ["cold", "warm"].map((runtime) => {
    const selected = rows.filter((r) => r.variant === variant && (r.turn === 0 ? "cold" : "warm") === runtime);
    const metric = (key: "firstTokenMs" | "firstVisibleTextMs" | "elapsedMs" | "toolCalls" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "costUsd") => {
      const values = selected.flatMap((r) => r[key] === null ? [] : [r[key]]);
      return { samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), total: values.length ? values.reduce((a, b) => a + b, 0) : null };
    };
    return { variant, runtime, samples: selected.length,
      successRate: selected.length ? selected.filter((r) => r.success).length / selected.length : null,
      firstTokenMs: metric("firstTokenMs"), firstVisibleTextMs: metric("firstVisibleTextMs"),
      elapsedMs: metric("elapsedMs"), toolCalls: metric("toolCalls"), outputTokens: metric("outputTokens"),
      cacheReadTokens: metric("cacheReadTokens"), cacheWriteTokens: metric("cacheWriteTokens"), costUsd: metric("costUsd") };
  }));
}
