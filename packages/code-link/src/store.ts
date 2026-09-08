import { randomUUID } from "node:crypto";
import type { Db, ProjectDb } from "@tomrade/db";
import type { ItemStatus } from "@tomrade/domain";
import { DEFAULT_BRANCH_TEMPLATE } from "./keys.js";
import type { PrState } from "./rules.js";

export const MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS plugin_code_link_links (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  repo_id       TEXT NOT NULL,
  branch        TEXT NOT NULL DEFAULT '',
  head_sha      TEXT,
  head_at       INTEGER,
  ahead         INTEGER NOT NULL DEFAULT 0,
  behind        INTEGER NOT NULL DEFAULT 0,
  merged_sha    TEXT,
  pr_number     INTEGER,
  pr_url        TEXT,
  pr_state      TEXT,
  thread_id     TEXT,
  source        TEXT NOT NULL DEFAULT 'scan',
  last_seen_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_code_link_links_key ON plugin_code_link_links(project_id, repo_id, branch, item_id);
CREATE INDEX IF NOT EXISTS idx_plugin_code_link_links_item ON plugin_code_link_links(item_id);
CREATE TABLE IF NOT EXISTS plugin_code_link_repos (
  repo_id         TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  readiness       TEXT NOT NULL DEFAULT 'unknown',
  has_brief       INTEGER NOT NULL DEFAULT 0,
  manifests_json  TEXT NOT NULL DEFAULT '[]',
  summary         TEXT,
  scanned_sha     TEXT,
  default_sha     TEXT,
  branch_template TEXT NOT NULL DEFAULT '{key}/{slug}',
  auto_done       INTEGER NOT NULL DEFAULT 1,
  agent_push      INTEGER NOT NULL DEFAULT 1,
  scanned_at      INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_code_link_proposals (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  link_id       TEXT,
  kind          TEXT NOT NULL,
  from_status   TEXT NOT NULL,
  to_status     TEXT,
  reason        TEXT NOT NULL,
  evidence_sha  TEXT,
  state         TEXT NOT NULL DEFAULT 'open',
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plugin_code_link_proposals_item ON plugin_code_link_proposals(item_id, state);
CREATE TABLE IF NOT EXISTS plugin_code_link_sessions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  repo_id        TEXT NOT NULL,
  branch         TEXT NOT NULL DEFAULT '',
  item_ids_json  TEXT NOT NULL DEFAULT '[]',
  mode           TEXT NOT NULL,
  agent          TEXT NOT NULL,
  external_id    TEXT,
  thread_id      TEXT,
  state          TEXT NOT NULL DEFAULT 'running',
  last_event_at  INTEGER,
  last_tool_at   INTEGER,
  last_commit_at INTEGER,
  summary        TEXT,
  device         TEXT NOT NULL DEFAULT '',
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plugin_code_link_sessions_project ON plugin_code_link_sessions(project_id, state);
`
  },
  {
    // What the agent is doing right now, as its last hook said: "Bash · flutter create…", "needs your approval".
    version: 2,
    up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN activity TEXT"
  },
  {
    version: 3,
    up: `
ALTER TABLE plugin_code_link_repos ADD COLUMN remote TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE plugin_code_link_repos ADD COLUMN remote_detail TEXT;
ALTER TABLE plugin_code_link_repos ADD COLUMN remote_at INTEGER;
`
  },
  {
    version: 4,
    up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN blocked TEXT"
  }
];

/** Every table travels in the project's folder; the merge is row-level, later write wins. */
export const TABLES = {
  plugin_code_link_links: { project: "project_id", export: { order: "id" } },
  plugin_code_link_repos: { project: "project_id", export: { order: "repo_id" } },
  plugin_code_link_proposals: { project: "project_id", export: { order: "id" } },
  plugin_code_link_sessions: { project: "project_id", export: { order: "id" } }
} as const;

export type LinkSource = "start" | "scan" | "mcp" | "manual";

/** One trace of a ticket's code in one repository: a branch, its pull request, whether it landed. */
export interface CodeLinkView {
  id: string;
  projectId: string;
  itemId: string;
  repoId: string;
  /** '' when only a default-branch commit named the ticket (the branch is gone or never existed). */
  branch: string;
  headSha: string | null;
  headAt: number | null;
  ahead: number;
  behind: number;
  mergedSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prState: PrState | null;
  threadId: string | null;
  source: LinkSource;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type Readiness = "unknown" | "empty" | "scaffolded";
export type RemoteState = "ok" | "unreachable" | "unknown";

export interface RepoStateView {
  repoId: string;
  projectId: string;
  readiness: Readiness;
  remote: RemoteState;
  remoteDetail: string | null;
  /** Last time this machine reached origin successfully. */
  remoteAt: number | null;
  hasBrief: boolean;
  manifests: string[];
  summary: string | null;
  scannedSha: string | null;
  defaultSha: string | null;
  branchTemplate: string;
  autoDone: boolean;
  agentPush: boolean;
  scannedAt: number | null;
  updatedAt: number;
}

export type ProposalKind = "propose" | "flag";
export type ProposalState = "open" | "accepted" | "rejected" | "stale";

export interface ProposalView {
  id: string;
  projectId: string;
  itemId: string;
  linkId: string | null;
  kind: ProposalKind;
  fromStatus: ItemStatus;
  toStatus: ItemStatus | null;
  reason: string;
  evidenceSha: string | null;
  state: ProposalState;
  createdAt: number;
  resolvedAt: number | null;
}

export type SessionMode = "headless" | "terminal";
/** `error`: the agent stopped on its own account (rate limit, auth) and is not working; the process may still be there. */
export type SessionState = "running" | "waiting" | "idle" | "error" | "ended" | "lost";

export interface SessionView {
  id: string;
  projectId: string;
  repoId: string;
  branch: string;
  itemIds: string[];
  mode: SessionMode;
  agent: string;
  externalId: string | null;
  threadId: string | null;
  state: SessionState;
  lastEventAt: number | null;
  lastToolAt: number | null;
  lastCommitAt: number | null;
  /** The agent's own one-liner about where it is (note_progress, or what it said when it last stopped). */
  summary: string | null;
  /** What it is doing this moment, from its last hook; null between tools. */
  activity: string | null;
  blocked: "credentials" | null;
  device: string;
  startedAt: number;
  endedAt: number | null;
}

interface LinkRow {
  id: string;
  project_id: string;
  item_id: string;
  repo_id: string;
  branch: string;
  head_sha: string | null;
  head_at: number | null;
  ahead: number;
  behind: number;
  merged_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  thread_id: string | null;
  source: string;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RepoRow {
  repo_id: string;
  project_id: string;
  readiness: string;
  remote: string;
  remote_detail: string | null;
  remote_at: number | null;
  has_brief: number;
  manifests_json: string;
  summary: string | null;
  scanned_sha: string | null;
  default_sha: string | null;
  branch_template: string;
  auto_done: number;
  agent_push: number;
  scanned_at: number | null;
  updated_at: number;
}

interface ProposalRow {
  id: string;
  project_id: string;
  item_id: string;
  link_id: string | null;
  kind: string;
  from_status: string;
  to_status: string | null;
  reason: string;
  evidence_sha: string | null;
  state: string;
  created_at: number;
  resolved_at: number | null;
}

interface SessionRow {
  id: string;
  project_id: string;
  repo_id: string;
  branch: string;
  item_ids_json: string;
  mode: string;
  agent: string;
  external_id: string | null;
  thread_id: string | null;
  state: string;
  last_event_at: number | null;
  last_tool_at: number | null;
  last_commit_at: number | null;
  summary: string | null;
  activity: string | null;
  blocked: string | null;
  device: string;
  started_at: number;
  ended_at: number | null;
}

const toLink = (r: LinkRow): CodeLinkView => ({
  id: r.id,
  projectId: r.project_id,
  itemId: r.item_id,
  repoId: r.repo_id,
  branch: r.branch,
  headSha: r.head_sha,
  headAt: r.head_at,
  ahead: r.ahead,
  behind: r.behind,
  mergedSha: r.merged_sha,
  prNumber: r.pr_number,
  prUrl: r.pr_url,
  prState: (r.pr_state as PrState | null) ?? null,
  threadId: r.thread_id,
  source: r.source as LinkSource,
  lastSeenAt: r.last_seen_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

const toRepo = (r: RepoRow): RepoStateView => ({
  repoId: r.repo_id,
  projectId: r.project_id,
  readiness: r.readiness as Readiness,
  remote: r.remote as RemoteState,
  remoteDetail: r.remote_detail,
  remoteAt: r.remote_at,
  hasBrief: r.has_brief === 1,
  manifests: JSON.parse(r.manifests_json) as string[],
  summary: r.summary,
  scannedSha: r.scanned_sha,
  defaultSha: r.default_sha,
  branchTemplate: r.branch_template,
  autoDone: r.auto_done === 1,
  agentPush: r.agent_push === 1,
  scannedAt: r.scanned_at,
  updatedAt: r.updated_at
});

const toProposal = (r: ProposalRow): ProposalView => ({
  id: r.id,
  projectId: r.project_id,
  itemId: r.item_id,
  linkId: r.link_id,
  kind: r.kind as ProposalKind,
  fromStatus: r.from_status as ItemStatus,
  toStatus: (r.to_status as ItemStatus | null) ?? null,
  reason: r.reason,
  evidenceSha: r.evidence_sha,
  state: r.state as ProposalState,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at
});

const toSession = (r: SessionRow): SessionView => ({
  id: r.id,
  projectId: r.project_id,
  repoId: r.repo_id,
  branch: r.branch,
  itemIds: JSON.parse(r.item_ids_json) as string[],
  mode: r.mode as SessionMode,
  agent: r.agent,
  externalId: r.external_id,
  threadId: r.thread_id,
  state: r.state as SessionState,
  lastEventAt: r.last_event_at,
  lastToolAt: r.last_tool_at,
  lastCommitAt: r.last_commit_at,
  summary: r.summary,
  activity: r.activity ?? null,
  blocked: (r.blocked as "credentials" | null) ?? null,
  device: r.device,
  startedAt: r.started_at,
  endedAt: r.ended_at
});

export interface LinkPatch {
  headSha?: string | null;
  headAt?: number | null;
  ahead?: number;
  behind?: number;
  mergedSha?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  prState?: PrState | null;
  threadId?: string | null;
  source?: LinkSource;
  lastSeenAt?: number | null;
}

export interface RepoStatePatch {
  readiness?: Readiness;
  remote?: RemoteState;
  remoteDetail?: string | null;
  remoteAt?: number | null;
  hasBrief?: boolean;
  manifests?: string[];
  summary?: string | null;
  scannedSha?: string | null;
  defaultSha?: string | null;
  branchTemplate?: string;
  autoDone?: boolean;
  agentPush?: boolean;
  scannedAt?: number | null;
}

export interface SessionPatch {
  branch?: string;
  itemIds?: string[];
  externalId?: string | null;
  threadId?: string | null;
  state?: SessionState;
  lastEventAt?: number | null;
  lastToolAt?: number | null;
  lastCommitAt?: number | null;
  summary?: string | null;
  activity?: string | null;
  blocked?: "credentials" | null;
  endedAt?: number | null;
}

/** Rows live in their project's file, so every read and write names the project first. */
export class CodeLinkStore {
  constructor(private readonly pool: Db) {}

  private db(projectId: string): ProjectDb {
    return this.pool.for(projectId);
  }

  // ── links ──────────────────────────────────────────────────────────────────

  links(projectId: string, itemId?: string): CodeLinkView[] {
    const db = this.db(projectId);
    const rows = itemId
      ? (db.prepare("SELECT * FROM plugin_code_link_links WHERE project_id = ? AND item_id = ? ORDER BY created_at ASC").all(projectId, itemId) as LinkRow[])
      : (db.prepare("SELECT * FROM plugin_code_link_links WHERE project_id = ? ORDER BY created_at ASC").all(projectId) as LinkRow[]);
    return rows.map(toLink);
  }

  linksForRepo(projectId: string, repoId: string): CodeLinkView[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_code_link_links WHERE project_id = ? AND repo_id = ? ORDER BY created_at ASC").all(projectId, repoId) as LinkRow[]).map(toLink);
  }

  link(projectId: string, id: string): CodeLinkView | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_code_link_links WHERE id = ?").get(id) as LinkRow | undefined;
    return row ? toLink(row) : null;
  }

  /** One row per (repo, branch, item). A field left undefined in the patch keeps what the row had. */
  upsertLink(projectId: string, key: { itemId: string; repoId: string; branch: string }, patch: LinkPatch): CodeLinkView {
    const db = this.db(projectId);
    const existing = db
      .prepare("SELECT * FROM plugin_code_link_links WHERE project_id = ? AND repo_id = ? AND branch = ? AND item_id = ?")
      .get(projectId, key.repoId, key.branch, key.itemId) as LinkRow | undefined;
    const now = Date.now();
    if (existing) {
      this.applyLinkPatch(db, existing.id, patch, now);
      return this.link(projectId, existing.id)!;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO plugin_code_link_links (id, project_id, item_id, repo_id, branch, head_sha, head_at, ahead, behind, merged_sha, pr_number, pr_url, pr_state, thread_id, source, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      projectId,
      key.itemId,
      key.repoId,
      key.branch,
      patch.headSha ?? null,
      patch.headAt ?? null,
      patch.ahead ?? 0,
      patch.behind ?? 0,
      patch.mergedSha ?? null,
      patch.prNumber ?? null,
      patch.prUrl ?? null,
      patch.prState ?? null,
      patch.threadId ?? null,
      patch.source ?? "scan",
      patch.lastSeenAt ?? null,
      now,
      now
    );
    return this.link(projectId, id)!;
  }

  patchLink(projectId: string, id: string, patch: LinkPatch): CodeLinkView {
    this.applyLinkPatch(this.db(projectId), id, patch, Date.now());
    return this.link(projectId, id)!;
  }

  private applyLinkPatch(db: ProjectDb, id: string, patch: LinkPatch, now: number): void {
    const columns: Record<keyof LinkPatch, string> = {
      headSha: "head_sha",
      headAt: "head_at",
      ahead: "ahead",
      behind: "behind",
      mergedSha: "merged_sha",
      prNumber: "pr_number",
      prUrl: "pr_url",
      prState: "pr_state",
      threadId: "thread_id",
      source: "source",
      lastSeenAt: "last_seen_at"
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(columns) as [keyof LinkPatch, string][]) {
      if (patch[field] === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(patch[field]);
    }
    sets.push("updated_at = ?");
    values.push(now, id);
    db.prepare(`UPDATE plugin_code_link_links SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  removeLink(projectId: string, id: string): void {
    this.db(projectId).prepare("DELETE FROM plugin_code_link_links WHERE id = ?").run(id);
  }

  // ── repositories ───────────────────────────────────────────────────────────

  repoStates(projectId: string): RepoStateView[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_code_link_repos WHERE project_id = ? ORDER BY repo_id ASC").all(projectId) as RepoRow[]).map(toRepo);
  }

  repoState(projectId: string, repoId: string): RepoStateView | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_code_link_repos WHERE repo_id = ?").get(repoId) as RepoRow | undefined;
    return row ? toRepo(row) : null;
  }

  upsertRepoState(projectId: string, repoId: string, patch: RepoStatePatch): RepoStateView {
    const existing = this.repoState(projectId, repoId);
    const now = Date.now();
    const next: RepoStateView = {
      repoId,
      projectId,
      readiness: patch.readiness ?? existing?.readiness ?? "unknown",
      remote: patch.remote ?? existing?.remote ?? "unknown",
      remoteDetail: patch.remoteDetail === undefined ? (existing?.remoteDetail ?? null) : patch.remoteDetail,
      remoteAt: patch.remoteAt === undefined ? (existing?.remoteAt ?? null) : patch.remoteAt,
      hasBrief: patch.hasBrief ?? existing?.hasBrief ?? false,
      manifests: patch.manifests ?? existing?.manifests ?? [],
      summary: patch.summary === undefined ? (existing?.summary ?? null) : patch.summary,
      scannedSha: patch.scannedSha === undefined ? (existing?.scannedSha ?? null) : patch.scannedSha,
      defaultSha: patch.defaultSha === undefined ? (existing?.defaultSha ?? null) : patch.defaultSha,
      branchTemplate: patch.branchTemplate ?? existing?.branchTemplate ?? DEFAULT_BRANCH_TEMPLATE,
      autoDone: patch.autoDone ?? existing?.autoDone ?? true,
      agentPush: patch.agentPush ?? existing?.agentPush ?? true,
      scannedAt: patch.scannedAt === undefined ? (existing?.scannedAt ?? null) : patch.scannedAt,
      updatedAt: now
    };
    this.db(projectId)
      .prepare(
        `INSERT INTO plugin_code_link_repos (repo_id, project_id, readiness, remote, remote_detail, remote_at, has_brief, manifests_json, summary, scanned_sha, default_sha, branch_template, auto_done, agent_push, scanned_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET
           readiness = excluded.readiness, remote = excluded.remote, remote_detail = excluded.remote_detail, remote_at = excluded.remote_at,
           has_brief = excluded.has_brief, manifests_json = excluded.manifests_json, summary = excluded.summary,
           scanned_sha = excluded.scanned_sha, default_sha = excluded.default_sha, branch_template = excluded.branch_template,
           auto_done = excluded.auto_done, agent_push = excluded.agent_push, scanned_at = excluded.scanned_at, updated_at = excluded.updated_at`
      )
      .run(
        repoId,
        projectId,
        next.readiness,
        next.remote,
        next.remoteDetail,
        next.remoteAt,
        next.hasBrief ? 1 : 0,
        JSON.stringify(next.manifests),
        next.summary,
        next.scannedSha,
        next.defaultSha,
        next.branchTemplate,
        next.autoDone ? 1 : 0,
        next.agentPush ? 1 : 0,
        next.scannedAt,
        now
      );
    return next;
  }

  // ── proposals ──────────────────────────────────────────────────────────────

  proposals(projectId: string, itemId?: string, state: ProposalState | "any" = "open"): ProposalView[] {
    const where = ["project_id = ?"];
    const args: unknown[] = [projectId];
    if (itemId) {
      where.push("item_id = ?");
      args.push(itemId);
    }
    if (state !== "any") {
      where.push("state = ?");
      args.push(state);
    }
    return (this.db(projectId).prepare(`SELECT * FROM plugin_code_link_proposals WHERE ${where.join(" AND ")} ORDER BY created_at ASC`).all(...args) as ProposalRow[]).map(toProposal);
  }

  proposal(projectId: string, id: string): ProposalView | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_code_link_proposals WHERE id = ?").get(id) as ProposalRow | undefined;
    return row ? toProposal(row) : null;
  }

  /**
   * Whether the same proposal is already standing, or was rejected against the
   * very same evidence — the second case is what keeps a "no" from being asked
   * again every scan until something actually changes.
   */
  hasRecentProposal(projectId: string, itemId: string, kind: ProposalKind, toStatus: ItemStatus | null, reason: string, evidenceSha: string | null): boolean {
    const row = this.db(projectId)
      .prepare(
        `SELECT 1 FROM plugin_code_link_proposals
         WHERE item_id = ? AND kind = ? AND to_status IS ? AND reason = ?
           AND (state = 'open' OR (state = 'rejected' AND evidence_sha IS ?))
         LIMIT 1`
      )
      .get(itemId, kind, toStatus, reason, evidenceSha);
    return !!row;
  }

  addProposal(projectId: string, input: { itemId: string; linkId: string | null; kind: ProposalKind; fromStatus: ItemStatus; toStatus: ItemStatus | null; reason: string; evidenceSha: string | null }): ProposalView {
    const id = randomUUID();
    this.db(projectId)
      .prepare(
        `INSERT INTO plugin_code_link_proposals (id, project_id, item_id, link_id, kind, from_status, to_status, reason, evidence_sha, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .run(id, projectId, input.itemId, input.linkId, input.kind, input.fromStatus, input.toStatus, input.reason, input.evidenceSha, Date.now());
    return this.proposal(projectId, id)!;
  }

  setProposalState(projectId: string, id: string, state: ProposalState): ProposalView {
    this.db(projectId).prepare("UPDATE plugin_code_link_proposals SET state = ?, resolved_at = ? WHERE id = ?").run(state, Date.now(), id);
    return this.proposal(projectId, id)!;
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  sessions(projectId: string, filter: { itemId?: string; live?: boolean } = {}): SessionView[] {
    const rows = (this.db(projectId).prepare("SELECT * FROM plugin_code_link_sessions WHERE project_id = ? ORDER BY started_at DESC").all(projectId) as SessionRow[]).map(toSession);
    return rows.filter((s) => (filter.itemId ? s.itemIds.includes(filter.itemId) : true) && (filter.live ? s.state !== "ended" : true));
  }

  session(projectId: string, id: string): SessionView | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_code_link_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  createSession(projectId: string, input: { id?: string; repoId: string; branch: string; itemIds: string[]; mode: SessionMode; agent: string; threadId: string | null; device: string; externalId?: string | null }): SessionView {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.db(projectId)
      .prepare(
        `INSERT INTO plugin_code_link_sessions (id, project_id, repo_id, branch, item_ids_json, mode, agent, external_id, thread_id, state, last_event_at, device, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`
      )
      .run(id, projectId, input.repoId, input.branch, JSON.stringify(input.itemIds), input.mode, input.agent, input.externalId ?? null, input.threadId, now, input.device, now);
    return this.session(projectId, id)!;
  }

  patchSession(projectId: string, id: string, patch: SessionPatch): SessionView {
    const columns: Record<keyof SessionPatch, string> = {
      branch: "branch",
      itemIds: "item_ids_json",
      externalId: "external_id",
      threadId: "thread_id",
      state: "state",
      lastEventAt: "last_event_at",
      lastToolAt: "last_tool_at",
      lastCommitAt: "last_commit_at",
      summary: "summary",
      activity: "activity",
      blocked: "blocked",
      endedAt: "ended_at"
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(columns) as [keyof SessionPatch, string][]) {
      const value = patch[field];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(field === "itemIds" ? JSON.stringify(value) : value);
    }
    if (!sets.length) return this.session(projectId, id)!;
    values.push(id);
    this.db(projectId).prepare(`UPDATE plugin_code_link_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.session(projectId, id)!;
  }
}
