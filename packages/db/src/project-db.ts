import Database from "better-sqlite3";
import type { Sqlite, Statement } from "./sqlite.js";

/**
 * One open SQLite file: a project's cache, or the Hub's. Every repository asks
 * `ctx.db.for(projectId)` for one of these on each call and never keeps it,
 * because a rebuild swaps the file underneath.
 */
/** Statements kept per file. SQL built per call (`IN (?, ?, …)`) adds new ones, so the oldest go past this. */
const STATEMENT_CACHE_MAX = 512;

export class ProjectDb {
  readonly handle: Sqlite;
  private open = true;
  private readonly statements = new Map<string, Statement>();

  constructor(
    public readonly projectId: string,
    public readonly path: string
  ) {
    this.handle = new Database(path);
    if (path !== ":memory:") this.handle.pragma("journal_mode = WAL");
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Compiling SQL costs more than most of these queries take to run, and the same few run on every
   * read. Shared statements stay in their default mode: nothing here calls pluck, raw, expand or iterate.
   */
  prepare(sql: string): Statement {
    const kept = this.statements.get(sql);
    if (kept) {
      this.statements.delete(sql);
      this.statements.set(sql, kept);
      return kept;
    }
    const statement = this.handle.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > STATEMENT_CACHE_MAX) this.statements.delete(this.statements.keys().next().value!);
    return statement;
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  pragma(source: string): unknown {
    return this.handle.pragma(source, { simple: true });
  }

  transaction<T>(fn: () => T): T {
    return this.handle.transaction(fn)();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.statements.clear();
    this.handle.close();
  }
}

export class ProjectNotOpenError extends Error {
  constructor(public readonly projectId: string) {
    super(`Project ${projectId} is not open on this machine`);
    this.name = "ProjectNotOpenError";
  }
}
