/**
 * A database written by the pre-boards build must migrate in place: nothing is
 * dropped, every item lands on a board and gets a key.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BoardsRepository, ItemsRepository, ProjectsRepository } from "../src/index.js";
import { migrate } from "../src/migrate.js";
import { SCHEMA_INDEXES_SQL, SCHEMA_TABLES_SQL } from "../src/schema.js";

/** The schema as it stood before boards, views, priority and keys. */
const LEGACY_SQL = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE items (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default', title TEXT NOT NULL, body TEXT,
  kind TEXT NOT NULL DEFAULT 'ticket', status TEXT NOT NULL DEFAULT 'backlog', parent_id TEXT,
  rank REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, human_locked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE oplog (seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, op TEXT NOT NULL,
  base_version INTEGER, before_json TEXT, after_json TEXT, by TEXT NOT NULL, at INTEGER NOT NULL);
`;

function legacyDb() {
  const db = new Database(":memory:");
  db.exec(LEGACY_SQL);
  const now = Date.now();
  db.prepare("INSERT INTO projects (id, name, description, created_at, updated_at) VALUES ('default', 'Default Project', NULL, ?, ?)").run(now, now);
  for (const [i, title] of ["Oldest", "Middle", "Newest"].entries()) {
    db.prepare(
      "INSERT INTO items (id, project_id, title, kind, status, rank, updated_at, updated_by, version, human_locked) VALUES (?, 'default', ?, 'ticket', 'todo', 0, ?, 'human', 1, 0)"
    ).run(`i${i}`, title, now + i);
  }
  return db;
}

describe("migration", () => {
  it("backfills board_id, priority and keys without losing rows", () => {
    const db = legacyDb();
    db.exec(SCHEMA_TABLES_SQL);
    migrate(db);
    db.exec(SCHEMA_INDEXES_SQL);

    const boards = new BoardsRepository(db);
    const items = new ItemsRepository(db);
    const board = boards.list("default").find((b) => !b.across)!;
    expect(board.name).toBe("All work");

    const all = items.list({ projectId: "default" });
    expect(all.length).toBe(3);
    expect(all.every((i) => i.boardId === board.id)).toBe(true);
    expect(all.every((i) => i.priority === 2)).toBe(true);
    // oldest write gets the lowest key
    expect(items.getByKey("default", "TOM-1")?.title).toBe("Oldest");
    expect(items.getByKey("default", "TOM-3")?.title).toBe("Newest");
  });

  it("is idempotent and leaves a migrated database alone", () => {
    const db = legacyDb();
    db.exec(SCHEMA_TABLES_SQL);
    migrate(db);
    db.exec(SCHEMA_INDEXES_SQL);
    const before = new BoardsRepository(db).list("default").length;
    migrate(db);
    expect(new BoardsRepository(db).list("default").length).toBe(before);
    expect(new ItemsRepository(db).list().length).toBe(3);
  });

  it("items whose project row is missing are recovered, not left unkeyed", () => {
    const db = legacyDb();
    db.prepare("INSERT INTO items (id, project_id, title, kind, status, rank, updated_at, updated_by, version, human_locked) VALUES ('orphan', 'ghost', 'Stray', 'ticket', 'todo', 0, ?, 'human', 1, 0)").run(Date.now());
    db.exec(SCHEMA_TABLES_SQL);
    migrate(db);
    // the unique key index is the real assertion: it cannot be created while a
    // project's items all sit at key_num 0
    expect(() => db.exec(SCHEMA_INDEXES_SQL)).not.toThrow();
    expect(new ItemsRepository(db).getByKey("ghost", "TOM-1")?.title).toBe("Stray");
  });

  it("a second migration never rewinds the key counter", () => {
    const db = legacyDb();
    db.exec(SCHEMA_TABLES_SQL);
    migrate(db);
    db.exec(SCHEMA_INDEXES_SQL);
    const boards = new BoardsRepository(db);
    const items = new ItemsRepository(db);
    const board = boards.list("default").find((b) => !b.across)!;
    const fourth = items.create({ title: "Fourth", boardId: board.id, by: "human" });
    items.delete(fourth.id, "human");
    db.pragma("user_version = 1");
    migrate(db);
    expect(items.create({ title: "Fifth", boardId: board.id, by: "human" }).key).toBe("TOM-5");
  });

  it("a new item after migration continues the key sequence", () => {
    const db = legacyDb();
    db.exec(SCHEMA_TABLES_SQL);
    migrate(db);
    db.exec(SCHEMA_INDEXES_SQL);
    new ProjectsRepository(db).ensureDefault();
    const board = new BoardsRepository(db).list("default").find((b) => !b.across)!;
    const next = new ItemsRepository(db).create({ title: "Fourth", boardId: board.id, by: "human" });
    expect(next.key).toBe("TOM-4");
  });
});
