/**
 * ctx.db is a pool: one SQLite file per project plus the Hub's. Plugin
 * migrations are registrations that follow every file, and a namespace that
 * does not declare its tables is refused.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { afterAll, describe, expect, it } from "vitest";
import { Db, ProjectNotOpenError, projectPredicate } from "@tomradex/db";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pool-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const STEPS = [{ version: 1, up: "CREATE TABLE IF NOT EXISTS plugin_demo_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT)" }];
const TABLES = { plugin_demo_notes: { project: "project_id", export: { order: "id" } as const } };

describe("the pool", () => {
  it("opens one file per project and refuses a project that is not open", async () => {
    const ctx = new Context();
    await ctx.plugin(Db, { dir: ":memory:" });
    ctx.db.open("a");
    ctx.db.open("b");
    ctx.db.for("a").prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('a', 'A', 1, 1)").run();
    expect(ctx.db.for("b").prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
    expect(ctx.db.openIds().sort()).toEqual(["a", "b"]);
    expect(() => ctx.db.for("c")).toThrow(ProjectNotOpenError);
    ctx.db.close("a");
    expect(ctx.db.has("a")).toBe(false);
  });

  it("keeps a project's cache on disk under the cache dir and removes it on remove()", async () => {
    const cache = path.join(dir, "cache");
    const ctx = new Context();
    await ctx.plugin(Db, { dir: cache });
    ctx.db.open("p1");
    expect(fs.existsSync(path.join(cache, "projects", "p1", "project.db"))).toBe(true);
    expect(fs.existsSync(path.join(cache, "hub.db"))).toBe(true);
    ctx.db.remove("p1");
    expect(fs.existsSync(path.join(cache, "projects", "p1"))).toBe(false);
  });

  it("applies a plugin registration to open files, to files opened later, and once per file", async () => {
    const ctx = new Context();
    await ctx.plugin(Db, { dir: ":memory:" });
    ctx.db.open("a");
    const dispose = ctx.db.migrate("demo", STEPS, { tables: TABLES });
    ctx.db.for("a").prepare("INSERT INTO plugin_demo_notes (id, project_id, body) VALUES ('n1', 'a', 'hi')").run();
    ctx.db.open("b");
    expect(ctx.db.for("b").prepare("SELECT COUNT(*) AS n FROM plugin_demo_notes").get()).toEqual({ n: 0 });
    expect(ctx.db.for("b").prepare("SELECT version FROM plugin_migrations WHERE namespace = 'demo'").get()).toEqual({ version: 1 });
    dispose();
    expect(ctx.db.registrations()).toEqual([]);
    // Nothing drops a table when the registration goes.
    expect(ctx.db.for("a").prepare("SELECT COUNT(*) AS n FROM plugin_demo_notes").get()).toEqual({ n: 1 });
  });

  it("hub-scope tables live in hub.db only", async () => {
    const ctx = new Context();
    await ctx.plugin(Db, { dir: ":memory:" });
    ctx.db.open("a");
    ctx.db.migrate("usage", [{ version: 1, up: "CREATE TABLE plugin_usage_days (day TEXT PRIMARY KEY, cost REAL)" }], { scope: "hub", tables: { plugin_usage_days: { export: { order: "day" } } } });
    ctx.db.hub.prepare("INSERT INTO plugin_usage_days (day, cost) VALUES ('2026-09-07', 1.5)").run();
    expect(() => ctx.db.for("a").prepare("SELECT * FROM plugin_usage_days").all()).toThrow();
  });

  it("refuses a registration without a declaration, an undeclared table, or a table outside the namespace", async () => {
    const ctx = new Context();
    await ctx.plugin(Db, { dir: ":memory:" });
    expect(() => ctx.db.migrate("demo", STEPS)).toThrow(/tables declaration/);
    expect(() => ctx.db.migrate("demo", STEPS, { tables: {} })).toThrow(/does not declare/);
    expect(() => ctx.db.migrate("demo", [{ version: 1, up: "CREATE TABLE notes (id TEXT)" }], { tables: TABLES })).toThrow(/plugin_demo_/);
    expect(() => ctx.db.migrate("demo", STEPS, { tables: { plugin_demo_notes: { export: false } } })).toThrow(/project scope/);
    expect(() => ctx.db.migrate("demo", STEPS, { scope: "hub", tables: TABLES })).toThrow(/hub tables belong to no project/);
    ctx.db.migrate("demo", STEPS, { tables: TABLES });
    expect(() => ctx.db.migrate("demo", STEPS, { tables: TABLES })).toThrow(/already registered/);
  });

  it("a failing step marks the namespace unhealthy for that file without taking the project down", async () => {
    const ctx = new Context();
    await ctx.plugin(Db, { dir: ":memory:" });
    ctx.db.open("a");
    ctx.db.migrate("bad", [{ version: 1, up: () => { throw new Error("boom"); } }], { tables: { plugin_bad_t: { project: "project_id", export: false } } });
    expect(ctx.db.healthy("bad", "a")).toBe(false);
    expect(ctx.db.has("a")).toBe(true);
  });

  it("derives a project predicate through a via chain", () => {
    const tables = {
      plugin_x_threads: { project: "project_id", export: false as const },
      plugin_x_messages: { project: { via: "thread_id", table: "plugin_x_threads" }, export: false as const }
    };
    expect(projectPredicate(tables, "plugin_x_threads")).toBe("project_id = @projectId");
    expect(projectPredicate(tables, "plugin_x_messages")).toBe("thread_id IN (SELECT id FROM plugin_x_threads WHERE project_id = @projectId)");
  });
});
