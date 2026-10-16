import type { ProjectDb } from "@tomradex/db";

/** What a worker call was for; the Usage pane names each one. */
export type WorkerPurpose = "plan" | "gaps" | "similar" | "dependencies" | "inbox" | "playbook" | "branch";

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
}

/** Worker calls from one source for one purpose. */
export interface WorkerUsage extends WorkerSpend {
  source: string;
  title: string;
  purpose: string | null;
  calls: number;
  failed: number;
}

export interface WorkerUsageSummary {
  today: WorkerUsage[];
  week: WorkerUsage[];
}

const TABLE = "plugin_llm_worker_calls";

// Machine-local: what this computer's worker spent, not part of any project.
export const WORKER_CALLS_MIGRATIONS = [
  {
    version: 1,
    up: `CREATE TABLE ${TABLE} (at INTEGER NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, purpose TEXT, input_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, ok INTEGER NOT NULL);
         CREATE INDEX ${TABLE}_at ON ${TABLE} (at)`
  }
];
export const WORKER_CALLS_TABLES = { [TABLE]: { export: false as const } };

export class WorkerCallLog {
  constructor(private readonly db: ProjectDb) {}

  record(call: WorkerCall): void {
    this.db
      .prepare(`INSERT INTO ${TABLE} (at, source, title, purpose, input_tokens, cache_read_tokens, output_tokens, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(call.at, call.source, call.title, call.purpose, call.inputTokens, call.cacheReadTokens, call.outputTokens, call.ok ? 1 : 0);
  }

  /** Today and the last seven days, by source and purpose, most input first. */
  summary(now = Date.now()): WorkerUsageSummary {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const today = midnight.getTime();
    // A bare column beside MAX() comes from the latest row: the source's current name.
    const since = (from: number) =>
      (this.db
        .prepare(
          `SELECT source, title, purpose, MAX(at) AS last, COUNT(*) AS calls, SUM(1 - ok) AS failed, SUM(input_tokens) AS inputTokens, SUM(cache_read_tokens) AS cacheReadTokens, SUM(output_tokens) AS outputTokens
           FROM ${TABLE} WHERE at >= ? GROUP BY source, purpose ORDER BY inputTokens DESC, calls DESC`
        )
        .all(from) as (WorkerUsage & { last: number })[]).map(({ last: _, ...row }) => row);
    return { today: since(today), week: since(today - 6 * 86_400_000) };
  }
}
