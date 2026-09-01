import { Context, Service } from "cordis";
import type { Db } from "@tomrade/db";
import type { Oplog } from "@tomrade/oplog";
import { write } from "@tomrade/write";
import { NotFoundError, type Author, type View, type ViewFilter, type ViewKind, type ViewPatch } from "@tomrade/domain";

declare module "cordis" {
  interface Context {
    views: Views;
  }
}

interface ViewRow {
  id: string;
  board_id: string;
  kind: string;
  columns_json: string;
  filter_json: string;
  wip_json: string;
  rank: number;
  created_at: number;
  updated_at: number;
}

function rowToView(r: ViewRow): View {
  return {
    id: r.id,
    boardId: r.board_id,
    kind: r.kind as ViewKind,
    columns: JSON.parse(r.columns_json) as string[],
    filter: JSON.parse(r.filter_json) as ViewFilter,
    wip: JSON.parse(r.wip_json) as Record<string, number>,
    rank: r.rank,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/** The app's four built-in views (status/priority/epic/dependencies) — fixed per board, never created or removed. */
export class Views extends Service {
  static provide = "views";
  static inject = ["db", "oplog"];

  constructor(ctx: Context) {
    super(ctx, "views");
  }

  private get db(): Db {
    return this.ctx.db;
  }

  private get oplog(): Oplog {
    return this.ctx.oplog;
  }

  listForBoard(boardId: string): View[] {
    return (this.db.prepare("SELECT * FROM views WHERE board_id = ? ORDER BY rank ASC, created_at ASC").all(boardId) as ViewRow[]).map(rowToView);
  }

  listForProject(projectId: string): View[] {
    return (
      this.db.prepare("SELECT v.* FROM views v JOIN boards b ON b.id = v.board_id WHERE b.project_id = ? ORDER BY b.rank ASC, v.rank ASC").all(projectId) as ViewRow[]
    ).map(rowToView);
  }

  get(id: string): View | null {
    const row = this.db.prepare("SELECT * FROM views WHERE id = ?").get(id) as ViewRow | undefined;
    return row ? rowToView(row) : null;
  }

  update(id: string, patch: ViewPatch, by: Author = "human"): View {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    const next: View = { ...existing, ...patch, updatedAt: Date.now() };
    return write(this.ctx, { entity: "view", op: "update", id, by, before: existing, after: next, patch }, () =>
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE views SET columns_json = ?, filter_json = ?, wip_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(next.columns), JSON.stringify(next.filter), JSON.stringify(next.wip), next.updatedAt, id);
        this.oplog.append({ entity: "view", op: "update", entityId: id, baseVersion: null, before: existing, after: next, by, at: next.updatedAt });
        return next;
      })
    );
  }

  /** Sparse per-view ordering; absent rows fall back to items.rank. */
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
