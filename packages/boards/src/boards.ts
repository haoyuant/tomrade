import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import { insertDefaultView, type Db } from "@tomrade/db";
import type { Oplog } from "@tomrade/oplog";
import { write } from "@tomrade/write";
import { InUseError, NotFoundError, type Author, type Board, type BoardPatch, type CreateBoardInput, type CreatedBoard } from "@tomrade/domain";

declare module "cordis" {
  interface Context {
    boards: Boards;
  }
}

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

export class Boards extends Service {
  static provide = "boards";
  static inject = ["db", "oplog"];

  constructor(ctx: Context) {
    super(ctx, "boards");
  }

  private get db(): Db {
    return this.ctx.db;
  }

  private get oplog(): Oplog {
    return this.ctx.oplog;
  }

  list(projectId: string): Board[] {
    return (this.db.prepare("SELECT * FROM boards WHERE project_id = ? ORDER BY across ASC, rank ASC, created_at ASC").all(projectId) as BoardRow[]).map(rowToBoard);
  }

  get(id: string): Board | null {
    const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | undefined;
    return row ? rowToBoard(row) : null;
  }

  /** The board an item lands on when the caller did not name one. */
  defaultFor(projectId: string): Board {
    const board = this.list(projectId).find((b) => !b.across);
    if (!board) throw new NotFoundError(projectId);
    return board;
  }

  /** A new board always gets the All work view, so it can never open empty. */
  create(input: CreateBoardInput, by: Author = "human"): CreatedBoard {
    const now = Date.now();
    const nextRank =
      input.rank ??
      ((this.db.prepare("SELECT MAX(rank) AS m FROM boards WHERE project_id = ? AND across = 0").get(input.projectId) as { m: number | null }).m ?? -1) + 1;
    const board: Board = {
      id: randomUUID(),
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
    return write(this.ctx, { entity: "board", op: "create", id: board.id, by, before: null, after: board }, () =>
      this.db.transaction((): CreatedBoard => {
        this.db
          .prepare(
            `INSERT INTO boards (id, project_id, name, icon, subtitle, across, sort, note, rank, created_at, updated_at)
             VALUES (@id, @projectId, @name, @icon, @subtitle, @across, @sort, @note, @rank, @createdAt, @updatedAt)`
          )
          .run({ ...board, across: board.across ? 1 : 0 });
        const defaultViewId = insertDefaultView(this.db, board.id, now);
        this.oplog.append({ entity: "board", op: "create", entityId: board.id, baseVersion: null, before: null, after: board, by, at: now });
        return { ...board, defaultViewId };
      })
    );
  }

  update(id: string, patch: BoardPatch, by: Author = "human"): Board {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    const next: Board = { ...existing, ...patch, updatedAt: Date.now() };
    return write(this.ctx, { entity: "board", op: "update", id, by, before: existing, after: next, patch }, () =>
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE boards SET name = ?, icon = ?, subtitle = ?, note = ?, rank = ?, updated_at = ? WHERE id = ?")
          .run(next.name, next.icon, next.subtitle, next.note, next.rank, next.updatedAt, id);
        this.oplog.append({ entity: "board", op: "update", entityId: id, baseVersion: null, before: existing, after: next, by, at: next.updatedAt });
        return next;
      })
    );
  }

  /** Refused while the board still owns issues: they would be stranded on a board_id nothing resolves. */
  remove(id: string, by: Author = "human"): void {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    const owned = (this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE board_id = ?").get(id) as { n: number }).n;
    if (owned > 0) throw new InUseError(id, `Board ${existing.name} still owns ${owned} issue${owned === 1 ? "" : "s"} — move them first`);
    write(this.ctx, { entity: "board", op: "delete", id, by, before: existing, after: null }, () =>
      this.db.transaction(() => {
        // The snapshot carries the views, so undo restores a board that can be opened.
        const views = this.db.prepare("SELECT * FROM views WHERE board_id = ?").all(id);
        this.db.prepare("DELETE FROM view_item_rank WHERE view_id IN (SELECT id FROM views WHERE board_id = ?)").run(id);
        this.db.prepare("DELETE FROM views WHERE board_id = ?").run(id);
        this.db.prepare("DELETE FROM boards WHERE id = ?").run(id);
        this.oplog.append({ entity: "board", op: "delete", entityId: id, baseVersion: null, before: { ...existing, views }, after: null, by, at: Date.now() });
      })
    );
  }

  /** Bulk-move issues between boards. Deliberate, which is why a drag never does it. */
  moveItems(fromBoardId: string, toBoardId: string, itemIds: string[], by: Author = "human"): number {
    if (!itemIds.length) return 0;
    const placeholders = itemIds.map(() => "?").join(",");
    return this.db.transaction(
      () =>
        this.db
          .prepare(`UPDATE items SET board_id = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE board_id = ? AND id IN (${placeholders})`)
          .run(toBoardId, Date.now(), by, fromBoardId, ...itemIds).changes
    );
  }
}
