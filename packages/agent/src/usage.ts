import { NO_TOKENS, runTokens, type TokenBreakdown } from "./tokens.js";
import type { TurnMetrics } from "./evaluation.js";

/** One started run as the Usage pane reads it, before any window is applied. */
export interface UsageRun {
  engine: string;
  status: "done" | "asked" | "cancelled" | "error";
  startedAt: number;
  endedAt: number | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  metrics: Pick<TurnMetrics, "cacheReadTokens" | "cacheWriteTokens" | "providerModel"> | null;
  costUsd: number | null;
  /** The ticket the run's conversation stands for; absent or null for a run on no ticket. */
  projectId?: string;
  itemId?: string | null;
  /** The delivery a General run was pinned to, when it said. */
  deliveryId?: string | null;
}

/** Median and nearest-rank p95 over the runs that reported both ends. */
export interface UsageDuration {
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
}

/** What a stretch of runs added up to. Counts and sums are exact; ratios derive from them. */
export interface UsageTotals extends TokenBreakdown {
  runs: number;
  /** Runs that ended in an error. */
  failedRuns: number;
  /** Runs the person stopped. Neither failed nor successful, so they never inflate a success rate. */
  cancelledRuns: number;
  /** Null when no run in the window said what it cost — never a fabricated zero. */
  costUsd: number | null;
  costKnownRuns: number;
  costUnknownRuns: number;
  /** Cache reads over all prompt tokens read; null when nothing was read. */
  cacheHitRate: number | null;
  duration: UsageDuration | null;
}

/** One provider model under an engine, when the engine named it. */
export interface ModelUsage extends UsageTotals {
  model: string;
}

/** What one engine's finished runs added up to over a stretch of time, across every open project. */
export interface EngineUsage extends UsageTotals {
  engine: string;
  title: string;
  /** The models this engine reported serving the window with, busiest first. */
  models: ModelUsage[];
}

/** One local day, always present in a range even when nothing ran on it. */
export interface UsageDay extends UsageTotals {
  /** Local midnight, for charts. */
  at: number;
  /** Local `YYYY-MM-DD`, stable across time zones in one machine's data. */
  date: string;
}

/** One ticket's runs in a window. `key` and `title` are filled in by whoever can read tickets. */
export interface TicketUsage extends UsageTotals {
  projectId: string;
  itemId: string;
  key: string | null;
  title: string;
}

export interface UsageReport {
  from: number;
  to: number;
  days: UsageDay[];
  engines: EngineUsage[];
  /** Tickets with runs in the window, costliest first. */
  tickets: TicketUsage[];
  /** Runs on no ticket: the assistant's own conversations, routines, chat. Still counted in `totals`. */
  noTicket: UsageTotals;
  totals: UsageTotals;
}

/** One delivery of a ticket and its runs; `sequence` null holds runs from before the first delivery began. */
export interface DeliveryUsage extends UsageTotals {
  sequence: number | null;
  state: string | null;
}

/** Everything one ticket's runs added up to, by agent and by delivery. */
export interface TicketSpend {
  totals: UsageTotals;
  engines: EngineUsage[];
  deliveries: DeliveryUsage[];
}

/** What a ticket's spend needs of its deliveries. */
export interface DeliverySpan {
  id: string;
  sequence: number;
  state: string;
  startedAt: number;
  completedAt: number | null;
}

export interface UsageSummary {
  /** Since local midnight. */
  today: EngineUsage[];
  /** The last seven days, today included. */
  week: EngineUsage[];
  /** The window the pane drew: the requested number of local days, ending today. */
  range: UsageReport;
}

const pad = (n: number) => String(n).padStart(2, "0");

export const dayStartOf = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export const dayKeyOf = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const shiftDays = (from: number, days: number): number => {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.getTime();
};

/** Local midnights from `from` to `count` days on, one per day — DST-safe because the calendar moves, not 86 400 000 ms. */
const localDays = (from: number, count: number): number[] => {
  const out: number[] = [];
  const d = new Date(dayStartOf(from));
  for (let i = 0; i < count; i++) {
    out.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return out;
};

/**
 * Cost in integer micro-dollars, the unit the ledger adds in: summing 0.1 and
 * 0.2 as floats reads 0.30000000000000004, while 100 000 + 200 000 µ$ is exact.
 * One micro-dollar is finer than any provider's per-token price.
 */
export const MICRO_USD = 1_000_000;
const microOf = (usd: number): number => Math.round(usd * MICRO_USD);
const usdOf = (micro: number): number => micro / MICRO_USD;

const percentile = (sorted: number[], p: number): number | null => (sorted.length ? sorted[Math.ceil(p * sorted.length) - 1]! : null);
const medianOf = (sorted: number[]): number | null => {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const durationOf = (values: number[]): UsageDuration | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, medianMs: medianOf(sorted), p95Ms: percentile(sorted, 0.95) };
};

const cacheRate = (tokens: TokenBreakdown): number | null => (tokens.inputTokens > 0 ? tokens.cacheReadTokens / tokens.inputTokens : null);

interface Bucket {
  tokens: TokenBreakdown;
  runs: number;
  failedRuns: number;
  cancelledRuns: number;
  costMicro: number;
  costKnownRuns: number;
  costUnknownRuns: number;
  durations: number[];
  models: Map<string, Bucket>;
}

const bucket = (): Bucket => ({ tokens: { ...NO_TOKENS }, runs: 0, failedRuns: 0, cancelledRuns: 0, costMicro: 0, costKnownRuns: 0, costUnknownRuns: 0, durations: [], models: new Map() });

const addRun = (into: Bucket, run: UsageRun): void => {
  const tokens = runTokens(run.usage, run.metrics);
  if (tokens) {
    into.tokens.inputTokens += tokens.inputTokens;
    into.tokens.uncachedInputTokens += tokens.uncachedInputTokens;
    into.tokens.cacheReadTokens += tokens.cacheReadTokens;
    into.tokens.cacheWriteTokens += tokens.cacheWriteTokens;
    into.tokens.outputTokens += tokens.outputTokens;
  }
  into.runs += 1;
  if (run.status === "error") into.failedRuns += 1;
  if (run.status === "cancelled") into.cancelledRuns += 1;
  if (run.costUsd === null) into.costUnknownRuns += 1;
  else {
    into.costMicro += microOf(run.costUsd);
    into.costKnownRuns += 1;
  }
  if (run.endedAt !== null && run.endedAt >= run.startedAt) into.durations.push(run.endedAt - run.startedAt);
};

const totalsOf = (b: Bucket): UsageTotals => ({
  ...b.tokens,
  runs: b.runs,
  failedRuns: b.failedRuns,
  cancelledRuns: b.cancelledRuns,
  costUsd: b.costKnownRuns ? usdOf(b.costMicro) : null,
  costKnownRuns: b.costKnownRuns,
  costUnknownRuns: b.costUnknownRuns,
  cacheHitRate: cacheRate(b.tokens),
  duration: durationOf(b.durations)
});

const modelsOf = (b: Bucket): ModelUsage[] =>
  [...b.models.entries()]
    .map(([model, m]) => ({ model, ...totalsOf(m) }))
    .sort((a, b) => b.runs - a.runs || b.inputTokens - a.inputTokens || a.model.localeCompare(b.model));

/** Sums the runs that started inside [from, to] into days, engines and totals. */
export function aggregateUsage(runs: UsageRun[], opts: { from: number; to: number; dayCount: number }): UsageReport {
  const days = localDays(opts.from, opts.dayCount);
  const byDay = new Map<string, Bucket>(days.map((at) => [dayKeyOf(at), bucket()]));
  const byEngine = new Map<string, Bucket>();
  const totals = bucket();
  const byTicket = new Map<string, { projectId: string; itemId: string; b: Bucket }>();
  const noTicket = bucket();
  for (const run of runs) {
    if (run.startedAt < opts.from || run.startedAt > opts.to) continue;
    addRun(totals, run);
    if (run.itemId && run.projectId) {
      const at = `${run.projectId} ${run.itemId}`;
      let ticket = byTicket.get(at);
      if (!ticket) byTicket.set(at, (ticket = { projectId: run.projectId, itemId: run.itemId, b: bucket() }));
      addRun(ticket.b, run);
    } else addRun(noTicket, run);
    addByEngine(byEngine, run);
    const day = byDay.get(dayKeyOf(run.startedAt));
    if (day) addRun(day, run);
  }
  return {
    from: opts.from,
    to: opts.to,
    days: days.map((at) => ({ at, date: dayKeyOf(at), ...totalsOf(byDay.get(dayKeyOf(at))!) })),
    engines: enginesOf(byEngine),
    tickets: [...byTicket.values()]
      .map(({ projectId, itemId, b }) => ({ projectId, itemId, key: null, title: "", ...totalsOf(b) }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.runs - a.runs || a.itemId.localeCompare(b.itemId)),
    noTicket: totalsOf(noTicket),
    totals: totalsOf(totals)
  };
}

const enginesOf = (byEngine: Map<string, Bucket>): EngineUsage[] =>
  [...byEngine.entries()]
    .map(([engine, b]) => ({ engine, title: engine, ...totalsOf(b), models: modelsOf(b) }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.runs - a.runs || a.title.localeCompare(b.title));

const addByEngine = (byEngine: Map<string, Bucket>, run: UsageRun): void => {
  let engine = byEngine.get(run.engine);
  if (!engine) byEngine.set(run.engine, (engine = bucket()));
  addRun(engine, run);
  const model = run.metrics?.providerModel;
  if (model) {
    let m = engine.models.get(model);
    if (!m) engine.models.set(model, (m = bucket()));
    addRun(m, run);
  }
};

/**
 * One ticket's runs, all time: by agent, and by the delivery each fell in — the one a General run was pinned to,
 * else the delivery under way when it started. Runs from before any delivery keep a row of their own.
 */
export function ticketSpend(runs: UsageRun[], deliveries: DeliverySpan[], titles: Map<string, string> = new Map()): TicketSpend {
  const totals = bucket();
  const byEngine = new Map<string, Bucket>();
  const byDelivery = new Map<number | null, Bucket>();
  const sorted = [...deliveries].sort((a, b) => a.sequence - b.sequence);
  const newestFirst = [...sorted].reverse();
  const deliveryOf = (run: UsageRun): DeliverySpan | null =>
    (run.deliveryId ? sorted.find((d) => d.id === run.deliveryId) : undefined) ??
    newestFirst.find((d) => d.startedAt <= run.startedAt && (d.completedAt === null || run.startedAt <= d.completedAt)) ??
    // a run between deliveries (after one closed, before the next opened) belongs to the one it followed
    newestFirst.find((d) => d.startedAt <= run.startedAt) ??
    null;
  for (const run of runs) {
    addRun(totals, run);
    addByEngine(byEngine, run);
    const sequence = deliveryOf(run)?.sequence ?? null;
    let b = byDelivery.get(sequence);
    if (!b) byDelivery.set(sequence, (b = bucket()));
    addRun(b, run);
  }
  const states = new Map(sorted.map((d) => [d.sequence, d.state]));
  return {
    totals: totalsOf(totals),
    engines: enginesOf(byEngine).map((e) => ({ ...e, title: titles.get(e.engine) ?? e.title })),
    deliveries: [...byDelivery.entries()]
      .map(([sequence, b]) => ({ sequence, state: sequence === null ? null : (states.get(sequence) ?? null), ...totalsOf(b) }))
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  };
}

/** The last `days` local days ending today, plus the today and week views older callers read. */
export function usageSummary(runs: UsageRun[], opts: { days: number; now: number; titles: Map<string, string> }): UsageSummary {
  const dayCount = Math.min(365, Math.max(1, Math.round(opts.days)));
  const today = dayStartOf(opts.now);
  const from = shiftDays(today, -(dayCount - 1));
  const weekFrom = shiftDays(today, -6);
  const range = aggregateUsage(runs, { from, to: opts.now, dayCount });
  const withTitles = (report: UsageReport): UsageReport => ({
    ...report,
    engines: report.engines.map((e) => ({ ...e, title: opts.titles.get(e.engine) ?? e.title }))
  });
  return {
    today: withTitles(aggregateUsage(runs, { from: today, to: opts.now, dayCount: 1 })).engines,
    week: withTitles(aggregateUsage(runs, { from: weekFrom, to: opts.now, dayCount: 7 })).engines,
    range: withTitles(range)
  };
}

/** Where a window begins, counting local days back from today. Exported so the pane and the store agree on "the last 7 days". */
export const windowStart = (now: number, days: number): number => shiftDays(dayStartOf(now), -(Math.max(1, Math.round(days)) - 1));
