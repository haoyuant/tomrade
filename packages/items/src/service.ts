import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import type { Db } from "@tomrade/db";
import type { Oplog } from "@tomrade/oplog";
import { write } from "@tomrade/write";
import { DependencyCycleError, NotFoundError, type Author, type CreateItemInput, type Item, type ItemKind, type ItemStatus, type ListItemsFilter, type Patch, type Priority } from "@tomrade/domain";
import { registerChannels } from "./channels.js";
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

function baseItem(row: ItemRow): Omit<Item, "labels" | "blocks"> {
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
  const { labels: _labels, blocks: _blocks, key: _key, ...rest } = item;
  return { ...rest, humanLocked: item.humanLocked ? 1 : 0 };
}

export class Items extends Service {
  static provide = "items";
  static inject = ["db", "oplog"];

  constructor(ctx: Context) {
    super(ctx, "items");
  }

  [Service.init]() {
    this.ctx.inject(["tools", "boards"], registerTools);
    this.ctx.inject(["ipc"], registerChannels);
  }

  private get db(): Db {
    return this.ctx.db;
  }

  private get oplog(): Oplog {
    return this.ctx.oplog;
  }

  list(filter: ListItemsFilter = {}): Item[] {
    const where: string[] = [];
    const params: unknown[] = [];
    const eq = (column: string, value: unknown) => {
      where.push(`${column} = ?`);
      params.push(value);
    };
    if (filter.projectId !== undefined) eq("i.project_id", filter.projectId);
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
    return this.hydrate(this.db.prepare(sql).all(...params) as ItemRow[]);
  }

  get(id: string): Item | null {
    const row = this.db.prepare(`${SELECT_ITEM} WHERE i.id = ?`).get(id) as ItemRow | undefined;
    return row ? this.hydrate([row])[0] : null;
  }

  /** Resolve a human key ('TOM-142') within a project. */
  getByKey(projectId: string, key: string): Item | null {
    const num = Number(key.split("-").pop());
    if (!Number.isFinite(num)) return null;
    const row = this.db.prepare(`${SELECT_ITEM} WHERE i.project_id = ? AND i.key_num = ?`).get(projectId, num) as ItemRow | undefined;
    return row ? this.hydrate([row])[0] : null;
  }

  create(input: CreateItemInput): Item {
    const projectId = input.projectId ?? "default";
    // The counter lives on the project so a deleted key is never handed out again.
    const proj = this.db.prepare("SELECT key_prefix, next_key_num FROM projects WHERE id = ?").get(projectId) as { key_prefix: string; next_key_num: number } | undefined;
    if (!proj) throw new NotFoundError(projectId);
    const now = Date.now();
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
      updatedAt: now,
      updatedBy: input.by,
      version: 1,
      humanLocked: false
    };
    return write(this.ctx, { entity: "item", op: "create", id: item.id, by: input.by, before: null, after: item }, () =>
      this.db.transaction(() => {
        this.db.prepare("UPDATE projects SET next_key_num = ? WHERE id = ?").run(item.keyNum + 1, projectId);
        this.db
          .prepare(
            `INSERT INTO items (id, project_id, board_id, key_num, title, body, kind, status, priority, parent_id, rank, updated_at, updated_by, version, human_locked)
             VALUES (@id, @projectId, @boardId, @keyNum, @title, @body, @kind, @status, @priority, @parentId, @rank, @updatedAt, @updatedBy, @version, @humanLocked)`
          )
          .run(toSqlParams(item));
        this.writeLabels(item.id, projectId, item.labels);
        this.oplog.append({ entity: "item", op: "create", entityId: item.id, baseVersion: null, before: null, after: item, by: input.by, at: now });
        return item;
      })
    );
  }

  /**
   * Omitting baseVersion is an unconditional write; supplying one asserts the
   * version the caller read, and the policy refuses a stale assertion whoever made it.
   */
  update(id: string, patch: Patch, by: Author, opts: { baseVersion?: number } = {}): Item {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    if (patch.blocks) patch = { ...patch, blocks: this.checkBlocks(existing, patch.blocks) };
    const next: Item = { ...existing, ...patch, updatedAt: Date.now(), updatedBy: by, version: existing.version + 1 };
    return write(this.ctx, { entity: "item", op: "update", id, by, baseVersion: opts.baseVersion, before: existing, after: next, patch }, () =>
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE items SET board_id = @boardId, title = @title, body = @body, kind = @kind, status = @status,
               priority = @priority, parent_id = @parentId, rank = @rank, updated_at = @updatedAt,
               updated_by = @updatedBy, version = @version, human_locked = @humanLocked
             WHERE id = @id`
          )
          .run(toSqlParams(next));
        if (patch.labels) this.writeLabels(id, next.projectId, next.labels);
        if (patch.blocks) this.writeBlocks(id, next.blocks);
        this.oplog.append({ entity: "item", op: "update", entityId: id, baseVersion: existing.version, before: existing, after: next, by, at: next.updatedAt });
        return next;
      })
    );
  }

  /** Reversible: the snapshot carries labels and relations in both directions. */
  delete(id: string, by: Author): void {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    const blockedBy = (this.db.prepare("SELECT from_item_id FROM item_relations WHERE kind = 'blocks' AND to_item_id = ?").all(id) as { from_item_id: string }[]).map((r) => r.from_item_id);
    write(this.ctx, { entity: "item", op: "delete", id, by, before: existing, after: null }, () =>
      this.db.transaction(() => {
        this.detach(id);
        this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
        this.oplog.append({ entity: "item", op: "delete", entityId: id, baseVersion: existing.version, before: { ...existing, blockedBy }, after: null, by, at: Date.now() });
      })
    );
  }

  /**
   * Permanent. The item's own history goes with it, so no snapshot can put the
   * row back; the tombstone names what happened and nothing that could rebuild it.
   */
  purge(id: string, by: Author, opts: { baseVersion?: number } = {}): void {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    write(this.ctx, { entity: "item", op: "purge", id, by, baseVersion: opts.baseVersion, before: existing, after: null }, () =>
      this.db.transaction(() => {
        const releasedChildren = (this.db.prepare("SELECT id FROM items WHERE parent_id = ?").all(id) as { id: string }[]).map((r) => r.id);
        this.detach(id);
        this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
        this.oplog.erase("item", id);
        this.oplog.append({
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

  /**
   * "Blocked until done" only means something on a DAG, so a patch that would
   * close a loop is refused before the write path ever sees it. Returns the
   * normalized list: de-duplicated, self-edges dropped, every target a live
   * item of the same project.
   */
  private checkBlocks(item: Item, raw: string[]): string[] {
    const targets = [...new Set(raw)].filter((t) => t !== item.id);
    if (targets.length) {
      const placeholders = targets.map(() => "?").join(",");
      const known = new Set(
        (this.db.prepare(`SELECT id FROM items WHERE project_id = ? AND id IN (${placeholders})`).all(item.projectId, ...targets) as { id: string }[]).map((r) => r.id)
      );
      for (const t of targets) if (!known.has(t)) throw new NotFoundError(t);
    }
    // The proposed graph: everyone else's edges as stored, this item's replaced.
    const edges = new Map<string, string[]>([[item.id, targets]]);
    const rel = this.db
      .prepare("SELECT r.from_item_id AS f, r.to_item_id AS t FROM item_relations r JOIN items i ON i.id = r.from_item_id WHERE r.kind = 'blocks' AND i.project_id = ? AND r.from_item_id != ?")
      .all(item.projectId, item.id) as { f: string; t: string }[];
    for (const { f, t } of rel) {
      const bucket = edges.get(f);
      if (bucket) bucket.push(t);
      else edges.set(f, [t]);
    }
    const keyOf = (id: string) => (this.db.prepare("SELECT i.key_num, COALESCE(p.key_prefix, 'TOM') AS kp FROM items i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?").get(id) as { key_num: number; kp: string } | undefined);
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
  private writeBlocks(itemId: string, targets: string[]): void {
    this.db.prepare("DELETE FROM item_relations WHERE from_item_id = ? AND kind = 'blocks'").run(itemId);
    for (const t of targets) this.db.prepare("INSERT OR IGNORE INTO item_relations (from_item_id, to_item_id, kind) VALUES (?, ?, 'blocks')").run(itemId, t);
  }

  /** Record that `id` blocks `blockedId`. */
  addRelation(id: string, blockedId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO item_relations (from_item_id, to_item_id, kind) VALUES (?, ?, 'blocks')").run(id, blockedId);
  }

  removeRelation(id: string, blockedId: string): void {
    this.db.prepare("DELETE FROM item_relations WHERE from_item_id = ? AND to_item_id = ? AND kind = 'blocks'").run(id, blockedId);
  }

  labelsFor(projectId: string): string[] {
    return (this.db.prepare("SELECT name FROM labels WHERE project_id = ? ORDER BY name ASC").all(projectId) as { name: string }[]).map((r) => r.name);
  }

  /** Cut labels, edges and ranks, and release children so they never point at a dead epic. */
  private detach(id: string): void {
    this.db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(id);
    this.db.prepare("DELETE FROM item_relations WHERE from_item_id = ? OR to_item_id = ?").run(id, id);
    this.db.prepare("DELETE FROM view_item_rank WHERE item_id = ?").run(id);
    this.db.prepare("UPDATE items SET parent_id = NULL WHERE parent_id = ?").run(id);
  }

  private hydrate(rows: ItemRow[]): Item[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const labelRows = this.db
      .prepare(`SELECT il.item_id, l.name FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id IN (${placeholders}) ORDER BY l.name`)
      .all(...ids) as { item_id: string; name: string }[];
    const relRows = this.db
      .prepare(`SELECT from_item_id, to_item_id FROM item_relations WHERE kind = 'blocks' AND from_item_id IN (${placeholders})`)
      .all(...ids) as { from_item_id: string; to_item_id: string }[];
    const labels = groupBy(labelRows, (r) => r.item_id, (r) => r.name);
    const blocks = groupBy(relRows, (r) => r.from_item_id, (r) => r.to_item_id);
    return rows.map((row) => ({ ...baseItem(row), labels: labels.get(row.id) ?? [], blocks: blocks.get(row.id) ?? [] }));
  }

  /** Replace an item's labels, creating any that are new to the project. */
  private writeLabels(itemId: string, projectId: string, names: string[]): void {
    this.db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(itemId);
    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      this.db.prepare("INSERT OR IGNORE INTO labels (id, project_id, name) VALUES (?, ?, ?)").run(randomUUID(), projectId, name);
      const label = this.db.prepare("SELECT id FROM labels WHERE project_id = ? AND name = ?").get(projectId, name) as { id: string };
      this.db.prepare("INSERT OR IGNORE INTO item_labels (item_id, label_id) VALUES (?, ?)").run(itemId, label.id);
    }
  }
}
