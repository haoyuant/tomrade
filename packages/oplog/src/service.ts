import { Context, Service } from "cordis";
import type { Db, ProjectDb } from "@tomrade/db";
import type {} from "@tomrade/hub";
import type { OplogEntity, OplogEntry, OplogOp, RollbackResult, UndoRecord, UndoResult, UndoRunResult, UndoStep } from "@tomrade/domain";
import { extensionScope, writeContext } from "@tomrade/write";
import type {} from "@tomrade/ipc";
import { patchOf, rowToEntry, type OplogRow } from "./rows.js";
import { applyEntry, labelOf, redoSummary, undoLast, undoRow, undoRun, undoVia, undoneRow, undoneRows, wasPurged } from "./undo.js";

declare module "cordis" {
  interface Context {
    oplog: Oplog;
  }
  interface Events {
    /** A row landed in a project's oplog; the storage layer appends it to the folder's log. */
    "oplog/appended"(projectId: string, entry: OplogEntry): void;
    /** Rows were taken back or put back outside a write: the state moved, so the folder is stale. */
    "oplog/reverted"(projectId: string): void;
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    "oplog.recent": (projectId: string, limit?: number) => OplogEntry[];
    "oplog.history": (projectId: string, entity: OplogEntity, id: string, limit?: number) => OplogEntry[];
    /** ⌘Z. With an entity id: that entity's latest backlog write, out of order; without: the newest record anywhere. */
    "oplog.undo": (projectId: string, entityId?: string) => UndoStep | null;
    "oplog.undoRun": (projectId: string, runId: string) => UndoRunResult;
    "oplog.undoVia": (projectId: string, pluginId: string) => UndoRunResult;
    /** ⇧⌘Z: the record undone most recently. */
    "oplog.redo": (projectId: string) => UndoStep | null;
    /** The project's history, newest first, undone records included. */
    "oplog.timeline": (projectId: string, limit?: number) => UndoRecord[];
    /** Move the cursor: undo everything newer than a live record, or redo up to and including an undone one. */
    "oplog.rollback": (projectId: string, ref: string) => RollbackResult;
    /** Take back one named record, wherever it sits. */
    "oplog.revert": (projectId: string, ref: string) => UndoStep;
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
  via?: string | null;
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

/**
 * A plugin whose own operations belong in ⌘Z and the history window. It lists
 * them as records, takes one back or re-applies one by its id, and drops what
 * it had undone when a write lands anywhere. Registered with `ctx.oplog.provide`.
 */
export interface UndoProvider {
  id: string;
  /** Newest first, undone records included with `undoneAt` set. */
  timeline(projectId: string, limit: number): UndoRecord[] | Promise<UndoRecord[]>;
  /** Revert one live record; the line returned goes in the toast. Throw to refuse. */
  undo(projectId: string, id: string): string | Promise<string>;
  /** Re-apply one undone record. */
  redo(projectId: string, id: string): string | Promise<string>;
  /** A write landed: the redo stack is void. Synchronous — it runs inside the write's transaction. */
  forget(projectId: string): void;
}

export const BACKLOG_PROVIDER = "oplog";
const TIMELINE_LIMIT = 200;
const isOwnUndoable = (op: string) => op !== "purge" && op !== "merge";

export class Oplog extends Service {
  static provide = "oplog";
  static inject = ["db", "hub"];

  private readonly home: Context;
  private readonly providers = new Map<string, UndoProvider>();

  constructor(ctx: Context) {
    super(ctx, "oplog");
    this.home = ctx;
  }

  [Service.init]() {
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("oplog.recent", (projectId, limit) => ctx.oplog.recent(projectId, limit));
      ctx.ipc.handle("oplog.history", (projectId, entity, id, limit) => ctx.oplog.historyFor(projectId, entity, id, limit));
      ctx.ipc.handle("oplog.undo", (projectId, entityId) => (entityId ? ctx.oplog.undoEntity(projectId, entityId) : ctx.oplog.undo(projectId)));
      ctx.ipc.handle("oplog.undoRun", (projectId, runId) => ctx.oplog.undoRun(projectId, runId));
      ctx.ipc.handle("oplog.undoVia", (projectId, pluginId) => ctx.oplog.undoVia(projectId, pluginId));
      ctx.ipc.handle("oplog.redo", (projectId) => ctx.oplog.redo(projectId));
      ctx.ipc.handle("oplog.timeline", (projectId, limit) => ctx.oplog.timeline(projectId, limit));
      ctx.ipc.handle("oplog.rollback", (projectId, ref) => ctx.oplog.rollback(projectId, ref));
      ctx.ipc.handle("oplog.revert", (projectId, ref) => ctx.oplog.revert(projectId, ref));
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
   * A write is a fork in history: whatever ⌘Z had taken back can no longer be
   * put back, here or in any provider, unless the row is itself a redo.
   */
  append(projectId: string, entry: OplogAppend, opts: { keepUndone?: boolean } = {}): OplogEntry {
    const db = this.db(projectId);
    const stored = db.transaction(() => {
      const row = this.insert(db, entry);
      if (!opts.keepUndone) this.forgetIn(db, projectId);
      return row;
    });
    this.home.emit("oplog/appended", projectId, stored);
    return stored;
  }

  private insert(db: ProjectDb, entry: OplogAppend): OplogEntry {
    const patch = patchOf(entry.op, entry.before, entry.after, entry.patch);
    const runId = entry.runId !== undefined ? entry.runId : (writeContext.getStore()?.runId ?? null);
    const via = entry.via !== undefined ? entry.via : (extensionScope.getStore()?.pluginId ?? null);
    // Rows parked for redo still hold their number; reusing it would give two ops one identity in the folder's log.
    const taken = db
      .prepare("SELECT MAX(m) AS m FROM (SELECT MAX(device_seq) AS m FROM oplog WHERE device = ? UNION ALL SELECT MAX(device_seq) AS m FROM oplog_undone WHERE device = ?)")
      .get(this.device, this.device) as { m: number | null };
    const deviceSeq = (taken.m ?? 0) + 1;
    const info = db
      .prepare(
        `INSERT INTO oplog (entity, entity_id, op, base_version, before_json, after_json, by, at, run_id, device, device_seq, patch_json, via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        patch ? JSON.stringify(patch) : null,
        via
      );
    const seq = Number(info.lastInsertRowid);
    return rowToEntry(db.prepare("SELECT * FROM oplog WHERE seq = ?").get(seq) as OplogRow);
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
    const db = this.db(projectId);
    db.prepare("DELETE FROM oplog WHERE entity = ? AND entity_id = ?").run(entity, id);
    db.prepare("DELETE FROM oplog_undone WHERE entity = ? AND entity_id = ?").run(entity, id);
  }

  // ── the backlog's own undo ───────────────────────────────────────────────────

  /** This machine's newest backlog write — or one entity's — reverted and parked for redo. */
  undoLast(projectId: string, entityId?: string): UndoResult | null {
    const result = undoLast(this.db(projectId), this.device, entityId);
    if (result) this.home.emit("oplog/reverted", projectId);
    return result;
  }

  undoRun(projectId: string, runId: string): UndoRunResult {
    const result = undoRun(this.db(projectId), runId);
    if (result.reverted) this.home.emit("oplog/reverted", projectId);
    return result;
  }

  /** Take back what one extension wrote in a project, optionally only since a moment. */
  undoVia(projectId: string, pluginId: string, since?: number): UndoRunResult {
    const result = undoVia(this.db(projectId), pluginId, since);
    if (result.reverted) this.home.emit("oplog/reverted", projectId);
    return result;
  }

  /** The toast's Undo: one entity's latest write, whatever landed since. */
  undoEntity(projectId: string, entityId: string): UndoStep | null {
    const result = this.undoLast(projectId, entityId);
    return result ? { record: this.recordOf(result.entry, Date.now()), summary: result.summary } : null;
  }

  private recordOf(entry: OplogEntry, undoneAt: number | null): UndoRecord {
    return {
      ref: `${BACKLOG_PROVIDER}:${entry.seq}`,
      provider: BACKLOG_PROVIDER,
      id: String(entry.seq),
      entity: entry.entity,
      entityId: entry.entityId,
      op: entry.op,
      label: labelOf(entry),
      target: null,
      by: entry.by,
      at: entry.at,
      runId: entry.runId,
      device: entry.device,
      undoable: entry.device === this.device && isOwnUndoable(entry.op),
      undoneAt
    };
  }

  private backlog: UndoProvider = {
    id: BACKLOG_PROVIDER,
    timeline: (projectId, limit) => {
      const db = this.db(projectId);
      const live = (db.prepare("SELECT * FROM oplog ORDER BY at DESC, seq DESC LIMIT ?").all(limit) as OplogRow[]).map((r) => this.recordOf(rowToEntry(r), null));
      const undone = undoneRows(db, limit).map((r) => this.recordOf(rowToEntry(r), r.undone_at));
      return [...live, ...undone];
    },
    undo: (projectId, id) => {
      const db = this.db(projectId);
      const row = db.prepare("SELECT * FROM oplog WHERE seq = ?").get(Number(id)) as OplogRow | undefined;
      if (!row) throw new Error("That write is no longer in the history");
      if (row.device !== this.device) throw new Error("A write from another machine cannot be undone here");
      if (!isOwnUndoable(row.op)) throw new Error(row.op === "purge" ? "A permanent delete cannot be restored" : "A sync's decision is history, not a write to undo");
      const result = undoRow(db, row);
      this.home.emit("oplog/reverted", projectId);
      return result.summary;
    },
    redo: (projectId, id) => {
      const db = this.db(projectId);
      const row = undoneRow(db, Number(id));
      if (!row) throw new Error("That write is no longer waiting to be redone");
      const entry = rowToEntry(row);
      // Put back as a new row: it is a new write of ours as far as the folder's log is concerned, at its old place in time.
      const stored = db.transaction(() => {
        applyEntry(db, entry);
        db.prepare("DELETE FROM oplog_undone WHERE seq = ?").run(row.seq);
        return this.insert(db, { ...entry, runId: entry.runId, via: entry.via });
      });
      this.home.emit("oplog/appended", projectId, stored);
      this.home.emit("oplog/reverted", projectId);
      return redoSummary(entry);
    },
    forget: (projectId) => {
      this.db(projectId).prepare("DELETE FROM oplog_undone").run();
    }
  };

  // ── the timeline across providers ───────────────────────────────────────────

  /** Reversible: a provider's records leave the timeline with the plugin that registered it. */
  provide(provider: UndoProvider): () => void {
    if (provider.id === BACKLOG_PROVIDER || this.providers.has(provider.id)) throw new Error(`undo provider "${provider.id}" is already registered`);
    return this.ctx.effect(() => {
      this.providers.set(provider.id, provider);
      return () => this.providers.delete(provider.id);
    }, `oplog.provide(${provider.id})`);
  }

  private all(): UndoProvider[] {
    return [this.backlog, ...this.providers.values()];
  }

  private providerOf(ref: string): { provider: UndoProvider; id: string } {
    const cut = ref.indexOf(":");
    const provider = cut > 0 ? this.all().find((p) => p.id === ref.slice(0, cut)) : undefined;
    if (!provider) throw new Error(`No history provider for ${ref}`);
    return { provider, id: ref.slice(cut + 1) };
  }

  private forgetIn(db: ProjectDb, projectId: string): void {
    db.prepare("DELETE FROM oplog_undone").run();
    for (const provider of this.providers.values()) {
      try {
        provider.forget(projectId);
      } catch (error) {
        this.home.logger.warn(`oplog: ${provider.id}.forget failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** A provider that wrote something on its own tells the timeline so, and the redo stack goes. */
  forgetUndone(projectId: string): void {
    this.forgetIn(this.db(projectId), projectId);
  }

  /** Every provider's records, newest first. */
  async timeline(projectId: string, limit = TIMELINE_LIMIT): Promise<UndoRecord[]> {
    const lists = await Promise.all(this.all().map((p) => p.timeline(projectId, limit)));
    return lists.flat().sort(newestFirst).slice(0, limit);
  }

  private async step(projectId: string, record: UndoRecord, direction: "undo" | "redo"): Promise<UndoStep> {
    const { provider, id } = this.providerOf(record.ref);
    const summary = await (direction === "undo" ? provider.undo(projectId, id) : provider.redo(projectId, id));
    return { record, summary };
  }

  /** ⌘Z: the newest thing this machine did, wherever it did it. */
  async undo(projectId: string): Promise<UndoStep | null> {
    const record = (await this.timeline(projectId)).find((r) => r.undoable && r.undoneAt === null);
    return record ? this.step(projectId, record, "undo") : null;
  }

  /** ⇧⌘Z: the record undone most recently — the top of the redo stack. */
  async redo(projectId: string): Promise<UndoStep | null> {
    const record = redoOrder((await this.timeline(projectId)).filter((r) => r.undoneAt !== null))[0];
    return record ? this.step(projectId, record, "redo") : null;
  }

  /** Take back one record by name, in or out of order. */
  async revert(projectId: string, ref: string): Promise<UndoStep> {
    const record = (await this.timeline(projectId)).find((r) => r.ref === ref);
    if (!record) throw new Error("That record is no longer in the history");
    if (record.undoneAt !== null) throw new Error("That record is already undone");
    if (!record.undoable) throw new Error("That record cannot be undone here");
    return this.step(projectId, record, "undo");
  }

  /**
   * Move the cursor to a record. A live one: everything newer that can be
   * undone is, newest first, leaving it the latest thing done. An undone one:
   * the redo stack is replayed down to and including it. Stops at the first
   * refusal and says why, with the steps already taken.
   */
  async rollback(projectId: string, ref: string): Promise<RollbackResult> {
    const records = await this.timeline(projectId, TIMELINE_LIMIT * 5);
    const index = records.findIndex((r) => r.ref === ref);
    if (index < 0) throw new Error("That record is no longer in the history");
    const target = records[index]!;
    const plan: { record: UndoRecord; direction: "undo" | "redo" }[] =
      target.undoneAt === null
        ? records
            .slice(0, index)
            .filter((r) => r.undoable && r.undoneAt === null)
            .map((record) => ({ record, direction: "undo" as const }))
        : redoOrder(records.filter((r) => r.undoneAt !== null && r.undoneAt >= target.undoneAt!)).map((record) => ({ record, direction: "redo" as const }));
    const steps: UndoStep[] = [];
    for (const { record, direction } of plan) {
      try {
        steps.push(await this.step(projectId, record, direction));
      } catch (error) {
        return { steps, stopped: error instanceof Error ? error.message : String(error) };
      }
    }
    return { steps, stopped: null };
  }
}

/**
 * Newest first. Writes land within one millisecond of each other, so a tie on
 * `at` falls back to a provider's own ids, which grow with time; records from
 * different providers with the same `at` keep their order.
 */
const newestFirst = (a: UndoRecord, b: UndoRecord): number => {
  if (a.at !== b.at) return b.at - a.at;
  if (a.provider !== b.provider) return 0;
  const x = Number(a.id);
  const y = Number(b.id);
  return Number.isFinite(x) && Number.isFinite(y) ? y - x : b.id.localeCompare(a.id);
};

/** The redo stack, top first: undone most recently, and among those undone together the oldest — it was undone last. */
const redoOrder = (records: UndoRecord[]): UndoRecord[] => [...records].sort((a, b) => b.undoneAt! - a.undoneAt! || newestFirst(b, a));
