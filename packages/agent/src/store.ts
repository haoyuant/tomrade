import { randomUUID } from "node:crypto";
import type { Db } from "@tomrade/db";
import type { Author } from "@tomrade/domain";
import type { Block, CardView, PendingView, RunStatus, RunView, ThreadMessage, ThreadSummary } from "./types.js";

export const MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS plugin_agent_threads (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  engine        TEXT NOT NULL,
  external_json TEXT NOT NULL DEFAULT '{}',
  waivers_json  TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_agent_messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  block_json TEXT NOT NULL,
  run_id     TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_agent_messages_thread ON plugin_agent_messages(thread_id, seq);
CREATE TABLE IF NOT EXISTS plugin_agent_runs (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  status     TEXT NOT NULL,
  engine     TEXT NOT NULL,
  stop       TEXT,
  error      TEXT,
  usage_json TEXT,
  cost_usd   REAL,
  changes    INTEGER NOT NULL DEFAULT 0,
  reverted   INTEGER NOT NULL DEFAULT 0,
  kept       INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plugin_agent_runs_thread ON plugin_agent_runs(thread_id, started_at);
CREATE TABLE IF NOT EXISTS plugin_agent_ledger (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  tool      TEXT NOT NULL,
  args_json TEXT NOT NULL,
  ok        INTEGER NOT NULL,
  summary   TEXT NOT NULL,
  ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_agent_ledger_run ON plugin_agent_ledger(run_id, seq);
CREATE TABLE IF NOT EXISTS plugin_agent_cards (
  thread_id  TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  schema_id  TEXT NOT NULL,
  title      TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, card_id)
);
CREATE TABLE IF NOT EXISTS plugin_agent_pending (
  thread_id     TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  workflow      TEXT,
  step          TEXT,
  state_json    TEXT,
  question_json TEXT NOT NULL,
  accepts       TEXT NOT NULL DEFAULT 'text',
  waive_rule    TEXT,
  waive_on_json TEXT,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_agent_briefs (
  project_id TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`
  }
];

interface ThreadRow {
  id: string;
  project_id: string;
  title: string;
  engine: string;
  external_json: string;
  waivers_json: string;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  thread_id: string;
  status: RunStatus;
  engine: string;
  stop: string | null;
  error: string | null;
  usage_json: string | null;
  cost_usd: number | null;
  changes: number;
  reverted: number;
  kept: number;
  started_at: number;
  ended_at: number | null;
}

interface PendingRow {
  thread_id: string;
  kind: "ask" | "workflow";
  workflow: string | null;
  step: string | null;
  state_json: string | null;
  question_json: string;
  accepts: "options" | "text";
  waive_rule: string | null;
  waive_on_json: string | null;
}

export interface PendingRecord extends PendingView {
  step: string | null;
  state: unknown;
  waiveRule: string | null;
  waiveOn: string[];
}

const toThread = (r: ThreadRow): ThreadSummary => ({ id: r.id, projectId: r.project_id, title: r.title, engine: r.engine, createdAt: r.created_at, updatedAt: r.updated_at });

const toRun = (r: RunRow): RunView => ({
  id: r.id,
  threadId: r.thread_id,
  status: r.status,
  engine: r.engine,
  stop: r.stop,
  error: r.error,
  usage: r.usage_json ? (JSON.parse(r.usage_json) as RunView["usage"]) : null,
  costUsd: r.cost_usd,
  changes: r.changes,
  reverted: r.reverted === 1,
  keptOnRevert: r.kept,
  startedAt: r.started_at,
  endedAt: r.ended_at
});

export class AgentStore {
  constructor(private readonly db: Db) {}

  threads(projectId: string): ThreadSummary[] {
    return (this.db.prepare("SELECT * FROM plugin_agent_threads WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as ThreadRow[]).map(toThread);
  }

  thread(id: string): ThreadSummary | null {
    const row = this.db.prepare("SELECT * FROM plugin_agent_threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  createThread(projectId: string, engine: string, title = ""): ThreadSummary {
    const now = Date.now();
    const id = randomUUID();
    this.db.prepare("INSERT INTO plugin_agent_threads (id, project_id, title, engine, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, projectId, title, engine, now, now);
    return this.thread(id)!;
  }

  touchThread(id: string, fields: { title?: string; engine?: string } = {}): void {
    if (fields.title !== undefined) this.db.prepare("UPDATE plugin_agent_threads SET title = ? WHERE id = ?").run(fields.title, id);
    if (fields.engine !== undefined) this.db.prepare("UPDATE plugin_agent_threads SET engine = ? WHERE id = ?").run(fields.engine, id);
    this.db.prepare("UPDATE plugin_agent_threads SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  external(threadId: string): Record<string, string> {
    const row = this.db.prepare("SELECT external_json FROM plugin_agent_threads WHERE id = ?").get(threadId) as { external_json: string } | undefined;
    return row ? (JSON.parse(row.external_json) as Record<string, string>) : {};
  }

  setExternal(threadId: string, engine: string, sessionId: string): void {
    const map = this.external(threadId);
    map[engine] = sessionId;
    this.db.prepare("UPDATE plugin_agent_threads SET external_json = ? WHERE id = ?").run(JSON.stringify(map), threadId);
  }

  waivers(threadId: string): Set<string> {
    const row = this.db.prepare("SELECT waivers_json FROM plugin_agent_threads WHERE id = ?").get(threadId) as { waivers_json: string } | undefined;
    return new Set(row ? (JSON.parse(row.waivers_json) as string[]) : []);
  }

  addWaiver(threadId: string, rule: string): void {
    const set = this.waivers(threadId);
    set.add(rule);
    this.db.prepare("UPDATE plugin_agent_threads SET waivers_json = ? WHERE id = ?").run(JSON.stringify([...set]), threadId);
  }

  messages(threadId: string): ThreadMessage[] {
    const rows = this.db.prepare("SELECT * FROM plugin_agent_messages WHERE thread_id = ? ORDER BY seq ASC").all(threadId) as {
      id: string;
      thread_id: string;
      seq: number;
      role: ThreadMessage["role"];
      block_json: string;
      run_id: string | null;
      at: number;
    }[];
    return rows.map((r) => ({ id: r.id, threadId: r.thread_id, seq: r.seq, role: r.role, block: JSON.parse(r.block_json) as Block, runId: r.run_id, at: r.at }));
  }

  appendMessage(threadId: string, role: ThreadMessage["role"], block: Block, runId: string | null): ThreadMessage {
    const seq = ((this.db.prepare("SELECT MAX(seq) AS m FROM plugin_agent_messages WHERE thread_id = ?").get(threadId) as { m: number | null }).m ?? 0) + 1;
    const message: ThreadMessage = { id: randomUUID(), threadId, seq, role, block, runId, at: Date.now() };
    this.db
      .prepare("INSERT INTO plugin_agent_messages (id, thread_id, seq, role, block_json, run_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(message.id, threadId, seq, role, JSON.stringify(block), runId, message.at);
    this.db.prepare("UPDATE plugin_agent_threads SET updated_at = ? WHERE id = ?").run(message.at, threadId);
    return message;
  }

  runs(threadId: string): RunView[] {
    return (this.db.prepare("SELECT * FROM plugin_agent_runs WHERE thread_id = ? ORDER BY started_at ASC").all(threadId) as RunRow[]).map(toRun);
  }

  run(id: string): RunView | null {
    const row = this.db.prepare("SELECT * FROM plugin_agent_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  beginRun(threadId: string, engine: string): RunView {
    const id = randomUUID();
    this.db.prepare("INSERT INTO plugin_agent_runs (id, thread_id, status, engine, started_at) VALUES (?, ?, 'running', ?, ?)").run(id, threadId, engine, Date.now());
    return this.run(id)!;
  }

  endRun(id: string, fields: { status: RunStatus; stop?: string; error?: string; usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number; changes: number }): RunView {
    this.db
      .prepare("UPDATE plugin_agent_runs SET status = ?, stop = ?, error = ?, usage_json = ?, cost_usd = ?, changes = ?, ended_at = ? WHERE id = ?")
      .run(
        fields.status,
        fields.stop ?? null,
        fields.error ?? null,
        fields.usage ? JSON.stringify({ inputTokens: fields.usage.inputTokens ?? 0, outputTokens: fields.usage.outputTokens ?? 0 }) : null,
        fields.costUsd ?? null,
        fields.changes,
        Date.now(),
        id
      );
    return this.run(id)!;
  }

  markReverted(id: string, kept: number): RunView {
    this.db.prepare("UPDATE plugin_agent_runs SET reverted = 1, kept = ? WHERE id = ?").run(kept, id);
    return this.run(id)!;
  }

  appendLedger(runId: string, seq: number, tool: string, args: unknown, ok: boolean, summary: string, ms: number): void {
    this.db
      .prepare("INSERT INTO plugin_agent_ledger (run_id, seq, tool, args_json, ok, summary, ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(runId, seq, tool, JSON.stringify(args ?? {}).slice(0, 4000), ok ? 1 : 0, summary.slice(0, 500), ms);
  }

  cards(threadId: string): CardView[] {
    const rows = this.db.prepare("SELECT * FROM plugin_agent_cards WHERE thread_id = ? ORDER BY updated_at ASC").all(threadId) as {
      thread_id: string;
      card_id: string;
      schema_id: string;
      title: string;
      data_json: string;
      version: number;
      updated_by: string;
      updated_at: number;
    }[];
    return rows.map((r) => ({
      threadId: r.thread_id,
      id: r.card_id,
      schema: r.schema_id,
      title: r.title,
      data: JSON.parse(r.data_json),
      version: r.version,
      updatedBy: r.updated_by as Author,
      updatedAt: r.updated_at
    }));
  }

  setCard(threadId: string, card: { id: string; schema: string; title: string; data: unknown }, by: Author | "human"): CardView {
    this.db
      .prepare(
        `INSERT INTO plugin_agent_cards (thread_id, card_id, schema_id, title, data_json, version, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(thread_id, card_id) DO UPDATE SET
           schema_id = excluded.schema_id, title = excluded.title, data_json = excluded.data_json,
           version = plugin_agent_cards.version + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .run(threadId, card.id, card.schema, card.title, JSON.stringify(card.data ?? null), by, Date.now());
    return this.cards(threadId).find((c) => c.id === card.id)!;
  }

  pending(threadId: string): PendingRecord | null {
    const row = this.db.prepare("SELECT * FROM plugin_agent_pending WHERE thread_id = ?").get(threadId) as PendingRow | undefined;
    if (!row) return null;
    return {
      threadId: row.thread_id,
      kind: row.kind,
      workflow: row.workflow,
      step: row.step,
      state: row.state_json ? JSON.parse(row.state_json) : null,
      question: JSON.parse(row.question_json) as PendingRecord["question"],
      accepts: row.accepts,
      waiveRule: row.waive_rule,
      waiveOn: row.waive_on_json ? (JSON.parse(row.waive_on_json) as string[]) : []
    };
  }

  setPending(threadId: string, record: Omit<PendingRecord, "threadId">): void {
    this.db
      .prepare(
        `INSERT INTO plugin_agent_pending (thread_id, kind, workflow, step, state_json, question_json, accepts, waive_rule, waive_on_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           kind = excluded.kind, workflow = excluded.workflow, step = excluded.step, state_json = excluded.state_json,
           question_json = excluded.question_json, accepts = excluded.accepts, waive_rule = excluded.waive_rule,
           waive_on_json = excluded.waive_on_json, created_at = excluded.created_at`
      )
      .run(
        threadId,
        record.kind,
        record.workflow,
        record.step,
        record.state === null ? null : JSON.stringify(record.state),
        JSON.stringify(record.question),
        record.accepts,
        record.waiveRule,
        JSON.stringify(record.waiveOn),
        Date.now()
      );
  }

  clearPending(threadId: string): void {
    this.db.prepare("DELETE FROM plugin_agent_pending WHERE thread_id = ?").run(threadId);
  }

  brief(projectId: string): string | null {
    return (this.db.prepare("SELECT body FROM plugin_agent_briefs WHERE project_id = ?").get(projectId) as { body: string } | undefined)?.body ?? null;
  }

  setBrief(projectId: string, body: string): void {
    this.db
      .prepare("INSERT INTO plugin_agent_briefs (project_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
      .run(projectId, body, Date.now());
  }

  changesOf(runId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM oplog WHERE run_id = ?").get(runId) as { n: number }).n;
  }
}
