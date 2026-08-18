export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL DEFAULT 'default',
  title         TEXT NOT NULL,
  body          TEXT,
  kind          TEXT NOT NULL DEFAULT 'ticket',
  status        TEXT NOT NULL DEFAULT 'backlog',
  parent_id     TEXT,
  rank          REAL NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  human_locked  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id, status);

CREATE TABLE IF NOT EXISTS oplog (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity        TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  op            TEXT NOT NULL,
  base_version  INTEGER,
  before_json   TEXT,
  after_json    TEXT,
  by            TEXT NOT NULL,
  at            INTEGER NOT NULL
);
`;