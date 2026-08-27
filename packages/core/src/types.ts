/** Core domain types. Data shapes are sync-friendly: UUID ids, version, updated_by, timestamps. */
export type ItemKind = "ticket" | "epic";

export type ItemStatus = "backlog" | "todo" | "doing" | "verifying" | "done" | "cancelled";

export const ITEM_STATUSES: readonly ItemStatus[] = ["backlog", "todo", "doing", "verifying", "done", "cancelled"];

/** 0 None · 1 Low · 2 Medium (default) · 3 High · 4 Urgent. */
export type Priority = 0 | 1 | 2 | 3 | 4;

export const DEFAULT_PRIORITY: Priority = 2;

/** Who wrote this change. Human edits are 'human'; AI writes are 'ai:<source>' (e.g. 'ai:mcp', 'ai:extraction'). */
export type Author = "human" | `ai:${string}`;

/** Derived from updatedBy + humanLocked; never stored. */
export type Provenance = "human" | "ai" | "locked";

export interface Item {
  id: string;
  projectId: string;
  /** The board that owns this issue. Dragging never changes it. */
  boardId: string;
  /** Per-project sequence behind the human key (TOM-142). Never reused. */
  keyNum: number;
  /** Display key, derived from the project prefix and keyNum. */
  key: string;
  title: string;
  body: string | null;
  kind: ItemKind;
  status: ItemStatus;
  priority: Priority;
  /** Parent epic (an item with kind 'epic'), or null. */
  parentId: string | null;
  /** Float sort key for manual ordering (sync-friendly: no integer positions). */
  rank: number;
  labels: string[];
  /** Ids of the items this one blocks. */
  blocks: string[];
  updatedAt: number;
  updatedBy: Author;
  version: number;
  /** When set, AI writes may not touch title/body of this item. */
  humanLocked: boolean;
}

/** Fields an AI writer may propose. humanLocked is human-only (guarded in the repository). */
export type Patch = Partial<
  Pick<
    Item,
    "title" | "body" | "kind" | "status" | "priority" | "parentId" | "rank" | "boardId" | "labels" | "humanLocked"
  >
>;

export type OplogEntity = "item" | "board" | "view";
/**
 * 'delete' is reversible — the row carries the snapshot undo restores from.
 * 'purge' is a human-only permanent destroy: the entity's own history is
 * removed with it and the tombstone carries no snapshot, so nothing can put
 * it back. Undo walks straight past a purge.
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

/**
 * A board is a workstream: the container an issue actually belongs to.
 * A board with `across` set owns nothing — it borrows every issue in the
 * project and runs the same views over the lot.
 */
export interface Board {
  id: string;
  projectId: string;
  name: string;
  /** Sprite id of the sidebar glyph, e.g. 'i-panel'. */
  icon: string;
  /** Workspace package (`packages/ui`) for a board, or the sub-line for a scope. */
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
  /** Column keys in display order; key space depends on groupBy. */
  columns: string[];
  filter: ViewFilter;
  /** WIP cap per column key. Advisory — a drop is never blocked. */
  wip: Record<string, number>;
  /** Lowest rank opens first. */
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

export interface AppSettings {
  llm: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
  theme: ThemePreference;
}
