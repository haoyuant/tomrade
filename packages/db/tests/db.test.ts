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

/** A v5 database: boards as containers (two of them cross-board scopes), four built-in views per board. */
const V5_SQL = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, key_prefix TEXT NOT NULL DEFAULT 'TOM', next_key_num INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE boards (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'i-board', subtitle TEXT, across INTEGER NOT NULL DEFAULT 0, sort TEXT, note TEXT, rank REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE views (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'i-board', group_by TEXT NOT NULL DEFAULT 'status', kind TEXT NOT NULL DEFAULT 'status', columns_json TEXT NOT NULL DEFAULT '[]', filter_json TEXT NOT NULL DEFAULT '{}', wip_json TEXT NOT NULL DEFAULT '{}', rank REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default', board_id TEXT NOT NULL DEFAULT '', key_num INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, body TEXT, kind TEXT NOT NULL DEFAULT 'ticket', status TEXT NOT NULL DEFAULT 'backlog', priority INTEGER NOT NULL DEFAULT 2, parent_id TEXT, rank REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, human_locked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE view_item_rank (view_id TEXT NOT NULL, item_id TEXT NOT NULL, rank REAL NOT NULL, PRIMARY KEY (view_id, item_id));
CREATE TABLE oplog (seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, op TEXT NOT NULL, base_version INTEGER, before_json TEXT, after_json TEXT, by TEXT NOT NULL, at INTEGER NOT NULL, run_id TEXT);
`;

function v5File(): { file: string; uiStatusViewId: string; uiBoardId: string } {
  const file = path.join(dir, `v5-${n++}.db`);
  const db = new Database(file);
  db.exec(V5_SQL);
  const now = Date.now();
  db.prepare("INSERT INTO projects (id, name, key_prefix, next_key_num, created_at, updated_at) VALUES ('default', 'Default Project', 'TOM', 2, ?, ?)").run(now, now);
  const boards = [
    ["b-main", "Main", "i-board", 0, null, 0],
    ["b-ui", "UI", "i-panel", 0, null, 1],
    ["b-recent", "Recently updated", "i-clock", 1, "recent", 100],
    ["b-epics", "Epics", "i-stack", 1, null, 101]
  ] as const;
  for (const [id, name, icon, across, sort, rank] of boards) {
    db.prepare("INSERT INTO boards (id, project_id, name, icon, across, sort, rank, created_at, updated_at) VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?)").run(id, name, icon, across, sort, rank, now, now);
    ["status", "priority", "epic", "dependencies"].forEach((kind, i) => {
      const columns = id === "b-ui" && kind === "status" ? '["todo","doing"]' : "[]";
      const filter = id === "b-ui" && kind === "status" ? '{"labels":["bug"],"epics":["none"]}' : "{}";
      const wip = id === "b-ui" && kind === "status" ? '{"doing":2}' : "{}";
      db.prepare("INSERT INTO views (id, board_id, name, icon, group_by, kind, columns_json, filter_json, wip_json, rank, created_at, updated_at) VALUES (?, ?, ?, 'i-board', ?, ?, ?, ?, ?, ?, ?, ?)").run(
        `${id}-${kind}`, id, kind, kind === "dependencies" ? "status" : kind, kind, columns, filter, wip, i, now, now
      );
    });
  }
  db.prepare("INSERT INTO items (id, project_id, board_id, key_num, title, status, updated_at, updated_by) VALUES ('i1', 'default', 'b-ui', 1, 'On UI', 'todo', ?, 'human')").run(now);
  db.prepare("INSERT INTO view_item_rank (view_id, item_id, rank) VALUES ('b-ui-status', 'i1', 2.5)").run();
  db.pragma("user_version = 5");
  db.close();
  return { file, uiStatusViewId: "b-ui-status", uiBoardId: "b-ui" };
}

describe("views lifted to the project (v5 → v6)", () => {
  it("each workstream becomes a filtered board view and scopes become views", async () => {
    const { file, uiStatusViewId, uiBoardId } = v5File();
    const { boards, views, items } = await fresh({ dbPath: file });
    expect(boards.list("default").map((b) => b.name)).toEqual(["Main", "UI"]);
    const all = views.listForProject("default");
    expect(all.map((v) => `${v.name}:${v.layout}`)).toEqual(["Main:board", "UI:board", "Recently updated:table", "Epics:board"]);
    const ui = all.find((v) => v.name === "UI")!;
    expect(ui.id).toBe(uiStatusViewId);
    expect(ui.query.filter).toEqual([
      { field: "board", op: "in", values: [uiBoardId] },
      { field: "labels", op: "in", values: ["bug"] },
      { field: "epic", op: "in", values: [null] }
    ]);
    expect(ui.query.columns).toEqual(["todo", "doing"]);
    expect(ui.query.wip).toEqual({ doing: 2 });
    expect(ui.query.columnBy).toBe("status");
    // manual order on the reused row survives the lift
    expect(views.ranks(ui.id)).toEqual({ i1: 2.5 });
    expect(all.find((v) => v.name === "Recently updated")!.query.sortBy).toEqual([{ field: "updated", dir: "desc" }]);
    expect(all.find((v) => v.name === "Epics")!.query.columnBy).toBe("epic");
    expect(items.list({ projectId: "default" }).length).toBe(1);
  });

  it("running the lift again changes nothing", async () => {
    const { file } = v5File();
    const { db, views } = await fresh({ dbPath: file });
    const before = views.listForProject("default").map((v) => v.id);
    db.pragma("user_version = 5");
    migrateCore(db.handle);
    expect(views.listForProject("default").map((v) => v.id)).toEqual(before);
  });
});

describe("core migration", () => {
  it("backfills board_id, priority and keys without losing rows", async () => {
    const { items, boards, board } = await fresh({ dbPath: legacyFile() });
    expect(board.name).toBe("Main");
    const all = items.list({ projectId: "default" });
    expect(all.length).toBe(3);
    expect(all.every((i) => i.boardId === board.id)).toBe(true);
    expect(all.every((i) => i.priority === 2)).toBe(true);
    expect(items.getByKey("default", "TOM-1")?.title).toBe("Oldest");
    expect(items.getByKey("default", "TOM-3")?.title).toBe("Newest");
    expect(boards.list("default").length).toBe(1);
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
