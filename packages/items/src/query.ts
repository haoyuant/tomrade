import { ITEM_STATUSES, dayBound, type FieldDef, type FilterClause, type FieldValue, type SortKey } from "@tomrade/domain";

/**
 * Compiles a view query to SQL over `items i`. Built-in fields are column
 * expressions; each custom field the query touches is one LEFT JOIN on
 * `item_values`, so a sort or range filter hits the (field_id, num|text) index.
 * The pure evaluator in @tomrade/domain must agree with this — the parity test
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
