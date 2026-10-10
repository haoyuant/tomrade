import { ITEM_STATUSES, dayBound, type FieldDef, type FilterClause, type FieldValue, type SortKey } from "@tomradex/domain";

/**
 * Compiles a view query to SQL over `items i`. Built-in fields are column
 * expressions; each custom field the query touches is one LEFT JOIN on
 * `item_values`, so a sort or range filter hits the (field_id, num|text) index.
 * The pure evaluator in @tomradex/domain must agree with this — the parity test
 * in tests/query.test.ts runs both.
 */
export interface Compiled {
  joins: string[];
  where: string[];
  orderBy: string[];
  /** In SQL order: join params, then where params, then order params. */
  params: unknown[];
}

const PROVENANCE_SQL = "CASE WHEN i.human_locked = 1 THEN 'locked' WHEN i.updated_by LIKE 'ai:%' THEN 'ai' WHEN i.updated_by LIKE 'sync:%' THEN 'sync' ELSE 'human' END";
const STATUS_RANK_SQL = `CASE i.status ${ITEM_STATUSES.map((s, n) => `WHEN '${s}' THEN ${n}`).join(" ")} END`;
export function compileQuery(q: { filter: FilterClause[]; sortBy: SortKey[] }, defs: Map<string, FieldDef>): Compiled {
  const joins: string[] = [];
  const joinParams: unknown[] = [];
  const where: string[] = [];
  const whereParams: unknown[] = [];
  const orderBy: string[] = [];
  const aliases = new Map<string, string>();

  /** One join per custom field, however many clauses name it. */
  const aliasOf = (fieldId: string): string => {
    let alias = aliases.get(fieldId);
    if (!alias) {
      alias = `v${aliases.size}`;
      aliases.set(fieldId, alias);
      joins.push(`LEFT JOIN item_values ${alias} ON ${alias}.item_id = i.id AND ${alias}.field_id = ?`);
      joinParams.push(fieldId);
    }
    return alias;
  };

  /** The comparable expression for a field, and how its filter values bind. */
  const exprOf = (def: FieldDef): { expr: string; bind: (v: FieldValue) => unknown } | null => {
    switch (def.id) {
      case "title":
        return { expr: "i.title", bind: String };
      case "status":
        return { expr: "i.status", bind: String };
      case "workType":
        return { expr: "i.work_type", bind: String };
      case "priority":
        return { expr: "i.priority", bind: Number };
      case "epic":
        return { expr: "i.parent_id", bind: String };
      case "board":
        return { expr: "i.board_id", bind: String };
      case "updated":
        return { expr: "i.updated_at", bind: Number };
      case "key":
        return { expr: "i.key_num", bind: Number };
      case "provenance":
        return { expr: `(${PROVENANCE_SQL})`, bind: String };
      case "labels":
        return null;
      default: {
        if (def.builtin) return null;
        const alias = aliasOf(def.id);
        return def.type === "number" || def.type === "checkbox" ? { expr: `${alias}.num`, bind: Number } : { expr: `${alias}.text`, bind: String };
      }
    }
  };

  for (const clause of q.filter) {
    const def = defs.get(clause.field);
    if (!def || !def.can.filter) continue;
    if (def.id === "labels") {
      const names = clause.values.filter((v): v is FieldValue => v !== null).map(String);
      const wantsEmpty = clause.values.includes(null);
      const parts: string[] = [];
      if (names.length) {
        parts.push(`EXISTS (SELECT 1 FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id AND l.name IN (${names.map(() => "?").join(",")}))`);
        whereParams.push(...names);
      }
      if (wantsEmpty) parts.push("NOT EXISTS (SELECT 1 FROM item_labels il WHERE il.item_id = i.id)");
      if (!parts.length) continue;
      const any = `(${parts.join(" OR ")})`;
      if (clause.op === "in") where.push(any);
      else if (clause.op === "not-in") where.push(`NOT ${any}`);
      continue;
    }
    const target = exprOf(def);
    if (!target) continue;
    const { expr, bind } = target;
    switch (clause.op) {
      case "in":
      case "not-in": {
        const present = clause.values.filter((v): v is FieldValue => v !== null);
        const wantsEmpty = clause.values.includes(null);
        const inList = present.length ? `${expr} IN (${present.map(() => "?").join(",")})` : null;
        if (inList) whereParams.push(...present.map(bind));
        if (clause.op === "in") {
          const parts = [inList, wantsEmpty ? `${expr} IS NULL` : null].filter(Boolean);
          if (parts.length) where.push(`(${parts.join(" OR ")})`);
        } else {
          // An empty value is "not in" any list unless the list names empty itself.
          const parts = [inList ? `NOT (${inList})` : null, wantsEmpty ? null : `${expr} IS NULL`].filter(Boolean);
          where.push(wantsEmpty ? `(${expr} IS NOT NULL${inList ? ` AND NOT (${inList})` : ""})` : `(${parts.join(" OR ")})`);
        }
        break;
      }
      case "contains": {
        const needle = String(clause.values[0] ?? "").toLowerCase();
        if (!needle) break;
        where.push(`instr(lower(${expr}), ?) > 0`);
        whereParams.push(needle);
        break;
      }
      case "gte":
      case "lte": {
        const bound = def.id === "updated" ? dayBound(clause.values[0], clause.op) : clause.values[0];
        if (bound === null || bound === undefined) break;
        where.push(`${expr} ${clause.op === "gte" ? ">=" : "<="} ?`);
        whereParams.push(def.id === "updated" ? bound : bind(bound));
        break;
      }
    }
  }

  for (const key of q.sortBy) {
    const def = defs.get(key.field);
    if (!def || !def.can.sort) continue;
    const expr = sortExprOf(def, aliasOf);
    if (!expr) continue;
    // Empty values sort last either way, as the evaluator does.
    orderBy.push(`(${expr}) IS NULL ASC`, `${expr} ${key.dir === "desc" ? "DESC" : "ASC"}`);
  }

  return { joins, where, orderBy, params: [...joinParams, ...whereParams] };
}

function sortExprOf(def: FieldDef, aliasOf: (fieldId: string) => string): string | null {
  switch (def.id) {
    case "title":
      return "lower(i.title)";
    case "status":
      return `(${STATUS_RANK_SQL})`;
    // Option order is Urgent → None, so the rank is the inverse of the number.
    case "priority":
      return "(4 - i.priority)";
    case "epic":
      return "(SELECT lower(p.title) FROM items p WHERE p.id = i.parent_id)";
    case "board":
      return "(SELECT b.rank FROM boards b WHERE b.id = i.board_id)";
    case "updated":
      return "i.updated_at";
    case "key":
      return "i.key_num";
    case "provenance":
      return `(CASE ${PROVENANCE_SQL} WHEN 'human' THEN 0 WHEN 'ai' THEN 1 WHEN 'sync' THEN 2 ELSE 3 END)`;
    case "labels":
      return null;
    default: {
      if (def.builtin) return null;
      const alias = aliasOf(def.id);
      if (def.type === "number" || def.type === "checkbox") return `${alias}.num`;
      if (def.type === "select") return `(SELECT o.rank FROM field_options o WHERE o.id = ${alias}.text)`;
      if (def.type === "text") return `lower(${alias}.text)`;
      return `${alias}.text`;
    }
  }
}

export interface CompiledSearch {
  joins: string[];
  joinParams: unknown[];
  where: string[];
  whereParams: unknown[];
  /** Relevance, present whenever there is a search; its params bind after the WHERE params. */
  orderBy: string[];
  orderParams: unknown[];
  /** How many terms the search has; widening to "any" only means something from two. */
  terms: number;
}

/** "all": every term must appear (the default). "any": one is enough, and rows with more come first. */
export type SearchMode = "all" | "any";

/** BM25 column weights: a hit in the title says more about what a ticket is than one in its body. */
export const SEARCH_TITLE_WEIGHT = 5;

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

/**
 * A title/body search as SQL over `items i`. Every term must appear, in either
 * column and any order; a quoted term is a contiguous match. Terms of three or
 * more characters go through the trigram index as FTS phrases (so operators in
 * them are text) and rank by title-weighted BM25; shorter terms are below what
 * a trigram can see, use instr(), and rank by whether they hit the title.
 */
export function compileSearch(search: string | undefined, mode: SearchMode = "all"): CompiledSearch {
  const terms = search ? searchTerms(search) : [];
  const indexed = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  const phrases = indexed.map((t) => `"${t.replace(/"/g, '""')}"`);
  const lowered = short.map((t) => t.toLowerCase());
  const sub = `(SELECT rowid, bm25(items_fts, ${SEARCH_TITLE_WEIGHT}, 1) AS rank FROM items_fts WHERE items_fts MATCH ?) fts ON fts.rowid = i.rowid`;
  const inText = "instr(lower(i.title || ' ' || coalesce(i.body, '')), ?) > 0";
  const titleHits = short.length ? `(${short.map(() => "(instr(lower(i.title), ?) > 0)").join(" + ")}) DESC` : null;
  if (mode === "all") {
    return {
      joins: indexed.length ? [`JOIN ${sub}`] : [],
      joinParams: indexed.length ? [phrases.join(" ")] : [],
      where: short.map(() => inText),
      whereParams: lowered,
      orderBy: indexed.length ? ["fts.rank ASC"] : titleHits ? [titleHits] : [],
      orderParams: indexed.length ? [] : lowered,
      terms: terms.length
    };
  }
  // Any term will do. Rows the index matched come first, BM25 rewarding more terms; rows only a
  // short term reached follow, title hits first. The LEFT JOIN keeps the latter in the set.
  const hit = [...(indexed.length ? ["fts.rowid IS NOT NULL"] : []), ...short.map(() => inText)];
  return {
    joins: indexed.length ? [`LEFT JOIN ${sub}`] : [],
    joinParams: indexed.length ? [phrases.join(" OR ")] : [],
    where: hit.length ? [`(${hit.join(" OR ")})`] : [],
    whereParams: lowered,
    orderBy: [...(indexed.length ? ["COALESCE(fts.rank, 0) ASC"] : []), ...(titleHits ? [titleHits] : [])],
    orderParams: lowered,
    terms: terms.length
  };
}
