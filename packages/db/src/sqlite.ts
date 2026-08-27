import type Database from "better-sqlite3";

export type Sqlite = Database.Database;
export type Statement = Database.Statement;

/** The slice of the connection seeds and helpers need; satisfied by the raw handle and by ctx.db. */
export interface Queryable {
  prepare(sql: string): Statement;
}
