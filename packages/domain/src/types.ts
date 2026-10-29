import type { Layout, ViewQuery } from "./query.js";
import type { TicketEvidence } from "./delivery.js";

export type ItemKind = "ticket" | "epic";
export type WorkType = "coding" | "general";

export type ItemStatus = "backlog" | "todo" | "doing" | "verifying" | "done" | "cancelled";

export const ITEM_STATUSES: readonly ItemStatus[] = ["backlog", "todo", "doing", "verifying", "done", "cancelled"];

/** 0 None · 1 Low · 2 Medium (default) · 3 High · 4 Urgent. */
export type Priority = 0 | 1 | 2 | 3 | 4;

export const DEFAULT_PRIORITY: Priority = 2;

/** Who wrote a change. Human edits are 'human'; every agent or plugin write is 'ai:<source>'. */
/** Who wrote: a person, a model, or a sync reading evidence in from outside (`sync:git` — a merge moved the ticket). */
export type Author = "human" | `ai:${string}` | `sync:${string}`;

/** Derived from updatedBy + humanLocked; never stored. */
export type Provenance = "human" | "ai" | "sync" | "locked";

/** A stored custom-field value. Dates are ISO `YYYY-MM-DD`; selects hold the option id. */
export type FieldValue = string | number;

export interface Item {
  evidence: TicketEvidence;
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
  workType: WorkType;
  playbookId: string | null;
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
export type Patch = Partial<Pick<Item, "title" | "body" | "kind" | "workType" | "playbookId" | "status" | "priority" | "parentId" | "rank" | "boardId" | "labels" | "blocks" | "humanLocked">> & {
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
  /** The extension that made the write; null for the app itself. Local to this machine. */
  via: string | null;
}

export interface UndoResult {
  entry: OplogEntry;
  /** One line describing what was reverted, for the toast. */
  summary: string;
}

/** Result of reverting one agent run. `kept` names writes left in place because someone edited the entity afterwards. */
export interface UndoRunResult {
  reverted: number;
  /** `entity` is an oplog entity, or what another undo provider calls its own (a file, a setting). */
  kept: { entity: string; entityId: string; label: string; reason: string }[];
}

/**
 * One record of the project's history as the timeline shows it: a backlog
 * write, a file operation, or anything a plugin logs through its own undo
 * provider. `ref` (`provider:id`) names it to `oplog.revert` and `oplog.rollback`.
 */
export interface UndoRecord {
  ref: string;
  provider: string;
  id: string;
  /** What kind of thing it touched: `item`, `board`, `view`, `file`, or a plugin's own. */
  entity: string;
  entityId: string;
  /** What happened to it: an oplog op, or a file op (`write`, `mkdir`, `move`, `copy`, `remove`, `import`). */
  op: string;
  /** The entity's name for a sentence: an issue key, a view name, a file path. */
  label: string;
  /** A second name when the op has one — where a file moved or was copied to. */
  target: string | null;
  by: Author;
  at: number;
  runId: string | null;
  /** The machine that made it; a record from another machine is history, never undoable here. */
  device: string;
  /** False for purges, merge notes and other machines' writes. */
  undoable: boolean;
  /** Set while the record sits in the redo stack; a new write anywhere clears that stack. */
  undoneAt: number | null;
}

/** One step the timeline took: the record it acted on and a line for the toast. */
export interface UndoStep {
  record: UndoRecord;
  summary: string;
}

/** Moving the timeline's cursor to a record: the steps taken, and why it stopped short when it did. */
export interface RollbackResult {
  steps: UndoStep[];
  stopped: string | null;
}

export interface CreateItemInput {
  projectId?: string;
  boardId: string;
  title: string;
  body?: string | null;
  kind?: ItemKind;
  workType?: WorkType;
  playbookId?: string | null;
  status?: ItemStatus;
  priority?: Priority;
  parentId?: string | null;
  rank?: number;
  labels?: string[];
  fields?: Record<string, FieldValue | null>;
  by: Author;
}

/** Statuses whose tickets pile up: the renderer holds only a window of them. */
export const CLOSED_STATUSES = ["done", "cancelled"] as const satisfies readonly ItemStatus[];
export type ClosedStatus = (typeof CLOSED_STATUSES)[number];

/**
 * How many done and cancelled tickets the renderer holds, each status apart:
 * the newest `limit` by when they reached it, and only those of the last `days`.
 * Null lifts that bound.
 */
export interface ClosedWindow {
  limit: number | null;
  days: number | null;
}

export const DEFAULT_CLOSED_WINDOW: ClosedWindow = { limit: 50, days: null };

export interface ListItemsFilter {
  projectId?: string;
  boardId?: string;
  status?: ItemStatus;
  kind?: ItemKind;
  workType?: WorkType;
  priority?: Priority;
  parentId?: string | null;
  label?: string;
  /** Words that must all appear in title or body, as substrings in any script; matches come most relevant first. */
  search?: string;
  /** At most this many rows, from the front of the order: the most relevant when searching. */
  limit?: number;
  /** When no item has every search term, fall back to items with some of them, best matches first. */
  widen?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  /** Prefix of the human issue key, e.g. 'TOM' in TOM-142. */
  keyPrefix: string;
  archived: boolean;
  /** The tour a first run opens with: this machine's own, never in the account's catalog. */
  sample?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  keyPrefix?: string;
  /** The language the seeded workstream and views are named in: "en" (the default) or "zh". */
  locale?: string;
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
  note: string | null;
  rank: number;
  /** The code repository this workstream stands for, if any; several workstreams may share one. */
  repoId: string | null;
  /** Where in that repository the workstream's code lives; '' for the root. */
  repoPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBoardInput {
  projectId: string;
  name: string;
  icon?: string;
  note?: string | null;
  rank?: number;
  repoId?: string | null;
  repoPath?: string;
}

export type BoardPatch = Partial<Pick<Board, "name" | "icon" | "note" | "rank" | "repoId" | "repoPath">>;

/**
 * A code repository a project's workstreams stand for. Shared: the remote URL
 * is its identity everywhere. Where it is checked out on this machine is the
 * catalog's business, never a row here.
 */
export interface Repo {
  id: string;
  projectId: string;
  remote: string;
  name: string;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRepoInput {
  projectId: string;
  remote: string;
  name?: string;
  defaultBranch?: string;
}

export type RepoPatch = Partial<Pick<Repo, "name" | "defaultBranch" | "remote">>;

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

export type BuiltInTheme = "light" | "dark" | "matcha" | "dawn" | "sunrise" | "daybreak" | "glass" | "neon" | "sakura";
export type ThemePreference = "system" | BuiltInTheme | `custom:${string}`;

export const THEME_TOKEN_NAMES = ["bg", "surface", "surface-warm", "fg", "fg-2", "muted", "meta", "border", "border-soft", "accent", "accent-on", "accent-light", "accent-active", "success", "warn", "danger", "tag-bg-faint", "tag-bg-soft", "tag-bg-base", "tag-bg-strong", "tag-fg"] as const;
export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export const THEME_FONT_NAMES = ["font-display", "font-body", "font-mono"] as const;
export type ThemeFontName = (typeof THEME_FONT_NAMES)[number];
export const THEME_FONT_SIZE_NAMES = ["text-xs", "text-sm", "text-base", "text-md", "text-lg", "text-xl", "text-2xl"] as const;
export const THEME_FONT_WEIGHT_NAMES = ["font-weight-regular", "font-weight-medium"] as const;
export const THEME_TYPOGRAPHY_NAMES = [...THEME_FONT_NAMES, ...THEME_FONT_SIZE_NAMES, ...THEME_FONT_WEIGHT_NAMES] as const;
export type ThemeTypographyName = (typeof THEME_TYPOGRAPHY_NAMES)[number];
export interface CustomTheme {
  id: `custom:${string}`;
  name: string;
  base: BuiltInTheme;
  icon: "i-sun" | "i-moon" | "i-leaf" | "i-tag" | "i-bug" | "i-board" | "i-stack" | "i-sliders";
  tokens: Record<ThemeTokenName, string>;
  fonts: Record<ThemeTypographyName, string>;
}
export type ThemeAutomationMode = "none" | "system" | "schedule" | "shuffle";
export interface ThemeScheduleRule { start: string; end: string; theme: Exclude<ThemePreference, "system">; }
export interface ThemeAutomation {
  mode: ThemeAutomationMode;
  defaultTheme: Exclude<ThemePreference, "system">;
  schedule: ThemeScheduleRule[];
  shuffleMinutes: number;
}

/**
 * 'system' follows the OS locale, falling back to English when no language
 * the app has matches it; otherwise a language tag — one the app ships
 * ("en", "zh", "zh-Hant", "ja", "es", "de", "fr", "ru") or one a language pack adds.
 */
export type LanguagePreference = "system" | (string & {});

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
