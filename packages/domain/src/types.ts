export type ItemKind = "ticket" | "epic";

export type ItemStatus = "backlog" | "todo" | "doing" | "verifying" | "done" | "cancelled";

export const ITEM_STATUSES: readonly ItemStatus[] = ["backlog", "todo", "doing", "verifying", "done", "cancelled"];

/** 0 None · 1 Low · 2 Medium (default) · 3 High · 4 Urgent. */
export type Priority = 0 | 1 | 2 | 3 | 4;

export const DEFAULT_PRIORITY: Priority = 2;

/** Who wrote a change. Human edits are 'human'; every agent or plugin write is 'ai:<source>'. */
export type Author = "human" | `ai:${string}`;

/** Derived from updatedBy + humanLocked; never stored. */
export type Provenance = "human" | "ai" | "locked";

export interface Item {
  id: string;
  projectId: string;
  /** The board that owns this issue. Dragging never changes it. */
  boardId: string;
  /** Per-project sequence behind the human key. Never reused. */
  keyNum: number;
  /** Display key, e.g. TOM-142. */
  key: string;
  title: string;
  body: string | null;
  kind: ItemKind;
  status: ItemStatus;
  priority: Priority;
  parentId: string | null;
  rank: number;
  labels: string[];
  /** Ids of the items this one blocks. */
  blocks: string[];
  updatedAt: number;
  updatedBy: Author;
  version: number;
  /** When set, AI writes may not touch title/body. */
  humanLocked: boolean;
}

export type Patch = Partial<Pick<Item, "title" | "body" | "kind" | "status" | "priority" | "parentId" | "rank" | "boardId" | "labels" | "humanLocked">>;

export type OplogEntity = "item" | "board" | "view";

/**
 * 'delete' is reversible — the row carries the snapshot undo restores from.
 * 'purge' is a human-only permanent destroy: the entity's own history goes with
 * it and the tombstone carries no snapshot, so undo walks straight past it.
 */
export type OplogOp = "create" | "update" | "delete" | "purge";

export interface OplogEntry {
  seq: number;
  entity: OplogEntity;
  entityId: string;
  op: OplogOp;
  baseVersion: number | null;
  before: unknown | null;
  after: unknown | null;
  by: Author;
  at: number;
  /** The agent run this write belongs to; null for a write made outside one. */
  runId: string | null;
}

export interface UndoResult {
  entry: OplogEntry;
  /** One line describing what was reverted, for the toast. */
  summary: string;
}

/** Result of reverting one agent run. `kept` names writes left in place because someone edited the entity afterwards. */
export interface UndoRunResult {
  reverted: number;
  kept: { entity: OplogEntity; entityId: string; label: string; reason: string }[];
}

export interface CreateItemInput {
  projectId?: string;
  boardId: string;
  title: string;
  body?: string | null;
  kind?: ItemKind;
  status?: ItemStatus;
  priority?: Priority;
  parentId?: string | null;
  rank?: number;
  labels?: string[];
  by: Author;
}

export interface ListItemsFilter {
  projectId?: string;
  boardId?: string;
  status?: ItemStatus;
  kind?: ItemKind;
  priority?: Priority;
  parentId?: string | null;
  label?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  /** Prefix of the human issue key, e.g. 'TOM' in TOM-142. */
  keyPrefix: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  keyPrefix?: string;
}

export type ProjectPatch = Partial<Pick<Project, "name" | "description" | "archived">>;

/**
 * A board is a workstream: the container an issue belongs to. A board with
 * `across` set owns nothing — it borrows every issue in the project.
 */
export interface Board {
  id: string;
  projectId: string;
  name: string;
  icon: string;
  subtitle: string | null;
  across: boolean;
  /** 'recent' orders by last write; null keeps view/manual rank. */
  sort: "recent" | null;
  note: string | null;
  rank: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBoardInput {
  projectId: string;
  name: string;
  icon?: string;
  subtitle?: string | null;
  across?: boolean;
  sort?: "recent" | null;
  note?: string | null;
  rank?: number;
}

/** A created board carries the id of the All work view it was given. */
export type CreatedBoard = Board & { defaultViewId: string };

export type BoardPatch = Partial<Pick<Board, "name" | "icon" | "subtitle" | "note" | "rank">>;

/** What each board column represents. Dragging writes this field. */
export type GroupBy = "status" | "priority" | "epic";

export interface ViewFilter {
  labels?: string[];
  /** Epic item ids, plus the literal 'none' for issues without a parent. */
  epics?: string[];
  priorities?: Priority[];
  provenance?: Provenance[];
}

/** A saved slice of one board: grouping, visible columns, filter, WIP caps. */
export interface View {
  id: string;
  boardId: string;
  name: string;
  icon: string;
  groupBy: GroupBy;
  columns: string[];
  filter: ViewFilter;
  /** WIP cap per column key. Advisory — a drop is never blocked. */
  wip: Record<string, number>;
  rank: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateViewInput {
  boardId: string;
  name: string;
  icon?: string;
  groupBy?: GroupBy;
  columns?: string[];
  filter?: ViewFilter;
  wip?: Record<string, number>;
  rank?: number;
}

export type ViewPatch = Partial<Pick<View, "name" | "icon" | "groupBy" | "columns" | "filter" | "wip" | "rank">>;

export type ThemePreference = "system" | "light" | "dark" | "matcha";

/** 'system' follows the OS locale, falling back to English when that locale isn't supported. */
export type LanguagePreference = "system" | "en" | "zh";

export interface LlmSettings {
  apiKey: string;
  baseURL: string;
  model: string;
}

/** Settings are sections keyed by id; plugins register their own. */
export interface AppSettings {
  theme: ThemePreference;
  language: LanguagePreference;
  llm?: LlmSettings;
  [section: string]: unknown;
}

