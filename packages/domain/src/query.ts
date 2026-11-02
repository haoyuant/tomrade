import { CHECKED, EMPTY_KEY, fieldValueOf, type FieldDef } from "./fields.js";
import type { FieldValue, Item } from "./types.js";

/**
 * How a view draws the backlog. Board and table group and sort; a graph draws
 * the edges a plugin contributes; a plugin layout is a page of the plugin's
 * own, named `plugin:` and the layout's id. A view is one layout plus one query.
 */
export type BuiltinLayout = "board" | "table" | "graph";
export type PluginLayout = `plugin:${string}`;
export type Layout = BuiltinLayout | PluginLayout;

export const LAYOUTS: readonly BuiltinLayout[] = ["board", "table", "graph"];
const PLUGIN_LAYOUT = "plugin:";

export const isBuiltinLayout = (layout: string): layout is BuiltinLayout => (LAYOUTS as readonly string[]).includes(layout);
export const isPluginLayout = (layout: string): layout is PluginLayout => layout.startsWith(PLUGIN_LAYOUT) && layout.length > PLUGIN_LAYOUT.length;
export const pluginLayout = (id: string): PluginLayout => `${PLUGIN_LAYOUT}${id}`;
/** The contributed layout's id behind a `plugin:` layout. */
export const pluginLayoutId = (layout: PluginLayout): string => layout.slice(PLUGIN_LAYOUT.length);
/** A stored layout as a Layout: a plugin's is kept even when no plugin provides it right now; anything else is a board. */
export const parseLayout = (raw: string): Layout => (isBuiltinLayout(raw) || isPluginLayout(raw) ? raw : "board");

/**
 * `in` / `not-in` take values; a null value means "empty". `contains` is a
 * case-insensitive substring over text. `gte` / `lte` compare numbers and dates.
 */
export type FilterOp = "in" | "not-in" | "contains" | "gte" | "lte";

export interface FilterClause {
  field: string;
  op: FilterOp;
  values: (FieldValue | null)[];
}

export interface SortKey {
  field: string;
  dir: "asc" | "desc";
}

/**
 * The stored shape of a view's query and the live shape the bar edits. Empty
 * `columns` means every key the field has; empty `sortBy` means manual order.
 */
export interface ViewQuery {
  filter: FilterClause[];
  /** Board layout: the field one column stands for. */
  columnBy: string | null;
  /** Visible column keys in order; empty shows them all. */
  columns: string[];
  /** Swimlanes on a board, groups in a table. */
  groupBy: string | null;
  sortBy: SortKey[];
  /** Fields drawn on cards and as table columns; empty means the layout's default. */
  fields: string[];
  /** WIP cap per column key. Advisory — a drop is never blocked. */
  wip: Record<string, number>;
  /** Graph layout: the contributed graph whose edges are drawn. */
  graph: string | null;
}

const EMPTY_QUERY: ViewQuery = { filter: [], columnBy: "status", columns: [], groupBy: null, sortBy: [], fields: [], wip: {}, graph: null };

/** Fill a partially stored query so every consumer sees the full shape. */
export const normalizeQuery = (q: Partial<ViewQuery> | null | undefined): ViewQuery => ({ ...EMPTY_QUERY, ...(q ?? {}), wip: { ...(q?.wip ?? {}) } });

/* ═══ the pure evaluator ══════════════════════════════════════════════════
   The renderer evaluates a query over the items it already holds; the items
   service compiles the same query to SQL. Both must agree — see the parity
   test in packages/items. */

export interface QueryContext {
  defs: Map<string, FieldDef>;
  /** Position of an option in its field's order; used to sort and to order columns. */
  optionRank(fieldId: string, key: string): number;
  /** A display name for an option key, for sorting fields whose options have no rank (epics by title). */
  optionName(fieldId: string, key: string): string;
}

const norm = (v: FieldValue | null): string | null => (v === null ? null : String(v));

const DAY = 86_400_000;

/** A `YYYY-MM-DD` bound against an epoch-ms value covers the whole day it names. */
export function dayBound(value: FieldValue | null | undefined, op: "gte" | "lte"): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return op === "lte" ? t + DAY - 1 : t;
}

function matchesClause(item: Item, clause: FilterClause): boolean {
  const raw = fieldValueOf(item, clause.field);
  const values = Array.isArray(raw) ? raw : raw === null ? [] : [raw];
  switch (clause.op) {
    case "in": {
      const wanted = new Set(clause.values.map(norm));
      if (!values.length) return wanted.has(null);
      return values.some((v) => wanted.has(String(v)));
    }
    case "not-in": {
      const wanted = new Set(clause.values.map(norm));
      if (!values.length) return !wanted.has(null);
      return !values.some((v) => wanted.has(String(v)));
    }
    case "contains": {
      const needle = String(clause.values[0] ?? "").toLowerCase();
      if (!needle) return true;
      return values.some((v) => String(v).toLowerCase().includes(needle));
    }
    case "gte":
    case "lte": {
      if (!values.length) return false;
      const v = values[0];
      // A numeric field may be bounded by a date string (Updated); anything else compares like for like.
      const bound = typeof v === "number" ? dayBound(clause.values[0], clause.op) : (clause.values[0] ?? null);
      if (bound === null) return false;
      const cmp = typeof v === "number" && typeof bound === "number" ? v - bound : String(v).localeCompare(String(bound));
      return clause.op === "gte" ? cmp >= 0 : cmp <= 0;
    }
  }
}

export const matchesFilter = (item: Item, filter: FilterClause[]): boolean => filter.every((c) => matchesClause(item, c));

/**
 * The terms of a search: whitespace-separated words, except that a run in
 * double quotes ("login timeout", “登录 超时”) is one term matched as a whole,
 * spaces included. A quote with no partner runs to the end of the string.
 */
export function searchTerms(search: string): string[] {
  const out: string[] = [];
  const closer: Record<string, string> = { '"': '"', "\u201c": "\u201d" };
  let i = 0;
  while (i < search.length) {
    const c = search[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const close = closer[c];
    if (close) {
      const end = search.indexOf(close, i + 1);
      const phrase = (end === -1 ? search.slice(i + 1) : search.slice(i + 1, end)).trim();
      if (phrase) out.push(phrase);
      i = end === -1 ? search.length : end + 1;
      continue;
    }
    let j = i;
    while (j < search.length && !/\s/.test(search[j]!)) j++;
    out.push(search.slice(i, j));
    i = j;
  }
  return out;
}

/** Every term appears, case aside, in the ticket's key, title or body — what the items index matches, plus the key. */
export function matchesSearch(item: Item, terms: string[]): boolean {
  if (!terms.length) return true;
  const text = `${item.key} ${item.title} ${item.body ?? ""}`.toLowerCase();
  return terms.every((term) => text.includes(term.toLowerCase()));
}

/** A comparable for one sort key: numbers for numeric fields, strings otherwise, null when empty. */
function sortKeyOf(item: Item, fieldId: string, ctx: QueryContext): number | string | null {
  const raw = fieldValueOf(item, fieldId);
  if (raw === null || Array.isArray(raw)) return null;
  const def = ctx.defs.get(fieldId);
  if (!def) return null;
  if (def.type === "select") return ctx.optionRank(fieldId, String(raw));
  if (def.type === "item") return ctx.optionName(fieldId, String(raw)).toLowerCase();
  if (def.type === "text") return String(raw).toLowerCase();
  return raw;
}

/** Empty values sort last whichever direction; ties fall through to manual rank, then recency. */
export function compareItems(a: Item, b: Item, sortBy: SortKey[], ctx: QueryContext, rankOf: (item: Item) => number): number {
  for (const key of sortBy) {
    const ka = sortKeyOf(a, key.field, ctx);
    const kb = sortKeyOf(b, key.field, ctx);
    if (ka === kb) continue;
    if (ka === null) return 1;
    if (kb === null) return -1;
    const cmp = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
    if (cmp !== 0) return key.dir === "desc" ? -cmp : cmp;
  }
  return rankOf(a) - rankOf(b) || b.updatedAt - a.updatedAt;
}

/** The keys a groupable field can take, in the field's order, with the empty key last where it applies. */
export function groupSpaceOf(def: FieldDef, options: { id: string }[]): string[] {
  if (def.type === "checkbox") return [String(CHECKED), EMPTY_KEY];
  const keys = options.map((o) => o.id);
  // Total fields: every item has a status, a priority, a provenance and a workstream.
  if (def.id === "status" || def.id === "priority" || def.id === "provenance" || def.id === "board") return keys;
  return [...keys, EMPTY_KEY];
}
