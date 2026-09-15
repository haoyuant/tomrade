import type { Db } from "./service.js";

export type DeliveryState = "active" | "completed" | "cancelled";
export interface DeliveryView {
  id: string;
  projectId: string;
  itemId: string;
  sequence: number;
  state: DeliveryState;
  startedAt: number;
  completedAt: number | null;
  updatedAt: number;
  /** Optional repository baselines; general deliveries leave this empty. */
  bases: Record<string, string | null>;
}

interface Row {
  id: string; project_id: string; item_id: string; sequence: number;
  state: DeliveryState; started_at: number; completed_at: number | null;
  updated_at: number; bases_json: string;
}
const view = (row: Row): DeliveryView => ({
  id: row.id, projectId: row.project_id, itemId: row.item_id, sequence: row.sequence,
  state: row.state, startedAt: row.started_at, completedAt: row.completed_at,
  updatedAt: row.updated_at, bases: JSON.parse(row.bases_json)
});

/** Shared delivery persistence. Domain writers own acceptance and status policy. */
export class DeliveryStore {
  constructor(private readonly pool: Db) {}

  list(projectId: string, itemId?: string): DeliveryView[] {
    const db = this.pool.for(projectId);
    const rows = itemId
      ? db.prepare("SELECT * FROM deliveries WHERE project_id = ? AND item_id = ? ORDER BY sequence").all(projectId, itemId)
      : db.prepare("SELECT * FROM deliveries WHERE project_id = ? ORDER BY item_id, sequence").all(projectId);
    return (rows as Row[]).map(view);
  }

  active(projectId: string, itemId: string): DeliveryView | null {
    const row = this.pool.for(projectId).prepare("SELECT * FROM deliveries WHERE project_id = ? AND item_id = ? AND state = 'active'").get(projectId, itemId) as Row | undefined;
    return row ? view(row) : null;
  }

  current(projectId: string, itemId: string): DeliveryView | null {
    return this.active(projectId, itemId) ?? this.list(projectId, itemId).at(-1) ?? null;
  }

  ensure(projectId: string, itemId: string, at = Date.now(), bases: DeliveryView["bases"] = {}): DeliveryView {
    const db = this.pool.for(projectId);
    return db.transaction(() => {
      const active = this.active(projectId, itemId);
      if (active) return active;
      if (!db.prepare("SELECT 1 FROM items WHERE id = ? AND project_id = ?").get(itemId, projectId)) throw new Error(`Unknown ticket ${itemId}`);
      const sequence = (this.list(projectId, itemId).at(-1)?.sequence ?? 0) + 1;
      db.prepare("INSERT INTO deliveries (id, project_id, item_id, sequence, state, started_at, completed_at, updated_at, bases_json) VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?)")
        .run(`${itemId}:delivery:${sequence}`, projectId, itemId, sequence, at, at, JSON.stringify(bases));
      return this.active(projectId, itemId)!;
    });
  }

  finish(projectId: string, itemId: string, state: Exclude<DeliveryState, "active">, at = Date.now()): DeliveryView | null {
    const active = this.active(projectId, itemId);
    if (!active) return null;
    this.pool.for(projectId).prepare("UPDATE deliveries SET state = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(state, at, at, active.id);
    return this.list(projectId, itemId).find(d => d.id === active.id)!;
  }
}
