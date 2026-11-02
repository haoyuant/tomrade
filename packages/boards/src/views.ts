import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import type { Db, ProjectDb } from "@tomradex/db";
import type { Oplog } from "@tomradex/oplog";
import { write } from "@tomradex/write";
import { InUseError, NotFoundError, normalizeQuery, parseLayout, type Author, type CreateViewInput, type View, type ViewPatch } from "@tomradex/domain";

declare module "cordis" {
  interface Context {
    views: Views;
  }
}

interface ViewRow {
  id: string;
  project_id: string;
  name: string;
  icon: string;
  layout: string;
  query_json: string;
  rank: number;
  created_at: number;
  updated_at: number;
}

const parseQuery = (json: string) => {
  try {
    return normalizeQuery(JSON.parse(json) as Record<string, unknown>);
  } catch {
    return normalizeQuery(null);
  }
};

function rowToView(r: ViewRow): View {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    icon: r.icon,
    layout: parseLayout(r.layout),
    query: parseQuery(r.query_json),
    rank: r.rank,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/** Saved views: a project's named ways of looking at its backlog, each one layout plus one query. */
export class Views extends Service {
  static provide = "views";
  static inject = ["db", "oplog"];

  constructor(ctx: Context) {
    super(ctx, "views");
  }

  private db(projectId: string): ProjectDb {
    return (this.ctx.db as Db).for(projectId);
  }

  private get oplog(): Oplog {
    return this.ctx.oplog;
  }

  listForProject(projectId: string): View[] {
    if (!this.ctx.db.has(projectId)) return [];
    return (this.db(projectId).prepare("SELECT * FROM views WHERE project_id = ? ORDER BY rank ASC, created_at ASC").all(projectId) as ViewRow[]).map(rowToView);
  }

  get(projectId: string, id: string): View | null {
    const row = this.db(projectId).prepare("SELECT * FROM views WHERE id = ?").get(id) as ViewRow | undefined;
    return row ? rowToView(row) : null;
  }

  create(input: CreateViewInput, by: Author = "human"): View {
    const db = this.db(input.projectId);
    const now = Date.now();
    const rank = input.rank ?? ((db.prepare("SELECT MAX(rank) AS m FROM views WHERE project_id = ?").get(input.projectId) as { m: number | null }).m ?? -1) + 1;
    const view: View = {
      id: randomUUID(),
      projectId: input.projectId,
      name: input.name,
      icon: input.icon ?? "i-board",
      layout: input.layout ?? "board",
      query: normalizeQuery(input.query),
      rank,
      createdAt: now,
      updatedAt: now
    };
    return write(this.ctx, { projectId: input.projectId, entity: "view", op: "create", id: view.id, by, before: null, after: view }, () =>
      db.transaction(() => {
        this.insert(db, view);
        this.oplog.append(input.projectId, { entity: "view", op: "create", entityId: view.id, baseVersion: null, before: null, after: view, by, at: now });
        return view;
      })
    );
  }

  update(projectId: string, id: string, patch: ViewPatch, by: Author = "human"): View {
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    const db = this.db(projectId);
    const next: View = { ...existing, ...patch, query: patch.query ? normalizeQuery(patch.query) : existing.query, updatedAt: Date.now() };
    return write(this.ctx, { projectId, entity: "view", op: "update", id, by, before: existing, after: next, patch }, () =>
      db.transaction(() => {
        db.prepare("UPDATE views SET name = ?, icon = ?, layout = ?, query_json = ?, rank = ?, updated_at = ? WHERE id = ?").run(next.name, next.icon, next.layout, JSON.stringify(next.query), next.rank, next.updatedAt, id);
        this.oplog.append(projectId, { entity: "view", op: "update", entityId: id, baseVersion: null, before: existing, after: next, by, at: next.updatedAt });
        return next;
      })
    );
  }

  /** Refused for a project's last view: the route has to land somewhere. The snapshot carries the manual order, so undo restores it whole. */
  remove(projectId: string, id: string, by: Author = "human"): void {
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    if (this.listForProject(projectId).length <= 1) throw new InUseError(id, `${existing.name} is the project's last view`);
    const db = this.db(projectId);
    write(this.ctx, { projectId, entity: "view", op: "delete", id, by, before: existing, after: null }, () =>
      db.transaction(() => {
        const ranks = db.prepare("SELECT item_id, rank FROM view_item_rank WHERE view_id = ?").all(id);
        db.prepare("DELETE FROM view_item_rank WHERE view_id = ?").run(id);
        db.prepare("DELETE FROM views WHERE id = ?").run(id);
        this.oplog.append(projectId, { entity: "view", op: "delete", entityId: id, baseVersion: null, before: { ...existing, ranks }, after: null, by, at: Date.now() });
      })
    );
  }

  /** Sparse per-view ordering; absent rows fall back to items.rank. */
  ranks(projectId: string, viewId: string): Record<string, number> {
    const rows = this.db(projectId).prepare("SELECT item_id, rank FROM view_item_rank WHERE view_id = ?").all(viewId) as { item_id: string; rank: number }[];
    return Object.fromEntries(rows.map((r) => [r.item_id, r.rank]));
  }

  /**
   * One item's manual position in one view. Logged as its own op so the move
   * travels in the folder's log and can be undone, without a view snapshot per drag.
   */
  setRank(projectId: string, viewId: string, itemId: string, rank: number, by: Author = "human"): void {
    if (!this.get(projectId, viewId)) throw new NotFoundError(viewId);
    const db = this.db(projectId);
    const prior = (db.prepare("SELECT rank FROM view_item_rank WHERE view_id = ? AND item_id = ?").get(viewId, itemId) as { rank: number } | undefined)?.rank ?? null;
    const patch = { itemId, rank };
    write(this.ctx, { projectId, entity: "view", op: "rank", id: viewId, by, before: { rank: prior }, after: { rank }, patch }, () =>
      db.transaction(() => {
        db.prepare("INSERT INTO view_item_rank (view_id, item_id, rank) VALUES (?, ?, ?) ON CONFLICT(view_id, item_id) DO UPDATE SET rank = excluded.rank").run(viewId, itemId, rank);
        this.oplog.append(projectId, { entity: "view", op: "rank", entityId: viewId, baseVersion: null, before: { rank: prior }, after: { rank }, by, at: Date.now(), patch });
      })
    );
  }

  /**
   * Several items' positions in one view, as one decision: a column renumbered
   * by a drag is one oplog entry, so one ⌘Z puts the whole column back.
   */
  setRanks(projectId: string, viewId: string, ranks: Record<string, number>, by: Author = "human"): void {
    const ids = Object.keys(ranks);
    if (ids.length <= 1) return ids.length ? this.setRank(projectId, viewId, ids[0]!, ranks[ids[0]!]!, by) : undefined;
    if (!this.get(projectId, viewId)) throw new NotFoundError(viewId);
    const db = this.db(projectId);
    const priorOf = db.prepare("SELECT rank FROM view_item_rank WHERE view_id = ? AND item_id = ?");
    const prior = Object.fromEntries(ids.map((id) => [id, (priorOf.get(viewId, id) as { rank: number } | undefined)?.rank ?? null]));
    const patch = { ranks };
    write(this.ctx, { projectId, entity: "view", op: "rank", id: viewId, by, before: { ranks: prior }, after: { ranks }, patch }, () =>
      db.transaction(() => {
        const upsert = db.prepare("INSERT INTO view_item_rank (view_id, item_id, rank) VALUES (?, ?, ?) ON CONFLICT(view_id, item_id) DO UPDATE SET rank = excluded.rank");
        for (const id of ids) upsert.run(viewId, id, ranks[id]);
        this.oplog.append(projectId, { entity: "view", op: "rank", entityId: viewId, baseVersion: null, before: { ranks: prior }, after: { ranks }, by, at: Date.now(), patch });
      })
    );
  }

  private insert(db: ProjectDb, view: View): void {
    db.prepare(
      `INSERT INTO views (id, project_id, board_id, name, icon, layout, query_json, rank, created_at, updated_at)
         VALUES (@id, @projectId, '', @name, @icon, @layout, @query, @rank, @createdAt, @updatedAt)`
    ).run({ ...view, query: JSON.stringify(view.query) });
  }
}
