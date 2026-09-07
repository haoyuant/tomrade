import Database from "better-sqlite3";
import type { Sqlite, Statement } from "./sqlite.js";

/**
 * One open SQLite file: a project's cache, or the Hub's. Every repository asks
 * `ctx.db.for(projectId)` for one of these on each call and never keeps it,
 * because a rebuild swaps the file underneath.
 */
export class ProjectDb {
  readonly handle: Sqlite;
  private open = true;

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

  prepare(sql: string): Statement {
    return this.handle.prepare(sql);
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
    this.handle.close();
  }
}

export class ProjectNotOpenError extends Error {
  constructor(public readonly projectId: string) {
    super(`Project ${projectId} is not open on this machine`);
    this.name = "ProjectNotOpenError";
  }
}
