import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { InUseError, NotFoundError } from "./errors.js";
import { insertDefaultView } from "./migrate.js";
import { appendOplog } from "./oplog.js";
import type { Author, Board, BoardPatch, CreateBoardInput, CreatedBoard, CreateViewInput, GroupBy, View, ViewFilter, ViewPatch } from "./types.js";

interface BoardRow {
  id: string;
  project_id: string;
  name: string;
  icon: string;
  subtitle: string | null;
  across: number;
  sort: string | null;
  note: string | null;
  rank: number;
  created_at: number;
  updated_at: number;
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

function rowToBoard(r: BoardRow): Board {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    icon: r.icon,
    subtitle: r.subtitle,
    across: r.across === 1,
    sort: r.sort === "recent" ? "recent" : null,
    note: r.note,
    rank: r.rank,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function rowToView(r: ViewRow): View {
  return {
    id: r.id,
    boardId: r.board_id,
    name: r.name,
    icon: r.icon,
    groupBy: r.group_by as GroupBy,
    columns: JSON.parse(r.columns_json) as string[],
    filter: JSON.parse(r.filter_json) as ViewFilter,
    wip: JSON.parse(r.wip_json) as Record<string, number>,
    rank: r.rank,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export class BoardsRepository {
  constructor(private readonly db: Db) {}

  list(projectId: string): Board[] {
    return (
      this.db.prepare("SELECT * FROM boards WHERE project_id = ? ORDER BY across ASC, rank ASC, created_at ASC").all(projectId) as BoardRow[]
    ).map(rowToBoard);
  }

  get(id: string): Board | null {
    const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | undefined;
    return row ? rowToBoard(row) : null;
  }

  /** A new board always gets the All work view, so it can never open empty (TOM-19). */
  create(input: CreateBoardInput, by: Author = "human"): CreatedBoard {
    const id = randomUUID();
    const now = Date.now();
    const nextRank =
      input.rank ??
      ((this.db.prepare("SELECT MAX(rank) AS m FROM boards WHERE project_id = ? AND across = 0").get(input.projectId) as { m: number | null })
        .m ?? -1) + 1;
    const board: Board = {
      id,
      projectId: input.projectId,
      name: input.name,
      icon: input.icon ?? "i-board",
      subtitle: input.subtitle ?? null,
      across: input.across ?? false,
      sort: input.sort ?? null,
      note: input.note ?? null,
      rank: nextRank,
      createdAt: now,
      updatedAt: now
    };
    const tx = this.db.transaction((): string => {
      this.db
        .prepare(
          `INSERT INTO boards (id, project_id, name, icon, subtitle, across, sort, note, rank, created_at, updated_at)
           VALUES (@id, @projectId, @name, @icon, @subtitle, @across, @sort, @note, @rank, @createdAt, @updatedAt)`
        )
        .run({ ...board, across: board.across ? 1 : 0 });
      const defaultViewId = insertDefaultView(this.db, id, now);
      appendOplog(this.db, "board", "create", id, null, null, board, by, now);
      return defaultViewId;
    });
    return { ...board, defaultViewId: tx() };
  }

  update(id: string, patch: BoardPatch, by: Author = "human"): Board {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    const next: Board = { ...existing, ...patch, updatedAt: Date.now() };
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE boards SET name = ?, icon = ?, subtitle = ?, note = ?, rank = ?, updated_at = ? WHERE id = ?")
        .run(next.name, next.icon, next.subtitle, next.note, next.rank, next.updatedAt, id);
      appendOplog(this.db, "board", "update", id, null, existing, next, by, next.updatedAt);
    });
    tx();
    return next;
  }

  /**
   * Deletes the board, its views and their ranks. Refused while the board still
   * owns issues: they would be stranded on a board_id nothing resolves. Move them
   * first — that is what the bulk move in board settings is for.
   */
  remove(id: string, by: Author = "human"): void {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    const owned = (this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE board_id = ?").get(id) as { n: number }).n;
    if (owned > 0) throw new InUseError(id, `Board ${existing.name} still owns ${owned} issue${owned === 1 ? "" : "s"} — move them first`);
    const tx = this.db.transaction(() => {
      // the snapshot carries the views, so undoing the delete restores a board
      // that can actually be opened
      const views = this.db.prepare("SELECT * FROM views WHERE board_id = ?").all(id);
      this.db.prepare("DELETE FROM view_item_rank WHERE view_id IN (SELECT id FROM views WHERE board_id = ?)").run(id);
      this.db.prepare("DELETE FROM views WHERE board_id = ?").run(id);
      this.db.prepare("DELETE FROM boards WHERE id = ?").run(id);
      appendOplog(this.db, "board", "delete", id, null, { ...existing, views }, null, by, Date.now());
    });
    tx();
  }

  /** Bulk-move issues between boards. Deliberate, which is why a drag never does it. */
  moveItems(fromBoardId: string, toBoardId: string, itemIds: string[], by: Author = "human"): number {
    if (!itemIds.length) return 0;
    const now = Date.now();
    const placeholders = itemIds.map(() => "?").join(",");
    const tx = this.db.transaction((): number =>
      this.db
        .prepare(`UPDATE items SET board_id = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE board_id = ? AND id IN (${placeholders})`)
        .run(toBoardId, now, by, fromBoardId, ...itemIds).changes
    );
    return tx();
  }
}

export class ViewsRepository {
  constructor(private readonly db: Db) {}

  listForBoard(boardId: string): View[] {
    return (this.db.prepare("SELECT * FROM views WHERE board_id = ? ORDER BY rank ASC, created_at ASC").all(boardId) as ViewRow[]).map(rowToView);
  }

  listForProject(projectId: string): View[] {
    return (
      this.db
        .prepare(
          "SELECT v.* FROM views v JOIN boards b ON b.id = v.board_id WHERE b.project_id = ? ORDER BY b.rank ASC, v.rank ASC"
        )
        .all(projectId) as ViewRow[]
    ).map(rowToView);
  }

  get(id: string): View | null {
    const row = this.db.prepare("SELECT * FROM views WHERE id = ?").get(id) as ViewRow | undefined;
    return row ? rowToView(row) : null;
  }

  create(input: CreateViewInput, by: Author = "human"): View {
    const id = randomUUID();
    const now = Date.now();
    const nextRank =
      input.rank ?? ((this.db.prepare("SELECT MAX(rank) AS m FROM views WHERE board_id = ?").get(input.boardId) as { m: number | null }).m ?? -1) + 1;
    const view: View = {
      id,
      boardId: input.boardId,
      name: input.name,
      icon: input.icon ?? "i-filter",
      groupBy: input.groupBy ?? "status",
      columns: input.columns ?? [],
      filter: input.filter ?? {},
      wip: input.wip ?? {},
      rank: nextRank,
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `INSERT INTO views (id, board_id, name, icon, group_by, columns_json, filter_json, wip_json, rank, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, view.boardId, view.name, view.icon, view.groupBy, JSON.stringify(view.columns), JSON.stringify(view.filter), JSON.stringify(view.wip), view.rank, now, now);
    appendOplog(this.db, "view", "create", id, null, null, view, by, now);
    return view;
  }

  update(id: string, patch: ViewPatch, by: Author = "human"): View {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    const next: View = { ...existing, ...patch, updatedAt: Date.now() };
    appendOplog(this.db, "view", "update", id, null, existing, next, by, next.updatedAt);
    this.db
      .prepare(
        `UPDATE views SET name = ?, icon = ?, group_by = ?, columns_json = ?, filter_json = ?, wip_json = ?, rank = ?, updated_at = ? WHERE id = ?`
      )
      .run(next.name, next.icon, next.groupBy, JSON.stringify(next.columns), JSON.stringify(next.filter), JSON.stringify(next.wip), next.rank, next.updatedAt, id);
    return next;
  }

  remove(id: string, by: Author = "human"): void {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    const tx = this.db.transaction(() => {
      const ranks = this.db.prepare("SELECT item_id, rank FROM view_item_rank WHERE view_id = ?").all(id);
      this.db.prepare("DELETE FROM view_item_rank WHERE view_id = ?").run(id);
      this.db.prepare("DELETE FROM views WHERE id = ?").run(id);
      appendOplog(this.db, "view", "delete", id, null, { ...existing, ranks }, null, by, Date.now());
    });
    tx();
  }

  /** Sparse per-view ordering; absent rows fall back to items.rank (TOM-77). */
  ranks(viewId: string): Record<string, number> {
    const rows = this.db.prepare("SELECT item_id, rank FROM view_item_rank WHERE view_id = ?").all(viewId) as { item_id: string; rank: number }[];
    return Object.fromEntries(rows.map((r) => [r.item_id, r.rank]));
  }

  setRank(viewId: string, itemId: string, rank: number): void {
    this.db
      .prepare("INSERT INTO view_item_rank (view_id, item_id, rank) VALUES (?, ?, ?) ON CONFLICT(view_id, item_id) DO UPDATE SET rank = excluded.rank")
      .run(viewId, itemId, rank);
  }
}
