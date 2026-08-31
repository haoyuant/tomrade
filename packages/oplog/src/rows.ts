import type { Author, OplogEntity, OplogEntry, OplogOp } from "@tomrade/domain";

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
  run_id: string | null;
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
    at: r.at,
    runId: r.run_id
  };
}
