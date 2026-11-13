import { randomUUID } from "node:crypto";
import type { Db, ProjectDb, Sqlite } from "@tomradex/db";
import { DeliveryStore } from "@tomradex/db";
import type { ItemStatus } from "@tomradex/domain";
import type { ChangeRun } from "./changes.js";
import { DEFAULT_BRANCH_TEMPLATE } from "./keys.js";
import type { ConnectAgent } from "./connect.js";
import type { PrState } from "./rules.js";
import { classifyRemoteFailure, type RemoteFailure } from "./remote.js";

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
  },
  {
    version: 5,
    up: (db: Sqlite) => {
      db.exec(`
CREATE TABLE plugin_code_link_deliveries (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  sequence      INTEGER NOT NULL,
  state         TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_plugin_code_link_deliveries_sequence ON plugin_code_link_deliveries(project_id, item_id, sequence);
CREATE UNIQUE INDEX idx_plugin_code_link_deliveries_active ON plugin_code_link_deliveries(project_id, item_id) WHERE state = 'active';
ALTER TABLE plugin_code_link_links ADD COLUMN delivery INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plugin_code_link_proposals ADD COLUMN delivery INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plugin_code_link_sessions ADD COLUMN delivery INTEGER NOT NULL DEFAULT 1;
`);
      db.exec(`
INSERT INTO plugin_code_link_deliveries (id, project_id, item_id, sequence, state, started_at, completed_at, updated_at)
SELECT l.item_id || ':delivery:1', l.project_id, l.item_id, 1,
       CASE
         WHEN i.status = 'cancelled' THEN 'cancelled'
         WHEN i.status = 'done' OR MAX(CASE WHEN l.merged_sha IS NOT NULL OR l.pr_state = 'merged' THEN 1 ELSE 0 END) = 1 THEN 'completed'
         ELSE 'active'
       END,
       MIN(l.created_at),
       CASE
         WHEN i.status IN ('done', 'cancelled') OR MAX(CASE WHEN l.merged_sha IS NOT NULL OR l.pr_state = 'merged' THEN 1 ELSE 0 END) = 1 THEN MAX(l.updated_at)
         ELSE NULL
       END,
       MAX(l.updated_at)
FROM plugin_code_link_links l
LEFT JOIN items i ON i.id = l.item_id
GROUP BY l.project_id, l.item_id;
DROP INDEX idx_plugin_code_link_links_key;
CREATE UNIQUE INDEX idx_plugin_code_link_links_key ON plugin_code_link_links(project_id, repo_id, branch, item_id, delivery);
`);
    }
  },
  { version: 6, up: "ALTER TABLE plugin_code_link_deliveries ADD COLUMN bases_json TEXT NOT NULL DEFAULT '{}'" },
  { version: 7, up: "ALTER TABLE plugin_code_link_repos ADD COLUMN agent_merge INTEGER NOT NULL DEFAULT 0" },
  // Where a parallel outside session works, so its hooks find it among the others with the same identity.
  { version: 8, up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN worktree TEXT" },
  // The agents a repository is connected for; NULL until someone chooses or connects.
  { version: 9, up: "ALTER TABLE plugin_code_link_repos ADD COLUMN connect_agents_json TEXT" },
  // The herdr pane a session runs in, as its hooks report it: where "open in terminal" finds it again.
  { version: 10, up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN herdr_pane TEXT" },
  // When this machine last heard each agent's hooks from a repository: its own health, never the project's data.
  {
    version: 11,
    up: `
CREATE TABLE plugin_code_link_hooks_heard (
  repo_id     TEXT NOT NULL,
  agent       TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  heard_at    INTEGER NOT NULL,
  PRIMARY KEY (repo_id, agent)
);
`
  },
  // The terminal app an outside session runs in (TERM_PROGRAM), as its hooks report it.
  { version: 12, up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN terminal TEXT" },
  // A conversation without a ticket stays findable: what it was called, where it ran, and whether anyone spoke to it.
  {
    version: 13,
    up: `
ALTER TABLE plugin_code_link_sessions ADD COLUMN title TEXT;
ALTER TABLE plugin_code_link_sessions ADD COLUMN cwd TEXT;
ALTER TABLE plugin_code_link_sessions ADD COLUMN transcript TEXT;
ALTER TABLE plugin_code_link_sessions ADD COLUMN prompted INTEGER NOT NULL DEFAULT 0;
`
  },
  // The tickets a session worked before it moved on to the one it holds, so each keeps the conversation that did it.
  { version: 14, up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN worked_json TEXT NOT NULL DEFAULT '[]'" },
  // Who merges a delivered ticket (the person, Tomrade after asking, or the agent itself), and which conversation asked for a session's start.
  {
    version: 15,
    up: `
ALTER TABLE plugin_code_link_repos ADD COLUMN merge_policy TEXT;
ALTER TABLE plugin_code_link_sessions ADD COLUMN requested_by TEXT;
`
  },
  // The person said in the conversation to merge once done: Tomrade merges the delivery without asking again.
  { version: 16, up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0" },
  // The person's word that an outside session changes code without a ticket (work_without_ticket), in their words.
  { version: 17, up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN without_ticket TEXT" },
  // When a ticket session's conversation was last saved on this machine, and whether only its end fit.
  {
    version: 18,
    up: `
ALTER TABLE plugin_code_link_sessions ADD COLUMN record_saved_at INTEGER;
ALTER TABLE plugin_code_link_sessions ADD COLUMN record_cut INTEGER NOT NULL DEFAULT 0;
`
  },
  // What a look back on a session says first: how often it turned to the person, and when it took each ticket on.
  {
    version: 19,
    up: `
ALTER TABLE plugin_code_link_sessions ADD COLUMN asked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plugin_code_link_sessions ADD COLUMN marks_json TEXT NOT NULL DEFAULT '[]';
`
  },
  // What a session waits on the person for, as a structure each window words in its own language.
  { version: 20, up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN ask_json TEXT" },
  // The tool whose call just failed, for each window to word in its own language.
  { version: 21, up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN failed_tool TEXT" },
  // What this machine saw of a repository stays on it: travelling, two machines that saw differently rewrote each
  // other's on every scan. The row that travels keeps what people chose and what the repository holds.
  {
    version: 22,
    up: `
CREATE TABLE plugin_code_link_repo_seen (
  repo_id        TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  remote         TEXT NOT NULL DEFAULT 'unknown',
  remote_detail  TEXT,
  remote_at      INTEGER,
  scanned_sha    TEXT,
  default_sha    TEXT,
  scanned_at     INTEGER,
  seen_at        INTEGER NOT NULL
);
INSERT INTO plugin_code_link_repo_seen (repo_id, project_id, remote, remote_detail, remote_at, scanned_sha, default_sha, scanned_at, seen_at)
  SELECT repo_id, project_id, remote, remote_detail, remote_at, scanned_sha, default_sha, scanned_at, updated_at FROM plugin_code_link_repos;
UPDATE plugin_code_link_repos SET remote = 'unknown', remote_detail = NULL, remote_at = NULL, scanned_sha = NULL, default_sha = NULL, scanned_at = NULL;
`
  },
  // What a person last reviewed of a code link: a commit in this machine's repository, so it stays on this machine.
  {
    version: 23,
    up: `
CREATE TABLE plugin_code_link_reviewed (
  link_id    TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sha        TEXT NOT NULL,
  at         INTEGER NOT NULL
);
`
  },
  // An agent's runs in a code link's folder: commits in this machine's repository, so they stay on this machine.
  {
    version: 24,
    up: `
CREATE TABLE plugin_code_link_runs (
  link_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source     TEXT NOT NULL,
  root       TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  before_sha TEXT,
  after_sha  TEXT,
  left_out   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (link_id, id)
);
`
  },
  // The project's role a session works as, when its Start named one.
  { version: 25, up: "ALTER TABLE plugin_code_link_sessions ADD COLUMN role TEXT" }
];

/** Durable code links travel with the project; running sessions belong to this machine. */
export const TABLES = {
  plugin_code_link_links: { project: "project_id", export: { order: "id" } },
  plugin_code_link_deliveries: { project: "project_id", export: false },
  plugin_code_link_repos: { project: "project_id", export: { order: "repo_id" } },
  plugin_code_link_proposals: { project: "project_id", export: { order: "id" } },
  plugin_code_link_sessions: { project: "project_id", export: false },
  plugin_code_link_hooks_heard: { project: "project_id", export: false },
  plugin_code_link_repo_seen: { project: "project_id", export: false },
  plugin_code_link_reviewed: { project: "project_id", export: false },
  plugin_code_link_runs: { project: "project_id", export: false }
} as const;

export type LinkSource = "start" | "scan" | "mcp" | "manual";

/** One trace of a ticket's code in one repository: a branch, its pull request, whether it landed. */
export interface CodeLinkView {
  id: string;
  projectId: string;
  itemId: string;
  repoId: string;
  /** One-based delivery number within the ticket. */
  delivery: number;
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

export type { DeliveryState, DeliveryView } from "@tomradex/db";
import type { DeliveryState, DeliveryView } from "@tomradex/db";

/** A stop only the person can clear: origin's credentials, or a pull request the agent was not let merge. */
export type SessionBlock = "credentials" | "merge";

/** Who merges a ticket's delivered branch: Tomrade once the person says yes in the conversation (the default), the person alone, or the agent itself. */
export type MergePolicy = "human" | "ask" | "agent";

export type Readiness = "unknown" | "empty" | "scaffolded";
/** `none`: the checkout has no origin, so nothing is fetched or pushed. */
export type RemoteState = "ok" | "unreachable" | "unknown" | "none";

export interface RepoStateView {
  repoId: string;
  projectId: string;
  readiness: Readiness;
  remote: RemoteState;
  remoteDetail: string | null;
  /** Why origin is unreachable, read from the detail; null while it is not. */
  remoteCause: RemoteFailure | null;
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
  mergePolicy: MergePolicy;
  /** `mergePolicy === "agent"`: agents merge their own pull requests once checks pass. */
  agentMerge: boolean;
  /** The coding agents Connect writes for and "connected" is judged by; null until chosen. */
  connectAgents: ConnectAgent[] | null;
  scannedAt: number | null;
  updatedAt: number;
}

export type ProposalKind = "propose" | "flag";
export type ProposalState = "open" | "accepted" | "rejected" | "stale";

export interface ProposalView {
  id: string;
  projectId: string;
  itemId: string;
  delivery: number;
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

/** A session taking a ticket on, at that moment. */
export interface SessionMark {
  itemId: string;
  at: number;
}

/** Where one page of ended sessions stops: the last row's end and id, so the next page follows it exactly. */
export interface SessionCursor {
  at: number;
  id: string;
}
/**
 * What a waiting session asks the person: a tool's permission — to run a command, to change a file, to use another
 * tool — or a question. `detail` is the command, the file or the question, clipped; null when its hooks did not say.
 */
export interface SessionAsk {
  kind: "permission" | "question";
  tool: string | null;
  action: "run" | "edit" | "use" | null;
  detail: string | null;
  /** A question's choices, top to bottom as its menu lists them: only for one question that takes one of them. */
  options?: string[];
}

/** `error`: the agent stopped on its own account (rate limit, auth) and is not working; the process may still be there. */
export type SessionState = "running" | "waiting" | "idle" | "error" | "ended" | "lost";

export interface SessionView {
  id: string;
  projectId: string;
  repoId: string;
  delivery: number;
  branch: string;
  itemIds: string[];
  /** Tickets it worked before moving on to the ones it holds, each with the delivery it worked. History only: nothing judges by it. */
  worked: { itemId: string; delivery: number }[];
  /** When it took each ticket on, in order: where a look back on its conversation cuts it by ticket. */
  marks: SessionMark[];
  /** How many times it turned to the person: a permission, a question. */
  asked: number;
  mode: SessionMode;
  agent: string;
  externalId: string | null;
  threadId: string | null;
  /** The worktree or folder an outside session said it works in (claim_ticket's worktree); null when it did not say. */
  worktree: string | null;
  /** The herdr pane (`w1:p1`) the session's hooks report from; null outside herdr. */
  herdrPane: string | null;
  /** The terminal app its hooks run in, as `TERM_PROGRAM` names it (iTerm.app, Apple_Terminal, vscode…); null when unsaid. */
  terminal: string | null;
  /** What the conversation is called: the agent's own title, its pane's, or the first thing it was asked. */
  title: string | null;
  /** The folder the agent runs in, as its hooks say. */
  cwd: string | null;
  /** The agent's own record of the conversation, where its hooks name one. */
  transcript: string | null;
  /** Someone has said something to it. */
  prompted: boolean;
  /** The person said this session changes code without a ticket (their words); null until they do, and once it claims one. */
  withoutTicket: string | null;
  /** When its conversation was last saved on this machine (a ticket's, once it ended); null when it was not. */
  recordSavedAt: number | null;
  /** Only the end of its conversation fit in what was saved. */
  recordCut: boolean;
  state: SessionState;
  lastEventAt: number | null;
  lastToolAt: number | null;
  lastCommitAt: number | null;
  /** The agent's own one-liner about where it is (note_progress, or what it said when it last stopped). */
  summary: string | null;
  /** What it is doing this moment, from its last hook; null between tools, and while it asks. */
  activity: string | null;
  /** The tool whose call just failed, while that is the last word of what it does ("" when the hook named none); null otherwise. */
  failedTool: string | null;
  /** What it waits on the person for, while it does; null otherwise. */
  ask: SessionAsk | null;
  blocked: SessionBlock | null;
  /** The conversation (thread) that asked Tomrade to start this session, when one did: where its delivery is reported back. */
  requestedBy: string | null;
  /** The person said, when asking for the work, to merge it once delivered. */
  autoMerge: boolean;
  /** The project's role it works as (a role's id), when its Start went by one. */
  role: string | null;
  device: string;
  startedAt: number;
  endedAt: number | null;
}

interface LinkRow {
  id: string;
  project_id: string;
  item_id: string;
  repo_id: string;
  delivery: number;
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
  agent_merge: number;
  merge_policy: string | null;
  connect_agents_json: string | null;
  scanned_at: number | null;
  updated_at: number;
}

/** This machine's own look at a repository. */
interface SeenRow {
  repo_id: string;
  remote: string;
  remote_detail: string | null;
  remote_at: number | null;
  scanned_sha: string | null;
  default_sha: string | null;
  scanned_at: number | null;
}

interface ProposalRow {
  id: string;
  project_id: string;
  item_id: string;
  delivery: number;
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
  delivery: number;
  branch: string;
  item_ids_json: string;
  worked_json: string | null;
  marks_json: string | null;
  ask_json: string | null;
  failed_tool: string | null;
  asked: number | null;
  mode: string;
  agent: string;
  external_id: string | null;
  thread_id: string | null;
  worktree: string | null;
  herdr_pane: string | null;
  terminal: string | null;
  title: string | null;
  cwd: string | null;
  transcript: string | null;
  prompted: number | null;
  without_ticket: string | null;
  record_saved_at: number | null;
  record_cut: number | null;
  state: string;
  last_event_at: number | null;
  last_tool_at: number | null;
  last_commit_at: number | null;
  summary: string | null;
  activity: string | null;
  blocked: string | null;
  requested_by: string | null;
  auto_merge: number | null;
  role: string | null;
  device: string;
  started_at: number;
  ended_at: number | null;
}

const toLink = (r: LinkRow): CodeLinkView => ({
  id: r.id,
  projectId: r.project_id,
  itemId: r.item_id,
  repoId: r.repo_id,
  delivery: r.delivery,
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

/** The row that travels, with this machine's look laid over it; a machine that has not looked yet has seen nothing. */
const toRepo = (r: RepoRow, seen: SeenRow | undefined): RepoStateView => ({
  repoId: r.repo_id,
  projectId: r.project_id,
  readiness: r.readiness as Readiness,
  remote: (seen?.remote ?? "unknown") as RemoteState,
  remoteDetail: seen?.remote_detail ?? null,
  remoteCause: seen?.remote === "unreachable" ? classifyRemoteFailure(seen.remote_detail ?? "") : null,
  remoteAt: seen?.remote_at ?? null,
  hasBrief: r.has_brief === 1,
  manifests: JSON.parse(r.manifests_json) as string[],
  summary: r.summary,
  scannedSha: seen?.scanned_sha ?? null,
  defaultSha: seen?.default_sha ?? null,
  branchTemplate: r.branch_template,
  autoDone: r.auto_done === 1,
  agentPush: r.agent_push === 1,
  mergePolicy: mergePolicyOf(r),
  agentMerge: mergePolicyOf(r) === "agent",
  connectAgents: r.connect_agents_json ? (JSON.parse(r.connect_agents_json) as ConnectAgent[]) : null,
  scannedAt: seen?.scanned_at ?? null,
  updatedAt: r.updated_at
});

const toProposal = (r: ProposalRow): ProposalView => ({
  id: r.id,
  projectId: r.project_id,
  itemId: r.item_id,
  delivery: r.delivery,
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

/**
 * A timestamp that only says a scan looked again (a link's last sighting, a repository's last scan or reach) is
 * refreshed this rarely when nothing else changed: the rows travel in the project's folder, and every write is a commit.
 */
export const BOOKKEEPING_REFRESH_MS = 24 * 60 * 60 * 1000;

const bookkeepingStale = (was: number | null, now: number | null): boolean =>
  was !== now && (was === null || now === null || now < was || now - was >= BOOKKEEPING_REFRESH_MS);

/** What travels of a repository's state: what people chose for it and what it holds. */
const sharedOf = ({ remote, remoteDetail, remoteCause, remoteAt, scannedSha, defaultSha, scannedAt, updatedAt, ...shared }: RepoStateView) => JSON.stringify(shared);

/** Whether this machine's look says nothing its stored one does not, its look-again timestamps aside. */
function sameSeen(was: RepoStateView, next: RepoStateView): boolean {
  const looked = (v: RepoStateView) => JSON.stringify([v.remote, v.remoteDetail, v.scannedSha, v.defaultSha]);
  return looked(was) === looked(next) && !bookkeepingStale(was.remoteAt, next.remoteAt) && !bookkeepingStale(was.scannedAt, next.scannedAt);
}

const MERGE_POLICIES: ReadonlySet<string> = new Set<MergePolicy>(["human", "ask", "agent"]);
/** A row from before the policy column answers through its switch: on is the agent's, off is asking, the default. */
const mergePolicyOf = (r: Pick<RepoRow, "merge_policy" | "agent_merge">): MergePolicy =>
  r.merge_policy && MERGE_POLICIES.has(r.merge_policy) ? (r.merge_policy as MergePolicy) : r.agent_merge === 1 ? "agent" : "ask";

const toSession = (r: SessionRow): SessionView => ({
  id: r.id,
  projectId: r.project_id,
  repoId: r.repo_id,
  delivery: r.delivery,
  branch: r.branch,
  itemIds: JSON.parse(r.item_ids_json) as string[],
  worked: r.worked_json ? (JSON.parse(r.worked_json) as SessionView["worked"]) : [],
  marks: r.marks_json ? (JSON.parse(r.marks_json) as SessionMark[]) : [],
  asked: r.asked ?? 0,
  mode: r.mode as SessionMode,
  agent: r.agent,
  externalId: r.external_id,
  threadId: r.thread_id,
  worktree: r.worktree ?? null,
  herdrPane: r.herdr_pane ?? null,
  terminal: r.terminal ?? null,
  title: r.title ?? null,
  cwd: r.cwd ?? null,
  transcript: r.transcript ?? null,
  prompted: !!r.prompted,
  withoutTicket: r.without_ticket ?? null,
  recordSavedAt: r.record_saved_at ?? null,
  recordCut: r.record_cut === 1,
  state: r.state as SessionState,
  lastEventAt: r.last_event_at,
  lastToolAt: r.last_tool_at,
  lastCommitAt: r.last_commit_at,
  summary: r.summary,
  activity: r.activity ?? null,
  failedTool: r.failed_tool ?? null,
  ask: r.ask_json ? (JSON.parse(r.ask_json) as SessionAsk) : null,
  blocked: (r.blocked as SessionBlock | null) ?? null,
  requestedBy: r.requested_by ?? null,
  autoMerge: r.auto_merge === 1,
  role: r.role ?? null,
  device: r.device,
  startedAt: r.started_at,
  endedAt: r.ended_at
});

/** What `sessions` narrows to; `threadId: null` asks for sessions on no thread. */
export interface SessionFilter {
  itemId?: string;
  delivery?: number;
  live?: boolean;
  threadId?: string | null;
  externalId?: string;
  /** These sessions only; an empty list matches none. */
  ids?: string[];
  /** Sessions that ran in one of these panes. */
  panes?: string[];
  /** Ended (or lost) sessions whose end — else their last word, else their start — is at or after this time. */
  endedSince?: number;
}

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
  mergePolicy?: MergePolicy;
  /** The old switch: on is the agent policy, off the person's. `mergePolicy` wins when both are given. */
  agentMerge?: boolean;
  connectAgents?: ConnectAgent[] | null;
  scannedAt?: number | null;
}

export interface SessionPatch {
  delivery?: number;
  branch?: string;
  itemIds?: string[];
  worked?: SessionView["worked"];
  marks?: SessionMark[];
  asked?: number;
  externalId?: string | null;
  threadId?: string | null;
  worktree?: string | null;
  herdrPane?: string | null;
  terminal?: string | null;
  title?: string | null;
  cwd?: string | null;
  transcript?: string | null;
  prompted?: boolean;
  withoutTicket?: string | null;
  recordSavedAt?: number | null;
  recordCut?: boolean;
  state?: SessionState;
  lastEventAt?: number | null;
  lastToolAt?: number | null;
  lastCommitAt?: number | null;
  summary?: string | null;
  activity?: string | null;
  failedTool?: string | null;
  ask?: SessionAsk | null;
  blocked?: SessionBlock | null;
  requestedBy?: string | null;
  autoMerge?: boolean;
  role?: string | null;
  endedAt?: number | null;
}

/** A pull request this machine saw open, or a branch it saw merged, for the activation funnel. */
export type PullStep = "open_pr" | "merge";

/** Rows live in their project's file, so every read and write names the project first. */
export class CodeLinkStore {
  constructor(
    private readonly pool: Db,
    private readonly onPull?: (step: PullStep) => void
  ) {}

  private db(projectId: string): ProjectDb {
    return this.pool.for(projectId);
  }

  // ── deliveries ─────────────────────────────────────────────────────────────

  deliveries(projectId: string, itemId?: string): DeliveryView[] {
    return new DeliveryStore(this.pool).list(projectId, itemId);
  }

  activeDelivery(projectId: string, itemId: string): DeliveryView | null {
    return new DeliveryStore(this.pool).active(projectId, itemId);
  }

  currentDelivery(projectId: string, itemId: string): DeliveryView | null {
    return this.activeDelivery(projectId, itemId) ?? this.deliveries(projectId, itemId).at(-1) ?? null;
  }

  /** `currentDelivery` of every ticket that has one, in one read: for a pass over a whole board. */
  currentDeliveries(projectId: string): Map<string, DeliveryView> {
    const out = new Map<string, DeliveryView>();
    // Listed by ticket, then sequence: the last one stands unless an active one came before it.
    for (const d of this.deliveries(projectId)) if (out.get(d.itemId)?.state !== "active") out.set(d.itemId, d);
    return out;
  }

  ensureActiveDelivery(projectId: string, itemId: string, at = Date.now()): DeliveryView {
    return new DeliveryStore(this.pool).ensure(projectId, itemId, at, Object.fromEntries(this.repoStates(projectId).map(repo => [repo.repoId, repo.defaultSha])));
  }

  finishActiveDelivery(projectId: string, itemId: string, state: Exclude<DeliveryState, "active">, at = Date.now()): DeliveryView | null {
    return new DeliveryStore(this.pool).finish(projectId, itemId, state, at);
  }

  /** Restore delivery rows when an older exported artifact carried only links. */
  repairLegacyDeliveries(projectId: string): void {
    this.db(projectId).exec(`INSERT OR IGNORE INTO deliveries (id, project_id, item_id, sequence, state, started_at, completed_at, updated_at, bases_json)
      SELECT id, project_id, item_id, sequence, state, started_at, completed_at, updated_at, bases_json FROM plugin_code_link_deliveries
      WHERE item_id IN (SELECT id FROM items)`);
    const rows = this.db(projectId)
      .prepare(
        `SELECT DISTINCT l.item_id, l.delivery
         FROM plugin_code_link_links l
         LEFT JOIN deliveries d
           ON d.project_id = l.project_id AND d.item_id = l.item_id AND d.sequence = l.delivery
         WHERE l.project_id = ? AND d.id IS NULL AND l.item_id IN (SELECT id FROM items)`
      )
      .all(projectId) as { item_id: string; delivery: number }[];
    for (const { item_id: itemId, delivery } of rows) {
      const aggregate = this.db(projectId)
        .prepare(
          `SELECT MIN(l.created_at) AS started_at, MAX(l.updated_at) AS updated_at,
                  MAX(CASE WHEN l.merged_sha IS NOT NULL OR l.pr_state = 'merged' THEN 1 ELSE 0 END) AS merged,
                  i.status AS status
           FROM plugin_code_link_links l LEFT JOIN items i ON i.id = l.item_id
           WHERE l.project_id = ? AND l.item_id = ? AND l.delivery = ?`
        )
        .get(projectId, itemId, delivery) as { started_at: number; updated_at: number; merged: number; status: ItemStatus | null };
      const state: DeliveryState = aggregate.status === "cancelled" ? "cancelled" : aggregate.status === "done" || aggregate.merged || this.activeDelivery(projectId, itemId) ? "completed" : "active";
      const id = `${itemId}:delivery:${delivery}`;
      this.db(projectId)
        .prepare("INSERT OR IGNORE INTO deliveries (id, project_id, item_id, sequence, state, started_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, projectId, itemId, delivery, state, aggregate.started_at, state === "active" ? null : aggregate.updated_at, aggregate.updated_at);
    }
    const items = this.db(projectId).prepare("SELECT id, status, updated_at FROM items WHERE project_id = ?").all(projectId) as { id: string; status: ItemStatus; updated_at: number }[];
    for (const item of items) {
      const current = this.currentDelivery(projectId, item.id);
      if (!current) continue;
      if (item.status !== "done" && item.status !== "cancelled" && current.state !== "active") this.ensureActiveDelivery(projectId, item.id, item.updated_at);
      if (item.status === "cancelled") this.finishActiveDelivery(projectId, item.id, "cancelled", item.updated_at);
    }
  }

  // ── links ──────────────────────────────────────────────────────────────────

  links(projectId: string, itemId?: string): CodeLinkView[] {
    const db = this.db(projectId);
    const rows = itemId
      ? (db.prepare("SELECT * FROM plugin_code_link_links WHERE project_id = ? AND item_id = ? ORDER BY delivery ASC, created_at ASC").all(projectId, itemId) as LinkRow[])
      : (db.prepare("SELECT * FROM plugin_code_link_links WHERE project_id = ? ORDER BY item_id, delivery ASC, created_at ASC").all(projectId) as LinkRow[]);
    return rows.map(toLink);
  }

  /** Links with a pull request not known to have ended, said in the query: most of the table settled long ago. */
  openPulls(projectId: string): CodeLinkView[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_code_link_links WHERE project_id = ? AND merged_sha IS NULL AND (pr_state IS NULL OR pr_state = 'open') AND (pr_url IS NOT NULL OR pr_number IS NOT NULL)").all(projectId) as LinkRow[]).map(toLink);
  }

  linksForRepo(projectId: string, repoId: string): CodeLinkView[] {
    return (this.db(projectId).prepare("SELECT * FROM plugin_code_link_links WHERE project_id = ? AND repo_id = ? ORDER BY delivery ASC, created_at ASC").all(projectId, repoId) as LinkRow[]).map(toLink);
  }

  link(projectId: string, id: string): CodeLinkView | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_code_link_links WHERE id = ?").get(id) as LinkRow | undefined;
    return row ? toLink(row) : null;
  }

  /** One row per (repo, branch, item). A field left undefined in the patch keeps what the row had. */
  upsertLink(projectId: string, key: { itemId: string; repoId: string; branch: string; delivery?: number }, patch: LinkPatch): CodeLinkView {
    const db = this.db(projectId);
    const delivery = key.delivery ?? this.ensureActiveDelivery(projectId, key.itemId).sequence;
    const existing = db
      .prepare("SELECT * FROM plugin_code_link_links WHERE project_id = ? AND repo_id = ? AND branch = ? AND item_id = ? AND delivery = ?")
      .get(projectId, key.repoId, key.branch, key.itemId, delivery) as LinkRow | undefined;
    const now = Date.now();
    if (existing) {
      this.applyLinkPatch(db, existing.id, patch, now);
      return this.link(projectId, existing.id)!;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO plugin_code_link_links (id, project_id, item_id, repo_id, delivery, branch, head_sha, head_at, ahead, behind, merged_sha, pr_number, pr_url, pr_state, thread_id, source, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      projectId,
      key.itemId,
      key.repoId,
      delivery,
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
    if (patch.prState === "open") this.onPull?.("open_pr");
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
    const current = db.prepare("SELECT * FROM plugin_code_link_links WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!current) return;
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(columns) as [keyof LinkPatch, string][]) {
      if (patch[field] === undefined || field === "lastSeenAt") continue;
      if ((current[column] ?? null) === patch[field]) continue;
      sets.push(`${column} = ?`);
      values.push(patch[field]);
    }
    const changed = sets.length > 0;
    const seen = patch.lastSeenAt;
    // Seen again with nothing else new: the row stays as it was, so the project's files do not change with it.
    if (seen !== undefined && (changed || bookkeepingStale((current.last_seen_at as number | null) ?? null, seen))) {
      sets.push("last_seen_at = ?");
      values.push(seen);
    }
    if (changed) {
      sets.push("updated_at = ?");
      values.push(now);
    }
    if (!sets.length) return;
    values.push(id);
    db.prepare(`UPDATE plugin_code_link_links SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    this.notePull(current, patch);
  }

  // Only a change this machine writes counts (rows synced from another device never pass here), and a merge only
  // once the link was seen unmerged first (an open pull request or a scanned head), so linking an old merged one does not.
  private notePull(before: Record<string, unknown>, patch: LinkPatch): void {
    if (!this.onPull) return;
    const prBefore = (before.pr_state as PrState | null) ?? null;
    if (patch.prState === "open" && prBefore === null) this.onPull("open_pr");
    const mergedBefore = before.merged_sha != null || prBefore === "merged";
    const mergedNow = !!patch.mergedSha || patch.prState === "merged";
    if (!mergedBefore && mergedNow && (prBefore === "open" || before.head_sha != null)) this.onPull("merge");
  }

  removeLink(projectId: string, id: string): void {
    this.db(projectId).prepare("DELETE FROM plugin_code_link_links WHERE id = ?").run(id);
    this.db(projectId).prepare("DELETE FROM plugin_code_link_reviewed WHERE link_id = ?").run(id);
  }

  /** What a person last reviewed of a code link on this machine; null before the first review. */
  reviewed(projectId: string, linkId: string): { sha: string; at: number } | null {
    return (this.db(projectId).prepare("SELECT sha, at FROM plugin_code_link_reviewed WHERE link_id = ?").get(linkId) as { sha: string; at: number } | undefined) ?? null;
  }

  setReviewed(projectId: string, linkId: string, sha: string, at: number): void {
    this.db(projectId)
      .prepare("INSERT INTO plugin_code_link_reviewed (link_id, project_id, sha, at) VALUES (?, ?, ?, ?) ON CONFLICT(link_id) DO UPDATE SET sha = excluded.sha, at = excluded.at")
      .run(linkId, projectId, sha, at);
  }

  /** A code link's runs on this machine, newest first. */
  changeRuns(projectId: string, linkId: string): ChangeRun[] {
    return this.db(projectId)
      .prepare("SELECT id, source, started_at AS startedAt, ended_at AS endedAt, before_sha AS before, after_sha AS after FROM plugin_code_link_runs WHERE link_id = ? ORDER BY started_at DESC, rowid DESC")
      .all(linkId) as ChangeRun[];
  }

  /** A run begins in a code link's folder, with what the commit kept of it leaves out (`left`); begun there already, it stays as it was. */
  startChangeRun(projectId: string, linkId: string, run: Pick<ChangeRun, "id" | "source" | "startedAt" | "before">, root: string, left: string): void {
    this.db(projectId)
      .prepare("INSERT OR IGNORE INTO plugin_code_link_runs (link_id, id, project_id, source, root, started_at, before_sha, left_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(linkId, run.id, projectId, run.source, root, run.startedAt, run.before, left);
  }

  /** Where a run is not over: each code link it began in, with the folder and what was kept of it then. */
  openChangeRuns(projectId: string, id: string): { linkId: string; root: string; before: string | null; leftOut: string }[] {
    return this.db(projectId).prepare("SELECT link_id AS linkId, root, before_sha AS before, left_out AS leftOut FROM plugin_code_link_runs WHERE id = ? AND ended_at IS NULL").all(id) as { linkId: string; root: string; before: string | null; leftOut: string }[];
  }

  endChangeRun(projectId: string, linkId: string, id: string, after: string | null, at: number): void {
    this.db(projectId).prepare("UPDATE plugin_code_link_runs SET after_sha = ?, ended_at = ? WHERE link_id = ? AND id = ? AND ended_at IS NULL").run(after, at, linkId, id);
  }

  dropChangeRun(projectId: string, linkId: string, id: string): void {
    this.db(projectId).prepare("DELETE FROM plugin_code_link_runs WHERE link_id = ? AND id = ?").run(linkId, id);
  }

  // ── repositories ───────────────────────────────────────────────────────────

  repoStates(projectId: string): RepoStateView[] {
    const db = this.db(projectId);
    const seen = new Map((db.prepare("SELECT * FROM plugin_code_link_repo_seen WHERE project_id = ?").all(projectId) as SeenRow[]).map((r) => [r.repo_id, r]));
    return (db.prepare("SELECT * FROM plugin_code_link_repos WHERE project_id = ? ORDER BY repo_id ASC").all(projectId) as RepoRow[]).map((r) => toRepo(r, seen.get(r.repo_id)));
  }

  repoState(projectId: string, repoId: string): RepoStateView | null {
    const db = this.db(projectId);
    const row = db.prepare("SELECT * FROM plugin_code_link_repos WHERE repo_id = ?").get(repoId) as RepoRow | undefined;
    return row ? toRepo(row, db.prepare("SELECT * FROM plugin_code_link_repo_seen WHERE repo_id = ?").get(repoId) as SeenRow | undefined) : null;
  }

  upsertRepoState(projectId: string, repoId: string, patch: RepoStatePatch): RepoStateView {
    const existing = this.repoState(projectId, repoId);
    const now = Date.now();
    const remote = patch.remote ?? existing?.remote ?? "unknown";
    const remoteDetail = patch.remoteDetail === undefined ? (existing?.remoteDetail ?? null) : patch.remoteDetail;
    const mergePolicy: MergePolicy = patch.mergePolicy ?? (patch.agentMerge === undefined ? (existing?.mergePolicy ?? "ask") : patch.agentMerge ? "agent" : "ask");
    const next: RepoStateView = {
      repoId,
      projectId,
      readiness: patch.readiness ?? existing?.readiness ?? "unknown",
      remote,
      remoteDetail,
      remoteCause: remote === "unreachable" ? classifyRemoteFailure(remoteDetail ?? "") : null,
      remoteAt: patch.remoteAt === undefined ? (existing?.remoteAt ?? null) : patch.remoteAt,
      hasBrief: patch.hasBrief ?? existing?.hasBrief ?? false,
      manifests: patch.manifests ?? existing?.manifests ?? [],
      summary: patch.summary === undefined ? (existing?.summary ?? null) : patch.summary,
      scannedSha: patch.scannedSha === undefined ? (existing?.scannedSha ?? null) : patch.scannedSha,
      defaultSha: patch.defaultSha === undefined ? (existing?.defaultSha ?? null) : patch.defaultSha,
      branchTemplate: patch.branchTemplate ?? existing?.branchTemplate ?? DEFAULT_BRANCH_TEMPLATE,
      autoDone: patch.autoDone ?? existing?.autoDone ?? true,
      agentPush: patch.agentPush ?? existing?.agentPush ?? true,
      mergePolicy,
      agentMerge: mergePolicy === "agent",
      connectAgents: patch.connectAgents === undefined ? (existing?.connectAgents ?? null) : patch.connectAgents,
      scannedAt: patch.scannedAt === undefined ? (existing?.scannedAt ?? null) : patch.scannedAt,
      updatedAt: now
    };
    const shared = !existing || sharedOf(existing) !== sharedOf(next);
    const seen = !existing || !sameSeen(existing, next);
    if (!shared && !seen) return existing!;
    const db = this.db(projectId);
    if (shared) {
      // The row that travels carries none of this machine's look: those columns stay as the migration left them.
      db.prepare(
        `INSERT INTO plugin_code_link_repos (repo_id, project_id, readiness, has_brief, manifests_json, summary, branch_template, auto_done, agent_push, agent_merge, merge_policy, connect_agents_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET
           readiness = excluded.readiness, has_brief = excluded.has_brief, manifests_json = excluded.manifests_json, summary = excluded.summary,
           branch_template = excluded.branch_template, auto_done = excluded.auto_done, agent_push = excluded.agent_push, agent_merge = excluded.agent_merge,
           merge_policy = excluded.merge_policy, connect_agents_json = excluded.connect_agents_json, updated_at = excluded.updated_at`
      ).run(
        repoId,
        projectId,
        next.readiness,
        next.hasBrief ? 1 : 0,
        JSON.stringify(next.manifests),
        next.summary,
        next.branchTemplate,
        next.autoDone ? 1 : 0,
        next.agentPush ? 1 : 0,
        next.agentMerge ? 1 : 0,
        next.mergePolicy,
        next.connectAgents ? JSON.stringify(next.connectAgents) : null,
        now
      );
    }
    if (seen) {
      db.prepare(
        `INSERT INTO plugin_code_link_repo_seen (repo_id, project_id, remote, remote_detail, remote_at, scanned_sha, default_sha, scanned_at, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET
           remote = excluded.remote, remote_detail = excluded.remote_detail, remote_at = excluded.remote_at, scanned_sha = excluded.scanned_sha,
           default_sha = excluded.default_sha, scanned_at = excluded.scanned_at, seen_at = excluded.seen_at`
      ).run(repoId, projectId, next.remote, next.remoteDetail, next.remoteAt, next.scannedSha, next.defaultSha, next.scannedAt, now);
    }
    return { ...next, updatedAt: shared ? now : existing!.updatedAt };
  }

  /** Each agent's last hook event from this repository on this machine, by agent id. */
  hooksHeard(projectId: string, repoId: string): Record<string, number> {
    const rows = this.db(projectId).prepare("SELECT agent, heard_at FROM plugin_code_link_hooks_heard WHERE repo_id = ?").all(repoId) as { agent: string; heard_at: number }[];
    return Object.fromEntries(rows.map((r) => [r.agent, r.heard_at]));
  }

  noteHookHeard(projectId: string, repoId: string, agent: string, at: number): void {
    this.db(projectId)
      .prepare("INSERT INTO plugin_code_link_hooks_heard (repo_id, agent, project_id, heard_at) VALUES (?, ?, ?, ?) ON CONFLICT(repo_id, agent) DO UPDATE SET heard_at = excluded.heard_at")
      .run(repoId, agent, projectId, at);
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

  proposalsForDelivery(projectId: string, itemId: string, delivery: number, state: ProposalState | "any" = "open"): ProposalView[] {
    return this.proposals(projectId, itemId, state).filter((proposal) => proposal.delivery === delivery);
  }

  /**
   * Whether the same proposal is already standing, or was rejected against the
   * very same evidence — the second case is what keeps a "no" from being asked
   * again every scan until something actually changes.
   */
  hasRecentProposal(projectId: string, itemId: string, delivery: number, kind: ProposalKind, toStatus: ItemStatus | null, reason: string, evidenceSha: string | null): boolean {
    const row = this.db(projectId)
      .prepare(
        `SELECT 1 FROM plugin_code_link_proposals
         WHERE item_id = ? AND delivery = ? AND kind = ? AND to_status IS ? AND reason = ?
           AND (state = 'open' OR (state = 'rejected' AND evidence_sha IS ?))
         LIMIT 1`
      )
      .get(itemId, delivery, kind, toStatus, reason, evidenceSha);
    return !!row;
  }

  addProposal(projectId: string, input: { itemId: string; delivery: number; linkId: string | null; kind: ProposalKind; fromStatus: ItemStatus; toStatus: ItemStatus | null; reason: string; evidenceSha: string | null }): ProposalView {
    const id = randomUUID();
    this.db(projectId)
      .prepare(
        `INSERT INTO plugin_code_link_proposals (id, project_id, item_id, delivery, link_id, kind, from_status, to_status, reason, evidence_sha, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .run(id, projectId, input.itemId, input.delivery, input.linkId, input.kind, input.fromStatus, input.toStatus, input.reason, input.evidenceSha, Date.now());
    return this.proposal(projectId, id)!;
  }

  setProposalState(projectId: string, id: string, state: ProposalState): ProposalView {
    this.db(projectId).prepare("UPDATE plugin_code_link_proposals SET state = ?, resolved_at = ? WHERE id = ?").run(state, Date.now(), id);
    return this.proposal(projectId, id)!;
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  /** Newest first. Every filter is applied by SQLite: ended rows are most of the table, and only matching rows are parsed. */
  sessions(projectId: string, filter: SessionFilter = {}): SessionView[] {
    const where = ["project_id = ?"];
    const args: unknown[] = [projectId];
    const and = (clause: string, ...values: unknown[]) => { where.push(clause); args.push(...values); };
    if (filter.live) and("state <> 'ended'");
    if (filter.delivery !== undefined) and("delivery = ?", filter.delivery);
    if (filter.itemId) and("EXISTS (SELECT 1 FROM json_each(item_ids_json) WHERE value = ?)", filter.itemId);
    if (filter.threadId === null) and("thread_id IS NULL");
    else if (filter.threadId !== undefined) and("thread_id = ?", filter.threadId);
    if (filter.externalId) and("external_id = ?", filter.externalId);
    if (filter.ids) and(filter.ids.length ? `id IN (${filter.ids.map(() => "?").join(", ")})` : "0", ...filter.ids);
    if (filter.panes) and(filter.panes.length ? `herdr_pane IN (${filter.panes.map(() => "?").join(", ")})` : "0", ...filter.panes);
    if (filter.endedSince !== undefined) and("state IN ('ended', 'lost') AND COALESCE(ended_at, last_event_at, started_at) >= ?", filter.endedSince);
    return (this.db(projectId).prepare(`SELECT * FROM plugin_code_link_sessions WHERE ${where.join(" AND ")} ORDER BY started_at DESC`).all(...args) as SessionRow[]).map(toSession);
  }

  /** What a session list shows at a glance: every session still going, then the newest few that ended since `since`. Reads only those rows. */
  recentSessions(projectId: string, since: number, ended: number): SessionView[] {
    const db = this.db(projectId);
    const live = db.prepare("SELECT * FROM plugin_code_link_sessions WHERE project_id = ? AND state NOT IN ('ended', 'lost') ORDER BY started_at DESC").all(projectId) as SessionRow[];
    const done = db
      .prepare("SELECT * FROM plugin_code_link_sessions WHERE project_id = ? AND state IN ('ended', 'lost') AND COALESCE(ended_at, last_event_at, started_at) >= ? ORDER BY COALESCE(ended_at, last_event_at, started_at) DESC LIMIT ?")
      .all(projectId, since, ended) as SessionRow[];
    return [...live, ...done].map(toSession);
  }

  /** Sessions that worked this ticket and moved on to another, newest first. */
  movedOn(projectId: string, itemId: string, delivery?: number): SessionView[] {
    const rows = this.db(projectId)
      .prepare("SELECT * FROM plugin_code_link_sessions WHERE project_id = ? AND EXISTS (SELECT 1 FROM json_each(worked_json) WHERE json_extract(value, '$.itemId') = ?) ORDER BY started_at DESC")
      .all(projectId, itemId) as SessionRow[];
    return rows.map(toSession).filter((s) => !s.itemIds.includes(itemId) && s.worked.some((w) => w.itemId === itemId && (delivery === undefined || w.delivery === delivery)));
  }

  session(projectId: string, id: string): SessionView | null {
    const row = this.db(projectId).prepare("SELECT * FROM plugin_code_link_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  createSession(projectId: string, input: { id?: string; repoId: string; delivery?: number; branch: string; itemIds: string[]; mode: SessionMode; agent: string; threadId: string | null; device: string; externalId?: string | null; worktree?: string | null; requestedBy?: string | null; autoMerge?: boolean; role?: string | null }): SessionView {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    // A ticket it starts on is its first mark: the conversation belongs to it from the first line.
    const marks: SessionMark[] = input.itemIds.map((itemId) => ({ itemId, at: now }));
    this.db(projectId)
      .prepare(
        `INSERT INTO plugin_code_link_sessions (id, project_id, repo_id, delivery, branch, item_ids_json, marks_json, mode, agent, external_id, thread_id, worktree, requested_by, auto_merge, role, state, last_event_at, device, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`
      )
      .run(id, projectId, input.repoId, input.delivery ?? 1, input.branch, JSON.stringify(input.itemIds), JSON.stringify(marks), input.mode, input.agent, input.externalId ?? null, input.threadId, input.worktree ?? null, input.requestedBy ?? null, input.autoMerge ? 1 : 0, input.role ?? null, now, input.device, now);
    return this.session(projectId, id)!;
  }

  /**
   * One page of the sessions that ended and were worth keeping (a ticket, a title, or someone spoke to them), newest
   * end first from `before`; `limit` rows at most. Only those rows are read, never the whole table.
   */
  endedPage(projectId: string, before: SessionCursor | null, limit: number): SessionView[] {
    const kept = "state IN ('ended', 'lost') AND (item_ids_json <> '[]' OR worked_json <> '[]' OR title IS NOT NULL OR prompted = 1)";
    const at = "COALESCE(ended_at, last_event_at, started_at)";
    const rows = before
      ? (this.db(projectId).prepare(`SELECT * FROM plugin_code_link_sessions WHERE project_id = ? AND ${kept} AND (${at} < ? OR (${at} = ? AND id < ?)) ORDER BY ${at} DESC, id DESC LIMIT ?`).all(projectId, before.at, before.at, before.id, limit) as SessionRow[])
      : (this.db(projectId).prepare(`SELECT * FROM plugin_code_link_sessions WHERE project_id = ? AND ${kept} ORDER BY ${at} DESC, id DESC LIMIT ?`).all(projectId, limit) as SessionRow[]);
    return rows.map(toSession);
  }

  /** The newest `limit` ended sessions whose title, branch, folder, agent or ticket (by id) holds `needle`, any case. */
  endedMatching(projectId: string, needle: string, itemIds: string[], limit: number): SessionView[] {
    const kept = "state IN ('ended', 'lost') AND (item_ids_json <> '[]' OR worked_json <> '[]' OR title IS NOT NULL OR prompted = 1)";
    const like = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
    const byTicket = itemIds.map(() => "item_ids_json LIKE ? OR worked_json LIKE ?").join(" OR ");
    const ticketArgs = itemIds.flatMap((id) => [`%${JSON.stringify(id)}%`, `%${JSON.stringify(id)}%`]);
    const rows = this.db(projectId)
      .prepare(
        `SELECT * FROM plugin_code_link_sessions WHERE project_id = ? AND ${kept}
         AND (title LIKE ? ESCAPE '\\' OR branch LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\' OR worktree LIKE ? ESCAPE '\\' OR agent LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'${byTicket ? ` OR ${byTicket}` : ""})
         ORDER BY COALESCE(ended_at, last_event_at, started_at) DESC, id DESC LIMIT ?`
      )
      .all(projectId, like, like, like, like, like, like, ...ticketArgs, limit) as SessionRow[];
    return rows.map(toSession);
  }

  /** Of these conversations, the ones a session speaks for (it ran in them): a list of conversations leaves those to the session. */
  threadsWithSessions(projectId: string, threadIds: string[]): Set<string> {
    if (!threadIds.length) return new Set();
    const rows = this.db(projectId).prepare(`SELECT DISTINCT thread_id FROM plugin_code_link_sessions WHERE project_id = ? AND thread_id IN (${threadIds.map(() => "?").join(",")})`).all(projectId, ...threadIds) as { thread_id: string }[];
    return new Set(rows.map((r) => r.thread_id));
  }

  /** The links of these tickets, in one read: what a page of sessions says about pull requests and commits. */
  linksOfItems(projectId: string, itemIds: string[]): CodeLinkView[] {
    if (!itemIds.length) return [];
    return (this.db(projectId).prepare(`SELECT * FROM plugin_code_link_links WHERE project_id = ? AND item_id IN (${itemIds.map(() => "?").join(",")}) ORDER BY item_id, delivery ASC, created_at ASC`).all(projectId, ...itemIds) as LinkRow[]).map(toLink);
  }

  patchSession(projectId: string, id: string, patch: SessionPatch): SessionView {
    const columns: Record<keyof SessionPatch, string> = {
      delivery: "delivery",
      branch: "branch",
      itemIds: "item_ids_json",
      worked: "worked_json",
      marks: "marks_json",
      asked: "asked",
      externalId: "external_id",
      threadId: "thread_id",
      worktree: "worktree",
      herdrPane: "herdr_pane",
      terminal: "terminal",
      title: "title",
      cwd: "cwd",
      transcript: "transcript",
      prompted: "prompted",
      withoutTicket: "without_ticket",
      recordSavedAt: "record_saved_at",
      recordCut: "record_cut",
      state: "state",
      lastEventAt: "last_event_at",
      lastToolAt: "last_tool_at",
      lastCommitAt: "last_commit_at",
      summary: "summary",
      activity: "activity",
      failedTool: "failed_tool",
      ask: "ask_json",
      blocked: "blocked",
      requestedBy: "requested_by",
      autoMerge: "auto_merge",
      role: "role",
      endedAt: "ended_at"
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    // A failure is what it does only until the next word of what it does.
    if (patch.activity !== undefined && patch.failedTool === undefined) patch = { ...patch, failedTool: null };
    for (const [field, column] of Object.entries(columns) as [keyof SessionPatch, string][]) {
      const value = patch[field];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(field === "itemIds" || field === "worked" || field === "marks" || (field === "ask" && value !== null) ? JSON.stringify(value) : field === "prompted" || field === "autoMerge" || field === "recordCut" ? (value ? 1 : 0) : value);
    }
    if (!sets.length) return this.session(projectId, id)!;
    values.push(id);
    this.db(projectId).prepare(`UPDATE plugin_code_link_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.session(projectId, id)!;
  }
}
