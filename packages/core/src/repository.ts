import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { ConflictError, HumanLockedError, NotFoundError } from "./errors.js";
import type { Author, CreateItemInput, Item, ItemStatus, ListItemsFilter, OplogEntry, Patch } from "./types.js";

interface ItemRow {
  id: string;
  project_id: string;
  title: string;
  body: string | null;
  kind: "ticket" | "epic";
  status: ItemStatus;
  parent_id: string | null;
  rank: number;
  updated_at: number;
  updated_by: string;
  version: number;
  human_locked: number;
}

/** better-sqlite3 cannot bind booleans; map Item -> bindable params. */
function toSqlParams(item: Item): Record<string, unknown> {
  return {
    ...item,
    humanLocked: item.humanLocked ? 1 : 0
  };
}

function rowToItem(row: ItemRow): Item {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    status: row.status,
    parentId: row.parent_id,
    rank: row.rank,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by as Author,
    version: row.version,
    humanLocked: row.human_locked === 1
  };
}

/** AI writers may never touch these fields on a human-locked item. */
const LOCKED_FIELDS: (keyof Patch)[] = ["title", "body"];

export class ItemsRepository {
  constructor(private readonly db: Db) {}

  list(filter: ListItemsFilter = {}): Item[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId !== undefined) {
      where.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.parentId !== undefined) {
      where.push(filter.parentId === null ? "parent_id IS NULL" : "parent_id = ?");
      if (filter.parentId !== null) params.push(filter.parentId);
    }
    const sql = `SELECT * FROM items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY rank ASC, updated_at DESC`;
    return (this.db.prepare(sql).all(...params) as ItemRow[]).map(rowToItem);
  }

  get(id: string): Item | null {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  create(input: CreateItemInput): Item {
    const id = randomUUID();
    const now = Date.now();
    const item: Item = {
      id,
      projectId: input.projectId ?? "default",
      title: input.title,
      body: input.body ?? null,
      kind: input.kind ?? "ticket",
      status: input.status ?? "backlog",
      parentId: input.parentId ?? null,
      rank: input.rank ?? 0,
      updatedAt: now,
      updatedBy: input.by,
      version: 1,
      humanLocked: false
    };
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO items (id, project_id, title, body, kind, status, parent_id, rank, updated_at, updated_by, version, human_locked)
        VALUES (@id, @projectId, @title, @body, @kind, @status, @parentId, @rank, @updatedAt, @updatedBy, @version, @humanLocked)
      `).run(toSqlParams(item));
      this.appendOplog("create", id, null, null, item, input.by, now);
    });
    tx();
    return item;
  }

  /**
   * Optimistic-lock update. AI writes are refused (ConflictError) when the caller's
   * baseVersion is stale, and refused (HumanLockedError) when touching locked fields
   * on a human-locked item. Human writes always win (last-writer-wins) but still
   * bump version and record the oplog row.
   */
  update(id: string, patch: Patch, by: Author, opts: { baseVersion?: number } = {}): Item {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);

    const isAi = by.startsWith("ai:");
    if (isAi) {
      const conflicting = LOCKED_FIELDS.filter((f) => f in patch);
      if (existing.humanLocked && conflicting.length > 0) {
        throw new HumanLockedError(id, conflicting);
      }
      if (opts.baseVersion !== undefined && opts.baseVersion !== existing.version) {
        throw new ConflictError(id, opts.baseVersion, existing.version);
      }
    }

    const next: Item = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
      updatedBy: by,
      version: existing.version + 1
    };
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE items SET title = @title, body = @body, kind = @kind, status = @status,
          parent_id = @parentId, rank = @rank, updated_at = @updatedAt, updated_by = @updatedBy,
          version = @version, human_locked = @humanLocked
        WHERE id = @id
      `).run(toSqlParams(next));
      this.appendOplog("update", id, existing.version, existing, next, by, next.updatedAt);
    });
    tx();
    return next;
  }

  delete(id: string, by: Author): void {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
      this.appendOplog("delete", id, existing.version, existing, null, by, Date.now());
    });
    tx();
  }

  /** Undo the most recent operation on a given entity (or globally when id omitted). */
  undo(entityId?: string): Item | null {
    const row = entityId
      ? (this.db.prepare("SELECT * FROM oplog WHERE entity = 'item' AND entity_id = ? ORDER BY seq DESC LIMIT 1").get(entityId) as OplogRow | undefined)
      : (this.db.prepare("SELECT * FROM oplog WHERE entity = 'item' ORDER BY seq DESC LIMIT 1").get() as OplogRow | undefined);
    if (!row) return null;
    const before = row.before_json ? (JSON.parse(row.before_json) as Item) : null;
    const after = row.after_json ? (JSON.parse(row.after_json) as Item) : null;

    const tx = this.db.transaction(() => {
      if (row.op === "create") {
        this.db.prepare("DELETE FROM items WHERE id = ?").run(row.entity_id);
      } else if (row.op === "delete") {
        if (before) this.insertItemRow(before);
      } else if (row.op === "update") {
        if (before) {
          this.db.prepare(`
            UPDATE items SET title = @title, body = @body, kind = @kind, status = @status,
              parent_id = @parentId, rank = @rank, updated_at = @updatedAt, updated_by = @updatedBy,
              version = @version, human_locked = @humanLocked
            WHERE id = @id
          `).run(toSqlParams(before));
        }
      }
      this.db.prepare("DELETE FROM oplog WHERE seq = ?").run(row.seq);
    });
    tx();
    return after ?? before;
  }

  recentOplog(limit = 50): OplogEntry[] {
    const rows = this.db.prepare("SELECT * FROM oplog ORDER BY seq DESC LIMIT ?").all(limit) as OplogRow[];
    return rows.map((r) => ({
      seq: r.seq,
      entity: r.entity as "item",
      entityId: r.entity_id,
      op: r.op as OplogEntry["op"],
      baseVersion: r.base_version,
      before: r.before_json ? JSON.parse(r.before_json) : null,
      after: r.after_json ? JSON.parse(r.after_json) : null,
      by: r.by as Author,
      at: r.at
    }));
  }

  private insertItemRow(item: Item): void {
    this.db.prepare(`
      INSERT INTO items (id, project_id, title, body, kind, status, parent_id, rank, updated_at, updated_by, version, human_locked)
      VALUES (@id, @projectId, @title, @body, @kind, @status, @parentId, @rank, @updatedAt, @updatedBy, @version, @humanLocked)
    `).run(toSqlParams(item));
  }

  private appendOplog(
    op: OplogEntry["op"],
    entityId: string,
    baseVersion: number | null,
    before: unknown | null,
    after: unknown | null,
    by: Author,
    at: number
  ): void {
    this.db.prepare(`
      INSERT INTO oplog (entity, entity_id, op, base_version, before_json, after_json, by, at)
      VALUES ('item', ?, ?, ?, ?, ?, ?, ?)
    `).run(entityId, op, baseVersion, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, by, at);
  }
}

interface OplogRow {
  seq: number;
  entity: string;
  entity_id: string;
  op: string;
  base_version: number | null;
  before_json: string | null;
  after_json: string | null;
  by: string;
  at: number;
}
