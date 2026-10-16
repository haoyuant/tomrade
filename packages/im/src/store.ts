import type { ProjectDb } from "@tomradex/db";

export const MIGRATIONS = [{ version: 1, up: `
CREATE TABLE plugin_im_bindings (
 id TEXT PRIMARY KEY, route_id TEXT NOT NULL, route_hash TEXT NOT NULL,
 connection_id TEXT NOT NULL, address_json TEXT NOT NULL, project_id TEXT NOT NULL,
 thread_id TEXT NOT NULL, actor_id TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE TABLE plugin_im_inbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, message_key TEXT UNIQUE,
 binding_id TEXT NOT NULL, event_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued', run_id TEXT, error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE plugin_im_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, binding_id TEXT NOT NULL,
 content_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', message_id TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT,
 created_at INTEGER NOT NULL
);
CREATE TABLE plugin_im_actions (
 token TEXT PRIMARY KEY, binding_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 question_id TEXT NOT NULL, actor_id TEXT NOT NULL, value_json TEXT,
 expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_plugin_im_inbox_binding ON plugin_im_inbox(binding_id, state, seq);
CREATE INDEX idx_plugin_im_outbox_binding ON plugin_im_outbox(binding_id, state, seq);
` }, { version: 2, up: `
ALTER TABLE plugin_im_outbox ADD COLUMN thread_id TEXT;
UPDATE plugin_im_outbox SET thread_id = (SELECT thread_id FROM plugin_im_bindings WHERE id = binding_id);
ALTER TABLE plugin_im_outbox ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plugin_im_outbox ADD COLUMN prepared_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plugin_im_outbox ADD COLUMN parts_json TEXT;
ALTER TABLE plugin_im_outbox ADD COLUMN part INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plugin_im_outbox ADD COLUMN message_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plugin_im_outbox ADD COLUMN sending_json TEXT;
ALTER TABLE plugin_im_inbox ADD COLUMN input_json TEXT;
ALTER TABLE plugin_im_actions ADD COLUMN run_id TEXT;
UPDATE plugin_im_outbox SET message_ids_json = json_array(message_id) WHERE message_id IS NOT NULL;
` }, { version: 3, up: `
ALTER TABLE plugin_im_actions ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plugin_im_actions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_plugin_im_actions_binding ON plugin_im_actions(binding_id, retired);
` }, { version: 4, up: `
ALTER TABLE plugin_im_bindings ADD COLUMN anchor TEXT;
ALTER TABLE plugin_im_outbox ADD COLUMN anchor TEXT;
ALTER TABLE plugin_im_outbox ADD COLUMN visible_to TEXT;
ALTER TABLE plugin_im_outbox ADD COLUMN stream INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plugin_im_outbox ADD COLUMN stream_of TEXT;
ALTER TABLE plugin_im_outbox ADD COLUMN streamed TEXT;
CREATE INDEX idx_plugin_im_outbox_stream ON plugin_im_outbox(binding_id, stream);
` }, { version: 5, up: `
ALTER TABLE plugin_im_bindings ADD COLUMN grp INTEGER;
ALTER TABLE plugin_im_bindings ADD COLUMN share_next INTEGER NOT NULL DEFAULT 0;
CREATE TABLE plugin_im_runs (binding_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY (binding_id, run_id));
` }, { version: 6, up: `
CREATE TABLE plugin_im_window (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT NOT NULL, place TEXT NOT NULL, message_key TEXT NOT NULL UNIQUE,
 message_id TEXT NOT NULL, author_json TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_plugin_im_window_place ON plugin_im_window(place, seq);
CREATE INDEX idx_plugin_im_window_route ON plugin_im_window(route_id, created_at);
` }];
export const TABLES = {
  plugin_im_bindings: { export: false }, plugin_im_inbox: { export: false },
  plugin_im_outbox: { export: false }, plugin_im_actions: { export: false }, plugin_im_runs: { export: false },
  plugin_im_window: { export: false }
} as const;

export interface Binding {
  id: string; route_id: string; route_hash: string; connection_id: string;
  address_json: string; project_id: string; thread_id: string; actor_id: string;
  cursor: number; created_at: number;
  /** In a group, the message that started the current turn; replies attach to it. */
  anchor: string | null;
  /** 1 for a group conversation, 0 for a direct chat; null for a binding made before it was recorded. */
  grp: number | null;
  /** 1 while the desktop asked for its next turn on this thread to reach the group too. */
  share_next: number;
}
export interface Inbox {
  seq: number; id: string; message_key: string | null; binding_id: string;
  event_json: string; input_json: string | null; fingerprint: string; state: string; run_id: string | null;
  error: string | null; created_at: number;
}
export interface Outbox {
  seq: number; id: string; binding_id: string; content_json: string; state: string;
  thread_id: string; revision: number; prepared_revision: number; parts_json: string | null; part: number; message_ids_json: string; sending_json: string | null;
  message_id: string | null; attempts: number; retry_at: number; error: string | null; created_at: number;
  anchor: string | null; visible_to: string | null;
  /** 1 while the row is a growing snapshot of a reply; 0 once final. */
  stream: number;
  /** The Agent message a stream became. */
  stream_of: string | null;
  /** Text already sent through a native stream that has not been stopped. */
  streamed: string | null;
}
/** A group message kept on this computer for a route with `groupContext`; `place` is its conversation and topic. */
export interface WindowRow {
  seq: number; route_id: string; place: string; message_key: string; message_id: string;
  author_json: string; text: string; created_at: number;
}
export interface Action {
  token: string; binding_id: string; thread_id: string; question_id: string;
  actor_id: string; run_id: string | null; value_json: string | null; expires_at: number; consumed: number;
  /** Its card was updated after the question ended; `consumed` alone only stops reuse. */
  retired: number; created_at: number;
}

/** Only local delivery metadata. Project history and execution stay with Agent. */
export class ImStore {
  constructor(readonly db: ProjectDb) {}
  get<T>(sql: string, ...args: unknown[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T>(sql: string, ...args: unknown[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: unknown[]): { changes: number; lastInsertRowid: number | bigint } { return this.db.prepare(sql).run(...args); }
  bindings(): Binding[] { return this.all("SELECT * FROM plugin_im_bindings"); }
  binding(id: string): Binding | undefined { return this.get("SELECT * FROM plugin_im_bindings WHERE id = ?", id); }

  /** Bounded history; dedup of older events relies on Agent input receipts instead. */
  prune(before: number) {
    this.db.transaction(() => {
      this.run("DELETE FROM plugin_im_inbox WHERE state NOT IN ('queued') AND created_at < ?", before);
      this.run("DELETE FROM plugin_im_outbox WHERE state IN ('delivered', 'cancelled') AND created_at < ?", before);
      this.run("DELETE FROM plugin_im_actions WHERE retired = 1 AND created_at < ?", before);
      this.run("DELETE FROM plugin_im_actions WHERE question_id LIKE 'remind:%' AND expires_at < ?", before);
      this.run("DELETE FROM plugin_im_actions WHERE question_id LIKE 'cmd:%' AND expires_at < ?", before);
    });
  }
}
