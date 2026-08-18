import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export type Db = Database.Database;

/** Open (and initialize) the SQLite database at the given path. */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  return db;
}
