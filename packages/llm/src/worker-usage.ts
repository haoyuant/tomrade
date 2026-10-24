import type { ProjectDb } from "@tomradex/db";

/** What a worker call was for; the Usage pane names each one. */
export type WorkerPurpose = "plan" | "gaps" | "similar" | "dependencies" | "inbox" | "playbook" | "branch" | "brief";

/** Tokens a worker call spent, every round of it (a repair round included). */
export interface WorkerSpend {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** One worker call in numbers. The prompt and the answer are never kept. */
export interface WorkerCall extends WorkerSpend {
  at: number;
  /** `profile:<id>` or `lent:<id>`. */
  source: string;
  /** The profile's or local agent's name when the call ran. */
  title: string;
  purpose: string | null;
  ok: boolean;
  /** How long the call took; absent for calls recorded before Tomrade timed them. */
  durationMs?: number | null;
}

export interface WorkerDuration {
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
}

/** What a stretch of worker calls added up to. */
export interface WorkerUsageTotals extends WorkerSpend {
  calls: number;
  failed: number;
  cacheHitRate: number | null;
  duration: WorkerDuration | null;
}

/** Worker calls from one source for one purpose. */
export interface WorkerUsage extends WorkerUsageTotals {
  source: string;
  title: string;
  purpose: string | null;
}

/** Worker calls for one purpose, across every source. */
export interface WorkerPurposeUsage extends WorkerUsageTotals {
  purpose: string | null;
}

/** One local day of worker calls, always present in a range even when nothing ran. */
export interface WorkerUsageDay extends WorkerUsageTotals {
  at: number;
  date: string;
}

export interface WorkerUsageReport {
  from: number;
  to: number;
  days: WorkerUsageDay[];
  sources: WorkerUsage[];
  purposes: WorkerPurposeUsage[];
  totals: WorkerUsageTotals;
}

export interface WorkerUsageSummary {
  today: WorkerUsage[];
  week: WorkerUsage[];
  range: WorkerUsageReport;
}

const TABLE = "plugin_llm_worker_calls";

/** The shape the pane draws when this machine has no worker-call log yet. */
export const emptyWorkerUsageSummary = (now = Date.now(), days = 7): WorkerUsageSummary => ({
  today: [],
  week: [],
  range: {
    from: now,
    to: now,
    days: [],
    sources: [],
    purposes: [],
    totals: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0, failed: 0, cacheHitRate: null, duration: null }
  }
});

// Machine-local: what this computer's worker spent, not part of any project.
export const WORKER_CALLS_MIGRATIONS = [
  {
    version: 1,
    up: `CREATE TABLE ${TABLE} (at INTEGER NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, purpose TEXT, input_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, ok INTEGER NOT NULL);
         CREATE INDEX ${TABLE}_at ON ${TABLE} (at)`
  },
  {
    // Calls timed from now on; older rows stay untimed rather than being given an invented duration.
    // Version 2 belongs to the refused-media table in the same "llm" namespace.
    version: 3,
    up: `ALTER TABLE ${TABLE} ADD COLUMN duration_ms INTEGER`
  }
];
export const WORKER_CALLS_TABLES = { [TABLE]: { export: false as const } };

interface Row {
  at: number;
  source: string;
  title: string;
  purpose: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  ok: number;
  durationMs: number | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayStartOf = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const dayKeyOf = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const shiftDays = (from: number, days: number): number => {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.getTime();
};
const localDays = (from: number, count: number): number[] => {
  const out: number[] = [];
  const d = new Date(dayStartOf(from));
  for (let i = 0; i < count; i++) {
    out.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return out;
};
const percentile = (sorted: number[], p: number): number | null => (sorted.length ? sorted[Math.ceil(p * sorted.length) - 1]! : null);
const medianOf = (sorted: number[]): number | null => {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

interface Bucket {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  calls: number;
  failed: number;
  durations: number[];
}

const bucket = (): Bucket => ({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0, failed: 0, durations: [] });

const add = (into: Bucket, row: Row): void => {
  into.inputTokens += row.inputTokens;
  into.cacheReadTokens += row.cacheReadTokens;
  into.outputTokens += row.outputTokens;
  into.calls += 1;
  into.failed += row.ok ? 0 : 1;
  if (row.durationMs !== null && row.durationMs >= 0) into.durations.push(row.durationMs);
};

const totalsOf = (b: Bucket): WorkerUsageTotals => {
  const durations = [...b.durations].sort((a, b) => a - b);
  return {
    inputTokens: b.inputTokens,
    cacheReadTokens: b.cacheReadTokens,
    outputTokens: b.outputTokens,
    calls: b.calls,
    failed: b.failed,
    // Cache reads are part of input on every adapter Tomrade speaks to; a provider that counted them apart never reports more than it read.
    cacheHitRate: b.inputTokens > 0 ? Math.min(1, b.cacheReadTokens / b.inputTokens) : null,
    duration: durations.length ? { samples: durations.length, medianMs: medianOf(durations), p95Ms: percentile(durations, 0.95) } : null
  };
};

/** One window's sources and purposes, from the rows that fall inside it. */
function aggregate(rows: Row[], from: number, to: number): { sources: WorkerUsage[]; purposes: WorkerPurposeUsage[]; totals: WorkerUsageTotals } {
  const sources = new Map<string, { bucket: Bucket; source: string; purpose: string | null; title: string; lastAt: number }>();
  const purposes = new Map<string | null, Bucket>();
  const totals = bucket();
  for (const row of rows) {
    if (row.at < from || row.at > to) continue;
    add(totals, row);
    // The title is the source's current name: the latest row that named it.
    const key = `${row.source}\u0000${row.purpose ?? ""}`;
    let source = sources.get(key);
    if (!source) {
      source = { bucket: bucket(), source: row.source, purpose: row.purpose, title: row.title, lastAt: row.at };
      sources.set(key, source);
    }
    if (row.at >= source.lastAt) {
      source.title = row.title;
      source.lastAt = row.at;
    }
    add(source.bucket, row);
    let purpose = purposes.get(row.purpose);
    if (!purpose) {
      purpose = bucket();
      purposes.set(row.purpose, purpose);
    }
    add(purpose, row);
  }
  return {
    sources: [...sources.values()]
      .map(({ bucket, source, purpose, title }) => ({ source, title, purpose, ...totalsOf(bucket) }))
      .sort((a, b) => b.inputTokens - a.inputTokens || b.calls - a.calls || a.title.localeCompare(b.title)),
    purposes: [...purposes.entries()]
      .map(([purpose, b]) => ({ purpose, ...totalsOf(b) }))
      .sort((a, b) => b.calls - a.calls || b.inputTokens - a.inputTokens),
    totals: totalsOf(totals)
  };
}

export class WorkerCallLog {
  constructor(private readonly db: ProjectDb) {}

  record(call: WorkerCall): void {
    this.db
      .prepare(`INSERT INTO ${TABLE} (at, source, title, purpose, input_tokens, cache_read_tokens, output_tokens, ok, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(call.at, call.source, call.title, call.purpose, call.inputTokens, call.cacheReadTokens, call.outputTokens, call.ok ? 1 : 0, call.durationMs ?? null);
  }

  /** Today, the last seven days and the requested range, by source and purpose, most input first. */
  summary(now = Date.now(), days = 7): WorkerUsageSummary {
    const dayCount = Math.min(365, Math.max(1, Math.round(days)));
    const today = dayStartOf(now);
    const weekFrom = shiftDays(today, -6);
    const from = shiftDays(today, -(dayCount - 1));
    const since = Math.min(weekFrom, from);
    const rows = this.db
      .prepare(`SELECT at, source, title, purpose, input_tokens AS inputTokens, cache_read_tokens AS cacheReadTokens, output_tokens AS outputTokens, ok, duration_ms AS durationMs FROM ${TABLE} WHERE at >= ? ORDER BY at`)
      .all(since) as Row[];
    const range = aggregate(rows, from, now);
    const days_ = localDays(from, dayCount).map((at) => {
      const b = bucket();
      for (const row of rows) if (row.at >= at && row.at < shiftDays(at, 1) && row.at <= now) add(b, row);
      return { at, date: dayKeyOf(at), ...totalsOf(b) };
    });
    return {
      today: aggregate(rows, today, now).sources,
      week: aggregate(rows, weekFrom, now).sources,
      range: { from, to: now, days: days_, sources: range.sources, purposes: range.purposes, totals: range.totals }
    };
  }
}
