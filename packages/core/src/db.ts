import Database from "better-sqlite3";
import { SCHEMA_INDEXES_SQL, SCHEMA_TABLES_SQL } from "./schema.js";
import { migrate } from "./migrate.js";

export type Db = Database.Database;

/** Open the SQLite database at the given path: create tables, migrate, then index. */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_TABLES_SQL);
  migrate(db);
  db.exec(SCHEMA_INDEXES_SQL);
  return db;
}
