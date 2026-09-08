import { Context, Service } from "cordis";
import type { Db } from "@tomrade/db";
import type { OplogEntity, OplogEntry, UndoResult, UndoRunResult } from "@tomrade/domain";
import { writeContext } from "@tomrade/write";
import type {} from "@tomrade/ipc";
import { rowToEntry, type OplogRow } from "./rows.js";
import { undoLast, undoRun, wasPurged } from "./undo.js";

declare module "cordis" {
  interface Context {
    oplog: Oplog;
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    "oplog.recent": (limit?: number) => OplogEntry[];
    "oplog.history": (entity: OplogEntity, id: string, limit?: number) => OplogEntry[];
    "oplog.undo": (entityId?: string) => UndoResult | null;
    "oplog.undoRun": (runId: string) => UndoRunResult;
  }
}

export type OplogAppend = Omit<OplogEntry, "seq" | "runId"> & { runId?: string | null };

export class Oplog extends Service {
  static provide = "oplog";
  static inject = ["db"];

  constructor(ctx: Context) {
    super(ctx, "oplog");
  }

  [Service.init]() {
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("oplog.recent", (limit) => ctx.oplog.recent(limit));
      ctx.ipc.handle("oplog.history", (entity, id, limit) => ctx.oplog.historyFor(entity, id, limit));
      ctx.ipc.handle("oplog.undo", (entityId) => ctx.oplog.undoLast(entityId));
      ctx.ipc.handle("oplog.undoRun", (runId) => ctx.oplog.undoRun(runId));
    });
  }

  private get db(): Db {
    return this.ctx.db;
  }

  append(entry: OplogAppend): void {
    this.db
      .prepare(
        `INSERT INTO oplog (entity, entity_id, op, base_version, before_json, after_json, by, at, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        entry.runId !== undefined ? entry.runId : (writeContext.getStore()?.runId ?? null)
      );
  }

  recent(limit = 50): OplogEntry[] {
    return (this.db.prepare("SELECT * FROM oplog ORDER BY at DESC, seq DESC LIMIT ?").all(limit) as OplogRow[]).map(rowToEntry);
  }

  /** One entity's history, newest first. */
  historyFor(entity: OplogEntity, id: string, limit = 20): OplogEntry[] {
    return (this.db.prepare("SELECT * FROM oplog WHERE entity = ? AND entity_id = ? ORDER BY at DESC, seq DESC LIMIT ?").all(entity, id, limit) as OplogRow[]).map(rowToEntry);
  }

  wasPurged(id: string): boolean {
    return wasPurged(this.db, id);
  }

  /** Remove an entity's own history. Only a purge does this, and it leaves a tombstone behind. */
  erase(entity: OplogEntity, id: string): void {
    this.db.prepare("DELETE FROM oplog WHERE entity = ? AND entity_id = ?").run(entity, id);
  }

  undoLast(entityId?: string): UndoResult | null {
    return undoLast(this.db, entityId);
  }

  undoRun(runId: string): UndoRunResult {
    return undoRun(this.db, runId);
  }
}
