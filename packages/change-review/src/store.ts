import type { ProjectDb } from "@tomradex/db";

export const MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS plugin_changereview_comments (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  link_id    TEXT NOT NULL,
  path       TEXT NOT NULL,
  side       TEXT NOT NULL,
  line       INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  quote      TEXT NOT NULL,
  body       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plugin_changereview_comments_item ON plugin_changereview_comments(item_id);
`
  },
  // A comment a reviewing agent made: who, in which run, and how much it matters.
  { version: 2, up: "ALTER TABLE plugin_changereview_comments ADD COLUMN finding TEXT" },
  // A review an agent made of a ticket's changes in a conversation of its own: what it read, and what came of it.
  {
    version: 3,
    up: `
CREATE TABLE IF NOT EXISTS plugin_changereview_reviews (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  delivery   INTEGER NOT NULL,
  engine     TEXT NOT NULL,
  same       INTEGER NOT NULL DEFAULT 0,
  thread_id  TEXT NOT NULL,
  heads      TEXT NOT NULL,
  asked_by   TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'running',
  findings   INTEGER,
  error      TEXT,
  handed_at  INTEGER,
  held       INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plugin_changereview_reviews_item ON plugin_changereview_reviews(item_id);
CREATE INDEX IF NOT EXISTS idx_plugin_changereview_reviews_thread ON plugin_changereview_reviews(thread_id);
`
  }
];

/** This machine's review of a checkout that is here: another machine sees other lines, and has its own agent to tell. */
export const TABLES = {
  plugin_changereview_comments: { project: "project_id", export: false },
  plugin_changereview_reviews: { project: "project_id", export: false }
} as const;

export type ReviewSide = "old" | "new";
export type ReviewState = "open" | "resolved";

export type ReviewSeverity = "info" | "warning" | "error";

/** What makes a comment an agent's finding rather than a person's words. */
export interface ReviewFinding {
  /** The agent that found it, as an author: `ai:claude-code`. */
  reviewer: string;
  /** The run it was found in, when a conversation here found it. */
  runId?: string;
  /** The review it belongs to, when Tomrade started that review: the finding then ages with it. */
  reviewId?: string;
  severity: ReviewSeverity;
}

/** `running` while its conversation works or waits on the person; `failed` when it stopped on an error or with the app. */
export type AgentReviewState = "running" | "done" | "failed" | "cancelled";

/** One review of a ticket's changes by an agent, in a conversation that works nothing else. */
export interface AgentReview {
  id: string;
  itemId: string;
  /** The ticket's delivery it reviewed, one-based. */
  delivery: number;
  /** The engine that reviewed. */
  engine: string;
  /** The engine that wrote the change reviewed it: no other one was ready. */
  same: boolean;
  threadId: string;
  /** For each code link it read, the tip it read and the tip Tomrade had last seen then. */
  heads: Record<string, { head: string | null; seen: string | null }>;
  /** `person`: someone asked for it. `auto`: the ticket was delivered and reviews start by themselves. */
  askedBy: "person" | "auto";
  state: AgentReviewState;
  /** How many findings it left; null until it is over. */
  findings: number | null;
  error: string | null;
  /** When its findings went to the session working the ticket by themselves; null when they wait on the person. */
  handedAt: number | null;
  /** Its findings wait on the person: the back and forth reached its limit, or no session could be told. */
  held: boolean;
  startedAt: number;
  endedAt: number | null;
}

/** A comment on a line, or a run of lines, of a ticket's diff: a person's, or a reviewing agent's finding. */
export interface ReviewComment {
  id: string;
  itemId: string;
  linkId: string;
  path: string;
  side: ReviewSide;
  line: number;
  endLine: number;
  /** The commented lines as they were, newline-joined: what re-pins the comment and what the agent is shown. */
  quote: string;
  body: string;
  state: ReviewState;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  /** Present on an agent's finding, and kept through every edit of it. */
  finding?: ReviewFinding;
  /** In a listing: a finding of a review whose branch has moved since, so it speaks of older code. */
  stale?: boolean;
}

/** What a new comment says of itself; the rest is the store's. */
export type ReviewDraft = Pick<ReviewComment, "linkId" | "path" | "side" | "line" | "endLine" | "quote" | "body">;

interface Row {
  id: string;
  item_id: string;
  link_id: string;
  path: string;
  side: string;
  line: number;
  end_line: number;
  quote: string;
  body: string;
  state: string;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  finding: string | null;
}

const toComment = (r: Row): ReviewComment => ({
  id: r.id,
  itemId: r.item_id,
  linkId: r.link_id,
  path: r.path,
  side: r.side as ReviewSide,
  line: r.line,
  endLine: r.end_line,
  quote: r.quote,
  body: r.body,
  state: r.state as ReviewState,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  sentAt: r.sent_at,
  ...(r.finding ? { finding: JSON.parse(r.finding) as ReviewFinding } : {})
});

interface ReviewRow {
  id: string;
  item_id: string;
  delivery: number;
  engine: string;
  same: number;
  thread_id: string;
  heads: string;
  asked_by: string;
  state: string;
  findings: number | null;
  error: string | null;
  handed_at: number | null;
  held: number;
  started_at: number;
  ended_at: number | null;
}

const toReview = (r: ReviewRow): AgentReview => ({
  id: r.id,
  itemId: r.item_id,
  delivery: r.delivery,
  engine: r.engine,
  same: r.same === 1,
  threadId: r.thread_id,
  heads: JSON.parse(r.heads) as AgentReview["heads"],
  askedBy: r.asked_by as AgentReview["askedBy"],
  state: r.state as AgentReviewState,
  findings: r.findings,
  error: r.error,
  handedAt: r.handed_at,
  held: r.held === 1,
  startedAt: r.started_at,
  endedAt: r.ended_at
});

export class ReviewStore {
  constructor(private readonly db: (projectId: string) => ProjectDb) {}

  /** A ticket's comments, oldest first. */
  of(projectId: string, itemId: string): ReviewComment[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_changereview_comments WHERE item_id = ? ORDER BY created_at ASC, rowid ASC").all(itemId) as Row[]).map(toComment);
  }

  get(projectId: string, id: string): ReviewComment | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_changereview_comments WHERE id = ?").get(id) as Row | undefined;
    return row ? toComment(row) : null;
  }

  add(projectId: string, itemId: string, id: string, draft: ReviewDraft, now: number, finding?: ReviewFinding): ReviewComment {
    this.db(projectId)
      .prepare("INSERT INTO plugin_changereview_comments (id, project_id, item_id, link_id, path, side, line, end_line, quote, body, created_at, updated_at, finding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectId, itemId, draft.linkId, draft.path, draft.side, draft.line, draft.endLine, draft.quote, draft.body, now, now, finding ? JSON.stringify(finding) : null);
    return this.get(projectId, id)!;
  }

  /** New words are not the ones the agent was sent: the comment waits to be sent again. */
  patch(projectId: string, id: string, patch: { body?: string; state?: ReviewState }, now: number): void {
    const cols: [string, unknown][] = [["updated_at", now]];
    if (patch.body !== undefined) cols.push(["body", patch.body], ["sent_at", null]);
    if (patch.state !== undefined) cols.push(["state", patch.state]);
    this.db(projectId).prepare(`UPDATE plugin_changereview_comments SET ${cols.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map(([, v]) => v), id);
  }

  remove(projectId: string, id: string): boolean {
    return this.db(projectId).prepare("DELETE FROM plugin_changereview_comments WHERE id = ?").run(id).changes > 0;
  }

  sent(projectId: string, ids: string[], at: number): void {
    const db = this.db(projectId);
    const stamp = db.prepare("UPDATE plugin_changereview_comments SET sent_at = ? WHERE id = ?");
    db.transaction(() => {
      for (const id of ids) stamp.run(at, id);
    });
  }

  /** A ticket's agent reviews, newest first. */
  reviews(projectId: string, itemId: string): AgentReview[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_changereview_reviews WHERE item_id = ? ORDER BY started_at DESC, rowid DESC").all(itemId) as ReviewRow[]).map(toReview);
  }

  review(projectId: string, id: string): AgentReview | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_changereview_reviews WHERE id = ?").get(id) as ReviewRow | undefined;
    return row ? toReview(row) : null;
  }

  /** The review a conversation is, when it is one. */
  reviewOfThread(projectId: string, threadId: string): AgentReview | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_changereview_reviews WHERE thread_id = ?").get(threadId) as ReviewRow | undefined;
    return row ? toReview(row) : null;
  }

  /** Every review of the project that is not over. */
  runningReviews(projectId: string): AgentReview[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_changereview_reviews WHERE state = 'running' ORDER BY started_at ASC").all() as ReviewRow[]).map(toReview);
  }

  /** Every review of the project whose findings wait on the person. */
  heldReviews(projectId: string): AgentReview[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_changereview_reviews WHERE held = 1 ORDER BY started_at ASC").all() as ReviewRow[]).map(toReview);
  }

  addReview(projectId: string, review: Pick<AgentReview, "id" | "itemId" | "delivery" | "engine" | "same" | "threadId" | "heads" | "askedBy" | "startedAt">): AgentReview {
    this.db(projectId)
      .prepare("INSERT INTO plugin_changereview_reviews (id, project_id, item_id, delivery, engine, same, thread_id, heads, asked_by, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(review.id, projectId, review.itemId, review.delivery, review.engine, review.same ? 1 : 0, review.threadId, JSON.stringify(review.heads), review.askedBy, review.startedAt);
    return this.review(projectId, review.id)!;
  }

  patchReview(projectId: string, id: string, patch: Partial<Pick<AgentReview, "state" | "findings" | "error" | "handedAt" | "held" | "endedAt">>): void {
    const cols: [string, unknown][] = [];
    if (patch.state !== undefined) cols.push(["state", patch.state]);
    if (patch.findings !== undefined) cols.push(["findings", patch.findings]);
    if (patch.error !== undefined) cols.push(["error", patch.error]);
    if (patch.handedAt !== undefined) cols.push(["handed_at", patch.handedAt]);
    if (patch.held !== undefined) cols.push(["held", patch.held ? 1 : 0]);
    if (patch.endedAt !== undefined) cols.push(["ended_at", patch.endedAt]);
    if (!cols.length) return;
    this.db(projectId).prepare(`UPDATE plugin_changereview_reviews SET ${cols.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map(([, v]) => v), id);
  }
}
