/**
 * Token accounting for a Claude Code turn. Live numbers come from the API's
 * own streaming events: message_start carries the request's prompt tokens,
 * cache included, and message_delta the reply so far. Final numbers come from
 * the result's modelUsage — every model call, cumulative across the turns one
 * process serves, so a turn is the difference from the previous result — with
 * the main-loop `usage` as the fallback for builds that lack it. Input means
 * every prompt token the model processed: cached ones are context, not free.
 */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface ModelTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ResultCounters {
  usage?: ApiUsage;
  modelUsage?: Record<string, ModelTokens>;
}

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const fromApi = (u: ApiUsage | undefined): Tokens => ({
  input: u?.input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? 0,
  cacheWrite: u?.cache_creation_input_tokens ?? 0
});

const sumModels = (models: Record<string, ModelTokens> | undefined): Tokens | null => {
  const rows = Object.values(models ?? {});
  if (!rows.length) return null;
  return rows.reduce<Tokens>((acc, m) => ({ input: acc.input + m.inputTokens, output: acc.output + m.outputTokens, cacheRead: acc.cacheRead + m.cacheReadInputTokens, cacheWrite: acc.cacheWrite + m.cacheCreationInputTokens }), ZERO);
};

/** Every prompt token the model read this turn, cached or not. */
export const promptTokens = (t: Tokens): number => t.input + t.cacheRead + t.cacheWrite;

/** Whether the provider said anything about caching; absent fields stay absent in the metrics. */
export const cacheKnown = (r: ResultCounters): boolean => Object.keys(r.modelUsage ?? {}).length > 0 || r.usage?.cache_read_input_tokens != null;

/**
 * This turn's counters, and the cumulative figure to diff the next result
 * against (null when the result carried no modelUsage).
 */
export function turnTokens(result: ResultCounters, previous: Tokens | null): { turn: Tokens; cumulative: Tokens | null } {
  const models = sumModels(result.modelUsage);
  if (!models) return { turn: fromApi(result.usage), cumulative: null };
  const before = previous ?? ZERO;
  return {
    turn: { input: Math.max(0, models.input - before.input), output: Math.max(0, models.output - before.output), cacheRead: Math.max(0, models.cacheRead - before.cacheRead), cacheWrite: Math.max(0, models.cacheWrite - before.cacheWrite) },
    cumulative: models
  };
}

/** The running total of one turn, fed by streaming events as they arrive. */
export class LiveUsage {
  private prompt = 0;
  private finished = 0;
  private current = 0;

  /** The total after this event, or null when the event says nothing about tokens. */
  observe(event: { type?: string; message?: { usage?: ApiUsage }; usage?: ApiUsage } | undefined): { inputTokens: number; outputTokens: number } | null {
    if (!event) return null;
    if (event.type === "message_start") {
      this.prompt += promptTokens(fromApi(event.message?.usage));
      this.current = event.message?.usage?.output_tokens ?? 0;
    } else if (event.type === "message_delta") this.current = event.usage?.output_tokens ?? this.current;
    else if (event.type === "message_stop") {
      this.finished += this.current;
      this.current = 0;
    } else return null;
    return { inputTokens: this.prompt, outputTokens: this.finished + this.current };
  }
}
