import type { Context } from "cordis";
import { describeFailure, looksRateLimited, resetTime, type Engine, type TurnIO, type TurnInput, type TurnMetrics, type TurnResult } from "@tomradex/agent";
import type {} from "@tomradex/mcp";
import { bindTurn, RuntimePool, runtimeFingerprint, type Runtime } from "./runtime.js";
import { engineLocale, KIT_WORDS } from "./words.js";

/** One running turn, as its runtime sees it. */
export interface TurnFrame {
  /** The person cancelled this turn. */
  readonly cancelled: boolean;
  /** The turn posted a question for the person and waits for the answer. */
  asked(): boolean;
  /** What cancelling does to this runtime; called once, after `cancelled` turned true. */
  onAbort(stop: () => void): void;
  /** Everything known about a failure, with what the agent last wrote to stderr. */
  details(sections: Record<string, unknown>): string | undefined;
  /** A failure's result: cancelled when the person cancelled, else `error` with its details. */
  failed(error: string, sections?: Record<string, unknown>): TurnResult;
}

export interface TurnSpec {
  ctx: Context;
  /** The runtime's MCP token, bound to this turn's tools until it ends. */
  token: string;
  input: TurnInput;
  metrics: TurnMetrics;
  /** The session the next turn resumes. */
  resume(): string | undefined;
  /** This runtime's result for a stop, with what it counted so far. */
  result(stop: TurnResult["stop"], error?: string, details?: string): TurnResult;
  /** The error line for a thrown failure; its message unless the runtime words it otherwise. */
  explain?(error: unknown): string;
  stderr?(): string | undefined;
  /** After a thrown failure, before its result: hand on what was said, close the runtime. */
  thrown?(error: unknown): void;
  /** Always, before Tomrade's tools are released. */
  cleanup?(): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** An error that reads as a usage or rate limit stops on that limit, lifting when its words say. */
function limited(result: TurnResult): TurnResult {
  if (result.stop !== "error" || result.limit || !looksRateLimited(result.error)) return result;
  return { ...result, limit: { until: resetTime(result.error) } };
}

/**
 * The frame every runtime's turn runs in: Tomrade's tools bound for its
 * length, cancellation, a thrown failure turned into a result with its
 * details, and a rate-limited error reported as a limit.
 */
export async function runTurn(io: TurnIO, spec: TurnSpec, body: (turn: TurnFrame) => Promise<TurnResult>): Promise<TurnResult> {
  const binding = bindTurn(spec.ctx, spec.token, io, spec.input);
  let cancelled = io.signal.aborted;
  let stop: (() => void) | undefined;
  const details = (sections: Record<string, unknown>) => describeFailure({ ...sections, stderr: spec.stderr?.() });
  const turn: TurnFrame = {
    get cancelled() { return cancelled; },
    asked: binding.asked,
    onAbort: (fn) => { stop = fn; },
    details,
    failed: (error, sections = {}) => (cancelled ? spec.result("cancelled") : spec.result("error", error, details(sections)))
  };
  const abort = () => { cancelled = true; stop?.(); };
  io.signal.addEventListener("abort", abort, { once: true });
  try {
    if (cancelled) return { stop: "cancelled", resume: spec.resume(), metrics: spec.metrics };
    return limited(await body(turn));
  } catch (error) {
    spec.thrown?.(error);
    return limited(turn.failed((spec.explain ?? messageOf)(error), { error }));
  } finally {
    io.signal.removeEventListener("abort", abort);
    spec.cleanup?.();
    await binding.release();
  }
}

/**
 * An engine's `turn` over warm runtimes, one per thread, closed with the
 * plugin. `fingerprint` names what else makes a thread's runtime stale.
 */
export function pooledEngine<T extends Runtime>(ctx: Context, opts: { create(input: TurnInput): T; fingerprint?(input: TurnInput, io: TurnIO): string }): Engine["turn"] {
  const pool = new RuntimePool<T>();
  ctx.effect(() => () => pool.close());
  return async (input, io) => {
    const url = ctx.mcp.url;
    if (!url) return { stop: "error", error: KIT_WORDS(engineLocale(ctx))("noMcp") };
    const fingerprint = runtimeFingerprint(input, io, url);
    return pool.run(`${input.projectId}:${input.threadId}`, opts.fingerprint ? `${fingerprint}:${opts.fingerprint(input, io)}` : fingerprint,
      () => opts.create(input), input, io);
  };
}
