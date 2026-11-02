import type { ProjectDb, Sqlite } from "@tomradex/db";
import { digestLines, exportParts, hasRowid, lineOf, manifestOf, projectRow, readPart, stateParts, type ExportOptions, type PartRow, type ProjectState, type StatePart } from "./state.js";

/** A row of a state file: the row, and its line there. */
interface KeptRow {
  row: Record<string, unknown>;
  line: Buffer;
}

/** A state file as last read: its rowids in file order and each row; a WITHOUT ROWID table keeps the rows alone. */
interface KeptPart {
  part: StatePart;
  order: number[];
  byRow: Map<number, KeptRow>;
  rows?: KeptRow[];
  /** The file's bytes, joined once and kept until a row of it is read again. */
  body?: Buffer;
}

interface Kept {
  db: ProjectDb;
  key: string;
  parts: KeptPart[];
  digest: string;
}

/** Per connection: the rows written since the kept digest read them, by table; `true` when the table cannot say which. */
const touchedBy = new WeakMap<Sqlite, Map<string, Set<number> | true>>();

function touched(handle: Sqlite): Map<string, Set<number> | true> {
  let seen = touchedBy.get(handle);
  if (!seen) {
    const tables = new Map<string, Set<number> | true>();
    handle.function("tomrade_touched", { deterministic: false }, (table: unknown, rowid: unknown) => {
      const name = String(table);
      const rows = tables.get(name);
      if (rows === true) return null;
      if (typeof rowid !== "number" && typeof rowid !== "bigint") tables.set(name, true);
      else if (rows) rows.add(Number(rowid));
      else tables.set(name, new Set([Number(rowid)]));
      return null;
    });
    touchedBy.set(handle, (seen = tables));
  }
  return seen;
}

/**
 * TEMP triggers live in this connection alone, never in the file, and see every write it makes to a
 * table: the plugin's own SQL, cascades, other triggers. A dropped table takes its triggers along;
 * the schema change that follows makes the next digest a full one, which watches again.
 */
function watch(db: ProjectDb, parts: StatePart[]): void {
  touched(db.handle);
  for (const table of new Set(parts.flatMap((p) => p.reads))) {
    const [before, after] = hasRowid(db, table) ? ["OLD.rowid", "NEW.rowid"] : ["NULL", "NULL"];
    const calls = { insert: `tomrade_touched('${table}', ${after})`, update: `tomrade_touched('${table}', ${before}), tomrade_touched('${table}', ${after})`, delete: `tomrade_touched('${table}', ${before})` };
    for (const [op, call] of Object.entries(calls)) {
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS "tomrade_touched_${table}_${op}" AFTER ${op.toUpperCase()} ON main."${table}" BEGIN SELECT ${call}; END`);
    }
  }
}

function keep(part: StatePart, rows: (KeptRow & { rowid: number | null })[]): KeptPart {
  if (!part.rowid) return { part, order: [], byRow: new Map(), rows: rows.map(({ row, line }) => ({ row, line })), body: undefined };
  return { part, order: rows.map((r) => r.rowid!), byRow: new Map(rows.map(({ rowid, row, line }) => [rowid!, { row, line }])), body: undefined };
}

const linesOf = (rows: PartRow[]) => rows.map((r) => ({ rowid: r.rowid, row: r.row, line: lineOf(r.row) }));

const rowsOf = (k: KeptPart): KeptRow[] => k.rows ?? k.order.map((id) => k.byRow.get(id)!);

const bodyOf = (k: KeptPart): Buffer => (k.body ??= Buffer.concat(rowsOf(k).map((r) => r.line)));

/**
 * The local digest for status, kept row by row: a write reads again only the rows it touched, and
 * the rowids of the files that hold them, in order. Another connection's commit or a schema change
 * shows in SQLite's own counters and reads everything again. The bytes hashed are the export's own,
 * so the digest is the same one.
 */
export class LocalDigests {
  private kept = new Map<string, Kept>();

  digest(projectId: string, db: ProjectDb, opts: ExportOptions): string {
    const key = this.keyOf(db, opts);
    const kept = this.kept.get(projectId);
    if (kept?.db !== db || kept.key !== key) {
      const parts = stateParts(db, projectId, opts);
      watch(db, parts);
      touched(db.handle).clear();
      return this.remember(projectId, db, key, parts.map((p) => keep(p, linesOf(readPart(db, projectId, p)))));
    }
    this.catchUp(projectId, db, kept);
    return kept.digest;
  }

  export(projectId: string, db: ProjectDb, opts: ExportOptions): ProjectState {
    return this.exportFiles(projectId, db, opts).state;
  }

  /**
   * An export and its state files' bytes, kept for the next digest and the next export: only the rows a write
   * touched are read again, and a file none of whose rows changed is the same bytes as before. Carried tables are
   * not this file's to keep; then everything is read and there are no bytes to give.
   */
  exportFiles(projectId: string, db: ProjectDb, opts: ExportOptions): { state: ProjectState; files?: Map<string, Buffer> } {
    if (Object.keys(opts.carry ?? {}).length) return { state: exportParts(db, projectId, opts).state };
    const key = this.keyOf(db, opts);
    let kept = this.kept.get(projectId);
    if (kept?.db === db && kept.key === key) this.catchUp(projectId, db, kept);
    else {
      touched(db.handle).clear();
      const { state, parts, lines } = exportParts(db, projectId, opts);
      watch(db, parts);
      kept = { db, key, parts: parts.map((p) => keep(p, lines.get(p.file)!)), digest: state.manifest.snapshot!.digest };
      this.kept.set(projectId, kept);
    }
    const tables: ProjectState["tables"] = {};
    const plugins: ProjectState["plugins"] = {};
    // Copies: whoever takes the state may change its rows, and the kept ones must stay as the file has them.
    for (const k of kept.parts) {
      const rows = rowsOf(k).map((r) => ({ ...r.row }));
      if (k.part.namespace) (plugins[k.part.namespace] ??= {})[k.part.table] = rows;
      else tables[k.part.table] = rows;
    }
    const state: ProjectState = { manifest: manifestOf(projectRow(db, projectId), opts, kept.digest), tables, plugins };
    return { state, files: new Map(kept.parts.map((k) => [k.part.file, bodyOf(k)])) };
  }

  /** The rows writes touched since the kept ones were read, read again. */
  private catchUp(projectId: string, db: ProjectDb, kept: Kept): void {
    const written = touched(db.handle);
    if (!written.size) return;
    const stale = kept.parts.filter((k) => k.part.reads.some((t) => written.has(t)));
    const rows = new Map(stale.map((k) => [k, written.get(k.part.table)]));
    written.clear();
    for (const [k, own] of rows) this.reread(projectId, db, k, own);
    if (stale.length) kept.digest = this.digestOf(kept.parts);
  }

  forget(projectId: string): void {
    this.kept.delete(projectId);
  }

  /** One file again: the rows its own table wrote, and any row its scope now takes in or lets go. */
  private reread(projectId: string, db: ProjectDb, k: KeptPart, own: Set<number> | true | undefined): void {
    if (!k.part.rowid || own === true) {
      Object.assign(k, keep(k.part, linesOf(readPart(db, projectId, k.part))));
      return;
    }
    const scope = k.part.scope ? ` WHERE ${k.part.scope}` : "";
    const order = (db.prepare(`SELECT rowid AS r FROM ${k.part.table}${scope} ORDER BY ${k.part.order}`).all(...(k.part.scope ? [{ projectId }] : [])) as { r: number }[]).map((x) => x.r);
    k.body = undefined;
    const missing = order.filter((id) => own?.has(id) || !k.byRow.has(id));
    if (missing.length) for (const r of linesOf(readPart(db, projectId, k.part, missing))) k.byRow.set(r.rowid!, { row: r.row, line: r.line });
    if (k.byRow.size > order.length) {
      const present = new Set(order);
      for (const id of k.byRow.keys()) if (!present.has(id)) k.byRow.delete(id);
    }
    k.order = order;
  }

  private remember(projectId: string, db: ProjectDb, key: string, parts: KeptPart[]): string {
    const digest = this.digestOf(parts);
    this.kept.set(projectId, { db, key, parts, digest });
    return digest;
  }

  private digestOf(parts: KeptPart[]): string {
    return digestLines(new Map(parts.map((k) => [k.part.file, rowsOf(k).map((r) => r.line)])));
  }

  private keyOf(db: ProjectDb, opts: ExportOptions): string {
    const counters = db.prepare("SELECT (SELECT data_version FROM pragma_data_version) AS version, (SELECT schema_version FROM pragma_schema_version) AS schema").get();
    return JSON.stringify([
      counters,
      [...(opts.exports ?? [])].sort(),
      opts.withhold ?? [],
      (opts.registrations ?? []).map((r) => [r.namespace, r.scope, r.tables])
    ]);
  }
}
