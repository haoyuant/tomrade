/**
 * The kept local digest reads again only what a write touched, and must still be the digest of a
 * whole export after any write: the write pipeline's, a plugin's own SQL, a cascade, another
 * connection, a schema change.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ProjectDb } from "@tomradex/db";
import { fresh } from "@tomradex/testkit";
import { exportState, stateFiles, writeArtifact, type ExportOptions } from "@tomradex/storage";
import { restoreLf } from "../src/state.js";
import { LocalDigests } from "../src/digests.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-digests-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function setup() {
  const bag = await fresh({ cacheDir: fs.mkdtempSync(path.join(root, "cache-")) });
  bag.ctx.db.migrate(
    "demo",
    [
      {
        version: 1,
        up: `CREATE TABLE plugin_demo_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT);
             CREATE TABLE plugin_demo_pairs (a TEXT NOT NULL, b TEXT NOT NULL, project_id TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
             CREATE TABLE plugin_demo_log (seq INTEGER NOT NULL, body TEXT, project_id TEXT)`
      }
    ],
    {
      tables: {
        plugin_demo_notes: { project: "project_id", export: { order: "id", always: true } },
        plugin_demo_pairs: { project: "project_id", export: { order: "a, b", always: true } },
        plugin_demo_log: { project: "project_id", export: { order: "seq", always: true } }
      }
    }
  );
  const opts = (): ExportOptions => ({ registrations: bag.ctx.db.registrations("project") });
  const digests = new LocalDigests();
  const db = bag.db as ProjectDb;
  const kept = () => digests.digest(bag.project.id, db, opts());
  const whole = () => exportState(db, bag.project.id, opts()).manifest.snapshot!.digest;
  return { ...bag, db, digests, opts, kept, whole };
}

describe("the kept local digest", () => {
  it("is the whole export's digest after every kind of write", async () => {
    const { ctx, db, items, board, project, digests, opts, kept, whole } = await setup();
    // The kept export too: the same state and, file by file, the same bytes as a whole one.
    const same = () => {
      expect(kept()).toBe(whole());
      const { state, files } = digests.exportFiles(project.id, db, { ...opts(), at: 1 });
      const all = exportState(db, project.id, { ...opts(), at: 1 });
      expect(state).toEqual(all);
      expect(new Map([...files!].map(([file, body]) => [file, body.toString("utf8")]))).toEqual(stateFiles(all));
    };
    same();

    const a = items.create({ title: "A", projectId: project.id, boardId: board.id, labels: ["ui"], by: "human" });
    const b = items.create({ title: "B", projectId: project.id, boardId: board.id, by: "human" });
    same();
    items.update(project.id, a.id, { title: "A2", labels: ["ui", "bug"] }, "human");
    same();
    items.addRelation(project.id, a.id, b.id);
    same();
    const field = ctx.fields.create({ projectId: project.id, name: "Points", type: "number" });
    items.update(project.id, b.id, { fields: { [field.id]: 3 } }, "human");
    same();

    db.prepare("INSERT INTO plugin_demo_notes (id, project_id, body) VALUES ('n1', ?, 'hi'), ('n2', ?, 'there')").run(project.id, project.id);
    same();
    db.prepare("UPDATE plugin_demo_notes SET body = 'changed' WHERE id = 'n2'").run();
    same();
    db.prepare("INSERT OR REPLACE INTO plugin_demo_notes (id, project_id, body) VALUES ('n1', ?, 'replaced')").run(project.id);
    same();
    db.prepare("INSERT INTO plugin_demo_pairs (a, b) VALUES ('x', 'y'), ('x', 'z')").run();
    same();
    db.prepare("DELETE FROM plugin_demo_pairs WHERE b = 'y'").run();
    same();
    // Tied rows: the file keeps one order however they are read back.
    db.prepare("INSERT INTO plugin_demo_log (seq, body) VALUES (1, 'second'), (1, 'first'), (0, 'zero')").run();
    same();
    db.prepare("UPDATE plugin_demo_log SET body = 'later' WHERE body = 'second'").run();
    same();

    // Deleting an item takes its labels, values and relations along.
    items.delete(project.id, a.id, "human");
    same();
    // A rolled-back write leaves the file as it was.
    expect(() =>
      db.transaction(() => {
        db.prepare("UPDATE plugin_demo_notes SET body = 'never'").run();
        throw new Error("no");
      })
    ).toThrow("no");
    same();
  });

  it("reads again only the rows a write touched", async () => {
    const { db, items, board, project, kept, whole } = await setup();
    for (let i = 0; i < 20; i++) items.create({ title: `T${i}`, projectId: project.id, boardId: board.id, by: "human" });
    kept();
    const sql = vi.spyOn(db, "prepare");
    const reads = () => {
      const calls = sql.mock.calls.map(([q]) => q);
      sql.mockClear();
      return { whole: calls.filter((q) => q.includes("tomrade_rowid") && q.includes("ORDER BY")).length, byRow: calls.filter((q) => q.includes("json_each(@only)")).length };
    };

    kept();
    expect(reads()).toEqual({ whole: 0, byRow: 0 });

    const one = items.list({ projectId: project.id })[3]!;
    items.update(project.id, one.id, { title: "Moved" }, "human");
    kept();
    expect(reads()).toEqual({ whole: 0, byRow: 1 });

    // A table that does not travel reads nothing.
    db.prepare("UPDATE oplog SET at = at").run();
    reads();
    kept();
    expect(reads()).toEqual({ whole: 0, byRow: 0 });
    sql.mockRestore();
    expect(kept()).toBe(whole());
  });

  it("reads everything again after another connection's commit or a schema change", async () => {
    const { ctx, db, project, kept, whole } = await setup();
    db.prepare("INSERT INTO plugin_demo_notes (id, project_id, body) VALUES ('n1', ?, 'hi')").run(project.id);
    kept();
    const other = new ProjectDb(project.id, ctx.db.pathFor(project.id));
    other.prepare("UPDATE plugin_demo_notes SET body = 'elsewhere'").run();
    other.close();
    expect(kept()).toBe(whole());

    db.exec("ALTER TABLE plugin_demo_notes ADD COLUMN extra TEXT");
    db.prepare("UPDATE plugin_demo_notes SET extra = 'x'").run();
    expect(kept()).toBe(whole());

    // A table made later is watched from the full read the schema change brings.
    ctx.db.migrate("later", [{ version: 1, up: "CREATE TABLE plugin_later_rows (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)" }], {
      tables: { plugin_later_rows: { project: "project_id", export: { order: "id", always: true } } }
    });
    expect(kept()).toBe(whole());
    db.prepare("INSERT INTO plugin_later_rows (id, project_id) VALUES ('r1', ?)").run(project.id);
    expect(kept()).toBe(whole());
  });

  it("keeps a whole export, so the next digest reads nothing", async () => {
    const { db, items, board, project, digests, opts, kept } = await setup();
    items.create({ title: "A", projectId: project.id, boardId: board.id, by: "human" });
    const exported = digests.export(project.id, db, opts());
    const sql = vi.spyOn(db, "prepare");
    expect(kept()).toBe(exported.manifest.snapshot!.digest);
    expect(sql.mock.calls.filter(([q]) => q.includes("tomrade_rowid"))).toHaveLength(0);
    sql.mockRestore();
  });

  it("writes a file again once something else changed it, even with the bytes it wrote last", async () => {
    const { db, items, board, project, digests, opts } = await setup();
    items.create({ title: "A", projectId: project.id, boardId: board.id, by: "human" });
    const dir = fs.mkdtempSync(path.join(root, "folder-"));
    const write = () => {
      const { state, files } = digests.exportFiles(project.id, db, { ...opts(), at: 1 });
      return writeArtifact(dir, state, { files });
    };
    expect(write()).toBe(true);
    expect(write()).toBe(false);
    const file = path.join(dir, ".tomrade", "state", "items.jsonl");
    const ours = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, ours.replace('"A"', '"Elsewhere"'));
    expect(write()).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(ours);
    // A checkout that turns it into CRLF is put back as well.
    fs.writeFileSync(file, ours.replace(/\n/g, "\r\n"));
    expect(restoreLf(dir)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(ours);
    expect(restoreLf(dir)).toBe(false);
  });
});

