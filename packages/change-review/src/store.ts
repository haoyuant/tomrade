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
  { version: 2, up: "ALTER TABLE plugin_changereview_comments ADD COLUMN finding TEXT" }
];

/** This machine's review of a checkout that is here: another machine sees other lines, and has its own agent to tell. */
export const TABLES = {
  plugin_changereview_comments: { project: "project_id", export: false }
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
  severity: ReviewSeverity;
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
}
