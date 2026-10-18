import type { DeliveryView, ProjectDb } from "@tomradex/db";
import { InUseError, StaleUndoError, normalizeQuery, type Board, type Item, type OplogEntry, type UndoResult, type UndoRunResult, type View } from "@tomradex/domain";
import { emptyEvidence, type WordsLocale } from "@tomradex/domain";
import { rowToEntry, type OplogRow, type UndoneRow } from "./rows.js";
import { OPLOG_WORDS } from "./words.js";

const UNDONE_COLUMNS = "seq, entity, entity_id, op, base_version, before_json, after_json, by, at, run_id, device, device_seq, patch_json, via";

interface ViewSnapshot extends View {
  ranks?: { item_id: string; rank: number }[];
}

/**
 * Was this id permanently destroyed? The test is the tombstone, not whether the
 * row exists now: a soft-deleted counterpart comes back the moment someone
 * undoes that delete, so a snapshot naming it must still round-trip.
 */
export const wasPurged = (db: ProjectDb, id: string): boolean => !!db.prepare("SELECT 1 FROM oplog WHERE op = 'purge' AND entity_id = ?").get(id);

function restoreItem(db: ProjectDb, item: Item & { deliveries?: DeliveryView[] }): void {
  // A snapshot written before a purge can still name what the purge destroyed;
  // restoring the issue must not restore a dangling parent or edge with it.
  const parentId = item.parentId && wasPurged(db, item.parentId) ? null : item.parentId;
  db.prepare(
    `INSERT INTO items (id, project_id, board_id, key_num, title, body, kind, work_type, playbook_id, evidence_json, status, priority, parent_id, rank, updated_at, updated_by, version, human_locked)
     VALUES (@id, @projectId, @boardId, @keyNum, @title, @body, @kind, @workType, @playbookId, @evidenceJson, @status, @priority, @parentId, @rank, @updatedAt, @updatedBy, @version, @humanLocked)
     ON CONFLICT(id) DO UPDATE SET
       board_id = excluded.board_id, title = excluded.title, body = excluded.body, kind = excluded.kind,
       work_type = excluded.work_type, playbook_id = excluded.playbook_id, evidence_json = excluded.evidence_json, status = excluded.status, priority = excluded.priority, parent_id = excluded.parent_id, rank = excluded.rank,
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
    workType: item.workType ?? "coding",
    playbookId: item.playbookId ?? null,
    evidenceJson: JSON.stringify(item.evidence ?? emptyEvidence()),
    status: item.status,
    priority: item.priority,
    parentId,
    rank: item.rank,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
    version: item.version,
    humanLocked: item.humanLocked ? 1 : 0
  });

  if (item.deliveries) {
    db.prepare("DELETE FROM deliveries WHERE project_id = ? AND item_id = ?").run(item.projectId, item.id);
    const insert = db.prepare("INSERT INTO deliveries (id, project_id, item_id, sequence, state, started_at, completed_at, updated_at, bases_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const d of item.deliveries) insert.run(d.id, item.projectId, item.id, d.sequence, d.state, d.startedAt, d.completedAt, d.updatedAt, JSON.stringify(d.bases));
  }

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

function restoreView(db: ProjectDb, view: ViewSnapshot): void {
  // A snapshot from before views moved to the project has no projectId/layout;
  // it cannot be placed, so it is restored as an empty board view on the board's project.
  const legacy = view as unknown as { boardId?: string; columns?: string[]; filter?: unknown; wip?: Record<string, number> };
  const projectId =
    view.projectId ?? (legacy.boardId ? ((db.prepare("SELECT project_id FROM boards WHERE id = ?").get(legacy.boardId) as { project_id: string } | undefined)?.project_id ?? "") : "");
  db.prepare(
    `INSERT INTO views (id, project_id, board_id, name, icon, layout, query_json, rank, created_at, updated_at)
     VALUES (@id, @projectId, '', @name, @icon, @layout, @query, @rank, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id, name = excluded.name, icon = excluded.icon, layout = excluded.layout,
       query_json = excluded.query_json, rank = excluded.rank, updated_at = excluded.updated_at`
  ).run({
    id: view.id,
    projectId,
    name: view.name ?? "View",
    icon: view.icon ?? "i-board",
    layout: view.layout ?? "board",
    query: JSON.stringify(view.query ? normalizeQuery(view.query) : normalizeQuery({ columns: legacy.columns, wip: legacy.wip })),
    rank: view.rank,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt
  });
  for (const r of view.ranks ?? []) {
    if (wasPurged(db, r.item_id)) continue;
    db.prepare("INSERT OR IGNORE INTO view_item_rank (view_id, item_id, rank) VALUES (?, ?, ?)").run(view.id, r.item_id, r.rank);
  }
}

function restoreBoard(db: ProjectDb, board: Board): void {
  db.prepare(
    `INSERT INTO boards (id, project_id, name, icon, across, sort, note, rank, repo_id, repo_path, created_at, updated_at)
     VALUES (@id, @projectId, @name, @icon, 0, NULL, @note, @rank, @repoId, @repoPath, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, icon = excluded.icon,
       note = excluded.note, rank = excluded.rank, repo_id = excluded.repo_id, repo_path = excluded.repo_path, updated_at = excluded.updated_at`
  ).run({
    id: board.id,
    projectId: board.projectId,
    name: board.name,
    icon: board.icon,
    note: board.note,
    rank: board.rank,
    repoId: board.repoId ?? null,
    repoPath: board.repoPath ?? "",
    createdAt: board.createdAt,
    updatedAt: board.updatedAt
  });
}

function removeItemRows(db: ProjectDb, id: string): void {
  db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(id);
  db.prepare("DELETE FROM item_values WHERE item_id = ?").run(id);
  db.prepare("DELETE FROM item_relations WHERE from_item_id = ? OR to_item_id = ?").run(id, id);
  db.prepare("DELETE FROM view_item_rank WHERE item_id = ?").run(id);
  db.prepare("DELETE FROM deliveries WHERE item_id = ?").run(id);
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
}

function removeBoard(db: ProjectDb, id: string): void {
  const owned = (db.prepare("SELECT COUNT(*) AS n FROM items WHERE board_id = ?").get(id) as { n: number }).n;
  if (owned > 0) throw new InUseError(id, `That workstream now holds ${owned} ticket${owned === 1 ? "" : "s"} — move them before undoing it`);
  db.prepare("DELETE FROM boards WHERE id = ?").run(id);
}

function setRank(db: ProjectDb, viewId: string, itemId: string, rank: number | null | undefined): void {
  if (rank == null) db.prepare("DELETE FROM view_item_rank WHERE view_id = ? AND item_id = ?").run(viewId, itemId);
  else db.prepare("INSERT INTO view_item_rank (view_id, item_id, rank) VALUES (?, ?, ?) ON CONFLICT(view_id, item_id) DO UPDATE SET rank = excluded.rank").run(viewId, itemId, rank);
}

/** A rank entry moves one item (`patch.itemId`, side `{ rank }`) or several (`patch.ranks`, side `{ ranks }`); `side` is its before or its after. */
function setRanks(db: ProjectDb, entry: OplogEntry, side: unknown): void {
  const p = entry.patch as { itemId?: string; ranks?: Record<string, number> } | null;
  const s = side as { rank?: number | null; ranks?: Record<string, number | null> } | null;
  if (p?.itemId) setRank(db, entry.entityId, p.itemId, s?.rank);
  else if (p?.ranks) for (const itemId of Object.keys(p.ranks)) setRank(db, entry.entityId, itemId, s?.ranks?.[itemId]);
}

/** Apply the inverse of one entry. Throws InUseError when a created board now owns issues. */
export function revertEntry(db: ProjectDb, entry: OplogEntry): void {
  if (entry.entity === "item") {
    if (entry.op === "create") {
      removeItemRows(db, entry.entityId);
    } else if (entry.before) {
      restoreItem(db, entry.before as Item);
    }
  } else if (entry.entity === "board") {
    if (entry.op === "create") {
      removeBoard(db, entry.entityId);
    } else if (entry.before) {
      restoreBoard(db, entry.before as Board);
    }
  } else if (entry.entity === "view") {
    if (entry.op === "rank") {
      setRanks(db, entry, entry.before);
    } else if (entry.op === "create") {
      db.prepare("DELETE FROM view_item_rank WHERE view_id = ?").run(entry.entityId);
      db.prepare("DELETE FROM views WHERE id = ?").run(entry.entityId);
    } else if (entry.before) {
      restoreView(db, entry.before as ViewSnapshot);
    }
  }
}

/** Apply one entry again — the mirror of revertEntry, for redo. */
export function applyEntry(db: ProjectDb, entry: OplogEntry): void {
  if (entry.entity === "item") {
    if (entry.op === "delete") removeItemRows(db, entry.entityId);
    else if (entry.after) restoreItem(db, entry.after as Item);
  } else if (entry.entity === "board") {
    if (entry.op === "delete") removeBoard(db, entry.entityId);
    else if (entry.after) restoreBoard(db, entry.after as Board);
  } else if (entry.entity === "view") {
    if (entry.op === "rank") {
      setRanks(db, entry, entry.after);
    } else if (entry.op === "delete") {
      db.prepare("DELETE FROM view_item_rank WHERE view_id = ?").run(entry.entityId);
      db.prepare("DELETE FROM views WHERE id = ?").run(entry.entityId);
    } else if (entry.after) {
      restoreView(db, entry.after as ViewSnapshot);
    }
  }
}

/** Park a row in the redo stack. */
export function retire(db: ProjectDb, seq: number, at: number): void {
  db.prepare(`INSERT INTO oplog_undone (${UNDONE_COLUMNS}, undone_at) SELECT ${UNDONE_COLUMNS}, ? FROM oplog WHERE seq = ?`).run(at, seq);
  db.prepare("DELETE FROM oplog WHERE seq = ?").run(seq);
}

export const undoneRows = (db: ProjectDb, limit: number): UndoneRow[] => db.prepare("SELECT * FROM oplog_undone ORDER BY at DESC, seq DESC LIMIT ?").all(limit) as UndoneRow[];

export const undoneRow = (db: ProjectDb, seq: number): UndoneRow | undefined => db.prepare("SELECT * FROM oplog_undone WHERE seq = ?").get(seq) as UndoneRow | undefined;

export const undoSummary = (entry: OplogEntry, locale: WordsLocale = "en"): string =>
  OPLOG_WORDS(locale)(entry.op === "create" ? "undoCreate" : entry.op === "delete" ? "undoDelete" : entry.op === "rank" ? "undoRank" : "undoChange", { label: labelOf(entry) });

export const redoSummary = (entry: OplogEntry, locale: WordsLocale = "en"): string =>
  OPLOG_WORDS(locale)(entry.op === "create" ? "redoCreate" : entry.op === "delete" ? "redoDelete" : entry.op === "rank" ? "redoRank" : "redoChange", { label: labelOf(entry) });

export const labelOf = (entry: OplogEntry): string => {
  const named = (entry.before ?? entry.after) as { key?: string; name?: string } | null;
  return named?.key ?? named?.name ?? entry.entityId;
};

/**
 * Walk the oplog backwards, newest first, across every entity it records. The
 * entry is consumed, so a second call reverts the write before it. A purge
 * tombstone carries no snapshot and is stepped over; it stays as the audit trail.
 */
/**
 * Only this machine's own writes are undoable this way: a row that arrived from
 * another machine's log carries a patch but no snapshot, and taking it back is
 * a new write of ours, not a revert of theirs.
 */
export function undoLast(db: ProjectDb, device: string, entityId?: string, at = Date.now(), stamp?: number): UndoResult | null {
  const row = entityId
    ? (db.prepare("SELECT * FROM oplog WHERE entity_id = ? AND op NOT IN ('purge', 'merge') AND device = ? ORDER BY seq DESC LIMIT 1").get(entityId, device) as OplogRow | undefined)
    : (db.prepare("SELECT * FROM oplog WHERE op NOT IN ('purge', 'merge') AND device = ? ORDER BY seq DESC LIMIT 1").get(device) as OplogRow | undefined);
  if (!row) return null;
  // Aimed at one write (a toast's): only while it is still what stands. Anything
  // newer — ours, an agent's, another machine's — means that write is not the
  // one this would take back.
  if (entityId && stamp !== undefined && currentStamp(db, row.entity, entityId).stamp !== stamp) throw new StaleUndoError(entityId);
  return undoRow(db, row, at);
}

/** Revert one row of ours and park it for redo. */
export function undoRow(db: ProjectDb, row: OplogRow, at = Date.now()): UndoResult {
  const entry: OplogEntry = rowToEntry(row);
  db.transaction(() => {
    revertEntry(db, entry);
    retire(db, row.seq, at);
  });
  return { entry, summary: undoSummary(entry) };
}

/** What stands at `id` right now, for deciding whether a snapshot is still current. */
function currentStamp(db: ProjectDb, entity: string, id: string): { exists: boolean; stamp: number | null } {
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
export function undoRun(db: ProjectDb, runId: string): UndoRunResult {
  return undoRows(db, db.prepare("SELECT * FROM oplog WHERE run_id = ? ORDER BY seq DESC").all(runId) as OplogRow[]);
}

/** Everything one extension wrote here, taken back on the same terms as a run. */
export function undoVia(db: ProjectDb, pluginId: string, since = 0): UndoRunResult {
  return undoRows(db, db.prepare("SELECT * FROM oplog WHERE via = ? AND at >= ? ORDER BY seq DESC").all(pluginId, since) as OplogRow[]);
}

function undoRows(db: ProjectDb, rows: OplogRow[]): UndoRunResult {
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
      if (entry.op === "merge") continue;
      if (entry.op === "rank") {
        revertEntry(db, entry);
        db.prepare("DELETE FROM oplog WHERE seq = ?").run(row.seq);
        reverted += 1;
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
