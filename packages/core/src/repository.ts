import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { ConflictError, HumanLockedError, NotFoundError, PurgeNotPermittedError } from "./errors.js";
import { appendOplog, rowToEntry, type OplogRow } from "./oplog.js";
import type { Author, CreateItemInput, Item, ItemKind, ItemStatus, ListItemsFilter, OplogEntry, Patch, Priority, Provenance } from "./types.js";

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

const SELECT_ITEM =
  "SELECT i.*, COALESCE(p.key_prefix, 'TOM') AS key_prefix FROM items i LEFT JOIN projects p ON p.id = i.project_id";

/** AI writers may never touch these fields on a human-locked item. */
const LOCKED_FIELDS: (keyof Patch)[] = ["title", "body"];

/** Derived, never stored: a locked item reads as locked whoever wrote it last. */
export function provenanceOf(item: Pick<Item, "humanLocked" | "updatedBy">): Provenance {
  if (item.humanLocked) return "locked";
  return item.updatedBy.startsWith("ai:") ? "ai" : "human";
}

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

export class ItemsRepository {
  constructor(private readonly db: Db) {}

  list(filter: ListItemsFilter = {}): Item[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId !== undefined) {
      where.push("i.project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.boardId !== undefined) {
      where.push("i.board_id = ?");
      params.push(filter.boardId);
    }
    if (filter.status !== undefined) {
      where.push("i.status = ?");
      params.push(filter.status);
    }
    if (filter.kind !== undefined) {
      where.push("i.kind = ?");
      params.push(filter.kind);
    }
    if (filter.priority !== undefined) {
      where.push("i.priority = ?");
      params.push(filter.priority);
    }
    if (filter.parentId !== undefined) {
      where.push(filter.parentId === null ? "i.parent_id IS NULL" : "i.parent_id = ?");
      if (filter.parentId !== null) params.push(filter.parentId);
    }
    if (filter.label !== undefined) {
      where.push("i.id IN (SELECT il.item_id FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE l.name = ?)");
      params.push(filter.label);
    }
    const sql = `${SELECT_ITEM} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.rank ASC, i.updated_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as ItemRow[];
    return this.hydrate(rows);
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
    const id = randomUUID();
    const now = Date.now();
    const projectId = input.projectId ?? "default";
    const tx = this.db.transaction((): Item => {
      // The counter lives on the project so a deleted key is never handed out again.
      const proj = this.db.prepare("SELECT key_prefix, next_key_num FROM projects WHERE id = ?").get(projectId) as
        | { key_prefix: string; next_key_num: number }
        | undefined;
      // without the project row there is no counter, and every item would claim key 1
      if (!proj) throw new NotFoundError(projectId);
      const keyNum = proj.next_key_num;
      const prefix = proj.key_prefix;
      this.db.prepare("UPDATE projects SET next_key_num = ? WHERE id = ?").run(keyNum + 1, projectId);
      const item: Item = {
        id,
        projectId,
        boardId: input.boardId,
        keyNum,
        key: `${prefix}-${keyNum}`,
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
      this.db
        .prepare(
          `INSERT INTO items (id, project_id, board_id, key_num, title, body, kind, status, priority, parent_id, rank, updated_at, updated_by, version, human_locked)
           VALUES (@id, @projectId, @boardId, @keyNum, @title, @body, @kind, @status, @priority, @parentId, @rank, @updatedAt, @updatedBy, @version, @humanLocked)`
        )
        .run(toSqlParams(item));
      this.writeLabels(item.id, projectId, item.labels);
      appendOplog(this.db, "item", "create", id, null, null, item, input.by, now);
      return item;
    });
    return tx();
  }

  /**
   * Optimistic-lock update. A caller that supplies baseVersion is asserting which
   * version it read, and a stale assertion is refused (ConflictError) whoever made
   * it — that is what lets the board surface a conflict instead of blind-writing
   * over an agent's change. Omitting baseVersion is an unconditional write.
   *
   * The human/AI asymmetry is about ownership, not staleness: only AI writes are
   * refused (HumanLockedError) on the locked fields of a human-locked item.
   */
  update(id: string, patch: Patch, by: Author, opts: { baseVersion?: number } = {}): Item {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);

    const isAi = by.startsWith("ai:");
    if (isAi && "humanLocked" in patch) {
      throw new HumanLockedError(id, ["humanLocked"]);
    }
    if (isAi) {
      const conflicting = LOCKED_FIELDS.filter((f) => f in patch);
      if (existing.humanLocked && conflicting.length > 0) {
        throw new HumanLockedError(id, conflicting);
      }
    }
    if (opts.baseVersion !== undefined && opts.baseVersion !== existing.version) {
      throw new ConflictError(id, opts.baseVersion, existing.version);
    }

    const next: Item = { ...existing, ...patch, updatedAt: Date.now(), updatedBy: by, version: existing.version + 1 };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE items SET board_id = @boardId, title = @title, body = @body, kind = @kind, status = @status,
             priority = @priority, parent_id = @parentId, rank = @rank, updated_at = @updatedAt,
             updated_by = @updatedBy, version = @version, human_locked = @humanLocked
           WHERE id = @id`
        )
        .run(toSqlParams(next));
      if (patch.labels) this.writeLabels(id, next.projectId, next.labels);
      appendOplog(this.db, "item", "update", id, existing.version, existing, next, by, next.updatedAt);
    });
    tx();
    return next;
  }

  delete(id: string, by: Author): void {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    // Incoming edges live on the other item's row, so the snapshot has to carry
    // them or undo restores the issue with half its relations.
    const blockedBy = (this.db.prepare("SELECT from_item_id FROM item_relations WHERE kind = 'blocks' AND to_item_id = ?").all(id) as {
      from_item_id: string;
    }[]).map((r) => r.from_item_id);
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(id);
      this.db.prepare("DELETE FROM item_relations WHERE from_item_id = ? OR to_item_id = ?").run(id, id);
      this.db.prepare("DELETE FROM view_item_rank WHERE item_id = ?").run(id);
      // children would otherwise point at a dead epic and vanish from every
      // epic-grouped view
      this.db.prepare("UPDATE items SET parent_id = NULL WHERE parent_id = ?").run(id);
      this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
      appendOplog(this.db, "item", "delete", id, existing.version, { ...existing, blockedBy }, null, by, Date.now());
    });
    tx();
  }

  /**
   * Permanent, human-only destroy. `delete` is the reversible one — it leaves a
   * snapshot undo restores from. This leaves nothing: the item's own oplog rows
   * go with it, so no earlier `update` snapshot can put the row back either, and
   * the tombstone it appends carries the key for the audit line and nothing that
   * could rebuild the issue. `undoLast` walks straight past a purge.
   *
   * Children are released, never destroyed with the parent — the tombstone
   * records which ones, because that reparenting is the one part of a purge
   * that touches rows the human never named and cannot be read back afterwards.
   */
  purge(id: string, by: Author, opts: { baseVersion?: number } = {}): void {
    // The reversibility promise is what makes an agent write safe to apply
    // immediately, so the write that cannot be reversed is closed to agents in
    // the class that owns the rule, not just at the IPC boundary.
    if (by !== "human") throw new PurgeNotPermittedError(id, by);
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    // A confirmation is a promise about the issue the human just read. An agent
    // can rewrite it through the shared repository while the sheet is open, so
    // the same staleness check every other write makes is what keeps that
    // promise — and here there is no undo to fall back on.
    if (opts.baseVersion !== undefined && opts.baseVersion !== existing.version) {
      throw new ConflictError(id, opts.baseVersion, existing.version);
    }

    const tx = this.db.transaction(() => {
      const releasedChildren = (this.db.prepare("SELECT id FROM items WHERE parent_id = ?").all(id) as { id: string }[]).map((r) => r.id);
      this.db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(id);
      this.db.prepare("DELETE FROM item_relations WHERE from_item_id = ? OR to_item_id = ?").run(id, id);
      this.db.prepare("DELETE FROM view_item_rank WHERE item_id = ?").run(id);
      this.db.prepare("UPDATE items SET parent_id = NULL WHERE parent_id = ?").run(id);
      this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
      // The whole point: with its history gone there is no snapshot left to
      // restore from, whatever anyone undoes afterwards.
      this.db.prepare("DELETE FROM oplog WHERE entity = 'item' AND entity_id = ?").run(id);
      // Ids, not a snapshot — they name what moved without being able to
      // rebuild anything.
      appendOplog(
        this.db,
        "item",
        "purge",
        id,
        null,
        { key: existing.key, title: existing.title, projectId: existing.projectId, releasedChildren },
        null,
        by,
        Date.now()
      );
    });
    tx();
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

  recentOplog(limit = 50): OplogEntry[] {
    return (this.db.prepare("SELECT * FROM oplog ORDER BY at DESC, seq DESC LIMIT ?").all(limit) as OplogRow[]).map(rowToEntry);
  }

  /** History of one item, newest first. */
  historyFor(itemId: string, limit = 20): OplogEntry[] {
    return (
      this.db.prepare("SELECT * FROM oplog WHERE entity = 'item' AND entity_id = ? ORDER BY at DESC, seq DESC LIMIT ?").all(itemId, limit) as OplogRow[]
    ).map(rowToEntry);
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
