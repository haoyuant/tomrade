import type { Layout, ViewQuery } from "./query.js";

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

/** A stored custom-field value. Dates are ISO `YYYY-MM-DD`; selects hold the option id. */
export type FieldValue = string | number;

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
  /** Ids of the items that block this one — the inverse of their `blocks`. */
  blockedBy: string[];
  /** Custom field values by field id. Built-in fields are the columns above. */
  fields: Record<string, FieldValue>;
  updatedAt: number;
  updatedBy: Author;
  version: number;
  /** When set, AI writes may not touch title/body. */
  humanLocked: boolean;
}

/** `fields` merges: a key set to null clears that value, absent keys are left alone. */
export type Patch = Partial<Pick<Item, "title" | "body" | "kind" | "status" | "priority" | "parentId" | "rank" | "boardId" | "labels" | "blocks" | "humanLocked">> & {
  fields?: Record<string, FieldValue | null>;
};

export type OplogEntity = "item" | "board" | "view";

/**
 * 'delete' is reversible — the row carries the snapshot undo restores from.
 * 'purge' is a human-only permanent destroy: the entity's own history goes with
 * it and the tombstone carries no snapshot, so undo walks straight past it.
 * 'rank' is one item's manual position in one view — logged so it travels and
 * can be undone, kept apart so history reads as decisions, not drags.
 * 'merge' is a note a sync left behind: the same field changed on two machines,
 * `before` holds the value that lost and `after` the one that stands. Undo
 * steps over it; taking the loser back is an ordinary edit.
 */
export type OplogOp = "create" | "update" | "delete" | "purge" | "rank" | "merge";

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
  /** The machine that made the write; `device:deviceSeq` is the op's identity across machines. */
  device: string;
  /** The op's position in its own machine's sequence; null only for rows written before devices existed. */
  deviceSeq: number | null;
  /** The fields the op changed (the whole entity for a create); what the folder's log carries. */
  patch: Record<string, unknown> | null;
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
  fields?: Record<string, FieldValue | null>;
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
 * A board is a workstream — an option of the built-in Workstream field. Every
 * issue belongs to exactly one; a drag on a Workstream column writes it like
 * any other field.
 */
export interface Board {
  id: string;
  projectId: string;
  name: string;
  icon: string;
  subtitle: string | null;
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
  note?: string | null;
  rank?: number;
}

export type BoardPatch = Partial<Pick<Board, "name" | "icon" | "subtitle" | "note" | "rank">>;

/** A saved, named way of looking at the project's backlog: one layout and one query. */
export interface View {
  id: string;
  projectId: string;
  name: string;
  icon: string;
  layout: Layout;
  query: ViewQuery;
  rank: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateViewInput {
  projectId: string;
  name: string;
  icon?: string;
  layout?: Layout;
  query?: Partial<ViewQuery>;
  rank?: number;
}

export type ViewPatch = Partial<Pick<View, "name" | "icon" | "layout" | "query" | "rank">>;

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

