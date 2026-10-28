import { randomUUID } from "node:crypto";
import type { Db, ProjectDb } from "@tomradex/db";
import type { Author } from "@tomradex/domain";
import type { Block, CardView, ParkView, PendingView, RunStatus, RunView, ThreadMessage, ThreadSummary, ThreadSurface } from "./thread.js";
import type { GeneralExecution } from "./workflow.js";
import { runTokens } from "./tokens.js";

const SURFACES: ThreadSurface[] = ["assistant", "code", "doctor", "probe"];

interface ParkedRow {
  thread_id: string;
  run_id: string | null;
  until: number;
  known: number;
  resume: number;
  attempt: number;
}

const toPark = (r: ParkedRow): ParkView => ({ threadId: r.thread_id, runId: r.run_id, until: r.until, known: !!r.known, resume: !!r.resume, attempt: r.attempt });

/** How a run the app's closing cut short stopped — not cancelled by anyone. */
const INTERRUPTED = "interrupted";

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
  },
  {
    // A thread may stand on a workstream, and so on that workstream's repository.
    version: 2,
    up: "ALTER TABLE plugin_agent_threads ADD COLUMN board_id TEXT"
  },
  {
    // A thread may implement one ticket, on a branch of its own.
    version: 3,
    up: "ALTER TABLE plugin_agent_threads ADD COLUMN item_id TEXT; ALTER TABLE plugin_agent_threads ADD COLUMN branch TEXT;"
  },
  {
    // A terminal code session has a thread for worktree identity, but belongs
    // in the ticket's Code section rather than the Assistant panel.
    version: 4,
    up: "ALTER TABLE plugin_agent_threads ADD COLUMN surface TEXT NOT NULL DEFAULT 'assistant'"
  },
  { version: 5, up: "ALTER TABLE plugin_agent_threads ADD COLUMN permission_mode TEXT" },
  { version: 6, up: "ALTER TABLE plugin_agent_runs ADD COLUMN metrics_json TEXT" },
  { version: 7, up: "ALTER TABLE plugin_agent_threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0" },
  { version: 8, up: "ALTER TABLE plugin_agent_threads ADD COLUMN execution_json TEXT" },
  { version: 9, up: "ALTER TABLE plugin_agent_runs ADD COLUMN execution_json TEXT" },
  { version: 10, up: "ALTER TABLE plugin_agent_runs ADD COLUMN playbooks_json TEXT NOT NULL DEFAULT '[]'" },
  { version: 11, up: "ALTER TABLE plugin_agent_threads ADD COLUMN options_json TEXT" },
  {
    // A thread that hit a usage limit, until it lifts.
    version: 12,
    up: `CREATE TABLE IF NOT EXISTS plugin_agent_parked (
  thread_id  TEXT PRIMARY KEY,
  run_id     TEXT,
  until      INTEGER NOT NULL,
  known      INTEGER NOT NULL,
  resume     INTEGER NOT NULL,
  attempt    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`
  },
  // A person brought the thread back from the archive; automatic archiving leaves it alone.
  { version: 13, up: "ALTER TABLE plugin_agent_threads ADD COLUMN restored INTEGER NOT NULL DEFAULT 0" },
  { version: 14, up: `CREATE TABLE plugin_agent_inputs (
    request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    run_id TEXT NOT NULL, source_json TEXT, created_at INTEGER NOT NULL
  )` },
  // The brief one step back: a careless rewrite is undone, not lost.
  { version: 15, up: "ALTER TABLE plugin_agent_briefs ADD COLUMN previous_body TEXT" },
  // A conversation opened under another, to write its code in the background while that one goes on talking.
  { version: 16, up: "ALTER TABLE plugin_agent_threads ADD COLUMN parent_id TEXT" },
  // What a conversation said last, kept with it so a card shows it without reading the conversation.
  { version: 17, up: "ALTER TABLE plugin_agent_threads ADD COLUMN said TEXT" },
  // A run the app's closing interrupted, once the person waved it away instead of continuing.
  { version: 18, up: "ALTER TABLE plugin_agent_runs ADD COLUMN dismissed_at INTEGER" }
];

interface ThreadRow {
  execution_json: string | null;
  options_json: string | null;
  id: string;
  project_id: string;
  board_id: string | null;
  item_id: string | null;
  branch: string | null;
  parent_id: string | null;
  title: string;
  engine: string;
  surface: string;
  permission_mode: string | null;
  archived: number;
  restored: number;
  said?: string | null;
  external_json: string;
  waivers_json: string;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  playbooks_json: string;
  execution_json: string | null;
  id: string;
  thread_id: string;
  status: RunStatus;
  engine: string;
  stop: string | null;
  error: string | null;
  usage_json: string | null;
  metrics_json: string | null;
  cost_usd: number | null;
  changes: number;
  reverted: number;
  kept: number;
  started_at: number;
  ended_at: number | null;
  dismissed_at?: number | null;
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

const toThread = (r: ThreadRow, engineOf: (id: string) => string = (id) => id): ThreadSummary => ({
  execution: r.execution_json ? JSON.parse(r.execution_json) : null,
  id: r.id,
  projectId: r.project_id,
  boardId: r.board_id ?? null,
  itemId: r.item_id ?? null,
  branch: r.branch ?? null,
  parentId: r.parent_id ?? null,
  title: r.title,
  engine: engineOf(r.engine),
  surface: SURFACES.includes(r.surface as ThreadSurface) ? (r.surface as ThreadSurface) : "assistant",
  permissionMode: r.permission_mode,
  options: r.options_json ? JSON.parse(r.options_json) : null,
  archived: r.archived === 1,
  restored: r.restored === 1,
  said: r.said ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

const toRun = (r: RunRow): RunView => {
  const usage = r.usage_json ? (JSON.parse(r.usage_json) as RunView["usage"]) : null;
  const metrics = r.metrics_json ? (JSON.parse(r.metrics_json) as RunView["metrics"]) : null;
  return {
    playbooks: JSON.parse(r.playbooks_json ?? "[]"),
    execution: r.execution_json ? JSON.parse(r.execution_json) : null,
    id: r.id,
    threadId: r.thread_id,
    status: r.status,
    engine: r.engine,
    stop: r.stop,
    error: r.error,
    usage,
    tokens: runTokens(usage, metrics),
    costUsd: r.cost_usd,
    changes: r.changes,
    reverted: r.reverted === 1,
    keptOnRevert: r.kept,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    ...(r.stop === INTERRUPTED ? { dismissedAt: r.dismissed_at ?? null } : {}),
    metrics
  };
};

/**
 * Table declarations for `ctx.db.migrate`: how each table's rows belong to a
 * project (deletion, the legacy split and export all read this), and whether
 * they travel in the project's folder. Cards and pending questions are one
 * machine's working state and never leave it. Conversations are `private`:
 * they never travel to a public repository.
 */
export const TABLES = {
  plugin_agent_threads: { project: "project_id", export: { order: "id", private: true } },
  plugin_agent_messages: { project: { via: "thread_id", table: "plugin_agent_threads" }, export: { order: "thread_id, seq", appendOnly: true, private: true } },
  plugin_agent_runs: { project: { via: "thread_id", table: "plugin_agent_threads" }, export: { order: "thread_id, started_at", private: true } },
  plugin_agent_ledger: { project: { via: "run_id", table: "plugin_agent_runs" }, export: { order: "run_id, seq", appendOnly: true, private: true } },
  plugin_agent_cards: { project: { via: "thread_id", table: "plugin_agent_threads" }, export: false },
  plugin_agent_pending: { project: { via: "thread_id", table: "plugin_agent_threads" }, export: false },
  plugin_agent_briefs: { project: "project_id", export: { order: "project_id" } },
  // this machine's clock continues a parked thread; another machine would continue it twice
  plugin_agent_inputs: { project: { via: "thread_id", table: "plugin_agent_threads" }, export: false },
  plugin_agent_parked: { project: { via: "thread_id", table: "plugin_agent_threads" }, export: false }
} as const;

/** Threads live in their project's file, so every read and write names the project first. */
export class AgentStore {
  constructor(
    private readonly pool: Db,
    /** The engine that answers for a stored engine id — another engine may have taken it in. */
    private readonly engineOf: (id: string) => string = (id) => id
  ) {}

  private toThread = (r: ThreadRow): ThreadSummary => toThread(r, this.engineOf);

  private db(projectId: string): ProjectDb {
    return this.pool.for(projectId);
  }

  transaction<T>(projectId: string, work: () => T): T {
    return this.db(projectId).transaction(work);
  }

  inputReceipt(projectId: string, requestId: string): { thread_id: string; fingerprint: string; run_id: string } | undefined {
    return this.db(projectId).prepare("SELECT thread_id, fingerprint, run_id FROM plugin_agent_inputs WHERE request_id = ?").get(requestId) as { thread_id: string; fingerprint: string; run_id: string } | undefined;
  }

  recordInput(projectId: string, requestId: string, threadId: string, fingerprint: string, runId: string, source?: Record<string, string>): void {
    this.db(projectId).prepare("INSERT INTO plugin_agent_inputs (request_id, thread_id, fingerprint, run_id, source_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(requestId, threadId, fingerprint, runId, source ? JSON.stringify(source) : null, Date.now());
  }

  threads(projectId: string, surface: ThreadSurface | ThreadSurface[] | null = "assistant"): ThreadSummary[] {
    const surfaces = surface === null ? null : [surface].flat();
    const rows = surfaces
      ? (this.db(projectId).prepare(`SELECT * FROM plugin_agent_threads WHERE project_id = ? AND surface IN (${surfaces.map(() => "?").join(",")}) AND archived = 0 ORDER BY updated_at DESC`).all(projectId, ...surfaces) as ThreadRow[])
      : (this.db(projectId).prepare("SELECT * FROM plugin_agent_threads WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC").all(projectId) as ThreadRow[]);
    return rows.map(this.toThread);
  }

  /** Put away, newest first — so a conversation archived by mistake can be found and brought back. */
  archivedThreads(projectId: string, surface: ThreadSurface | ThreadSurface[] = "assistant"): ThreadSummary[] {
    const surfaces = [surface].flat();
    return (this.db(projectId).prepare(`SELECT * FROM plugin_agent_threads WHERE project_id = ? AND surface IN (${surfaces.map(() => "?").join(",")}) AND archived = 1 ORDER BY updated_at DESC`).all(projectId, ...surfaces) as ThreadRow[]).map(this.toThread);
  }

  /** One page of the open or the put-away conversations, newest first from `before` (the last row's time and id); never the whole table. */
  threadsPage(projectId: string, surface: ThreadSurface | ThreadSurface[], archived: boolean, before: { at: number; id: string } | null, limit: number): ThreadSummary[] {
    const surfaces = [surface].flat();
    const marks = surfaces.map(() => "?").join(",");
    const rows = before
      ? (this.db(projectId).prepare(`SELECT * FROM plugin_agent_threads WHERE project_id = ? AND surface IN (${marks}) AND archived = ? AND (updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC, id DESC LIMIT ?`).all(projectId, ...surfaces, archived ? 1 : 0, before.at, before.at, before.id, limit) as ThreadRow[])
      : (this.db(projectId).prepare(`SELECT * FROM plugin_agent_threads WHERE project_id = ? AND surface IN (${marks}) AND archived = ? ORDER BY updated_at DESC, id DESC LIMIT ?`).all(projectId, ...surfaces, archived ? 1 : 0, limit) as ThreadRow[]);
    return rows.map(this.toThread);
  }

  /** The newest `limit` open or put-away conversations whose title holds `needle`, any case. */
  threadsMatching(projectId: string, surface: ThreadSurface | ThreadSurface[], archived: boolean, needle: string, limit: number): ThreadSummary[] {
    const surfaces = [surface].flat();
    const like = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = this.db(projectId).prepare(`SELECT * FROM plugin_agent_threads WHERE project_id = ? AND surface IN (${surfaces.map(() => "?").join(",")}) AND archived = ? AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id DESC LIMIT ?`).all(projectId, ...surfaces, archived ? 1 : 0, like, limit) as ThreadRow[];
    return rows.map(this.toThread);
  }

  setArchived(projectId: string, id: string, archived: boolean, opts: { restored?: boolean } = {}): void {
    this.db(projectId).prepare("UPDATE plugin_agent_threads SET archived = ?, restored = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, !archived && opts.restored ? 1 : 0, Date.now(), id);
  }

  deleteThread(projectId: string, id: string): void {
    const db = this.db(projectId);
    const runIds = (db.prepare("SELECT id FROM plugin_agent_runs WHERE thread_id = ?").all(id) as { id: string }[]).map((r) => r.id);
    for (const runId of runIds) db.prepare("DELETE FROM plugin_agent_ledger WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM plugin_agent_messages WHERE thread_id = ?").run(id);
    db.prepare("DELETE FROM plugin_agent_runs WHERE thread_id = ?").run(id);
    db.prepare("DELETE FROM plugin_agent_cards WHERE thread_id = ?").run(id);
    db.prepare("DELETE FROM plugin_agent_pending WHERE thread_id = ?").run(id);
    db.prepare("DELETE FROM plugin_agent_threads WHERE id = ?").run(id);
  }

  thread(projectId: string, id: string): ThreadSummary | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_agent_threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return row ? this.toThread(row) : null;
  }

  setExecution(projectId: string, threadId: string, execution: GeneralExecution): void {
    this.db(projectId).prepare("UPDATE plugin_agent_threads SET execution_json = ? WHERE id = ?").run(JSON.stringify(execution), threadId);
  }

  recordPlaybook(projectId: string, runId: string, playbook: GeneralExecution["playbook"]): void {
    const run = this.run(projectId, runId);
    if (!run) return;
    const snapshots = run.playbooks ?? [];
    if (snapshots.some(p => p.id === playbook.id && p.digest === playbook.digest)) return;
    this.db(projectId).prepare("UPDATE plugin_agent_runs SET playbooks_json = ? WHERE id = ?").run(JSON.stringify([...snapshots, playbook]), runId);
  }

  createThread(projectId: string, engine: string, title = "", boardId: string | null = null, itemId: string | null = null, branch: string | null = null, surface: ThreadSurface = "assistant", parentId: string | null = null): ThreadSummary {
    const now = Date.now();
    const id = randomUUID();
    this.db(projectId)
      .prepare("INSERT INTO plugin_agent_threads (id, project_id, board_id, item_id, branch, parent_id, title, engine, surface, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectId, boardId, itemId, branch, parentId, title, engine, surface, now, now);
    return this.thread(projectId, id)!;
  }

  touchThread(projectId: string, id: string, fields: { title?: string; engine?: string; boardId?: string | null; itemId?: string | null; branch?: string | null; surface?: ThreadSurface; permissionMode?: string | null; options?: Record<string, unknown> | null } = {}): void {
    const db = this.db(projectId);
    if (fields.title !== undefined) db.prepare("UPDATE plugin_agent_threads SET title = ? WHERE id = ?").run(fields.title, id);
    if (fields.engine !== undefined) db.prepare("UPDATE plugin_agent_threads SET engine = ? WHERE id = ?").run(fields.engine, id);
    if (fields.boardId !== undefined) db.prepare("UPDATE plugin_agent_threads SET board_id = ? WHERE id = ?").run(fields.boardId, id);
    if (fields.itemId !== undefined) db.prepare("UPDATE plugin_agent_threads SET item_id = ? WHERE id = ?").run(fields.itemId, id);
    if (fields.branch !== undefined) db.prepare("UPDATE plugin_agent_threads SET branch = ? WHERE id = ?").run(fields.branch, id);
    if (fields.permissionMode !== undefined) db.prepare("UPDATE plugin_agent_threads SET permission_mode = ? WHERE id = ?").run(fields.permissionMode, id);
    if (fields.surface !== undefined) db.prepare("UPDATE plugin_agent_threads SET surface = ? WHERE id = ?").run(fields.surface, id);
    if (fields.options !== undefined) db.prepare("UPDATE plugin_agent_threads SET options_json = ? WHERE id = ?").run(fields.options && Object.keys(fields.options).length ? JSON.stringify(fields.options) : null, id);
    db.prepare("UPDATE plugin_agent_threads SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /** What a conversation said last, set once a turn ends; its place in the lists stays as it was. */
  setSaid(projectId: string, id: string, said: string | null): void {
    this.db(projectId).prepare("UPDATE plugin_agent_threads SET said = ? WHERE id = ?").run(said, id);
  }

  /** The last text a run said, read from that run's own messages newest first; null when it said nothing. */
  lastText(projectId: string, threadId: string, runId: string): string | null {
    const rows = this.db(projectId).prepare("SELECT block_json FROM plugin_agent_messages WHERE thread_id = ? AND run_id = ? AND role = 'agent' ORDER BY seq DESC LIMIT 200").all(threadId, runId) as { block_json: string }[];
    for (const row of rows) {
      const block = JSON.parse(row.block_json) as Block;
      if (block.type === "text" && block.text.trim()) return block.text;
    }
    return null;
  }

  /** Threads started from a ticket, newest first. */
  threadsForItem(projectId: string, itemId: string): ThreadSummary[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_agent_threads WHERE project_id = ? AND item_id = ? ORDER BY updated_at DESC").all(projectId, itemId) as ThreadRow[]).map(this.toThread);
  }

  external(projectId: string, threadId: string): Record<string, string> {
    const row = this.db(projectId).prepare("SELECT external_json FROM plugin_agent_threads WHERE id = ?").get(threadId) as { external_json: string } | undefined;
    return row ? (JSON.parse(row.external_json) as Record<string, string>) : {};
  }

  /** Null forgets the engine's session. */
  setExternal(projectId: string, threadId: string, engine: string, sessionId: string | null): void {
    const map = this.external(projectId, threadId);
    if (sessionId === null) delete map[engine];
    else map[engine] = sessionId;
    this.db(projectId).prepare("UPDATE plugin_agent_threads SET external_json = ? WHERE id = ?").run(JSON.stringify(map), threadId);
  }

  waivers(projectId: string, threadId: string): Set<string> {
    const row = this.db(projectId).prepare("SELECT waivers_json FROM plugin_agent_threads WHERE id = ?").get(threadId) as { waivers_json: string } | undefined;
    return new Set(row ? (JSON.parse(row.waivers_json) as string[]) : []);
  }

  addWaiver(projectId: string, threadId: string, rule: string): void {
    const set = this.waivers(projectId, threadId);
    set.add(rule);
    this.db(projectId).prepare("UPDATE plugin_agent_threads SET waivers_json = ? WHERE id = ?").run(JSON.stringify([...set]), threadId);
  }

  /** Oldest first; `afterSeq` leaves out what a reader already holds (messages are only ever appended). */
  messages(projectId: string, threadId: string, afterSeq = 0): ThreadMessage[] {
    const rows = this.db(projectId).prepare("SELECT * FROM plugin_agent_messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC").all(threadId, afterSeq) as {
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

  appendMessage(projectId: string, threadId: string, role: ThreadMessage["role"], block: Block, runId: string | null): ThreadMessage {
    const db = this.db(projectId);
    const seq = ((db.prepare("SELECT MAX(seq) AS m FROM plugin_agent_messages WHERE thread_id = ?").get(threadId) as { m: number | null }).m ?? 0) + 1;
    const message: ThreadMessage = { id: randomUUID(), threadId, seq, role, block, runId, at: Date.now() };
    db.prepare("INSERT INTO plugin_agent_messages (id, thread_id, seq, role, block_json, run_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      message.id,
      threadId,
      seq,
      role,
      JSON.stringify(block),
      runId,
      message.at
    );
    db.prepare("UPDATE plugin_agent_threads SET updated_at = ? WHERE id = ?").run(message.at, threadId);
    return message;
  }

  runs(projectId: string, threadId: string): RunView[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_agent_runs WHERE thread_id = ? ORDER BY started_at ASC").all(threadId) as RunRow[]).map(toRun);
  }

  run(projectId: string, id: string): RunView | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_agent_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** The project a run belongs to, searched across open files — for a caller that only holds the run id. */
  projectOfRun(runId: string): string | null {
    for (const projectId of this.pool.openIds()) {
      if (this.db(projectId).prepare("SELECT 1 FROM plugin_agent_runs WHERE id = ?").get(runId)) return projectId;
    }
    return null;
  }

  /**
   * Runs left mid-flight by a killed process — no in-memory controller will ever cancel them. A background
   * conversation's interruption is its conclusion: `parentNote` words it for the conversation it reports to.
   * The runs stop as `interrupted`, and both notes say so, so the conversation can offer to go on. Returns the
   * conversations interrupted.
   */
  reconcileInterrupted(projectId: string, note = "Interrupted — the app closed while this run was in progress.", parentNote?: (title: string) => string): string[] {
    const db = this.db(projectId);
    const stale = db.prepare("SELECT id, thread_id FROM plugin_agent_runs WHERE status = 'running'").all() as { id: string; thread_id: string }[];
    if (!stale.length) return [];
    const now = Date.now();
    const update = db.prepare("UPDATE plugin_agent_runs SET status = 'cancelled', stop = ?, error = ?, ended_at = ? WHERE id = ?");
    for (const { id, thread_id } of stale) {
      update.run(INTERRUPTED, note, now, id);
      this.appendMessage(projectId, thread_id, "system", { type: "note", text: note, interrupted: true }, id);
      const thread = db.prepare("SELECT title, parent_id FROM plugin_agent_threads WHERE id = ?").get(thread_id) as { title: string; parent_id: string | null } | undefined;
      if (parentNote && thread?.parent_id && this.thread(projectId, thread.parent_id)) this.appendMessage(projectId, thread.parent_id, "system", { type: "note", text: parentNote(thread.title), threadFor: thread_id, interrupted: true }, null);
    }
    return [...new Set(stale.map((s) => s.thread_id))];
  }

  /**
   * The run that left this conversation interrupted: its last run, when the app's closing cut it short and
   * nobody has continued, waved it away or archived the conversation since. Null otherwise.
   */
  interruptedRun(projectId: string, threadId: string): RunView | null {
    const row = this.db(projectId)
      .prepare("SELECT r.* FROM plugin_agent_runs r JOIN plugin_agent_threads t ON t.id = r.thread_id WHERE r.thread_id = ? AND t.archived = 0 ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1")
      .get(threadId) as RunRow | undefined;
    return row && row.stop === INTERRUPTED && row.dismissed_at == null ? toRun(row) : null;
  }

  /** The project's open conversations left interrupted (see `interruptedRun`), on these surfaces. */
  interruptedThreads(projectId: string, surface: ThreadSurface | ThreadSurface[] = "assistant"): ThreadSummary[] {
    const surfaces = [surface].flat();
    const rows = this.db(projectId)
      .prepare(
        `SELECT t.* FROM plugin_agent_threads t JOIN plugin_agent_runs r ON r.id = (SELECT id FROM plugin_agent_runs WHERE thread_id = t.id ORDER BY started_at DESC, rowid DESC LIMIT 1)
         WHERE t.project_id = ? AND t.archived = 0 AND t.surface IN (${surfaces.map(() => "?").join(",")}) AND r.stop = ? AND r.dismissed_at IS NULL ORDER BY t.updated_at DESC`
      )
      .all(projectId, ...surfaces, INTERRUPTED) as ThreadRow[];
    return rows.map(this.toThread);
  }

  /** The person waved the interruption away: the conversation stays as it is, no longer interrupted. Returns the run, or null when it was not interrupted. */
  dismissInterrupted(projectId: string, threadId: string): RunView | null {
    const run = this.interruptedRun(projectId, threadId);
    if (!run) return null;
    this.db(projectId).prepare("UPDATE plugin_agent_runs SET dismissed_at = ? WHERE id = ?").run(Date.now(), run.id);
    return this.run(projectId, run.id);
  }

  beginRun(projectId: string, threadId: string, engine: string): RunView {
    const id = randomUUID();
    const execution = this.thread(projectId, threadId)?.execution;
    this.db(projectId).prepare("INSERT INTO plugin_agent_runs (id, thread_id, status, engine, started_at, execution_json) VALUES (?, ?, 'running', ?, ?, ?)").run(id, threadId, engine, Date.now(), execution ? JSON.stringify(execution) : null);
    return this.run(projectId, id)!;
  }

  endRun(
    projectId: string,
    id: string,
    fields: { status: RunStatus; stop?: string; error?: string; usage?: { inputTokens?: number; outputTokens?: number }; metrics?: RunView["metrics"]; costUsd?: number; changes: number }
  ): RunView {
    this.db(projectId)
      .prepare("UPDATE plugin_agent_runs SET status = ?, stop = ?, error = ?, usage_json = ?, metrics_json = ?, cost_usd = ?, changes = ?, ended_at = ? WHERE id = ?")
      .run(
        fields.status,
        fields.stop ?? null,
        fields.error ?? null,
        fields.usage ? JSON.stringify({ inputTokens: fields.usage.inputTokens ?? 0, outputTokens: fields.usage.outputTokens ?? 0 }) : null,
        fields.metrics ? JSON.stringify(fields.metrics) : null,
        fields.costUsd ?? null,
        fields.changes,
        Date.now(),
        id
      );
    return this.run(projectId, id)!;
  }

  markReverted(projectId: string, id: string, kept: number): RunView {
    this.db(projectId).prepare("UPDATE plugin_agent_runs SET reverted = 1, kept = ? WHERE id = ?").run(kept, id);
    return this.run(projectId, id)!;
  }

  appendLedger(projectId: string, runId: string, seq: number, tool: string, args: unknown, ok: boolean, summary: string, ms: number): void {
    this.db(projectId)
      .prepare("INSERT INTO plugin_agent_ledger (run_id, seq, tool, args_json, ok, summary, ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(runId, seq, tool, JSON.stringify(args ?? {}).slice(0, 4000), ok ? 1 : 0, summary.slice(0, 500), ms);
  }

  cards(projectId: string, threadId: string): CardView[] {
    const rows = this.db(projectId).prepare("SELECT * FROM plugin_agent_cards WHERE thread_id = ? ORDER BY updated_at ASC").all(threadId) as {
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

  setCard(projectId: string, threadId: string, card: { id: string; schema: string; title: string; data: unknown }, by: Author | "human"): CardView {
    this.db(projectId)
      .prepare(
        `INSERT INTO plugin_agent_cards (thread_id, card_id, schema_id, title, data_json, version, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(thread_id, card_id) DO UPDATE SET
           schema_id = excluded.schema_id, title = excluded.title, data_json = excluded.data_json,
           version = plugin_agent_cards.version + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .run(threadId, card.id, card.schema, card.title, JSON.stringify(card.data ?? null), by, Date.now());
    return this.cards(projectId, threadId).find((c) => c.id === card.id)!;
  }

  pending(projectId: string, threadId: string): PendingRecord | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_agent_pending WHERE thread_id = ?").get(threadId) as PendingRow | undefined;
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

  setPending(projectId: string, threadId: string, record: Omit<PendingRecord, "threadId">): void {
    this.db(projectId)
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

  clearPending(projectId: string, threadId: string): void {
    this.db(projectId).prepare("DELETE FROM plugin_agent_pending WHERE thread_id = ?").run(threadId);
  }

  parked(projectId: string, threadId: string): ParkView | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_agent_parked WHERE thread_id = ?").get(threadId) as ParkedRow | undefined;
    return row ? toPark(row) : null;
  }

  allParked(projectId: string): ParkView[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_agent_parked ORDER BY until ASC").all() as ParkedRow[]).map(toPark);
  }

  park(projectId: string, park: ParkView): void {
    this.db(projectId)
      .prepare("INSERT OR REPLACE INTO plugin_agent_parked (thread_id, run_id, until, known, resume, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(park.threadId, park.runId, park.until, park.known ? 1 : 0, park.resume ? 1 : 0, park.attempt, Date.now());
  }

  unpark(projectId: string, threadId: string): boolean {
    return this.db(projectId).prepare("DELETE FROM plugin_agent_parked WHERE thread_id = ?").run(threadId).changes > 0;
  }

  brief(projectId: string): string | null {
    return this.briefView(projectId)?.body ?? null;
  }

  briefView(projectId: string): { body: string; updatedAt: number; previous: string | null } | null {
    const row = this.db(projectId).prepare("SELECT body, updated_at, previous_body FROM plugin_agent_briefs WHERE project_id = ?").get(projectId) as { body: string; updated_at: number; previous_body: string | null } | undefined;
    return row ? { body: row.body, updatedAt: row.updated_at, previous: row.previous_body } : null;
  }

  /** The body it replaces is kept as the previous one; writing the same text again keeps nothing new. */
  setBrief(projectId: string, body: string): void {
    this.db(projectId)
      .prepare(
        "INSERT INTO plugin_agent_briefs (project_id, body, updated_at, previous_body) VALUES (?, ?, ?, NULL) ON CONFLICT(project_id) DO UPDATE SET previous_body = CASE WHEN plugin_agent_briefs.body = excluded.body THEN plugin_agent_briefs.previous_body ELSE plugin_agent_briefs.body END, body = excluded.body, updated_at = excluded.updated_at"
      )
      .run(projectId, body, Date.now());
  }

  /** The previous body back as the current one; what it replaces becomes the previous. False when there is none. */
  restoreBrief(projectId: string): boolean {
    const view = this.briefView(projectId);
    if (!view || view.previous === null) return false;
    this.db(projectId).prepare("UPDATE plugin_agent_briefs SET body = ?, previous_body = ?, updated_at = ? WHERE project_id = ?").run(view.previous, view.body, Date.now(), projectId);
    return true;
  }

  changesOf(projectId: string, runId: string): number {
    return (this.db(projectId).prepare("SELECT COUNT(*) AS n FROM oplog WHERE run_id = ?").get(runId) as { n: number }).n;
  }

  /** What the run netted out to, per entity — the facts behind "Changed N". */
  changedEntities(projectId: string, runId: string): { key: string; label: string; op: "created" | "updated" | "deleted" }[] {
    const rows = this.db(projectId).prepare("SELECT entity, entity_id, op, before_json, after_json FROM oplog WHERE run_id = ? ORDER BY seq ASC").all(runId) as {
      entity: string;
      entity_id: string;
      op: string;
      before_json: string | null;
      after_json: string | null;
    }[];
    const net = new Map<string, { first: string; last: string; snap: { key?: string; name?: string; title?: string } }>();
    for (const row of rows) {
      const snap = JSON.parse(row.after_json ?? row.before_json ?? "{}") as { key?: string; name?: string; title?: string };
      const seen = net.get(row.entity_id);
      if (seen) {
        seen.last = row.op;
        if (row.after_json) seen.snap = snap;
      } else {
        net.set(row.entity_id, { first: row.op, last: row.op, snap });
      }
    }
    const out: { key: string; label: string; op: "created" | "updated" | "deleted" }[] = [];
    for (const { first, last, snap } of net.values()) {
      if (first === "create" && (last === "delete" || last === "purge")) continue; // net nothing
      const op = first === "create" ? "created" : last === "delete" ? "deleted" : "updated";
      out.push({ key: snap.key ?? snap.name ?? "·", label: snap.title ?? (snap.key ? "" : (snap.name ?? "")), op });
    }
    return out.slice(0, 60);
  }
}
