/**
 * Three-way merge of two project states over a common base. A pure function:
 * where the inputs came from (a git merge-base, the `published/` copy, a
 * server) is not its concern, and the same inputs produce the same bytes on
 * every machine, so two sides merging the same pair converge.
 *
 * Rules (the proposal's §7): a row changed on one side only is taken; a row
 * changed on both merges field by field; the same field changed on both is
 * settled by the logs — later `at` wins, tie by device id — and noted; a row
 * deleted on one side and edited on the other keeps the edit and is noted; set
 * tables take the union minus what one side removed; ranks are last-writer
 * without a note; issue keys created on both sides are renumbered on ours.
 */

export type Row = Record<string, unknown>;

export interface LogOp {
  device: string;
  deviceSeq: number;
  at: number;
  by: string;
  entity: string;
  entityId: string;
  op: string;
  patch: Record<string, unknown> | null;
}

export interface TableRule {
  /** Primary key columns; a row's identity across the three states. */
  key: string[];
  /**
   * rows: field-level three-way with log arbitration.
   * set: membership only — union minus one side's removals.
   * quiet: last-writer-wins per row, no conflict notes (ordering).
   * append: rows never change — union by key.
   */
  mode: "rows" | "set" | "quiet" | "append";
  /** Which oplog entity the table's rows belong to, and the column holding that entity's id. */
  entity?: "item" | "board" | "view";
  idColumn?: string;
  /** Column → the patch field the log names it by; unmapped columns match their own name. */
  fieldMap?: Record<string, string>;
  /** Columns that are consequences of other edits; taken from the side that won the row, never a conflict. */
  derived?: string[];
}

export interface MergeState {
  project: Row;
  tables: Record<string, Row[]>;
}

export interface ConflictNote {
  table: string;
  entity: string | null;
  entityId: string;
  field: string;
  ours: unknown;
  theirs: unknown;
  took: "ours" | "theirs";
  /** Why this side: "later", "device", "no-log" (fallback to theirs), "edited-over-delete". */
  reason: string;
}

export interface Renumbered {
  itemId: string;
  from: number;
  to: number;
}

/**
 * A merged state that is valid for the database but disagrees with itself about
 * a delivery: it commits, and somebody decides what the evidence should say.
 */
export interface Attention {
  kind: "evidence";
  entityId: string;
  code: "orphan-artifact" | "orphan-review" | "duplicate-review" | "delivery-state" | "done-unaccepted";
}

export interface MergeInput {
  base: MergeState | null;
  ours: MergeState;
  theirs: MergeState;
  logs: { ours: LogOp[]; theirs: LogOp[] };
  rules: Record<string, TableRule>;
}

export interface MergeResult {
  merged: MergeState;
  conflicts: ConflictNote[];
  renumbered: Renumbered[];
  attention: Attention[];
}

const ITEM_FIELDS: Record<string, string> = { board_id: "boardId", parent_id: "parentId", human_locked: "humanLocked", key_num: "keyNum", work_type: "workType", playbook_id: "playbookId", evidence_json: "evidence" };

/** The core tables. Plugin tables are added by the caller from their declarations. */
export const CORE_RULES: Record<string, TableRule> = {
  deliveries: { key: ["id"], mode: "rows", derived: ["updated_at"] },
  boards: { key: ["id"], mode: "rows", entity: "board", idColumn: "id", fieldMap: { repo_id: "repoId", repo_path: "repoPath" }, derived: ["updated_at"] },
  repos: { key: ["id"], mode: "rows", derived: ["updated_at"] },
  views: { key: ["id"], mode: "rows", entity: "view", idColumn: "id", fieldMap: { query_json: "query" }, derived: ["updated_at"] },
  items: { key: ["id"], mode: "rows", entity: "item", idColumn: "id", fieldMap: ITEM_FIELDS, derived: ["updated_at", "updated_by", "version"] },
  labels: { key: ["id"], mode: "rows" },
  fields: { key: ["id"], mode: "rows", derived: ["updated_at"] },
  field_options: { key: ["id"], mode: "rows" },
  item_values: { key: ["item_id", "field_id"], mode: "rows", entity: "item", idColumn: "item_id" },
  item_labels: { key: ["item_id", "label_id"], mode: "set" },
  item_relations: { key: ["from_item_id", "to_item_id", "kind"], mode: "set" },
  view_item_rank: { key: ["view_id", "item_id"], mode: "quiet" }
};

const keyOf = (row: Row, key: string[]): string => key.map((k) => JSON.stringify(row[k] ?? null)).join("\0");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const byKey = (rows: Row[], key: string[]): Map<string, Row> => new Map(rows.map((r) => [keyOf(r, key), r]));
const sortedKeys = (...maps: Map<string, Row>[]): string[] => [...new Set(maps.flatMap((m) => [...m.keys()]))].sort();

/** The latest moment a side's log touched one field of one entity; null when the log says nothing. */
function lastTouch(log: LogOp[], entity: string, entityId: string, field: string): { at: number; device: string } | null {
  let best: { at: number; device: string } | null = null;
  for (const op of log) {
    if (op.entity !== entity || op.entityId !== entityId || !op.patch) continue;
    const touched = field in op.patch || (field.startsWith("fields.") && isRecord(op.patch.fields) && field.slice(7) in op.patch.fields);
    if (!touched) continue;
    if (!best || op.at > best.at || (op.at === best.at && op.device > best.device)) best = { at: op.at, device: op.device };
  }
  return best;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Which side wins one contested field. Later wins; a tie falls to the greater device id; silence falls to theirs. */
function arbitrate(rule: TableRule, table: string, row: Row, field: string, input: MergeInput): { took: "ours" | "theirs"; reason: string } {
  const entity = rule.entity;
  const id = rule.idColumn ? String(row[rule.idColumn]) : null;
  if (!entity || !id) return { took: "theirs", reason: "no-log" };
  const logField = table === "item_values" ? `fields.${String(row.field_id)}` : (rule.fieldMap?.[field] ?? field);
  const o = lastTouch(input.logs.ours, entity, id, logField);
  const t = lastTouch(input.logs.theirs, entity, id, logField);
  if (!o && !t) return { took: "theirs", reason: "no-log" };
  if (o && !t) return { took: "ours", reason: "later" };
  if (t && !o) return { took: "theirs", reason: "later" };
  if (o!.at !== t!.at) return { took: o!.at > t!.at ? "ours" : "theirs", reason: "later" };
  return { took: o!.device > t!.device ? "ours" : "theirs", reason: "device" };
}

function mergeRow(table: string, rule: TableRule, base: Row | undefined, ours: Row, theirs: Row, input: MergeInput, conflicts: ConflictNote[]): Row {
  const columns = [...new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base ?? {})])];
  const derived = new Set(rule.derived ?? []);
  const out: Row = {};
  let winner: "ours" | "theirs" | null = null;
  for (const c of columns) {
    if (derived.has(c)) continue;
    const b = base?.[c];
    const o = ours[c];
    const t = theirs[c];
    if (table === "items" && c === "evidence_json" && !same(o, t)) {
      const mergedEvidence = mergeEvidence(b, o, t, input, conflicts);
      if (mergedEvidence !== null) { out[c] = mergedEvidence; continue; }
    }
    if (same(o, t)) out[c] = o;
    else if (base && same(o, b)) out[c] = t;
    else if (base && same(t, b)) out[c] = o;
    else {
      // Both moved it away from the base (or there is no base to tell).
      const verdict = arbitrate(rule, table, ours, c, input);
      out[c] = verdict.took === "ours" ? o : t;
      if (!winner) winner = verdict.took;
      if (rule.mode === "rows") {
        conflicts.push({ table, entity: rule.entity ?? null, entityId: rule.idColumn ? String(ours[rule.idColumn]) : keyOf(ours, rule.key), field: c, ours: o, theirs: t, took: verdict.took, reason: verdict.reason });
      }
    }
  }
  // Consequences follow the newer side; a version moves past both so a stale write on either machine is refused.
  const newer = ((ours.updated_at as number | undefined) ?? 0) >= ((theirs.updated_at as number | undefined) ?? 0) ? ours : theirs;
  for (const c of derived) {
    if (c === "version") {
      const changed = !same(out, stripDerived(ours, derived)) && !same(out, stripDerived(theirs, derived));
      out[c] = Math.max(Number(ours[c] ?? 0), Number(theirs[c] ?? 0)) + (changed ? 1 : 0);
    } else if (c === "updated_at") {
      out[c] = Math.max(Number(ours[c] ?? 0), Number(theirs[c] ?? 0));
    } else {
      out[c] = (winner === "ours" ? ours : winner === "theirs" ? theirs : newer)[c];
    }
  }
  return out;
}

const stripDerived = (row: Row, derived: Set<string>): Row => Object.fromEntries(Object.entries(row).filter(([k]) => !derived.has(k)));

/** Independently created artifact/submission/review IDs must survive concurrent edits. */
function mergeEvidence(base: unknown, ours: unknown, theirs: unknown, input: MergeInput, conflicts: ConflictNote[]): string | null {
  try {
    const parse = (value: unknown): Record<string, Row[]> => typeof value === "string" ? JSON.parse(value) : { resources: [], submissions: [], reviews: [] };
    const b = parse(base), o = parse(ours), t = parse(theirs);
    const out: Record<string, Row[]> = {};
    for (const name of ["resources", "submissions", "reviews"]) {
      if (![b[name], o[name], t[name]].every(rows => Array.isArray(rows) && rows.every(row => typeof row.id === "string"))) return null;
      const table = `delivery_${name}`;
      out[name] = mergeTable(table, { key: ["id"], mode: "rows" }, {
        ...input,
        base: input.base ? { project: input.base.project, tables: { [table]: b[name] } } : null,
        ours: { project: input.ours.project, tables: { [table]: o[name] } },
        theirs: { project: input.theirs.project, tables: { [table]: t[name] } }
      }, conflicts);
      const time = name === "resources" ? "createdAt" : name === "submissions" ? "submittedAt" : "reviewedAt";
      out[name].sort((a, b) => Number(a[time] ?? 0) - Number(b[time] ?? 0) || String(a.id).localeCompare(String(b.id)));
    }
    return JSON.stringify(out);
  } catch { return null; }
}

function mergeTable(table: string, rule: TableRule, input: MergeInput, conflicts: ConflictNote[]): Row[] {
  const base = byKey(input.base?.tables[table] ?? [], rule.key);
  const ours = byKey(input.ours.tables[table] ?? [], rule.key);
  const theirs = byKey(input.theirs.tables[table] ?? [], rule.key);
  const hasBase = input.base !== null;
  const out: Row[] = [];

  for (const k of sortedKeys(base, ours, theirs)) {
    const b = base.get(k);
    const o = ours.get(k);
    const t = theirs.get(k);

    if (rule.mode === "set" || rule.mode === "append") {
      // Membership: present on both, or added by one side, stays; removed by one side goes — unless there is no base to know what "removed" means.
      if (o && t) out.push(o);
      else if (!hasBase && (o || t)) out.push((o ?? t)!);
      else if (o && !b) out.push(o);
      else if (t && !b) out.push(t);
      continue;
    }

    if (o && !t) {
      if (!b || !hasBase) {
        out.push(o); // created here
      } else if (same(o, b)) {
        // deleted there, untouched here: the delete stands
      } else {
        out.push(o);
        if (rule.mode === "rows") conflicts.push({ table, entity: rule.entity ?? null, entityId: rule.idColumn ? String(o[rule.idColumn]) : k, field: "*", ours: "edited", theirs: "deleted", took: "ours", reason: "edited-over-delete" });
      }
      continue;
    }
    if (t && !o) {
      if (!b || !hasBase) out.push(t);
      else if (same(t, b)) {
        // deleted here, untouched there
      } else {
        out.push(t);
        if (rule.mode === "rows") conflicts.push({ table, entity: rule.entity ?? null, entityId: rule.idColumn ? String(t[rule.idColumn]) : k, field: "*", ours: "deleted", theirs: "edited", took: "theirs", reason: "edited-over-delete" });
      }
      continue;
    }
    if (o && t) {
      if (same(o, t)) out.push(o);
      else if (rule.mode === "quiet") out.push(pickNewer(o, t));
      else out.push(mergeRow(table, rule, b, o, t, input, conflicts));
    }
  }
  return out;
}

/** For ordering rows: the side whose row is not the base's, else theirs. No timestamps to compare, so the caller's rule is "quiet". */
const pickNewer = (o: Row, t: Row): Row => t;

/**
 * Two machines each created an issue and both got APP-42. Ours were never
 * published — nobody has seen them — so they move; theirs may already be in a
 * PR title. Renumbering continues after the highest key either side knows.
 */
function renumberKeys(items: Row[], oursCreated: Set<string>): Renumbered[] {
  const taken = new Map<number, string>();
  let max = 0;
  for (const row of items) {
    const n = Number(row.key_num ?? 0);
    if (n > max) max = n;
  }
  const renumbered: Renumbered[] = [];
  const sorted = [...items].sort((a, b) => (oursCreated.has(String(a.id)) ? 1 : 0) - (oursCreated.has(String(b.id)) ? 1 : 0) || String(a.id).localeCompare(String(b.id)));
  for (const row of sorted) {
    const n = Number(row.key_num ?? 0);
    const holder = taken.get(n);
    if (holder === undefined) {
      taken.set(n, String(row.id));
      continue;
    }
    // Only a row we created and never published may move.
    const mover = oursCreated.has(String(row.id)) ? row : items.find((r) => String(r.id) === holder && oursCreated.has(String(r.id)));
    if (!mover) continue;
    max += 1;
    renumbered.push({ itemId: String(mover.id), from: n, to: max });
    mover.key_num = max;
    taken.set(max, String(mover.id));
    if (mover !== row) taken.set(n, String(row.id));
  }
  return renumbered;
}

export function mergeStates(input: MergeInput): MergeResult {
  const conflicts: ConflictNote[] = [];
  const tables: Record<string, Row[]> = {};
  const names = [...new Set([...Object.keys(input.rules), ...Object.keys(input.ours.tables), ...Object.keys(input.theirs.tables)])].sort();
  for (const table of names) {
    const rule = input.rules[table] ?? { key: ["id"], mode: "rows" as const };
    tables[table] = mergeTable(table, rule, input, conflicts);
  }

  // Rows that cannot satisfy the store's unique indexes are not committed: both
  // snapshots stay intact and the sync reports an error for reconciliation.
  // Anything softer (see evidenceAttention) commits and is flagged instead.
  const activeItems = new Set<string>();
  const sequences = new Set<string>();
  const itemIds = new Set((tables.items ?? []).map(item => String(item.id)));
  for (const delivery of tables.deliveries ?? []) {
    const owner = String(delivery.item_id);
    if (!itemIds.has(owner)) throw new Error(`Delivery sync conflict for ${owner}: its ticket was concurrently deleted`);
    const sequence = `${owner}:${delivery.sequence}`;
    if (sequences.has(sequence) || (delivery.state === "active" && activeItems.has(owner))) throw new Error(`Delivery sync conflict for ${owner}: reconcile concurrent deliveries before syncing`);
    sequences.add(sequence);
    if (delivery.state === "active") activeItems.add(owner);
  }
  const attention = evidenceAttention(tables.items ?? [], tables.deliveries ?? []);

  const baseItems = new Set((input.base?.tables.items ?? []).map((r) => String(r.id)));
  const oursCreated = new Set((input.ours.tables.items ?? []).map((r) => String(r.id)).filter((id) => !baseItems.has(id)));
  const renumbered = tables.items ? renumberKeys(tables.items, oursCreated) : [];

  // The project row: the same field rules, with no log to consult, so theirs wins a tie.
  const projectRule: TableRule = { key: ["id"], mode: "rows", derived: ["updated_at"] };
  const project = same(input.ours.project, input.theirs.project) ? input.ours.project : mergeRow("projects", projectRule, input.base?.project, input.ours.project, input.theirs.project, input, conflicts);

  return { merged: { project, tables }, conflicts, renumbered, attention };
}

/**
 * Where an item's delivery evidence disagrees with itself. The merged rows are
 * still well-formed, so none of this stops a sync: a person settles it in the app.
 */
export function evidenceAttention(items: Row[], deliveries: Row[]): Attention[] {
  const found: Attention[] = [];
  for (const item of items) {
    if (typeof item.evidence_json !== "string") continue;
    const entityId = String(item.id);
    const flag = (code: Attention["code"]) => {
      if (!found.some((a) => a.entityId === entityId && a.code === code)) found.push({ kind: "evidence", entityId, code });
    };
    const evidence = JSON.parse(item.evidence_json) as { resources: Row[]; submissions: Row[]; reviews: Row[] };
    const resources = new Map(evidence.resources.map((r) => [r.id, r]));
    const submissions = new Map(evidence.submissions.map((s) => [s.id, s]));
    for (const submission of evidence.submissions) {
      for (const id of submission.artifactIds as string[]) {
        const resource = resources.get(id);
        if (!resource || resource.role !== "output" || resource.deliveryId !== submission.deliveryId) flag("orphan-artifact");
      }
    }
    const reviewed = new Set<unknown>();
    for (const review of evidence.reviews) {
      if (!submissions.has(review.submissionId)) flag("orphan-review");
      else if (reviewed.has(review.submissionId)) flag("duplicate-review");
      reviewed.add(review.submissionId);
    }
    const latestDelivery = deliveries.filter((d) => d.item_id === item.id).sort((a, b) => Number(a.sequence) - Number(b.sequence)).at(-1);
    if (item.work_type === "general" && latestDelivery) {
      const expected = item.status === "done" ? "completed" : item.status === "cancelled" ? "cancelled" : "active";
      if (latestDelivery.state !== expected) flag("delivery-state");
    }
    const submitted = evidence.submissions.filter((s) => s.deliveryId === latestDelivery?.id).at(-1);
    if (item.status === "done" && submitted && !evidence.reviews.some((r) => r.submissionId === submitted.id && r.decision === "accepted")) flag("done-unaccepted");
  }
  return found;
}
