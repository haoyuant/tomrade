import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import type { ProjectDb } from "@tomrade/db";
import type { Oplog } from "@tomrade/oplog";
import { write } from "@tomrade/write";
import {
  DependencyCycleError,
  NotFoundError,
  type Author,
  type CreateItemInput,
  type FieldValue,
  type FilterClause,
  type Item,
  type ItemKind,
  type ItemStatus,
  type ListItemsFilter,
  type Patch,
  type Priority,
  type SortKey
} from "@tomrade/domain";
import type { Fields, StoredValue } from "@tomrade/fields";
import { registerChannels } from "./channels.js";
import { compileQuery } from "./query.js";
import { registerTools } from "./tools.js";

declare module "cordis" {
  interface Context {
    items: Items;
  }
}

interface ItemRow {
  id: string;
  project_id: string;
  board_id: string;
  key_num: number;
  key_prefix: string;
  title: string;
  body: string | null;
  kind: ItemKind;
  status: ItemStatus;
  priority: number;
  parent_id: string | null;
  rank: number;
  updated_at: number;
  updated_by: string;
  version: number;
  human_locked: number;
}

const SELECT_ITEM = "SELECT i.*, COALESCE(p.key_prefix, 'TOM') AS key_prefix FROM items i LEFT JOIN projects p ON p.id = i.project_id";

function baseItem(row: ItemRow): Omit<Item, "labels" | "blocks" | "blockedBy" | "fields"> {
  return {
    id: row.id,
    projectId: row.project_id,
    boardId: row.board_id,
    keyNum: row.key_num,
    key: `${row.key_prefix}-${row.key_num}`,
    title: row.title,
    body: row.body,
    kind: row.kind,
    status: row.status,
    priority: row.priority as Priority,
    parentId: row.parent_id,
    rank: row.rank,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by as Author,
    version: row.version,
    humanLocked: row.human_locked === 1
  };
}

function groupBy<T, V>(rows: T[], key: (r: T) => string, value: (r: T) => V): Map<string, V[]> {
  const out = new Map<string, V[]>();
  for (const r of rows) {
    const k = key(r);
    const bucket = out.get(k);
    if (bucket) bucket.push(value(r));
    else out.set(k, [value(r)]);
  }
  return out;
}

/** better-sqlite3 cannot bind booleans. */
function toSqlParams(item: Item): Record<string, unknown> {
  const { labels: _labels, blocks: _blocks, blockedBy: _blockedBy, fields: _fields, key: _key, ...rest } = item;
  return { ...rest, humanLocked: item.humanLocked ? 1 : 0 };
}

/** The stored shape read back as a value: a number if one is there, the text otherwise. */
const valueOfRow = (r: { num: number | null; text: string | null }): FieldValue => (r.num !== null ? r.num : (r.text as string));

export interface ItemQuery {
  projectId: string;
  filter?: FilterClause[];
  sortBy?: SortKey[];
}

export class Items extends Service {
  static provide = "items";
  static inject = ["db", "oplog", "fields"];

  constructor(ctx: Context) {
    super(ctx, "items");
  }

  [Service.init]() {
    this.ctx.inject(["tools", "boards"], registerTools);
    this.ctx.inject(["ipc"], registerChannels);
  }

  /** Resolved per call: a rebuild swaps a project's file underneath, so nothing holds a handle. */
  private db(projectId: string): ProjectDb {
    if (!this.ctx.db.has(projectId)) throw new NotFoundError(projectId);
    return this.ctx.db.for(projectId);
  }

  private get oplog(): Oplog {
    return this.ctx.oplog;
  }

  private get fields(): Fields {
    return this.ctx.fields;
  }

  /** Without a project the list is the union over every open project, for surfaces that span them. */
  list(filter: ListItemsFilter = {}): Item[] {
    const where: string[] = [];
    const params: unknown[] = [];
    const eq = (column: string, value: unknown) => {
      where.push(`${column} = ?`);
      params.push(value);
    };
    if (filter.boardId !== undefined) eq("i.board_id", filter.boardId);
    if (filter.status !== undefined) eq("i.status", filter.status);
    if (filter.kind !== undefined) eq("i.kind", filter.kind);
    if (filter.priority !== undefined) eq("i.priority", filter.priority);
    if (filter.parentId === null) where.push("i.parent_id IS NULL");
    else if (filter.parentId !== undefined) eq("i.parent_id", filter.parentId);
    if (filter.label !== undefined) {
      where.push("i.id IN (SELECT il.item_id FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE l.name = ?)");
      params.push(filter.label);
    }
    const sql = `${SELECT_ITEM} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.rank ASC, i.updated_at DESC`;
    const projectIds = filter.projectId !== undefined ? [filter.projectId] : this.ctx.db.openIds();
    return projectIds.flatMap((projectId) => {
      if (!this.ctx.db.has(projectId)) return [];
      const db = this.ctx.db.for(projectId);
      return this.hydrate(db, db.prepare(sql).all(...params) as ItemRow[]);
    });
  }

  /**
   * A view's query, run in SQL: filter clauses over any field, sort keys over
   * any sortable field, empty values last, ties by rank then recency. What the
   * renderer computes over its cached list for the live board, this computes
   * for tools and for projects too large to hold in memory.
   */
  query(q: ItemQuery): Item[] {
    const db = this.db(q.projectId);
    const defs = new Map(this.fields.list(q.projectId).map((f) => [f.id, f]));
    const compiled = compileQuery({ filter: q.filter ?? [], sortBy: q.sortBy ?? [] }, defs);
    const sql = `${SELECT_ITEM} ${compiled.joins.join(" ")} WHERE i.project_id = ?${compiled.where.length ? " AND " + compiled.where.join(" AND ") : ""} ORDER BY ${[...compiled.orderBy, "i.rank ASC", "i.updated_at DESC"].join(", ")}`;
    // The project id binds after the joins and before the clause params.
    const joinCount = compiled.joins.length;
    const params = [...compiled.params.slice(0, joinCount), q.projectId, ...compiled.params.slice(joinCount)];
    return this.hydrate(db, db.prepare(sql).all(...params) as ItemRow[]);
  }

  get(projectId: string, id: string): Item | null {
    if (!this.ctx.db.has(projectId)) return null;
    const db = this.ctx.db.for(projectId);
    const row = db.prepare(`${SELECT_ITEM} WHERE i.id = ?`).get(id) as ItemRow | undefined;
    return row ? this.hydrate(db, [row])[0] : null;
  }

  /** Resolve a human key ('TOM-142') within a project. */
  getByKey(projectId: string, key: string): Item | null {
    if (!this.ctx.db.has(projectId)) return null;
    const num = Number(key.split("-").pop());
    if (!Number.isFinite(num)) return null;
    const db = this.ctx.db.for(projectId);
    const row = db.prepare(`${SELECT_ITEM} WHERE i.project_id = ? AND i.key_num = ?`).get(projectId, num) as ItemRow | undefined;
    return row ? this.hydrate(db, [row])[0] : null;
  }

  create(input: CreateItemInput): Item {
    const projectId = input.projectId;
    if (!projectId) throw new NotFoundError("(no projectId) — every item belongs to a project; call list_projects and pass one");
    const db = this.db(projectId);
    // The counter lives on the project so a deleted key is never handed out again.
    const proj = db.prepare("SELECT key_prefix, next_key_num FROM projects WHERE id = ?").get(projectId) as { key_prefix: string; next_key_num: number } | undefined;
    if (!proj) throw new NotFoundError(projectId);
    const now = Date.now();
    const stored = this.fields.normalize(projectId, input.fields ?? {});
    const item: Item = {
      id: randomUUID(),
      projectId,
      boardId: input.boardId,
      keyNum: proj.next_key_num,
      key: `${proj.key_prefix}-${proj.next_key_num}`,
      title: input.title,
      body: input.body ?? null,
      kind: input.kind ?? "ticket",
      status: input.status ?? "backlog",
      priority: input.priority ?? 2,
      parentId: input.parentId ?? null,
      rank: input.rank ?? 0,
      labels: input.labels ?? [],
      blocks: [],
      blockedBy: [],
      fields: mergeFields({}, input.fields ?? {}, stored),
      updatedAt: now,
      updatedBy: input.by,
      version: 1,
      humanLocked: false
    };
    return write(this.ctx, { projectId, entity: "item", op: "create", id: item.id, by: input.by, before: null, after: item }, () =>
      db.transaction(() => {
        db.prepare("UPDATE projects SET next_key_num = ? WHERE id = ?").run(item.keyNum + 1, projectId);
        db.prepare(
          `INSERT INTO items (id, project_id, board_id, key_num, title, body, kind, status, priority, parent_id, rank, updated_at, updated_by, version, human_locked)
           VALUES (@id, @projectId, @boardId, @keyNum, @title, @body, @kind, @status, @priority, @parentId, @rank, @updatedAt, @updatedBy, @version, @humanLocked)`
        ).run(toSqlParams(item));
        this.writeLabels(db, item.id, projectId, item.labels);
        this.writeValues(db, item.id, stored);
        this.oplog.append(projectId, { entity: "item", op: "create", entityId: item.id, baseVersion: null, before: null, after: item, by: input.by, at: now });
        return item;
      })
    );
  }

  /**
   * Omitting baseVersion is an unconditional write; supplying one asserts the
   * version the caller read, and the policy refuses a stale assertion whoever made it.
   */
  update(projectId: string, id: string, patch: Patch, by: Author, opts: { baseVersion?: number } = {}): Item {
    const db = this.db(projectId);
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    if (patch.blocks) patch = { ...patch, blocks: this.checkBlocks(db, existing, patch.blocks) };
    // Validated before the write path sees it, so a bad value is refused as a bad value, not as a conflict.
    const stored = patch.fields ? this.fields.normalize(projectId, patch.fields) : null;
    const { fields: fieldsPatch, ...rest } = patch;
    const next: Item = { ...existing, ...rest, fields: mergeFields(existing.fields, fieldsPatch ?? {}, stored ?? new Map()), updatedAt: Date.now(), updatedBy: by, version: existing.version + 1 };
    return write(this.ctx, { projectId, entity: "item", op: "update", id, by, baseVersion: opts.baseVersion, before: existing, after: next, patch }, () =>
      db.transaction(() => {
        db.prepare(
          `UPDATE items SET board_id = @boardId, title = @title, body = @body, kind = @kind, status = @status,
             priority = @priority, parent_id = @parentId, rank = @rank, updated_at = @updatedAt,
             updated_by = @updatedBy, version = @version, human_locked = @humanLocked
           WHERE id = @id`
        ).run(toSqlParams(next));
        if (patch.labels) this.writeLabels(db, id, projectId, next.labels);
        if (patch.blocks) this.writeBlocks(db, id, next.blocks);
        if (stored) this.writeValues(db, id, stored);
        this.oplog.append(projectId, { entity: "item", op: "update", entityId: id, baseVersion: existing.version, before: existing, after: next, by, at: next.updatedAt });
        return next;
      })
    );
  }

  /** Reversible: the snapshot carries labels and relations in both directions. */
  delete(projectId: string, id: string, by: Author): void {
    const db = this.db(projectId);
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    write(this.ctx, { projectId, entity: "item", op: "delete", id, by, before: existing, after: null }, () =>
      db.transaction(() => {
        this.detach(db, id);
        db.prepare("DELETE FROM items WHERE id = ?").run(id);
        this.oplog.append(projectId, { entity: "item", op: "delete", entityId: id, baseVersion: existing.version, before: existing, after: null, by, at: Date.now() });
      })
    );
  }

  /**
   * Permanent. The item's own history goes with it, so no snapshot can put the
   * row back; the tombstone names what happened and nothing that could rebuild it.
   */
  purge(projectId: string, id: string, by: Author, opts: { baseVersion?: number } = {}): void {
    const db = this.db(projectId);
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    write(this.ctx, { projectId, entity: "item", op: "purge", id, by, baseVersion: opts.baseVersion, before: existing, after: null }, () =>
      db.transaction(() => {
        const releasedChildren = (db.prepare("SELECT id FROM items WHERE parent_id = ?").all(id) as { id: string }[]).map((r) => r.id);
        this.detach(db, id);
        db.prepare("DELETE FROM items WHERE id = ?").run(id);
        this.oplog.erase(projectId, "item", id);
        this.oplog.append(projectId, {
          entity: "item",
          op: "purge",
          entityId: id,
          baseVersion: null,
          before: { key: existing.key, title: existing.title, projectId: existing.projectId, releasedChildren },
          after: null,
          by,
          at: Date.now()
        });
      })
    );
  }

  /** Bulk-move issues between workstreams, one logged update each, so every move is undoable and travels. */
  moveToBoard(projectId: string, itemIds: string[], toBoardId: string, by: Author = "human"): number {
    let moved = 0;
    for (const id of itemIds) {
      const existing = this.get(projectId, id);
      if (!existing || existing.boardId === toBoardId) continue;
      this.update(projectId, id, { boardId: toBoardId }, by);
      moved += 1;
    }
    return moved;
  }

  /**
   * "Blocked until done" only means something on a DAG, so a patch that would
   * close a loop is refused before the write path ever sees it. Returns the
   * normalized list: de-duplicated, self-edges dropped, every target a live
   * item of the same project.
   */
  private checkBlocks(db: ProjectDb, item: Item, raw: string[]): string[] {
    const targets = [...new Set(raw)].filter((t) => t !== item.id);
    if (targets.length) {
      const placeholders = targets.map(() => "?").join(",");
      const known = new Set((db.prepare(`SELECT id FROM items WHERE project_id = ? AND id IN (${placeholders})`).all(item.projectId, ...targets) as { id: string }[]).map((r) => r.id));
      for (const t of targets) if (!known.has(t)) throw new NotFoundError(t);
    }
    // The proposed graph: everyone else's edges as stored, this item's replaced.
    const edges = new Map<string, string[]>([[item.id, targets]]);
    const rel = db
      .prepare("SELECT r.from_item_id AS f, r.to_item_id AS t FROM item_relations r JOIN items i ON i.id = r.from_item_id WHERE r.kind = 'blocks' AND i.project_id = ? AND r.from_item_id != ?")
      .all(item.projectId, item.id) as { f: string; t: string }[];
    for (const { f, t } of rel) {
      const bucket = edges.get(f);
      if (bucket) bucket.push(t);
      else edges.set(f, [t]);
    }
    const keyOf = (id: string) => db.prepare("SELECT i.key_num, COALESCE(p.key_prefix, 'TOM') AS kp FROM items i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?").get(id) as { key_num: number; kp: string } | undefined;
    const label = (id: string) => {
      const row = keyOf(id);
      return row ? `${row.kp}-${row.key_num}` : id;
    };
    const seen = new Set<string>();
    const walk = (node: string, path: string[]): void => {
      for (const nxt of edges.get(node) ?? []) {
        if (nxt === item.id) throw new DependencyCycleError(item.id, [...path, nxt].map(label));
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        walk(nxt, [...path, nxt]);
      }
    };
    walk(item.id, [item.id]);
    return targets;
  }

  /** Replace an item's outgoing edges to match the patched list. */
  private writeBlocks(db: ProjectDb, itemId: string, targets: string[]): void {
    db.prepare("DELETE FROM item_relations WHERE from_item_id = ? AND kind = 'blocks'").run(itemId);
    for (const t of targets) db.prepare("INSERT OR IGNORE INTO item_relations (from_item_id, to_item_id, kind) VALUES (?, ?, 'blocks')").run(itemId, t);
  }

  /** Record that `id` blocks `blockedId`. A logged blocks edit, so seeding and undo agree. */
  addRelation(projectId: string, id: string, blockedId: string, by: Author = "human"): void {
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    if (existing.blocks.includes(blockedId)) return;
    this.update(projectId, id, { blocks: [...existing.blocks, blockedId] }, by);
  }

  removeRelation(projectId: string, id: string, blockedId: string, by: Author = "human"): void {
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    if (!existing.blocks.includes(blockedId)) return;
    this.update(projectId, id, { blocks: existing.blocks.filter((t) => t !== blockedId) }, by);
  }

  labelsFor(projectId: string): string[] {
    return (this.db(projectId).prepare("SELECT name FROM labels WHERE project_id = ? ORDER BY name ASC").all(projectId) as { name: string }[]).map((r) => r.name);
  }

  /** Cut labels, values, edges and ranks, and release children so they never point at a dead epic. */
  private detach(db: ProjectDb, id: string): void {
    db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(id);
    db.prepare("DELETE FROM item_values WHERE item_id = ?").run(id);
    db.prepare("DELETE FROM item_relations WHERE from_item_id = ? OR to_item_id = ?").run(id, id);
    db.prepare("DELETE FROM view_item_rank WHERE item_id = ?").run(id);
    db.prepare("UPDATE items SET parent_id = NULL WHERE parent_id = ?").run(id);
  }

  private hydrate(db: ProjectDb, rows: ItemRow[]): Item[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const labelRows = db
      .prepare(`SELECT il.item_id, l.name FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id IN (${placeholders}) ORDER BY l.name`)
      .all(...ids) as { item_id: string; name: string }[];
    const relRows = db
      .prepare(`SELECT from_item_id, to_item_id FROM item_relations WHERE kind = 'blocks' AND (from_item_id IN (${placeholders}) OR to_item_id IN (${placeholders}))`)
      .all(...ids, ...ids) as { from_item_id: string; to_item_id: string }[];
    const valueRows = db.prepare(`SELECT item_id, field_id, num, text FROM item_values WHERE item_id IN (${placeholders})`).all(...ids) as {
      item_id: string;
      field_id: string;
      num: number | null;
      text: string | null;
    }[];
    const labels = groupBy(labelRows, (r) => r.item_id, (r) => r.name);
    const blocks = groupBy(relRows, (r) => r.from_item_id, (r) => r.to_item_id);
    const blockedBy = groupBy(relRows, (r) => r.to_item_id, (r) => r.from_item_id);
    const values = groupBy(valueRows, (r) => r.item_id, (r) => [r.field_id, valueOfRow(r)] as const);
    return rows.map((row) => ({
      ...baseItem(row),
      labels: labels.get(row.id) ?? [],
      blocks: blocks.get(row.id) ?? [],
      blockedBy: blockedBy.get(row.id) ?? [],
      fields: Object.fromEntries(values.get(row.id) ?? [])
    }));
  }

  /** Upsert or clear one row per field named in the patch; untouched fields keep their rows. */
  private writeValues(db: ProjectDb, itemId: string, stored: Map<string, StoredValue | null>): void {
    for (const [fieldId, value] of stored) {
      if (value === null) db.prepare("DELETE FROM item_values WHERE item_id = ? AND field_id = ?").run(itemId, fieldId);
      else {
        db.prepare("INSERT INTO item_values (item_id, field_id, num, text) VALUES (?, ?, ?, ?) ON CONFLICT(item_id, field_id) DO UPDATE SET num = excluded.num, text = excluded.text").run(itemId, fieldId, value.num, value.text);
      }
    }
  }

  /** Replace an item's labels, creating any that are new to the project. */
  private writeLabels(db: ProjectDb, itemId: string, projectId: string, names: string[]): void {
    db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(itemId);
    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      db.prepare("INSERT OR IGNORE INTO labels (id, project_id, name) VALUES (?, ?, ?)").run(randomUUID(), projectId, name);
      const label = db.prepare("SELECT id FROM labels WHERE project_id = ? AND name = ?").get(projectId, name) as { id: string };
      db.prepare("INSERT OR IGNORE INTO item_labels (item_id, label_id) VALUES (?, ?)").run(itemId, label.id);
    }
  }
}

/**
 * The merged `fields` an item carries after a patch: a key the registry
 * normalized to nothing (null, or an unticked checkbox) is dropped, absent keys survive.
 */
function mergeFields(current: Record<string, FieldValue>, patch: Record<string, FieldValue | null>, stored: Map<string, StoredValue | null>): Record<string, FieldValue> {
  const out = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || stored.get(k) === null) delete out[k];
    else out[k] = v;
  }
  return out;
}
