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

/**
 * The running total of one turn, fed by streaming events as they arrive. Each
 * stream (the main loop, every subagent) has one open request at a time. One
 * that drops mid-stream is sent again whole, so its figures leave the total
 * when the retry is announced instead of counting the prompt twice.
 */
export class LiveUsage {
  private prompt = 0;
  private finished = 0;
  /** Each stream's open request: its prompt, and its reply so far. */
  private open = new Map<string, { prompt: number; output: number }>();

  /** The total after this event, or null when the event says nothing about tokens. */
  observe(event: { type?: string; message?: { usage?: ApiUsage }; usage?: ApiUsage } | undefined, stream: string | null = null): { inputTokens: number; outputTokens: number } | null {
    if (!event) return null;
    const key = stream ?? "";
    if (event.type === "message_start") {
      this.close(key);
      this.open.set(key, { prompt: promptTokens(fromApi(event.message?.usage)), output: event.message?.usage?.output_tokens ?? 0 });
    } else if (event.type === "message_delta") {
      const open = this.open.get(key);
      if (open) open.output = event.usage?.output_tokens ?? open.output;
    } else if (event.type === "message_stop") this.close(key);
    else return null;
    return this.total();
  }

  /** The main loop's open request failed and will be sent again. */
  retry(): { inputTokens: number; outputTokens: number } {
    this.open.delete("");
    return this.total();
  }

  private close(key: string) {
    const open = this.open.get(key);
    if (!open) return;
    this.prompt += open.prompt;
    this.finished += open.output;
    this.open.delete(key);
  }

  private total() {
    let prompt = this.prompt;
    let output = this.finished;
    for (const open of this.open.values()) { prompt += open.prompt; output += open.output; }
    return { inputTokens: prompt, outputTokens: output };
  }
}
