/**
 * A database written by the pre-boards build migrates in place when ctx.db
 * opens it: nothing is dropped, every item lands on a board and gets a key.
 * Plugin migrations run under their own namespace and version counter.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { migrateCore } from "@tomrade/db";
import { fresh } from "@tomrade/testkit";

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-db-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
function legacyFile(withOrphan = false): string {
  const file = path.join(dir, `legacy-${n++}.db`);
  const db = new Database(file);
  db.exec(LEGACY_SQL);
  const now = Date.now();
  db.prepare("INSERT INTO projects (id, name, description, created_at, updated_at) VALUES ('default', 'Default Project', NULL, ?, ?)").run(now, now);
  for (const [i, title] of ["Oldest", "Middle", "Newest"].entries()) {
    db.prepare("INSERT INTO items (id, project_id, title, kind, status, rank, updated_at, updated_by, version, human_locked) VALUES (?, 'default', ?, 'ticket', 'todo', 0, ?, 'human', 1, 0)").run(`i${i}`, title, now + i);
  }
  if (withOrphan) {
    db.prepare("INSERT INTO items (id, project_id, title, kind, status, rank, updated_at, updated_by, version, human_locked) VALUES ('orphan', 'ghost', 'Stray', 'ticket', 'todo', 0, ?, 'human', 1, 0)").run(now);
  }
  db.close();
  return file;
}

describe("core migration", () => {
  it("backfills board_id, priority and keys without losing rows", async () => {
    const { items, boards, board } = await fresh({ dbPath: legacyFile() });
    expect(board.name).toBe("All work");
    const all = items.list({ projectId: "default" });
    expect(all.length).toBe(3);
    expect(all.every((i) => i.boardId === board.id)).toBe(true);
    expect(all.every((i) => i.priority === 2)).toBe(true);
    expect(items.getByKey("default", "TOM-1")?.title).toBe("Oldest");
    expect(items.getByKey("default", "TOM-3")?.title).toBe("Newest");
    expect(boards.list("default").length).toBe(3);
  });

  it("is idempotent: reopening a migrated database leaves it alone", async () => {
    const file = legacyFile();
    const first = await fresh({ dbPath: file });
    const before = first.boards.list("default").length;
    await first.ctx.fiber.dispose();
    const second = await fresh({ dbPath: file });
    expect(second.boards.list("default").length).toBe(before);
    expect(second.items.list().length).toBe(3);
  });

  it("items whose project row is missing are recovered, not left unkeyed", async () => {
    const { items } = await fresh({ dbPath: legacyFile(true) });
    expect(items.getByKey("ghost", "TOM-1")?.title).toBe("Stray");
  });

  it("a second migration never rewinds the key counter", async () => {
    const { db, items, board } = await fresh({ dbPath: legacyFile() });
    const fourth = items.create({ title: "Fourth", boardId: board.id, by: "human" });
    items.delete(fourth.id, "human");
    db.pragma("user_version = 1");
    migrateCore(db.handle);
    expect(items.create({ title: "Fifth", boardId: board.id, by: "human" }).key).toBe("TOM-5");
  });
});

describe("plugin migrations", () => {
  it("run once per version under the plugin's own counter", async () => {
    const { db } = await fresh();
    const steps = [
      { version: 1, up: "CREATE TABLE plugin_demo_notes (id TEXT PRIMARY KEY, body TEXT)" },
      { version: 2, up: "ALTER TABLE plugin_demo_notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0" }
    ];
    expect(db.migrate("demo", steps)).toBe(2);
    expect(db.migrate("demo", steps)).toBe(2);
    db.prepare("INSERT INTO plugin_demo_notes (id, body, pinned) VALUES ('n1', 'hi', 1)").run();
    expect(db.migrate("demo", [...steps, { version: 3, up: (h) => h.exec("CREATE TABLE plugin_demo_tags (name TEXT)") }])).toBe(3);
    expect((db.prepare("SELECT version FROM plugin_migrations WHERE namespace = 'demo'").get() as { version: number }).version).toBe(3);
  });

  it("refuse to touch tables outside the plugin's namespace", async () => {
    const { db } = await fresh();
    expect(() => db.migrate("demo", [{ version: 1, up: "CREATE TABLE notes (id TEXT)" }])).toThrow(/plugin_demo_/);
    expect(() => db.migrate("demo", [{ version: 1, up: "DROP TABLE items" }])).toThrow(/plugin_demo_/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
  });
});
