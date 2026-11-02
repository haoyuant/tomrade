import type { ProjectDb } from "@tomradex/db";
import type { FeedbackKind, PrEvent } from "./rules.js";

export const MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS plugin_prfeedback_watches (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  delivery     INTEGER NOT NULL,
  repo         TEXT NOT NULL,
  number       INTEGER NOT NULL,
  url          TEXT,
  watched_from INTEGER NOT NULL,
  head         TEXT,
  updated      TEXT,
  reported     TEXT,
  wakes        INTEGER NOT NULL DEFAULT 0,
  bot_rounds   INTEGER NOT NULL DEFAULT 0,
  failures     INTEGER NOT NULL DEFAULT 0,
  notice_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_plugin_prfeedback_watches_item ON plugin_prfeedback_watches(item_id, delivery);
CREATE TABLE IF NOT EXISTS plugin_prfeedback_events (
  project_id TEXT NOT NULL,
  watch_id   TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  actor      TEXT,
  bot        INTEGER NOT NULL DEFAULT 0,
  at         INTEGER NOT NULL,
  url        TEXT,
  body       TEXT NOT NULL,
  path       TEXT,
  state      TEXT NOT NULL,
  batch      TEXT,
  PRIMARY KEY (watch_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_prfeedback_events_state ON plugin_prfeedback_events(watch_id, state);
`
  }
];

/** This machine's agents and clock: another machine watches its own sessions, and a shared row would wake one agent twice. */
export const TABLES = {
  plugin_prfeedback_watches: { project: "project_id", export: false },
  plugin_prfeedback_events: { project: "project_id", export: false }
} as const;

/** `ignored` keeps the record of who was not let in; `superseded` is CI of a commit the branch moved on from. */
export type EventState = "pending" | "delivered" | "ignored" | "noticed" | "capped" | "superseded";

export type NoticeKind = "capped" | "unreachable" | "locked" | "refused" | "unreadable";

export interface Notice {
  kind: NoticeKind;
  why?: string;
  threadId: string | null;
  sessionId: string | null;
  agent: string;
}

export interface Watch {
  id: string;
  projectId: string;
  itemId: string;
  delivery: number;
  repo: string;
  number: number;
  url: string | null;
  watchedFrom: number;
  head: string | null;
  /** The pull request's `updated_at` its comments were last read at. */
  updated: string | null;
  /** The commit whose failed CI was told or set aside: it is not looked at again. */
  reported: string | null;
  wakes: number;
  botRounds: number;
  failures: number;
  notice: Notice | null;
}

interface WatchRow {
  id: string;
  project_id: string;
  item_id: string;
  delivery: number;
  repo: string;
  number: number;
  url: string | null;
  watched_from: number;
  head: string | null;
  updated: string | null;
  reported: string | null;
  wakes: number;
  bot_rounds: number;
  failures: number;
  notice_json: string | null;
}

interface EventRow {
  event_id: string;
  kind: string;
  actor: string | null;
  bot: number;
  at: number;
  url: string | null;
  body: string;
  path: string | null;
  batch: string | null;
}

const toWatch = (r: WatchRow): Watch => ({
  id: r.id,
  projectId: r.project_id,
  itemId: r.item_id,
  delivery: r.delivery,
  repo: r.repo,
  number: r.number,
  url: r.url,
  watchedFrom: r.watched_from,
  head: r.head,
  updated: r.updated,
  reported: r.reported,
  wakes: r.wakes,
  botRounds: r.bot_rounds,
  failures: r.failures,
  notice: r.notice_json ? (JSON.parse(r.notice_json) as Notice) : null
});

export interface HeldEvent extends PrEvent {
  batch: string | null;
}

const toEvent = (r: EventRow): HeldEvent => ({
  id: r.event_id,
  kind: r.kind as FeedbackKind,
  actor: r.actor,
  bot: !!r.bot,
  association: null,
  at: r.at,
  url: r.url,
  body: r.body,
  path: r.path,
  batch: r.batch
});

export class FeedbackStore {
  constructor(private readonly db: (projectId: string) => ProjectDb) {}

  watches(projectId: string): Watch[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_prfeedback_watches WHERE project_id = ?").all(projectId) as WatchRow[]).map(toWatch);
  }

  watch(projectId: string, id: string): Watch | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_prfeedback_watches WHERE id = ?").get(id) as WatchRow | undefined;
    return row ? toWatch(row) : null;
  }

  add(input: Pick<Watch, "id" | "projectId" | "itemId" | "delivery" | "repo" | "number" | "url" | "watchedFrom">): void {
    this.db(input.projectId)
      .prepare("INSERT OR IGNORE INTO plugin_prfeedback_watches (id, project_id, item_id, delivery, repo, number, url, watched_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.projectId, input.itemId, input.delivery, input.repo, input.number, input.url, input.watchedFrom);
  }

  patch(projectId: string, id: string, patch: { head?: string | null; updated?: string | null; reported?: string | null; failures?: number; notice?: Notice | null }): void {
    const cols: [string, unknown][] = [];
    if (patch.head !== undefined) cols.push(["head", patch.head]);
    if (patch.updated !== undefined) cols.push(["updated", patch.updated]);
    if (patch.reported !== undefined) cols.push(["reported", patch.reported]);
    if (patch.failures !== undefined) cols.push(["failures", patch.failures]);
    if (patch.notice !== undefined) cols.push(["notice_json", patch.notice ? JSON.stringify(patch.notice) : null]);
    if (!cols.length) return;
    this.db(projectId).prepare(`UPDATE plugin_prfeedback_watches SET ${cols.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map(([, v]) => v), id);
  }

  /** The branch moved: CI of the old commit no longer asks for anything. */
  supersede(projectId: string, watchId: string): void {
    this.db(projectId).prepare("UPDATE plugin_prfeedback_events SET state = 'superseded', batch = NULL WHERE watch_id = ? AND state = 'pending' AND kind = 'ci'").run(watchId);
  }

  /** Once per event, however many times it is read. */
  record(projectId: string, watchId: string, event: PrEvent, state: EventState): void {
    this.db(projectId)
      .prepare("INSERT OR IGNORE INTO plugin_prfeedback_events (project_id, watch_id, event_id, kind, actor, bot, at, url, body, path, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(projectId, watchId, event.id, event.kind, event.actor, event.bot ? 1 : 0, event.at, event.url, event.body, event.path, state);
  }

  state(projectId: string, watchId: string, eventId: string): EventState | null {
    const row = this.db(projectId).prepare("SELECT state FROM plugin_prfeedback_events WHERE watch_id = ? AND event_id = ?").get(watchId, eventId) as { state: EventState } | undefined;
    return row?.state ?? null;
  }

  pending(projectId: string, watchId: string): HeldEvent[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_prfeedback_events WHERE watch_id = ? AND state = 'pending' ORDER BY at ASC, event_id ASC").all(watchId) as EventRow[]).map(toEvent);
  }

  /** Named before the send: a crash after it sends these same events again, under the same request id. */
  batch(projectId: string, watchId: string, batch: string, eventIds: string[]): void {
    const db = this.db(projectId);
    const named = db.prepare("UPDATE plugin_prfeedback_events SET batch = ? WHERE watch_id = ? AND event_id = ?");
    db.transaction(() => {
      for (const id of eventIds) named.run(batch, watchId, id);
    });
  }

  settle(projectId: string, watchId: string, eventIds: string[], state: EventState): void {
    const db = this.db(projectId);
    const settled = db.prepare("UPDATE plugin_prfeedback_events SET state = ? WHERE watch_id = ? AND event_id = ?");
    db.transaction(() => {
      for (const id of eventIds) settled.run(state, watchId, id);
    });
  }

  woke(projectId: string, watchId: string, bot: boolean): void {
    this.db(projectId).prepare("UPDATE plugin_prfeedback_watches SET wakes = wakes + 1, bot_rounds = bot_rounds + ? WHERE id = ?").run(bot ? 1 : 0, watchId);
  }

  /** A ticket's wakes across its delivery's pull requests. */
  wakes(projectId: string, itemId: string, delivery: number): number {
    const row = this.db(projectId).prepare("SELECT COALESCE(SUM(wakes), 0) AS n FROM plugin_prfeedback_watches WHERE item_id = ? AND delivery = ?").get(itemId, delivery) as { n: number };
    return row.n;
  }

  drop(projectId: string, watchId: string): void {
    const db = this.db(projectId);
    db.transaction(() => {
      db.prepare("DELETE FROM plugin_prfeedback_events WHERE watch_id = ?").run(watchId);
      db.prepare("DELETE FROM plugin_prfeedback_watches WHERE id = ?").run(watchId);
    });
  }

  clear(projectId: string): void {
    const db = this.db(projectId);
    db.transaction(() => {
      db.prepare("DELETE FROM plugin_prfeedback_events WHERE project_id = ?").run(projectId);
      db.prepare("DELETE FROM plugin_prfeedback_watches WHERE project_id = ?").run(projectId);
    });
  }
}
