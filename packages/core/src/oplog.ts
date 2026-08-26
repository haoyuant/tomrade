import type { Db } from "./db.js";
import type { Author, OplogEntity, OplogEntry, OplogOp } from "./types.js";

export interface OplogRow {
  seq: number;
  entity: string;
  entity_id: string;
  op: string;
  base_version: number | null;
  before_json: string | null;
  after_json: string | null;
  by: string;
  at: number;
}

export function rowToEntry(r: OplogRow): OplogEntry {
  return {
    seq: r.seq,
    entity: r.entity as OplogEntity,
    entityId: r.entity_id,
    op: r.op as OplogOp,
    baseVersion: r.base_version,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
    by: r.by as Author,
    at: r.at
  };
}

export function appendOplog(
  db: Db,
  entity: OplogEntity,
  op: OplogOp,
  entityId: string,
  baseVersion: number | null,
  before: unknown | null,
  after: unknown | null,
  by: Author,
  at: number
): void {
  db.prepare(
    `INSERT INTO oplog (entity, entity_id, op, base_version, before_json, after_json, by, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(entity, entityId, op, baseVersion, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, by, at);
}
