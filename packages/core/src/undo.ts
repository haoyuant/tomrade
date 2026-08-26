import type { Db } from "./db.js";
import { rowToEntry, type OplogRow } from "./oplog.js";
import { InUseError } from "./errors.js";
import type { Board, Item, OplogEntry, View } from "./types.js";

export interface UndoResult {
  entry: OplogEntry;
  /** One line describing what was reverted, for the toast. */
  summary: string;
}

function restoreItem(db: Db, item: Item): void {
  db.prepare(
    `INSERT INTO items (id, project_id, board_id, key_num, title, body, kind, status, priority, parent_id, rank, updated_at, updated_by, version, human_locked)
     VALUES (@id, @projectId, @boardId, @keyNum, @title, @body, @kind, @status, @priority, @parentId, @rank, @updatedAt, @updatedBy, @version, @humanLocked)
     ON CONFLICT(id) DO UPDATE SET
       board_id = excluded.board_id, title = excluded.title, body = excluded.body, kind = excluded.kind,
       status = excluded.status, priority = excluded.priority, parent_id = excluded.parent_id, rank = excluded.rank,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by, version = excluded.version,
       human_locked = excluded.human_locked`
  ).run({
    id: item.id,
    projectId: item.projectId,
    boardId: item.boardId,
    keyNum: item.keyNum,
    title: item.title,
    body: item.body,
    kind: item.kind,
    status: item.status,
    priority: item.priority,
    parentId: item.parentId,
    rank: item.rank,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
    version: item.version,
    humanLocked: item.humanLocked ? 1 : 0
  });

  db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(item.id);
  for (const name of item.labels ?? []) {
    const label = db.prepare("SELECT id FROM labels WHERE project_id = ? AND name = ?").get(item.projectId, name) as { id: string } | undefined;
    if (label) db.prepare("INSERT OR IGNORE INTO item_labels (item_id, label_id) VALUES (?, ?)").run(item.id, label.id);
  }

  // Relations are edges, and a delete cut both directions, so both are restored
  // from the snapshot. INSERT OR IGNORE keeps this safe for an update snapshot,
  // where the edges were never removed.
  for (const blocked of item.blocks ?? []) {
    db.prepare("INSERT OR IGNORE INTO item_relations (from_item_id, to_item_id, kind) VALUES (?, ?, 'blocks')").run(item.id, blocked);
  }
  for (const blocker of (item as ItemSnapshot).blockedBy ?? []) {
    db.prepare("INSERT OR IGNORE INTO item_relations (from_item_id, to_item_id, kind) VALUES (?, ?, 'blocks')").run(blocker, item.id);
  }
}

interface ItemSnapshot extends Item {
  /** Present on a delete snapshot: the edges pointing *at* this item. */
  blockedBy?: string[];
}

interface BoardSnapshot extends Board {
  views?: ViewRow[];
}

interface ViewRow {
  id: string;
  board_id: string;
  name: string;
  icon: string;
  group_by: string;
  columns_json: string;
  filter_json: string;
  wip_json: string;
  rank: number;
  created_at: number;
  updated_at: number;
}

function restoreViewRows(db: Db, rows: ViewRow[]): void {
  for (const v of rows) {
    db.prepare(
      `INSERT INTO views (id, board_id, name, icon, group_by, columns_json, filter_json, wip_json, rank, created_at, updated_at)
       VALUES (@id, @board_id, @name, @icon, @group_by, @columns_json, @filter_json, @wip_json, @rank, @created_at, @updated_at)
       ON CONFLICT(id) DO NOTHING`
    ).run(v);
  }
}

function restoreView(db: Db, view: View & { ranks?: { item_id: string; rank: number }[] }): void {
  db.prepare(
    `INSERT INTO views (id, board_id, name, icon, group_by, columns_json, filter_json, wip_json, rank, created_at, updated_at)
     VALUES (@id, @boardId, @name, @icon, @groupBy, @columns, @filter, @wip, @rank, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, icon = excluded.icon, group_by = excluded.group_by,
       columns_json = excluded.columns_json, filter_json = excluded.filter_json,
       wip_json = excluded.wip_json, rank = excluded.rank, updated_at = excluded.updated_at`
  ).run({
    id: view.id,
    boardId: view.boardId,
    name: view.name,
    icon: view.icon,
    groupBy: view.groupBy,
    columns: JSON.stringify(view.columns),
    filter: JSON.stringify(view.filter),
    wip: JSON.stringify(view.wip),
    rank: view.rank,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt
  });
  for (const r of view.ranks ?? []) {
    db.prepare("INSERT OR IGNORE INTO view_item_rank (view_id, item_id, rank) VALUES (?, ?, ?)").run(view.id, r.item_id, r.rank);
  }
}

function restoreBoard(db: Db, board: Board): void {
  db.prepare(
    `INSERT INTO boards (id, project_id, name, icon, subtitle, across, sort, note, rank, created_at, updated_at)
     VALUES (@id, @projectId, @name, @icon, @subtitle, @across, @sort, @note, @rank, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, icon = excluded.icon, subtitle = excluded.subtitle,
       note = excluded.note, rank = excluded.rank, updated_at = excluded.updated_at`
  ).run({
    id: board.id,
    projectId: board.projectId,
    name: board.name,
    icon: board.icon,
    subtitle: board.subtitle,
    across: board.across ? 1 : 0,
    sort: board.sort,
    note: board.note,
    rank: board.rank,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt
  });
  restoreViewRows(db, (board as BoardSnapshot).views ?? []);
}

/**
 * Walk the oplog backwards, newest first, across every entity it records.
 * The entry is consumed, so a second call reverts the write before it.
 */
export function undoLast(db: Db, entityId?: string): UndoResult | null {
  const row = entityId
    ? (db.prepare("SELECT * FROM oplog WHERE entity_id = ? ORDER BY seq DESC LIMIT 1").get(entityId) as OplogRow | undefined)
    : (db.prepare("SELECT * FROM oplog ORDER BY seq DESC LIMIT 1").get() as OplogRow | undefined);
  if (!row) return null;

  const entry = rowToEntry(row);
  const named = (entry.before ?? entry.after) as { key?: string; name?: string } | null;
  const label = named?.key ?? named?.name ?? entry.entityId;

  const tx = db.transaction(() => {
    if (entry.entity === "item") {
      if (entry.op === "create") {
        db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(entry.entityId);
        db.prepare("DELETE FROM item_relations WHERE from_item_id = ? OR to_item_id = ?").run(entry.entityId, entry.entityId);
        db.prepare("DELETE FROM view_item_rank WHERE item_id = ?").run(entry.entityId);
        db.prepare("DELETE FROM items WHERE id = ?").run(entry.entityId);
      } else if (entry.before) {
        restoreItem(db, entry.before as Item);
      }
    } else if (entry.entity === "board") {
      if (entry.op === "create") {
        // work may have been moved onto it since; removing the board would
        // strand those issues on a board_id nothing resolves
        const owned = (db.prepare("SELECT COUNT(*) AS n FROM items WHERE board_id = ?").get(entry.entityId) as { n: number }).n;
        if (owned > 0) throw new InUseError(entry.entityId, `That board now owns ${owned} issue${owned === 1 ? "" : "s"} — move them before undoing it`);
        db.prepare("DELETE FROM view_item_rank WHERE view_id IN (SELECT id FROM views WHERE board_id = ?)").run(entry.entityId);
        db.prepare("DELETE FROM views WHERE board_id = ?").run(entry.entityId);
        db.prepare("DELETE FROM boards WHERE id = ?").run(entry.entityId);
      } else if (entry.before) {
        restoreBoard(db, entry.before as Board);
      }
    } else if (entry.entity === "view") {
      if (entry.op === "create") {
        db.prepare("DELETE FROM view_item_rank WHERE view_id = ?").run(entry.entityId);
        db.prepare("DELETE FROM views WHERE id = ?").run(entry.entityId);
      } else if (entry.before) {
        restoreView(db, entry.before as View);
      }
    }
    db.prepare("DELETE FROM oplog WHERE seq = ?").run(row.seq);
  });
  tx();

  const verb = entry.op === "create" ? "Removed" : entry.op === "delete" ? "Restored" : "Reverted";
  return { entry, summary: `${verb} ${label}` };
}
