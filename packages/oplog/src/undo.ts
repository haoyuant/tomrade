import type { Db } from "@tomrade/db";
import { InUseError, VIEW_KIND_META, type Board, type Item, type OplogEntry, type UndoResult, type UndoRunResult, type View, type ViewKind } from "@tomrade/domain";
import { rowToEntry, type OplogRow } from "./rows.js";

interface ViewRow {
  id: string;
  board_id: string;
  name: string;
  icon: string;
  group_by: string;
  kind: string;
  columns_json: string;
  filter_json: string;
  wip_json: string;
  rank: number;
  created_at: number;
  updated_at: number;
}

interface BoardSnapshot extends Board {
  views?: ViewRow[];
}

interface ViewSnapshot extends View {
  ranks?: { item_id: string; rank: number }[];
}

/**
 * Was this id permanently destroyed? The test is the tombstone, not whether the
 * row exists now: a soft-deleted counterpart comes back the moment someone
 * undoes that delete, so a snapshot naming it must still round-trip.
 */
export const wasPurged = (db: Db, id: string): boolean => !!db.prepare("SELECT 1 FROM oplog WHERE op = 'purge' AND entity_id = ?").get(id);

function restoreItem(db: Db, item: Item): void {
  // A snapshot written before a purge can still name what the purge destroyed;
  // restoring the issue must not restore a dangling parent or edge with it.
  const parentId = item.parentId && wasPurged(db, item.parentId) ? null : item.parentId;
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
    parentId,
    rank: item.rank,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
    version: item.version,
    humanLocked: item.humanLocked ? 1 : 0
  });

  // Values are replaced to match the snapshot; a field deleted since has no row to land on and is skipped.
  db.prepare("DELETE FROM item_values WHERE item_id = ?").run(item.id);
  for (const [fieldId, value] of Object.entries(item.fields ?? {})) {
    if (!db.prepare("SELECT 1 FROM fields WHERE id = ?").get(fieldId)) continue;
    db.prepare("INSERT INTO item_values (item_id, field_id, num, text) VALUES (?, ?, ?, ?)").run(item.id, fieldId, typeof value === "number" ? value : null, typeof value === "number" ? null : value);
  }

  db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(item.id);
  for (const name of item.labels ?? []) {
    const label = db.prepare("SELECT id FROM labels WHERE project_id = ? AND name = ?").get(item.projectId, name) as { id: string } | undefined;
    if (label) db.prepare("INSERT OR IGNORE INTO item_labels (item_id, label_id) VALUES (?, ?)").run(item.id, label.id);
  }

  // Outgoing edges are replaced to match the snapshot — an update can add or
  // remove blocks now, so an undo has to take back both kinds of change.
  db.prepare("DELETE FROM item_relations WHERE from_item_id = ? AND kind = 'blocks'").run(item.id);
  for (const blocked of item.blocks ?? []) {
    if (wasPurged(db, blocked)) continue;
    db.prepare("INSERT OR IGNORE INTO item_relations (from_item_id, to_item_id, kind) VALUES (?, ?, 'blocks')").run(item.id, blocked);
  }
  // Snapshots written before blockedBy was tracked lack the field entirely.
  for (const blocker of item.blockedBy ?? []) {
    if (wasPurged(db, blocker)) continue;
    db.prepare("INSERT OR IGNORE INTO item_relations (from_item_id, to_item_id, kind) VALUES (?, ?, 'blocks')").run(blocker, item.id);
  }
}

function restoreView(db: Db, view: ViewSnapshot): void {
  // A snapshot written before `kind` replaced the freeform name/groupBy pair
  // (view rename/removal predates this build) still carries the old fields.
  const legacy = view as unknown as { groupBy?: ViewKind };
  const kind: ViewKind = view.kind ?? legacy.groupBy ?? "status";
  const meta = VIEW_KIND_META[kind] ?? VIEW_KIND_META.status;
  db.prepare(
    `INSERT INTO views (id, board_id, name, icon, group_by, kind, columns_json, filter_json, wip_json, rank, created_at, updated_at)
     VALUES (@id, @boardId, @name, @icon, @groupBy, @kind, @columns, @filter, @wip, @rank, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, icon = excluded.icon, group_by = excluded.group_by, kind = excluded.kind,
       columns_json = excluded.columns_json, filter_json = excluded.filter_json,
       wip_json = excluded.wip_json, rank = excluded.rank, updated_at = excluded.updated_at`
  ).run({
    id: view.id,
    boardId: view.boardId,
    name: meta.name,
    icon: meta.icon,
    groupBy: meta.groupBy,
    kind,
    columns: JSON.stringify(view.columns),
    filter: JSON.stringify(view.filter),
    wip: JSON.stringify(view.wip),
    rank: view.rank,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt
  });
  for (const r of view.ranks ?? []) {
    if (wasPurged(db, r.item_id)) continue;
    db.prepare("INSERT OR IGNORE INTO view_item_rank (view_id, item_id, rank) VALUES (?, ?, ?)").run(view.id, r.item_id, r.rank);
  }
}

function restoreBoard(db: Db, board: BoardSnapshot): void {
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
  for (const v of board.views ?? []) {
    // A snapshot taken before `kind` existed carries only group_by; back-fill from it.
    const row = v as ViewRow & { kind?: string };
    db.prepare(
      `INSERT INTO views (id, board_id, name, icon, group_by, kind, columns_json, filter_json, wip_json, rank, created_at, updated_at)
       VALUES (@id, @board_id, @name, @icon, @group_by, @kind, @columns_json, @filter_json, @wip_json, @rank, @created_at, @updated_at)
       ON CONFLICT(id) DO NOTHING`
    ).run({ ...row, kind: row.kind ?? row.group_by });
  }
}

/** Apply the inverse of one entry. Throws InUseError when a created board now owns issues. */
function revertEntry(db: Db, entry: OplogEntry): void {
  if (entry.entity === "item") {
    if (entry.op === "create") {
      db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(entry.entityId);
      db.prepare("DELETE FROM item_values WHERE item_id = ?").run(entry.entityId);
      db.prepare("DELETE FROM item_relations WHERE from_item_id = ? OR to_item_id = ?").run(entry.entityId, entry.entityId);
      db.prepare("DELETE FROM view_item_rank WHERE item_id = ?").run(entry.entityId);
      db.prepare("DELETE FROM items WHERE id = ?").run(entry.entityId);
    } else if (entry.before) {
      restoreItem(db, entry.before as Item);
    }
  } else if (entry.entity === "board") {
    if (entry.op === "create") {
      const owned = (db.prepare("SELECT COUNT(*) AS n FROM items WHERE board_id = ?").get(entry.entityId) as { n: number }).n;
      if (owned > 0) throw new InUseError(entry.entityId, `That board now owns ${owned} issue${owned === 1 ? "" : "s"} — move them before undoing it`);
      db.prepare("DELETE FROM view_item_rank WHERE view_id IN (SELECT id FROM views WHERE board_id = ?)").run(entry.entityId);
      db.prepare("DELETE FROM views WHERE board_id = ?").run(entry.entityId);
      db.prepare("DELETE FROM boards WHERE id = ?").run(entry.entityId);
    } else if (entry.before) {
      restoreBoard(db, entry.before as BoardSnapshot);
    }
  } else if (entry.entity === "view") {
    if (entry.op === "create") {
      db.prepare("DELETE FROM view_item_rank WHERE view_id = ?").run(entry.entityId);
      db.prepare("DELETE FROM views WHERE id = ?").run(entry.entityId);
    } else if (entry.before) {
      restoreView(db, entry.before as ViewSnapshot);
    }
  }
}

const labelOf = (entry: OplogEntry): string => {
  const named = (entry.before ?? entry.after) as { key?: string; name?: string } | null;
  return named?.key ?? named?.name ?? entry.entityId;
};

/**
 * Walk the oplog backwards, newest first, across every entity it records. The
 * entry is consumed, so a second call reverts the write before it. A purge
 * tombstone carries no snapshot and is stepped over; it stays as the audit trail.
 */
export function undoLast(db: Db, entityId?: string): UndoResult | null {
  const row = entityId
    ? (db.prepare("SELECT * FROM oplog WHERE entity_id = ? AND op != 'purge' ORDER BY seq DESC LIMIT 1").get(entityId) as OplogRow | undefined)
    : (db.prepare("SELECT * FROM oplog WHERE op != 'purge' ORDER BY seq DESC LIMIT 1").get() as OplogRow | undefined);
  if (!row) return null;

  const entry: OplogEntry = rowToEntry(row);
  db.transaction(() => {
    revertEntry(db, entry);
    db.prepare("DELETE FROM oplog WHERE seq = ?").run(row.seq);
  });

  const verb = entry.op === "create" ? "Removed" : entry.op === "delete" ? "Restored" : "Reverted";
  return { entry, summary: `${verb} ${labelOf(entry)}` };
}

/** What stands at `id` right now, for deciding whether a snapshot is still current. */
function currentStamp(db: Db, entity: string, id: string): { exists: boolean; stamp: number | null } {
  const sql =
    entity === "item"
      ? "SELECT version AS stamp FROM items WHERE id = ?"
      : entity === "board"
        ? "SELECT updated_at AS stamp FROM boards WHERE id = ?"
        : "SELECT updated_at AS stamp FROM views WHERE id = ?";
  const row = db.prepare(sql).get(id) as { stamp: number } | undefined;
  return { exists: !!row, stamp: row?.stamp ?? null };
}

const stampOf = (entity: string, snapshot: unknown): number | null => {
  const s = snapshot as { version?: number; updatedAt?: number } | null;
  return (entity === "item" ? s?.version : s?.updatedAt) ?? null;
};

/**
 * Revert every write one run made, newest first, in one transaction. An entity
 * someone else edited afterwards is left in place and reported, never silently
 * overwritten; the run's remaining oplog rows stay behind as the audit trail.
 */
export function undoRun(db: Db, runId: string): UndoRunResult {
  const rows = db.prepare("SELECT * FROM oplog WHERE run_id = ? ORDER BY seq DESC").all(runId) as OplogRow[];
  const kept: UndoRunResult["kept"] = [];
  let reverted = 0;

  db.transaction(() => {
    for (const row of rows) {
      const entry = rowToEntry(row);
      const keep = (reason: string) => kept.push({ entity: entry.entity, entityId: entry.entityId, label: labelOf(entry), reason });
      if (entry.op === "purge") {
        keep("a permanent delete cannot be restored");
        continue;
      }
      const current = currentStamp(db, entry.entity, entry.entityId);
      if (entry.op === "create" || entry.op === "update") {
        if (entry.op === "update" && !current.exists) {
          keep("deleted after this run");
          continue;
        }
        if (current.exists && current.stamp !== stampOf(entry.entity, entry.after)) {
          keep("edited after this run");
          continue;
        }
      } else if (entry.op === "delete" && current.exists) {
        keep("already restored");
        continue;
      }
      try {
        // A created row that is already gone leaves nothing to do; consuming
        // the entry is still right, so ⌘Z never replays this run's writes.
        if (current.exists || entry.op === "delete") revertEntry(db, entry);
        db.prepare("DELETE FROM oplog WHERE seq = ?").run(row.seq);
        reverted += 1;
      } catch (err) {
        if (err instanceof InUseError) keep(err.message);
        else throw err;
      }
    }
  });

  return { reverted, kept };
}
