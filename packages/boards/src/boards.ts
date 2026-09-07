import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import type { Db, ProjectDb } from "@tomrade/db";
import type { Oplog } from "@tomrade/oplog";
import { itemsOf } from "./items-like.js";
import { write } from "@tomrade/write";
import { InUseError, NotFoundError, type Author, type Board, type BoardPatch, type CreateBoardInput } from "@tomrade/domain";

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
    note: r.note,
    rank: r.rank,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/** The Workstream field's options. A board owns issues (items.board_id) and nothing else. */
export class Boards extends Service {
  static provide = "boards";
  static inject = ["db", "oplog", "items"];

  constructor(ctx: Context) {
    super(ctx, "boards");
  }

  private db(projectId: string): ProjectDb {
    return (this.ctx.db as Db).for(projectId);
  }

  private get oplog(): Oplog {
    return this.ctx.oplog;
  }

  list(projectId: string): Board[] {
    return (this.db(projectId).prepare("SELECT * FROM boards WHERE project_id = ? ORDER BY rank ASC, created_at ASC").all(projectId) as BoardRow[]).map(rowToBoard);
  }

  get(projectId: string, id: string): Board | null {
    const row = this.db(projectId).prepare("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | undefined;
    return row ? rowToBoard(row) : null;
  }

  /** The board an item lands on when the caller did not name one. */
  defaultFor(projectId: string): Board {
    const board = this.list(projectId)[0];
    if (!board) throw new NotFoundError(projectId);
    return board;
  }

  create(input: CreateBoardInput, by: Author = "human"): Board {
    const db = this.db(input.projectId);
    const now = Date.now();
    const nextRank = input.rank ?? ((db.prepare("SELECT MAX(rank) AS m FROM boards WHERE project_id = ?").get(input.projectId) as { m: number | null }).m ?? -1) + 1;
    const board: Board = {
      id: randomUUID(),
      projectId: input.projectId,
      name: input.name,
      icon: input.icon ?? "i-board",
      subtitle: input.subtitle ?? null,
      note: input.note ?? null,
      rank: nextRank,
      createdAt: now,
      updatedAt: now
    };
    return write(this.ctx, { projectId: input.projectId, entity: "board", op: "create", id: board.id, by, before: null, after: board }, () =>
      db.transaction(() => {
        db.prepare(
          `INSERT INTO boards (id, project_id, name, icon, subtitle, across, sort, note, rank, created_at, updated_at)
             VALUES (@id, @projectId, @name, @icon, @subtitle, 0, NULL, @note, @rank, @createdAt, @updatedAt)`
        ).run(board);
        this.oplog.append(input.projectId, { entity: "board", op: "create", entityId: board.id, baseVersion: null, before: null, after: board, by, at: now });
        return board;
      })
    );
  }

  update(projectId: string, id: string, patch: BoardPatch, by: Author = "human"): Board {
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    const db = this.db(projectId);
    const next: Board = { ...existing, ...patch, updatedAt: Date.now() };
    return write(this.ctx, { projectId, entity: "board", op: "update", id, by, before: existing, after: next, patch }, () =>
      db.transaction(() => {
        db.prepare("UPDATE boards SET name = ?, icon = ?, subtitle = ?, note = ?, rank = ?, updated_at = ? WHERE id = ?").run(next.name, next.icon, next.subtitle, next.note, next.rank, next.updatedAt, id);
        this.oplog.append(projectId, { entity: "board", op: "update", entityId: id, baseVersion: null, before: existing, after: next, by, at: next.updatedAt });
        return next;
      })
    );
  }

  /**
   * Refused while the board still owns issues: they would be stranded on a
   * board_id nothing resolves. Move them first (`moveItems`), or keep the last
   * board — a project always has one for new issues to land on.
   */
  remove(projectId: string, id: string, by: Author = "human"): void {
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    const db = this.db(projectId);
    const owned = (db.prepare("SELECT COUNT(*) AS n FROM items WHERE board_id = ?").get(id) as { n: number }).n;
    if (owned > 0) throw new InUseError(id, `Workstream ${existing.name} still holds ${owned} issue${owned === 1 ? "" : "s"} — move them first`);
    if (this.list(projectId).length <= 1) throw new InUseError(id, `Workstream ${existing.name} is the project's last; new issues need somewhere to land`);
    write(this.ctx, { projectId, entity: "board", op: "delete", id, by, before: existing, after: null }, () =>
      db.transaction(() => {
        db.prepare("DELETE FROM boards WHERE id = ?").run(id);
        this.oplog.append(projectId, { entity: "board", op: "delete", entityId: id, baseVersion: null, before: existing, after: null, by, at: Date.now() });
      })
    );
  }

  /**
   * Bulk-move issues between workstreams. Each move is an ordinary logged item
   * write, so it travels in the folder's log and undoes one issue at a time.
   * Returns how many issues actually left `fromBoardId`.
   */
  moveItems(projectId: string, fromBoardId: string, toBoardId: string, itemIds: string[], by: Author = "human"): number {
    if (!itemIds.length) return 0;
    if (!this.get(projectId, toBoardId)) throw new NotFoundError(toBoardId);
    const wanted = new Set(itemIds);
    const items = itemsOf(this.ctx);
    const moving = items
      .list({ projectId, boardId: fromBoardId })
      .filter((i) => wanted.has(i.id))
      .map((i) => i.id);
    if (!moving.length) return 0;
    return items.moveToBoard(projectId, moving, toBoardId, by);
  }
}
