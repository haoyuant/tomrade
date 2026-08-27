import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import type { Db } from "@tomrade/db";
import type { Oplog } from "@tomrade/oplog";
import { write } from "@tomrade/write";
import { NotFoundError, type Author, type CreateViewInput, type GroupBy, type View, type ViewFilter, type ViewPatch } from "@tomrade/domain";

declare module "cordis" {
  interface Context {
    views: Views;
  }
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

  create(input: CreateViewInput, by: Author = "human"): View {
    const now = Date.now();
    const nextRank = input.rank ?? ((this.db.prepare("SELECT MAX(rank) AS m FROM views WHERE board_id = ?").get(input.boardId) as { m: number | null }).m ?? -1) + 1;
    const view: View = {
      id: randomUUID(),
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
    return write(this.ctx, { entity: "view", op: "create", id: view.id, by, before: null, after: view }, () =>
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO views (id, board_id, name, icon, group_by, columns_json, filter_json, wip_json, rank, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(view.id, view.boardId, view.name, view.icon, view.groupBy, JSON.stringify(view.columns), JSON.stringify(view.filter), JSON.stringify(view.wip), view.rank, now, now);
        this.oplog.append({ entity: "view", op: "create", entityId: view.id, baseVersion: null, before: null, after: view, by, at: now });
        return view;
      })
    );
  }

  update(id: string, patch: ViewPatch, by: Author = "human"): View {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    const next: View = { ...existing, ...patch, updatedAt: Date.now() };
    return write(this.ctx, { entity: "view", op: "update", id, by, before: existing, after: next, patch }, () =>
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE views SET name = ?, icon = ?, group_by = ?, columns_json = ?, filter_json = ?, wip_json = ?, rank = ?, updated_at = ? WHERE id = ?")
          .run(next.name, next.icon, next.groupBy, JSON.stringify(next.columns), JSON.stringify(next.filter), JSON.stringify(next.wip), next.rank, next.updatedAt, id);
        this.oplog.append({ entity: "view", op: "update", entityId: id, baseVersion: null, before: existing, after: next, by, at: next.updatedAt });
        return next;
      })
    );
  }

  remove(id: string, by: Author = "human"): void {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError(id);
    write(this.ctx, { entity: "view", op: "delete", id, by, before: existing, after: null }, () =>
      this.db.transaction(() => {
        const ranks = this.db.prepare("SELECT item_id, rank FROM view_item_rank WHERE view_id = ?").all(id);
        this.db.prepare("DELETE FROM view_item_rank WHERE view_id = ?").run(id);
        this.db.prepare("DELETE FROM views WHERE id = ?").run(id);
        this.oplog.append({ entity: "view", op: "delete", entityId: id, baseVersion: null, before: { ...existing, ranks }, after: null, by, at: Date.now() });
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
