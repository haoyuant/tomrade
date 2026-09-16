/**
 * Target core schema. Every table is created with its full current definition,
 * so a fresh database needs no migration; `migrateCore` brings a database
 * written by an older build up to the same shape.
 */
export const CORE_SCHEMA_VERSION = 13;

export const CORE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  key_prefix    TEXT NOT NULL DEFAULT 'TOM',
  next_key_num  INTEGER NOT NULL DEFAULT 1,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- A board is an option of the built-in Workstream field. across/sort are
-- legacy columns (cross-board scopes became saved views); kept for stability.
CREATE TABLE IF NOT EXISTS boards (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT 'i-board',
  across        INTEGER NOT NULL DEFAULT 0,
  sort          TEXT,
  note          TEXT,
  rank          REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  repo_id       TEXT,
  repo_path     TEXT NOT NULL DEFAULT ''
);

-- A code repository a workstream stands for. Its identity is the remote URL,
-- shared with the project; where it is checked out is each machine's own.
CREATE TABLE IF NOT EXISTS repos (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  remote         TEXT NOT NULL,
  name           TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- A saved view: one layout plus one query, owned by the project. board_id is a
-- legacy column from when views sliced one board; always '' now.
CREATE TABLE IF NOT EXISTS views (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL DEFAULT '',
  board_id      TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT 'i-board',
  layout        TEXT NOT NULL DEFAULT 'board',
  query_json    TEXT NOT NULL DEFAULT '{}',
  rank          REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL DEFAULT 'default',
  board_id      TEXT NOT NULL DEFAULT '',
  key_num       INTEGER NOT NULL DEFAULT 0,
  title         TEXT NOT NULL,
  body          TEXT,
  kind          TEXT NOT NULL DEFAULT 'ticket',
  work_type     TEXT NOT NULL DEFAULT 'coding',
  playbook_id   TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{"resources":[],"submissions":[],"reviews":[]}',
  status        TEXT NOT NULL DEFAULT 'backlog',
  priority      INTEGER NOT NULL DEFAULT 2,
  parent_id     TEXT,
  rank          REAL NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  human_locked  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS labels (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  name          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  bases_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS item_labels (
  item_id       TEXT NOT NULL,
  label_id      TEXT NOT NULL,
  PRIMARY KEY (item_id, label_id)
);

CREATE TABLE IF NOT EXISTS item_relations (
  from_item_id  TEXT NOT NULL,
  to_item_id    TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (from_item_id, to_item_id, kind)
);

-- Sparse: a row appears only once a human drags that item in that view;
-- ordering falls back to items.rank otherwise.
CREATE TABLE IF NOT EXISTS view_item_rank (
  view_id       TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  rank          REAL NOT NULL,
  PRIMARY KEY (view_id, item_id)
);

-- Custom fields: definitions per project, options for selects, and one sparse
-- value row per (item, field). A number lands in num, everything else in text,
-- so a sort or range filter on any field is one indexed column.
CREATE TABLE IF NOT EXISTS fields (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  rank          REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS field_options (
  id            TEXT PRIMARY KEY,
  field_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  rank          REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS item_values (
  item_id       TEXT NOT NULL,
  field_id      TEXT NOT NULL,
  num           REAL,
  text          TEXT,
  PRIMARY KEY (item_id, field_id)
);

-- device/device_seq name the machine that made the write and its position in
-- that machine's own sequence, so "device:device_seq" is one op's identity
-- everywhere; patch_json is the fields it changed, which is what the folder's
-- log carries and what a merge arbitrates with.
CREATE TABLE IF NOT EXISTS oplog (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity        TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  op            TEXT NOT NULL,
  base_version  INTEGER,
  before_json   TEXT,
  after_json    TEXT,
  by            TEXT NOT NULL,
  at            INTEGER NOT NULL,
  run_id        TEXT,
  device        TEXT NOT NULL DEFAULT '',
  device_seq    INTEGER,
  patch_json    TEXT
);

-- Rows ⌘Z took back, kept whole so ⇧⌘Z can put them back: the redo stack.
-- Any new write empties it. seq is the row's original oplog seq.
CREATE TABLE IF NOT EXISTS oplog_undone (
  seq           INTEGER PRIMARY KEY,
  entity        TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  op            TEXT NOT NULL,
  base_version  INTEGER,
  before_json   TEXT,
  after_json    TEXT,
  by            TEXT NOT NULL,
  at            INTEGER NOT NULL,
  run_id        TEXT,
  device        TEXT NOT NULL DEFAULT '',
  device_seq    INTEGER,
  patch_json    TEXT,
  undone_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_migrations (
  namespace     TEXT PRIMARY KEY,
  version       INTEGER NOT NULL
);
`;

/** Created after migration: the unique key index cannot exist while backfill is pending. */
export const CORE_INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_sequence ON deliveries(project_id, item_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_active ON deliveries(project_id, item_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_boards_project ON boards(project_id, rank);
CREATE INDEX IF NOT EXISTS idx_views_project ON views(project_id, rank);
CREATE INDEX IF NOT EXISTS idx_repos_project ON repos(project_id, name);
CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id, status);
CREATE INDEX IF NOT EXISTS idx_items_board ON items(board_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_key ON items(project_id, key_num);
CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_name ON labels(project_id, name);
CREATE INDEX IF NOT EXISTS idx_item_labels_label ON item_labels(label_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON item_relations(to_item_id);
CREATE INDEX IF NOT EXISTS idx_fields_project ON fields(project_id, rank);
CREATE INDEX IF NOT EXISTS idx_field_options_field ON field_options(field_id, rank);
CREATE INDEX IF NOT EXISTS idx_item_values_num ON item_values(field_id, num);
CREATE INDEX IF NOT EXISTS idx_item_values_text ON item_values(field_id, text);
CREATE INDEX IF NOT EXISTS idx_oplog_purge ON oplog(entity_id) WHERE op = 'purge';
CREATE INDEX IF NOT EXISTS idx_oplog_run ON oplog(run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_oplog_device ON oplog(device, device_seq) WHERE device_seq IS NOT NULL;
`;
