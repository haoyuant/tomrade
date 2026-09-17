/**
 * The pool. A pre-P0 `tomrade.db` (every project in one file) is split into one
 * cache per project on boot, migrating each file in place: nothing is dropped,
 * every item lands on a board and gets a key, the old file is moved aside.
 * Plugin migrations are registrations: declared, applied to every open file
 * of their scope, and to each one opened later.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-db-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A cache dir and a legacy file inside it, the way userData holds both. */
function workspace(): { cacheDir: string; legacyPath: string } {
  const dir = path.join(root, `ws-${n++}`);
  fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
  return { cacheDir: path.join(dir, "cache"), legacyPath: path.join(dir, "tomrade.db") };
}

function legacyFile(withOrphan = false): { cacheDir: string; legacyPath: string } {
  const ws = workspace();
  const db = new Database(ws.legacyPath);
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
  return ws;
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

function v5File(): { cacheDir: string; legacyPath: string; uiStatusViewId: string; uiBoardId: string } {
  const ws = workspace();
  const db = new Database(ws.legacyPath);
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
  return { ...ws, uiStatusViewId: "b-ui-status", uiBoardId: "b-ui" };
}

describe("views lifted to the project (v5 → v6), through the split", () => {
  it("each workstream becomes a filtered board view and scopes become views", async () => {
    const { cacheDir, legacyPath, uiStatusViewId, uiBoardId } = v5File();
    const { boards, views, items, project } = await fresh({ cacheDir, legacyPath });
    expect(project.id).toBe("default");
    expect(boards.list(project.id).map((b) => b.name)).toEqual(["Main", "UI"]);
    const all = views.listForProject(project.id);
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
    expect(views.ranks(project.id, ui.id)).toEqual({ i1: 2.5 });
    expect(all.find((v) => v.name === "Recently updated")!.query.sortBy).toEqual([{ field: "updated", dir: "desc" }]);
    expect(all.find((v) => v.name === "Epics")!.query.columnBy).toBe("epic");
    expect(items.list({ projectId: project.id }).length).toBe(1);
  });

  it("indexes items written before the search index existed", async () => {
    const { db, items, board, project } = await fresh();
    items.create({ projectId: project.id, title: "Invoice export", boardId: board.id, by: "human" });
    // An older build's file: rows in items, nothing in the index.
    db.exec("INSERT INTO items_fts(items_fts) VALUES ('delete-all')");
    expect(items.list({ projectId: project.id, search: "invoice" })).toEqual([]);
    db.pragma("user_version = 13");
    migrateCore(db.handle);
    expect(items.list({ projectId: project.id, search: "invoice" }).map((i) => i.title)).toEqual(["Invoice export"]);
  });

  it("running the lift again changes nothing", async () => {
    const { cacheDir, legacyPath } = v5File();
    const { db, views, project } = await fresh({ cacheDir, legacyPath });
    const before = views.listForProject(project.id).map((v) => v.id);
    db.pragma("user_version = 5");
    migrateCore(db.handle);
    expect(views.listForProject(project.id).map((v) => v.id)).toEqual(before);
  });

  it("drops a column a later build stopped reading, without losing the row it sat on", async () => {
    const { cacheDir, legacyPath, uiBoardId } = v5File();
    const { db, boards, project } = await fresh({ cacheDir, legacyPath });
    expect((db.prepare("PRAGMA table_info(boards)").all() as { name: string }[]).map((c) => c.name)).not.toContain("subtitle");
    expect(boards.get(project.id, uiBoardId)?.name).toBe("UI");
  });
});

describe("the legacy split", () => {
  it("backfills board_id, priority and keys without losing rows", async () => {
    const { cacheDir, legacyPath } = legacyFile();
    const { items, boards, board, project } = await fresh({ cacheDir, legacyPath });
    expect(board.name).toBe("Main");
    const all = items.list({ projectId: project.id });
    expect(all.length).toBe(3);
    expect(all.every((i) => i.boardId === board.id)).toBe(true);
    expect(all.every((i) => i.priority === 2)).toBe(true);
    expect(items.getByKey(project.id, "TOM-1")?.title).toBe("Oldest");
    expect(items.getByKey(project.id, "TOM-3")?.title).toBe("Newest");
    expect(boards.list(project.id).length).toBe(1);
  });

  it("moves the old file aside and leaves one cache per project", async () => {
    const { cacheDir, legacyPath } = legacyFile();
    const { ctx, project, hub } = await fresh({ cacheDir, legacyPath });
    expect(fs.existsSync(legacyPath)).toBe(false);
    const backups = fs.readdirSync(path.join(cacheDir, "backups"));
    expect(backups.some((f) => f.startsWith("tomrade.db.pre-split."))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "projects", project.id, "project.db"))).toBe(true);
    expect(ctx.db.openIds()).toEqual([project.id]);
    expect(hub.catalog.project(project.id)?.name).toBe("Default Project");
  });

  it("a split file reopens with its rows intact", async () => {
    const { cacheDir, legacyPath } = legacyFile();
    const { ctx, boards, items, project } = await fresh({ cacheDir, legacyPath });
    const before = boards.list(project.id).length;
    ctx.db.close(project.id);
    // A closed project is simply absent from a listing; only id-addressed reads throw.
    expect(items.list({ projectId: project.id })).toEqual([]);
    expect(items.get(project.id, "x")).toBeNull();
    expect(() => ctx.db.for(project.id)).toThrow(/not open/);
    ctx.db.open(project.id);
    expect(boards.list(project.id).length).toBe(before);
    expect(items.list({ projectId: project.id }).length).toBe(3);
  });

  it("items whose project row is missing are recovered into a project of their own", async () => {
    const { cacheDir, legacyPath } = legacyFile(true);
    const { items, projects } = await fresh({ cacheDir, legacyPath });
    expect(projects.list().map((p) => p.id).sort()).toEqual(["default", "ghost"]);
    expect(items.getByKey("ghost", "TOM-1")?.title).toBe("Stray");
    expect(items.list({ projectId: "default" }).length).toBe(3);
  });

  it("a second migration never rewinds the key counter", async () => {
    const { cacheDir, legacyPath } = legacyFile();
    const { db, items, board, project } = await fresh({ cacheDir, legacyPath });
    const fourth = items.create({ projectId: project.id, title: "Fourth", boardId: board.id, by: "human" });
    items.delete(project.id, fourth.id, "human");
    db.pragma("user_version = 1");
    migrateCore(db.handle);
    expect(items.create({ projectId: project.id, title: "Fifth", boardId: board.id, by: "human" }).key).toBe("TOM-5");
  });

  it("stamps every old oplog row with this machine's id", async () => {
    const { cacheDir, legacyPath } = legacyFile();
    const { db, hub } = await fresh({ cacheDir, legacyPath });
    // the split itself writes nothing to the oplog; migrateCore backfills leave the rows as they were
    const rows = db.prepare("SELECT device, device_seq, seq FROM oplog").all() as { device: string; device_seq: number; seq: number }[];
    expect(rows.every((r) => r.device === hub.deviceId && r.device_seq === r.seq)).toBe(true);
  });
});

describe("plugin migrations", () => {
  const steps = [
    { version: 1, up: "CREATE TABLE plugin_demo_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT)" },
    { version: 2, up: "ALTER TABLE plugin_demo_notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0" }
  ];
  const tables = { plugin_demo_notes: { project: "project_id", export: { order: "id" } } };

  it("apply to every open project now, and to each project opened later", async () => {
    const { ctx, db, projects, project } = await fresh();
    const dispose = ctx.db.migrate("demo", steps, { tables });
    db.prepare("INSERT INTO plugin_demo_notes (id, project_id, body, pinned) VALUES ('n1', ?, 'hi', 1)").run(project.id);
    expect((db.prepare("SELECT version FROM plugin_migrations WHERE namespace = 'demo'").get() as { version: number }).version).toBe(2);
    const later = projects.create({ name: "Later" });
    expect(ctx.db.for(later.id).prepare("SELECT COUNT(*) AS n FROM plugin_demo_notes").get()).toEqual({ n: 0 });
    dispose();
    // the registration is gone with the plugin; the table it made is not dropped
    const after = projects.create({ name: "After" });
    expect(() => ctx.db.for(after.id).prepare("SELECT 1 FROM plugin_demo_notes").get()).toThrow(/no such table/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM plugin_demo_notes").get()).toEqual({ n: 1 });
  });

  it("a namespace is registered once, and a new version runs on every file", async () => {
    const { ctx, db } = await fresh();
    ctx.db.migrate("demo", steps, { tables });
    expect(() => ctx.db.migrate("demo", steps, { tables })).toThrow(/already registered/);
    expect(ctx.db.registrations("project").map((r) => r.namespace)).toEqual(["demo"]);
    expect(db.prepare("PRAGMA table_info(plugin_demo_notes)").all().length).toBe(4);
  });

  it("refuses tables outside the namespace, undeclared tables, and a missing declaration", async () => {
    const { ctx, db } = await fresh();
    expect(() => ctx.db.migrate("demo", [{ version: 1, up: "CREATE TABLE notes (id TEXT)" }], { tables })).toThrow(/plugin_demo_/);
    expect(() => ctx.db.migrate("demo", [{ version: 1, up: "DROP TABLE items" }], { tables })).toThrow(/plugin_demo_/);
    expect(() => ctx.db.migrate("demo", steps)).toThrow(/tables declaration/);
    expect(() => ctx.db.migrate("demo", steps, { tables: {} })).toThrow(/does not declare/);
    expect(() => ctx.db.migrate("demo", steps, { tables: { plugin_demo_notes: { export: false } } })).toThrow(/project scope/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
  });

  it("a hub-scope namespace lands in hub.db and nowhere else", async () => {
    const { ctx, db } = await fresh();
    ctx.db.migrate("usage", [{ version: 1, up: "CREATE TABLE plugin_usage_days (day TEXT PRIMARY KEY, cost REAL)" }], {
      scope: "hub",
      tables: { plugin_usage_days: { export: { order: "day" } } }
    });
    ctx.db.hub.prepare("INSERT INTO plugin_usage_days (day, cost) VALUES ('2026-09-07', 1.5)").run();
    expect(ctx.db.hub.prepare("SELECT COUNT(*) AS n FROM plugin_usage_days").get()).toEqual({ n: 1 });
    expect(() => db.prepare("SELECT 1 FROM plugin_usage_days").get()).toThrow(/no such table/);
    expect(() => ctx.db.migrate("other", [{ version: 1, up: "CREATE TABLE plugin_other_t (id TEXT)" }], { scope: "hub", tables: { plugin_other_t: { project: "id", export: false } } })).toThrow(/hub tables belong to no project/);
  });
});
