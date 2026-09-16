import type { Author, OplogEntity, OplogEntry, OplogOp } from "@tomrade/domain";

/** A row ⌘Z took back, parked in `oplog_undone` until ⇧⌘Z puts it back or a new write drops it. */
export interface UndoneRow extends OplogRow {
  undone_at: number;
}

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
  device: string;
  device_seq: number | null;
  patch_json: string | null;
}

const parse = (json: string | null): unknown => {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

export function rowToEntry(r: OplogRow): OplogEntry {
  return {
    seq: r.seq,
    entity: r.entity as OplogEntity,
    entityId: r.entity_id,
    op: r.op as OplogOp,
    baseVersion: r.base_version,
    before: parse(r.before_json),
    after: parse(r.after_json),
    by: r.by as Author,
    at: r.at,
    runId: r.run_id,
    device: r.device ?? "",
    deviceSeq: r.device_seq ?? null,
    patch: (parse(r.patch_json) as Record<string, unknown> | null) ?? null
  };
}

/**
 * The fields an op changed: the whole entity for a create, the differing keys
 * for an update, nothing for a delete or purge. This is what the folder's log
 * carries and what a merge arbitrates with.
 */
export function patchOf(op: OplogOp, before: unknown, after: unknown, given?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (given !== undefined) return given;
  if (op === "create") return isRecord(after) ? after : null;
  if (op === "update" && isRecord(before) && isRecord(after)) {
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key] ?? null;
    }
    return out;
  }
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
