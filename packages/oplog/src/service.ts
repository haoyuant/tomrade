import { Context, Service } from "cordis";
import type { Db, ProjectDb } from "@tomrade/db";
import type {} from "@tomrade/hub";
import type { OplogEntity, OplogEntry, OplogOp, UndoResult, UndoRunResult } from "@tomrade/domain";
import { writeContext } from "@tomrade/write";
import type {} from "@tomrade/ipc";
import { patchOf, rowToEntry, type OplogRow } from "./rows.js";
import { undoLast, undoRun, wasPurged } from "./undo.js";

declare module "cordis" {
  interface Context {
    oplog: Oplog;
  }
  interface Events {
    /** A row landed in a project's oplog; the storage layer appends it to the folder's log. */
    "oplog/appended"(projectId: string, entry: OplogEntry): void;
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    "oplog.recent": (projectId: string, limit?: number) => OplogEntry[];
    "oplog.history": (projectId: string, entity: OplogEntity, id: string, limit?: number) => OplogEntry[];
    "oplog.undo": (projectId: string, entityId?: string) => UndoResult | null;
    "oplog.undoRun": (projectId: string, runId: string) => UndoRunResult;
  }
}

export interface OplogAppend {
  entity: OplogEntity;
  entityId: string;
  op: OplogOp;
  baseVersion: number | null;
  before: unknown | null;
  after: unknown | null;
  by: OplogEntry["by"];
  at: number;
  runId?: string | null;
  /** Given for ops whose diff is not before→after (a rank move); derived otherwise. */
  patch?: Record<string, unknown> | null;
}

/** An op as another machine's log carries it; imported with its own device id, never re-stamped. */
export interface ForeignOp {
  device: string;
  deviceSeq: number;
  entity: OplogEntity;
  entityId: string;
  op: OplogOp;
  baseVersion: number | null;
  by: OplogEntry["by"];
  at: number;
  runId?: string | null;
  patch: Record<string, unknown> | null;
}

export class Oplog extends Service {
  static provide = "oplog";
  static inject = ["db", "hub"];

  constructor(ctx: Context) {
    super(ctx, "oplog");
  }

  [Service.init]() {
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("oplog.recent", (projectId, limit) => ctx.oplog.recent(projectId, limit));
      ctx.ipc.handle("oplog.history", (projectId, entity, id, limit) => ctx.oplog.historyFor(projectId, entity, id, limit));
      ctx.ipc.handle("oplog.undo", (projectId, entityId) => ctx.oplog.undoLast(projectId, entityId));
      ctx.ipc.handle("oplog.undoRun", (projectId, runId) => ctx.oplog.undoRun(projectId, runId));
    });
  }

  private db(projectId: string): ProjectDb {
    return (this.ctx.db as Db).for(projectId);
  }

  private get device(): string {
    return this.ctx.hub.deviceId;
  }

  /**
   * Lands one row, stamped with this machine's id and the next number in this
   * machine's own sequence. `device_seq` is deliberately not the row's seq: a
   * cache rebuilt from the folder renumbers rows but keeps their device_seq, and
   * the op id `device:device_seq` must stay unique and monotonic through that.
   */
  append(projectId: string, entry: OplogAppend): OplogEntry {
    const db = this.db(projectId);
    const patch = patchOf(entry.op, entry.before, entry.after, entry.patch);
    const runId = entry.runId !== undefined ? entry.runId : (writeContext.getStore()?.runId ?? null);
    const deviceSeq = ((db.prepare("SELECT MAX(device_seq) AS m FROM oplog WHERE device = ?").get(this.device) as { m: number | null }).m ?? 0) + 1;
    const info = db
      .prepare(
        `INSERT INTO oplog (entity, entity_id, op, base_version, before_json, after_json, by, at, run_id, device, device_seq, patch_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.entity,
        entry.entityId,
        entry.op,
        entry.baseVersion,
        entry.before ? JSON.stringify(entry.before) : null,
        entry.after ? JSON.stringify(entry.after) : null,
        entry.by,
        entry.at,
        runId,
        this.device,
        deviceSeq,
        patch ? JSON.stringify(patch) : null
      );
    const seq = Number(info.lastInsertRowid);
    const row = db.prepare("SELECT * FROM oplog WHERE seq = ?").get(seq) as OplogRow;
    const stored = rowToEntry(row);
    this.ctx.emit("oplog/appended", projectId, stored);
    return stored;
  }

  /**
   * Rows from another machine's log. No snapshots, so undo cannot revert them;
   * they are history and the merge's evidence. Duplicates by (device, seq) are skipped.
   */
  importForeign(projectId: string, ops: ForeignOp[], opts: { includeOwn?: boolean } = {}): number {
    const db = this.db(projectId);
    let imported = 0;
    db.transaction(() => {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO oplog (entity, entity_id, op, base_version, before_json, after_json, by, at, run_id, device, device_seq, patch_json)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`
      );
      for (const op of ops) {
        // Our own rows come back only when the cache is rebuilt from the folder.
        if (op.device === this.device && !opts.includeOwn) continue;
        imported += insert.run(op.entity, op.entityId, op.op, op.baseVersion, op.by, op.at, op.runId ?? null, op.device, op.deviceSeq, op.patch ? JSON.stringify(op.patch) : null).changes;
      }
    });
    return imported;
  }

  recent(projectId: string, limit = 50): OplogEntry[] {
    return (this.db(projectId).prepare("SELECT * FROM oplog ORDER BY at DESC, seq DESC LIMIT ?").all(limit) as OplogRow[]).map(rowToEntry);
  }

  /** Rows after a given seq, oldest first: what the folder's log still lacks. */
  since(projectId: string, seq: number): OplogEntry[] {
    return (this.db(projectId).prepare("SELECT * FROM oplog WHERE seq > ? ORDER BY seq ASC").all(seq) as OplogRow[]).map(rowToEntry);
  }

  /** One entity's history, newest first. */
  historyFor(projectId: string, entity: OplogEntity, id: string, limit = 20): OplogEntry[] {
    return (this.db(projectId).prepare("SELECT * FROM oplog WHERE entity = ? AND entity_id = ? ORDER BY at DESC, seq DESC LIMIT ?").all(entity, id, limit) as OplogRow[]).map(rowToEntry);
  }

  wasPurged(projectId: string, id: string): boolean {
    return wasPurged(this.db(projectId), id);
  }

  /** Remove an entity's own history. Only a purge does this, and it leaves a tombstone behind. */
  erase(projectId: string, entity: OplogEntity, id: string): void {
    this.db(projectId).prepare("DELETE FROM oplog WHERE entity = ? AND entity_id = ?").run(entity, id);
  }

  undoLast(projectId: string, entityId?: string): UndoResult | null {
    return undoLast(this.db(projectId), this.device, entityId);
  }

  undoRun(projectId: string, runId: string): UndoRunResult {
    return undoRun(this.db(projectId), runId);
  }
}
