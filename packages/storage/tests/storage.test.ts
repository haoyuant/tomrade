/**
 * The folder is the truth and the cache follows it. A project must round-trip
 * through text without losing a row, an unchanged project must produce no
 * diff, every write must reach the folder's log at once, and a folder changed
 * by someone else must be read back in — or, when both moved, left alone.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Service, type Context } from "cordis";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import {
  ARTIFACT_DIR,
  ForeignProjectError,
  Storage,
  TornArtifactError,
  appendLog,
  compactLog,
  digestFiles,
  digestState,
  exportState,
  importState,
  parseLog,
  readArtifact,
  readLogs,
  serializeState,
  stateFiles,
  writeArtifact
} from "@tomradex/storage";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-storage-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
const tmp = (name: string) => {
  const dir = path.join(root, `${name}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const QUIET = { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 };

/** A machine: a Hub folder of its own, storage loaded, the boot reconcile finished. */
async function machine(opts: { cacheDir?: string; storage?: Record<string, unknown> } = {}) {
  const hubDir = tmp("hub");
  const bag = await fresh({ hubDir, cacheDir: opts.cacheDir, plugins: [[Storage, { ...QUIET, ...opts.storage }]] });
  await settle();
  await bag.ctx.storage.ready;
  const dir = bag.hub.catalog.project(bag.project.id)!.dir!;
  return { ...bag, storage: bag.ctx.storage, hubDir, dir };
}

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, ARTIFACT_DIR, rel), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the artifact", () => {
  it("round-trips a project through text without losing anything", async () => {
    const { ctx, db, items, boards, views, board, project } = await machine();
    const epic = items.create({ title: "Reporting", kind: "epic", projectId: project.id, boardId: board.id, by: "human" });
    const a = items.create({ title: "Export PDF", projectId: project.id, boardId: board.id, parentId: epic.id, labels: ["ui", "bug"], priority: 1, by: "human" });
    const b = items.create({ title: "Dark mode", projectId: project.id, boardId: board.id, by: "ai:mcp" });
    items.addRelation(project.id, a.id, b.id);
    const other = boards.create({ projectId: project.id, name: "Other" });
    const view = views.create({ projectId: project.id, name: "Bugs", layout: "table" });
    views.setRank(project.id, view.id, a.id, 2.5);
    const field = ctx.fields.create({ projectId: project.id, name: "Points", type: "number" });
    items.update(project.id, a.id, { fields: { [field.id]: 5 } }, "human");

    const state = exportState(db, project.id);
    expect(state.manifest.v).toBe(2);
    expect(state.manifest.project).toEqual({ id: project.id, name: "Default Project", description: null, key_prefix: "TOM", created_at: project.createdAt });
    expect(state.manifest.snapshot?.digest).toBe(digestState(state));
    expect(Object.keys(state.manifest.project)).not.toContain("next_key_num");

    const dir = tmp("artifact");
    writeArtifact(dir, state);
    const back = readArtifact(dir)!;
    expect(digestState(back)).toBe(digestState(state));

    const second = await machine();
    second.ctx.db.open(project.id);
    importState(second.ctx.db.for(project.id), back);
    expect(second.items.list({ projectId: project.id }).map((i) => [i.key, i.title, i.labels.sort(), i.blocks, i.fields]).sort()).toEqual(
      items.list({ projectId: project.id }).map((i) => [i.key, i.title, i.labels.sort(), i.blocks, i.fields]).sort()
    );
    expect(second.boards.list(project.id).map((b) => b.name)).toEqual(boards.list(project.id).map((b) => b.name));
    expect(second.views.ranks(project.id, view.id)).toEqual({ [a.id]: 2.5 });
    expect(second.boards.get(project.id, other.id)?.name).toBe("Other");
    // The counter is derived past every key the folder holds.
    expect(second.items.create({ title: "Next", projectId: project.id, boardId: board.id, by: "human" }).key).toBe("TOM-4");
  });

  it("is deterministic: the same data writes the same bytes, and nothing is touched twice", async () => {
    const { db, items, board, project } = await machine();
    items.create({ title: "A", projectId: project.id, boardId: board.id, by: "human" });
    const state = exportState(db, project.id, { at: 1 });
    const dir = tmp("det");
    expect(writeArtifact(dir, state)).toBe(true);
    expect(writeArtifact(dir, exportState(db, project.id, { at: 1 }))).toBe(false);
    const files = serializeState(state);
    expect(files.has(path.join(ARTIFACT_DIR, ".gitattributes"))).toBe(true);
    expect(files.get(path.join(ARTIFACT_DIR, ".gitattributes"))).toMatch(/merge=union/);
    expect(files.has(path.join(ARTIFACT_DIR, "README.md"))).toBe(true);
  });

  it("refuses a torn snapshot and a manifest with conflict markers", async () => {
    const { db, project } = await machine();
    const dir = tmp("torn");
    writeArtifact(dir, exportState(db, project.id));
    fs.appendFileSync(path.join(dir, ARTIFACT_DIR, "state", "items.jsonl"), '{"id":"x"}\n');
    expect(() => readArtifact(dir)).toThrow(TornArtifactError);
    const manifest = path.join(dir, ARTIFACT_DIR, "project.json");
    fs.writeFileSync(manifest, "<<<<<<< HEAD\n" + fs.readFileSync(manifest, "utf8"));
    expect(() => readArtifact(dir)).toThrow(/conflict markers/);
  });

  it("carries declared plugin tables, and leaves undeclared and machine-local ones alone", async () => {
    const { ctx, db, project, hub } = await machine();
    ctx.db.migrate("demo", [{ version: 1, up: "CREATE TABLE plugin_demo_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT)" }], {
      tables: { plugin_demo_notes: { project: "project_id", export: { order: "id" } } }
    });
    ctx.db.migrate("local", [{ version: 1, up: "CREATE TABLE plugin_local_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT)" }], {
      tables: { plugin_local_sessions: { project: "project_id", export: false } }
    });
    // A binding is identity, not data: it travels without being chosen.
    ctx.db.migrate("pin", [{ version: 1, up: "CREATE TABLE plugin_pin_binding (project_id TEXT PRIMARY KEY, url TEXT NOT NULL)" }], {
      tables: { plugin_pin_binding: { project: "project_id", export: { order: "project_id", always: true } } }
    });
    db.prepare("INSERT INTO plugin_demo_notes (id, project_id, body) VALUES ('n1', ?, 'hi')").run(project.id);
    db.prepare("INSERT INTO plugin_local_sessions (id, project_id, body) VALUES ('s1', ?, 'running here')").run(project.id);
    db.prepare("INSERT INTO plugin_pin_binding (project_id, url) VALUES (?, 'git@example.com:docs.git')").run(project.id);
    const state = exportState(db, project.id, { registrations: ctx.db.registrations("project"), exports: ["demo"] });
    expect(state.plugins.demo.plugin_demo_notes).toEqual([{ id: "n1", project_id: project.id, body: "hi" }]);
    expect(state.manifest.exports).toEqual(["demo"]);
    expect(state.plugins.local).toBeUndefined();
    expect(state.plugins.pin.plugin_pin_binding).toEqual([{ project_id: project.id, url: "git@example.com:docs.git" }]);
    const dir = tmp("plug");
    writeArtifact(dir, state);
    expect(fs.existsSync(path.join(dir, ARTIFACT_DIR, "plugins", "demo", "plugin_demo_notes.jsonl"))).toBe(true);
    // Not exported: nothing written, and the digest changes with the choice — but the binding still travels.
    const without = exportState(db, project.id, { registrations: ctx.db.registrations("project"), exports: [] });
    expect(Object.keys(without.plugins)).toEqual(["pin"]);
    expect(without.manifest.exports).toEqual([]);
    expect(digestState(without)).not.toBe(digestState(state));
    expect(hub.catalog.project(project.id)?.exports).toEqual([]);

    // An older artifact may still contain this table. Once its registration
    // becomes machine-local, importing that artifact must not clear local rows.
    state.plugins.local = { plugin_local_sessions: [] };
    importState(db, state, { registrations: ctx.db.registrations("project") });
    expect(db.prepare("SELECT body FROM plugin_local_sessions WHERE id = 's1'").get()).toEqual({ body: "running here" });
  });
});

describe("the log", () => {
  it("appends lines with a header, reads them back, and drops a torn tail", () => {
    const dir = tmp("log");
    appendLog(dir, "m1", [{ id: "m1:1", at: 1, by: "human", entity: "item", entityId: "a", op: "create", base: null, patch: { title: "A" } }]);
    appendLog(dir, "m1", [{ id: "m1:2", at: 2, by: "human", entity: "item", entityId: "a", op: "update", base: 1, patch: { status: "doing" } }]);
    fs.appendFileSync(path.join(dir, ARTIFACT_DIR, "log", "m1.jsonl"), '{"id":"m1:3","at":3,"by":"hu');
    const logs = readLogs(dir);
    expect(logs).toHaveLength(1);
    expect(logs[0].device).toBe("m1");
    expect(logs[0].ops.map((o) => o.id)).toEqual(["m1:1", "m1:2"]);
    expect(fs.readFileSync(path.join(dir, ARTIFACT_DIR, "log", "m1.jsonl"), "utf8").startsWith('{"log":1,"device":"m1"}')).toBe(true);
  });

  it("compacts only what is older than the window", () => {
    const dir = tmp("compact");
    const now = 10_000;
    appendLog(dir, "m1", [
      { id: "m1:1", at: 1, by: "human", entity: "item", entityId: "a", op: "create", base: null, patch: null },
      { id: "m1:2", at: 9_000, by: "human", entity: "item", entityId: "a", op: "update", base: 1, patch: null }
    ]);
    compactLog(dir, "m1", 5_000, now);
    expect(parseLog(fs.readFileSync(path.join(dir, ARTIFACT_DIR, "log", "m1.jsonl"), "utf8")).map((o) => o.id)).toEqual(["m1:2"]);
  });
});

describe("ctx.storage", () => {
  it("gives every project a folder under the Hub and writes it", async () => {
    const { dir, hubDir, project } = await machine();
    expect(dir.startsWith(path.join(hubDir, "projects"))).toBe(true);
    expect(path.basename(dir)).toBe("default-project");
    const state = readArtifact(dir)!;
    expect(String(state.manifest.project.id)).toBe(project.id);
    expect(read(dir, "state/boards.jsonl")).toMatch(/Main/);
  });

  it("writes every commit to the log at once and the snapshot after the quiet period", async () => {
    const { storage, items, board, project, dir } = await machine({ storage: { snapshotIdleMs: 20, snapshotMaxMs: 200 } });
    const a = items.create({ title: "Logged", projectId: project.id, boardId: board.id, by: "human" });
    const log = read(dir, "log/test-device.jsonl");
    expect(log).toMatch(/"op":"create"/);
    expect(log).toMatch(new RegExp(`"entityId":"${a.id}"`));
    expect((await storage.statusFor(project.id)).state).toBe("ahead");
    await sleep(120);
    expect(read(dir, "state/items.jsonl")).toMatch(/Logged/);
    expect((await storage.statusFor(project.id)).state).toBe("synced");
    const manifest = JSON.parse(read(dir, "project.json"));
    expect(manifest.snapshot.checkpoint["test-device"]).toBeGreaterThan(0);
  });

  it("takes the folder's copy on refresh when local is clean, and imports the other machine's log as history", async () => {
    const a = await machine();
    const item = a.items.create({ title: "From A", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.publish(a.project.id);
    // Status keeps the folder's digest while its files stay as they were; the copy below must still be seen.
    expect((await a.storage.statusFor(a.project.id)).state).toBe("synced");
    expect((await a.storage.statusFor(a.project.id)).state).toBe("synced");

    const b = await machine();
    const bDir = path.join(b.hubDir, "projects", "copy");
    fs.cpSync(a.dir, bDir, { recursive: true });
    const id = await b.storage.attach(bDir);
    expect(id).toBe(a.project.id);
    expect(b.items.list({ projectId: id }).map((i) => i.title)).toEqual(["From A"]);
    expect(b.projects.get(id)?.name).toBe("Default Project");

    // B edits and publishes; A takes it in — B's device stamps the row A already had a log line for.
    b.items.update(id, item.id, { status: "doing" }, "human");
    await b.storage.publish(id);
    fs.cpSync(bDir, a.dir, { recursive: true, force: true });
    expect((await a.storage.statusFor(a.project.id)).state).toBe("behind");
    await a.storage.refresh(a.project.id);
    expect(a.items.get(a.project.id, item.id)?.status).toBe("doing");
    expect((await a.storage.statusFor(a.project.id)).state).toBe("synced");
    // B's history arrived, but B's machine is the same id in tests, so it is skipped as our own; the snapshot still landed.
    expect(a.oplog.recent(a.project.id).some((e) => e.entityId === item.id)).toBe(true);
  });

  it("merges when both moved: different fields both survive, the same field is settled and noted", async () => {
    const a = await machine();
    const item = a.items.create({ title: "Shared", projectId: a.project.id, boardId: a.board.id, by: "human" });
    const other = a.items.create({ title: "Contested", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.publish(a.project.id);
    // Someone else changes the folder: a title here, a status there…
    const state = readArtifact(a.dir)!;
    state.tables.items.find((r) => r.id === item.id)!.title = "Renamed elsewhere";
    state.tables.items.find((r) => r.id === other.id)!.status = "doing";
    state.manifest.snapshot!.digest = digestState(state);
    writeArtifact(a.dir, state);
    // …and we change the cache: the other item's status too, and the first item's own status.
    a.items.update(a.project.id, item.id, { status: "done" }, "human");
    a.items.update(a.project.id, other.id, { status: "verifying" }, "human");
    expect((await a.storage.statusFor(a.project.id)).state).toBe("diverged");
    await a.storage.refresh(a.project.id);
    const merged = a.items.get(a.project.id, item.id)!;
    expect(merged.title).toBe("Renamed elsewhere");
    expect(merged.status).toBe("done");
    // Only our side has a log entry for the contested field, so our value stands, and history says why.
    expect(a.items.get(a.project.id, other.id)?.status).toBe("verifying");
    const notes = a.oplog.historyFor(a.project.id, "item", other.id).filter((e) => e.op === "merge");
    expect(notes).toHaveLength(1);
    expect(notes[0].by).toBe("ai:sync");
    expect(notes[0].before).toMatchObject({ status: "doing" });
    expect(notes[0].after).toMatchObject({ status: "verifying" });
    // Undo steps over the note and the folder now holds the merged state.
    expect(a.oplog.undoLast(a.project.id)?.entry.op).not.toBe("merge");
    await a.storage.publish(a.project.id);
    expect((await a.storage.statusFor(a.project.id)).state).toBe("synced");
    expect(fs.readFileSync(path.join(a.dir, ARTIFACT_DIR, "state", "items.jsonl"), "utf8")).toMatch(/Renamed elsewhere/);
  });

  it("syncs past a done ticket whose delivery was never accepted, and lists it until it is settled", async () => {
    const a = await machine();
    const item = a.items.create({ title: "Build it", workType: "coding", projectId: a.project.id, boardId: a.board.id, by: "human" });
    let updated = a.items.submitDelivery(a.project.id, item.id, { report: "Ready" }, "human");
    updated = a.items.reviewDelivery(a.project.id, item.id, { submissionId: updated.evidence.submissions[0].id, decision: "changes-requested" }, updated.version);
    await a.storage.publish(a.project.id);
    const state = readArtifact(a.dir)!;
    state.tables.items.find((r) => r.id === item.id)!.title = "Renamed elsewhere";
    state.manifest.snapshot!.digest = digestState(state);
    writeArtifact(a.dir, state);
    // What an older build left behind: done over a delivery whose last verdict was "changes requested".
    a.ctx.db.for(a.project.id).prepare("UPDATE items SET status = 'done', version = version + 1 WHERE id = ?").run(item.id);
    expect((await a.storage.statusFor(a.project.id)).state).toBe("diverged");
    await a.storage.refresh(a.project.id);
    expect(a.items.get(a.project.id, item.id)?.title).toBe("Renamed elsewhere");
    expect(a.storage.attentionViews(a.project.id)).toEqual([{ itemId: item.id, key: expect.stringMatching(/-\d+$/), title: "Renamed elsewhere", code: "done-unaccepted" }]);
    a.items.settleEvidence(a.project.id, item.id, "accept", a.items.get(a.project.id, item.id)!.version);
    expect(a.storage.attentionViews(a.project.id)).toEqual([]);
  });

  it("never loses rows that travel nowhere: an unticked namespace sits out a merge, and one ticked elsewhere joins ours", async () => {
    const a = await machine();
    a.ctx.db.migrate("demo", [{ version: 1, up: "CREATE TABLE plugin_demo_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT)" }], {
      tables: { plugin_demo_notes: { project: "project_id", export: { order: "id" } } }
    });
    const notes = () => a.ctx.db.for(a.project.id).prepare("SELECT id, body FROM plugin_demo_notes ORDER BY id").all();
    await a.storage.setExports(a.project.id, []);
    a.ctx.db.for(a.project.id).prepare("INSERT INTO plugin_demo_notes (id, project_id, body) VALUES ('n1', ?, 'only here')").run(a.project.id);
    const item = a.items.create({ title: "Shared", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.publish(a.project.id);
    const edit = (change: (state: ReturnType<typeof readArtifact> & object) => void) => {
      const state = readArtifact(a.dir)!;
      change(state);
      state.manifest.snapshot!.digest = digestState(state);
      writeArtifact(a.dir, state);
    };
    // Both sides moved, and the namespace travels on neither: merging it would read as every row deleted.
    edit((state) => (state.tables.items.find((r) => r.id === item.id)!.title = "Renamed elsewhere"));
    a.items.update(a.project.id, item.id, { status: "done" }, "human");
    expect((await a.storage.statusFor(a.project.id)).state).toBe("diverged");
    await a.storage.refresh(a.project.id);
    expect(a.items.get(a.project.id, item.id)?.title).toBe("Renamed elsewhere");
    expect(notes()).toEqual([{ id: "n1", body: "only here" }]);
    await a.storage.publish(a.project.id);
    // Another machine ticks it and brings its own rows: they join ours rather than replace them.
    edit((state) => {
      state.manifest.exports = ["demo"];
      state.plugins.demo = { plugin_demo_notes: [{ id: "n2", project_id: a.project.id, body: "from there" }] };
    });
    await a.storage.refresh(a.project.id);
    expect(notes()).toEqual([{ id: "n1", body: "only here" }, { id: "n2", body: "from there" }]);
    expect(a.hub.catalog.project(a.project.id)?.exports).toEqual(["demo"]);
  });

  it("keeps a merge it has not published yet: the folder still holding the older snapshot is not a deletion", async () => {
    const a = await machine();
    const shared = a.items.create({ title: "Shared", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.publish(a.project.id);
    // Someone else renames the shared issue in the folder while we create one of our own.
    const state = readArtifact(a.dir)!;
    state.tables.items.find((r) => r.id === shared.id)!.title = "Renamed elsewhere";
    state.manifest.snapshot!.digest = digestState(state);
    writeArtifact(a.dir, state);
    const ours = a.items.create({ title: "Ours, unpublished", projectId: a.project.id, boardId: a.board.id, by: "ai:mcp" });
    await a.storage.refresh(a.project.id);
    expect(a.items.get(a.project.id, ours.id)?.title).toBe("Ours, unpublished");
    // Nothing moved since: another refresh (the watcher, the periodic reconcile) must leave the merge alone.
    const later = a.items.create({ title: "Later", projectId: a.project.id, boardId: a.board.id, by: "ai:mcp" });
    await a.storage.refresh(a.project.id);
    expect(a.items.list({ projectId: a.project.id }).map((i) => i.title).sort()).toEqual(["Later", "Ours, unpublished", "Renamed elsewhere"]);
    expect((await a.storage.statusFor(a.project.id)).state).toBe("ahead");
    await a.storage.publish(a.project.id);
    expect(readArtifact(a.dir)!.tables.items.map((r) => r.id).sort()).toEqual([shared.id, ours.id, later.id].sort());
    expect((await a.storage.statusFor(a.project.id)).state).toBe("synced");
  });

  it("renumbers our unpublished issues when the folder already used the key", async () => {
    const a = await machine();
    a.items.create({ title: "First", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.publish(a.project.id);
    const state = readArtifact(a.dir)!;
    const theirs = { ...state.tables.items[0], id: "their-item", key_num: 2, title: "Theirs #2" };
    state.tables.items.push(theirs);
    state.manifest.snapshot!.digest = digestState(state);
    writeArtifact(a.dir, state);
    const mine = a.items.create({ title: "Mine #2", projectId: a.project.id, boardId: a.board.id, by: "human" });
    expect(mine.key).toBe("TOM-2");
    await a.storage.refresh(a.project.id);
    expect(a.items.get(a.project.id, mine.id)?.key).toBe("TOM-3");
    expect(a.items.get(a.project.id, "their-item")?.key).toBe("TOM-2");
    expect(a.items.create({ title: "Next", projectId: a.project.id, boardId: a.board.id, by: "human" }).key).toBe("TOM-4");
  });

  it("reads a folder written before a core table existed, and keeps publishing to it", async () => {
    const { storage, items, board, project, dir } = await machine();
    items.create({ title: "Before deliveries", projectId: project.id, boardId: board.id, by: "human" });
    await storage.publish(project.id);
    // What a build from before the deliveries table wrote: no file, and a digest that never named one.
    const older = path.join(ARTIFACT_DIR, "state", "deliveries.jsonl");
    const files = stateFiles(readArtifact(dir)!);
    files.delete(older);
    fs.rmSync(path.join(dir, older));
    const manifest = JSON.parse(read(dir, "project.json"));
    manifest.snapshot.digest = digestFiles(files);
    fs.writeFileSync(path.join(dir, ARTIFACT_DIR, "project.json"), JSON.stringify(manifest, null, 2) + "\n");

    expect(readArtifact(dir)?.tables.items.map((r) => r.title)).toEqual(["Before deliveries"]);
    expect((await storage.statusFor(project.id)).state).not.toBe("syncing");
    items.create({ title: "After", projectId: project.id, boardId: board.id, by: "human" });
    await storage.publish(project.id);
    expect(read(dir, "state/items.jsonl")).toMatch(/After/);
    expect(fs.existsSync(path.join(dir, older))).toBe(true);
    expect((await storage.statusFor(project.id)).state).toBe("synced");
  });

  it("never writes over a folder it cannot read: from a newer build, with conflict markers, or with a line cut short", async () => {
    const { storage, items, board, project, dir } = await machine();
    items.create({ title: "Published", projectId: project.id, boardId: board.id, by: "human" });
    await storage.publish(project.id);
    const manifestFile = path.join(dir, ARTIFACT_DIR, "project.json");
    const itemsFile = path.join(dir, ARTIFACT_DIR, "state", "items.jsonl");
    const filesOf = () => Object.fromEntries((fs.readdirSync(dir, { recursive: true }) as string[]).filter((rel) => fs.statSync(path.join(dir, rel)).isFile()).map((rel) => [rel, fs.readFileSync(path.join(dir, rel), "utf8")]));
    const newer = (manifest: string) => fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(manifest), schemaVersion: JSON.parse(manifest).schemaVersion + 1 }, null, 2) + "\n");
    const cases: [(manifest: string, rows: string) => void, object][] = [
      [newer, { state: "error", detail: expect.stringContaining("Update Tomrade") }],
      [(_, rows) => fs.writeFileSync(itemsFile, `<<<<<<< HEAD\n${rows}=======\n${rows}>>>>>>> origin/main\n`), { state: "error", detail: expect.stringContaining("conflict markers") }],
      [(_, rows) => fs.writeFileSync(itemsFile, rows.slice(0, -12)), { state: "syncing" }]
    ];
    for (const [damage, status] of cases) {
      const manifest = fs.readFileSync(manifestFile, "utf8");
      const rows = fs.readFileSync(itemsFile, "utf8");
      items.create({ title: "Ours", projectId: project.id, boardId: board.id, by: "human" });
      damage(manifest, rows);
      const damaged = filesOf();
      expect(await storage.publish(project.id)).toMatchObject(status);
      expect(filesOf()).toEqual(damaged);
      // Once it reads cleanly again, the write goes through.
      fs.writeFileSync(manifestFile, manifest);
      fs.writeFileSync(itemsFile, rows);
      expect((await storage.publish(project.id)).state).toBe("synced");
    }
    // A line cut short is a file still arriving, even where the digest is not checked.
    const rows = fs.readFileSync(itemsFile, "utf8");
    fs.writeFileSync(itemsFile, rows.slice(0, -12));
    expect(() => readArtifact(dir, { verify: false })).toThrow(TornArtifactError);
    fs.writeFileSync(itemsFile, rows);
    // The folder moved, and taking it in pulls what this build cannot read: that is not written over either.
    const moved = readArtifact(dir)!;
    moved.tables.items[0].title = "Renamed elsewhere";
    moved.manifest.snapshot!.digest = digestState(moved);
    writeArtifact(dir, moved);
    items.create({ title: "Ours", projectId: project.id, boardId: board.id, by: "human" });
    let pulled = {};
    // The refresh a publish makes inside its own turn.
    vi.spyOn(storage as unknown as { refreshInTurn: Storage["refresh"] }, "refreshInTurn").mockImplementationOnce(async () => {
      newer(fs.readFileSync(manifestFile, "utf8"));
      pulled = filesOf();
      return storage.statusFor(project.id);
    });
    expect(await storage.publish(project.id)).toMatchObject({ state: "error" });
    expect(filesOf()).toEqual(pulled);
  });

  it("reads a folder a checkout turned into CRLF, and the next write puts LF back", async () => {
    const { storage, items, board, project, dir } = await machine();
    const item = items.create({ title: "Published", projectId: project.id, boardId: board.id, by: "human" });
    await storage.publish(project.id);
    const artifact = path.join(dir, ARTIFACT_DIR);
    const texts = () => (fs.readdirSync(artifact, { recursive: true }) as string[]).filter((rel) => /\.jsonl?$/.test(rel)).map((rel) => path.join(artifact, rel));
    // What git does with core.autocrlf=true and no eol rule.
    for (const file of texts()) fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
    expect(fs.readFileSync(path.join(artifact, "state", "items.jsonl"), "utf8")).toContain("\r\n");

    const back = readArtifact(dir)!;
    expect(back.tables.items.map((r) => r.title)).toEqual(["Published"]);
    expect(digestState(back)).toBe(back.manifest.snapshot!.digest);
    expect((await storage.statusFor(project.id)).state).toBe("synced");

    // Nothing changed, and still the write leaves every file LF, with the rule that keeps it so.
    expect((await storage.publish(project.id)).state).toBe("synced");
    for (const file of texts()) expect(fs.readFileSync(file, "utf8")).not.toContain("\r");
    expect(read(dir, ".gitattributes")).toMatch(/^\*\.jsonl text eol=lf$/m);
    items.update(project.id, item.id, { title: "Edited" }, "human");
    expect((await storage.publish(project.id)).state).toBe("synced");
    expect(readArtifact(dir)!.tables.items.map((r) => r.title)).toEqual(["Edited"]);
  });

  it("reads a folder that goes on not matching its manifest as syncing at first, then as an error it logs and tells the person once", async () => {
    const notices: { title: string; body?: string }[] = [];
    class Alerts extends Service {
      static provide = "alerts";
      constructor(ctx: Context) {
        super(ctx, "alerts");
      }
      sounds() {
        return [];
      }
      async play() {}
      notify(notice: { title: string; body?: string }) {
        notices.push(notice);
      }
    }
    const { ctx, storage, items, board, project, dir } = await machine({ storage: { tornErrorMs: 1_000 } });
    await ctx.plugin(Alerts);
    await settle();
    const said: string[] = [];
    ctx.logger.exporter({ export: (m: { type: string; args: unknown[] }) => void said.push(`${m.type} ${String(m.args[0])}`) } as never);
    items.create({ title: "Published", projectId: project.id, boardId: board.id, by: "human" });
    await storage.publish(project.id);
    const itemsFile = path.join(dir, ARTIFACT_DIR, "state", "items.jsonl");
    const rows = fs.readFileSync(itemsFile, "utf8");
    fs.appendFileSync(itemsFile, '{"id":"x"}\n');

    // A moment's mismatch is a sync still arriving: nothing is written, the log says why, nobody is alarmed.
    items.create({ title: "Ours", projectId: project.id, boardId: board.id, by: "human" });
    expect(await storage.publish(project.id)).toMatchObject({ state: "syncing" });
    expect(said.some((l) => l.startsWith("info") && l.includes("folder not written: syncing"))).toBe(true);
    expect(notices).toEqual([]);

    await sleep(1_100);
    expect(await storage.statusFor(project.id)).toMatchObject({ state: "error", detail: expect.stringContaining("project.json") });
    expect(storage.cachedState(project.id)).toBe("error");
    expect(notices).toEqual([{ title: "Default Project has stopped syncing", body: expect.stringContaining("git checkout -- .tomrade") }]);
    expect(said.filter((l) => l.startsWith("warn") && l.includes("have not matched their manifest"))).toHaveLength(1);
    // Told once, however often it is asked; the writes it skips are logged as warnings now.
    expect(await storage.publish(project.id)).toMatchObject({ state: "error" });
    await storage.refresh(project.id);
    expect(notices).toHaveLength(1);
    expect(said.some((l) => l.startsWith("warn") && l.includes("folder not written: error"))).toBe(true);

    // Matching again, the write goes through; a later mismatch starts over as a sync arriving.
    fs.writeFileSync(itemsFile, rows);
    expect((await storage.publish(project.id)).state).toBe("synced");
    expect(readArtifact(dir)!.tables.items.map((r) => r.title).sort()).toEqual(["Ours", "Published"]);
    fs.appendFileSync(itemsFile, '{"id":"y"}\n');
    expect((await storage.statusFor(project.id)).state).toBe("syncing");
  });

  it("never opens one project over another's folder", async () => {
    const a = await machine();
    const b = await machine();
    await expect(b.storage.setFolder(b.project.id, a.dir)).rejects.toThrow(ForeignProjectError);
    const other = await a.storage.attach(b.dir).catch((e: Error) => e);
    expect(other).toBe(b.project.id);
  });

  it("leaves a folder that lost the project alone, since another project may have it now", async () => {
    const a = await machine();
    const b = await machine();
    a.items.create({ title: "Mine", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.publish(a.project.id);
    // The folder goes, and another Tomrade makes a fresh one at the same path.
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(a.dir, "files"), { recursive: true });
    await a.storage.publish(a.project.id);
    await a.storage.reconcile(a.project.id);
    expect(fs.existsSync(path.join(a.dir, ARTIFACT_DIR))).toBe(false);
    expect(await a.storage.statusFor(a.project.id)).toMatchObject({ state: "unavailable", detail: expect.stringContaining("no longer holds this project") });

    await b.storage.setFolder(b.project.id, a.dir);
    expect(String(readArtifact(a.dir)!.manifest.project.id)).toBe(b.project.id);
    await a.storage.publish(a.project.id).catch(() => {});
    expect(String(readArtifact(a.dir)!.manifest.project.id)).toBe(b.project.id);
  });

  it("writes the project back when its folder is chosen again", async () => {
    const { storage, items, board, project, dir } = await machine();
    items.create({ title: "Restored", projectId: project.id, boardId: board.id, by: "human" });
    await storage.publish(project.id);
    fs.rmSync(path.join(dir, ARTIFACT_DIR), { recursive: true, force: true });
    expect((await storage.statusFor(project.id)).state).toBe("unavailable");
    await storage.setFolder(project.id, dir);
    expect(read(dir, "state/items.jsonl")).toMatch(/Restored/);
    expect((await storage.statusFor(project.id)).state).toBe("synced");
  });

  it("puts .tomrade back in a code checkout whose branch had none", async () => {
    const { storage, items, board, project, hubDir } = await machine();
    const code = path.join(hubDir, "code");
    fs.mkdirSync(code);
    execFileSync("git", ["init", "-q", code]);
    await storage.setFolder(project.id, code);
    expect(storage.entry(project.id)?.git).toBe("shared");
    fs.rmSync(path.join(code, ARTIFACT_DIR), { recursive: true, force: true });
    items.create({ title: "Back again", projectId: project.id, boardId: board.id, by: "human" });
    await storage.publish(project.id);
    expect(read(code, "state/items.jsonl")).toMatch(/Back again/);
  });

  it("moves to another folder and leaves the old one as it was", async () => {
    const { storage, items, board, project, dir, hubDir } = await machine();
    items.create({ title: "Moving", projectId: project.id, boardId: board.id, by: "human" });
    await storage.publish(project.id);
    const next = path.join(hubDir, "elsewhere");
    const info = await storage.setFolder(project.id, next);
    expect(info.dir).toBe(next);
    expect(read(next, "state/items.jsonl")).toMatch(/Moving/);
    expect(fs.existsSync(path.join(dir, ARTIFACT_DIR, "project.json"))).toBe(true);
    expect((await storage.statusFor(project.id)).state).toBe("synced");
  });

  it("rebuilds the cache from the folder, history included", async () => {
    const cacheDir = tmp("cache");
    const { ctx, storage, items, board, project, dir } = await machine({ cacheDir });
    const a = items.create({ title: "Kept", projectId: project.id, boardId: board.id, by: "human" });
    items.update(project.id, a.id, { status: "doing" }, "human");
    await storage.publish(project.id);
    ctx.db.for(project.id).prepare("DELETE FROM items").run();
    await storage.rebuild(project.id);
    expect(items.get(project.id, a.id)?.status).toBe("doing");
    expect(ctx.oplog.historyFor(project.id, "item", a.id).map((e) => e.op)).toEqual(["update", "create"]);
    expect(fs.existsSync(path.join(cacheDir, "projects", project.id, "published", ARTIFACT_DIR, "project.json"))).toBe(true);
    expect(read(dir, "state/items.jsonl")).toMatch(/Kept/);
  });

  it("writes this machine's unpublished edits to the folder before rebuilding, so none is lost", async () => {
    const { ctx, storage, items, board, project, dir } = await machine({ cacheDir: tmp("cache") });
    const a = items.create({ title: "Published", projectId: project.id, boardId: board.id, by: "human" });
    await storage.publish(project.id);
    // Up to snapshotMaxMs of edits sit in the log alone; the quiet timers here never fire.
    items.update(project.id, a.id, { status: "doing" }, "human");
    const b = items.create({ title: "Unpublished", projectId: project.id, boardId: board.id, by: "human" });
    expect(read(dir, "state/items.jsonl")).not.toMatch(/Unpublished/);
    await storage.rebuild(project.id);
    expect(items.get(project.id, a.id)?.status).toBe("doing");
    expect(items.get(project.id, b.id)?.title).toBe("Unpublished");
    expect(read(dir, "state/items.jsonl")).toMatch(/Unpublished/);
    expect(ctx.oplog.historyFor(project.id, "item", a.id).map((e) => e.op)).toEqual(["update", "create"]);
    expect((await storage.statusFor(project.id)).state).toBe("synced");
  });

  it("refuses to rebuild while the folder cannot take the unpublished edits, and keeps the cache", async () => {
    const { storage, items, board, project, dir } = await machine({ cacheDir: tmp("cache") });
    await storage.publish(project.id);
    const a = items.create({ title: "Kept in the cache", projectId: project.id, boardId: board.id, by: "human" });
    const manifestFile = path.join(dir, ARTIFACT_DIR, "project.json");
    const manifest = fs.readFileSync(manifestFile, "utf8");
    fs.writeFileSync(manifestFile, "<<<<<<< HEAD\n" + manifest);
    await expect(storage.rebuild(project.id)).rejects.toThrow(/edits the folder does not hold yet — .*conflict markers/);
    expect(items.get(project.id, a.id)?.title).toBe("Kept in the cache");
    expect(fs.readFileSync(manifestFile, "utf8")).toMatch(/^<<<<<<< HEAD/);
    fs.writeFileSync(manifestFile, manifest);
    await storage.rebuild(project.id);
    expect(items.get(project.id, a.id)?.title).toBe("Kept in the cache");
    expect(read(dir, "state/items.jsonl")).toMatch(/Kept in the cache/);
  });

  it("leaves the Hub folder untouched while its manifest cannot be read, and says why", async () => {
    const { storage, hubDir } = await machine();
    const manifestFile = path.join(hubDir, "hub.json");
    const ignoreFile = path.join(hubDir, ".gitignore");
    expect(JSON.parse(fs.readFileSync(manifestFile, "utf8")).v).toBe(1);
    const ignore = fs.readFileSync(ignoreFile, "utf8");
    fs.writeFileSync(manifestFile, "{ not json");
    fs.rmSync(ignoreFile);
    expect(await storage.writeHub()).toBeNull();
    expect(fs.readFileSync(manifestFile, "utf8")).toBe("{ not json");
    expect(fs.existsSync(ignoreFile)).toBe(false);
    expect(await storage.hubStatus()).toMatchObject({ state: "error", detail: expect.stringContaining("hub.json could not be read") });
    expect(storage.hubManifest()).toBeNull();
    // Valid JSON of the wrong shape is no better.
    const odd = JSON.stringify({ v: 1, projects: "none" });
    fs.writeFileSync(manifestFile, odd);
    expect(await storage.writeHub()).toBeNull();
    expect(fs.readFileSync(manifestFile, "utf8")).toBe(odd);
    // Repaired, it is written again — with the other machine's project kept.
    fs.writeFileSync(manifestFile, JSON.stringify({ v: 1, projects: [{ id: "elsewhere", name: "Other machine's", keyPrefix: "OTH", remote: null, hint: null, updatedAt: 1 }], repos: [], removed: [] }));
    expect((await storage.writeHub())?.projects.map((p) => p.id)).toContain("elsewhere");
    expect(fs.readFileSync(ignoreFile, "utf8")).toBe(ignore);
    expect((await storage.hubStatus()).state).toBe("local");
  });

  it("removing a project keeps its folder unless asked", async () => {
    const { projects, dir } = await machine();
    const kept = projects.create({ name: "Kept" });
    const gone = projects.create({ name: "Gone" });
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    const keptDir = projects.get(kept.id) && (await import("@tomradex/hub")).Catalog ? path.join(path.dirname(dir), "kept") : null;
    expect(keptDir && fs.existsSync(path.join(keptDir, ARTIFACT_DIR, "project.json"))).toBe(true);
    const goneDir = path.join(path.dirname(dir), "gone");
    expect(fs.existsSync(path.join(goneDir, ARTIFACT_DIR, "project.json"))).toBe(true);
    projects.remove(kept.id);
    projects.remove(gone.id, { deleteFolder: true });
    expect(fs.existsSync(path.join(keptDir!, ARTIFACT_DIR, "project.json"))).toBe(true);
    expect(fs.existsSync(goneDir)).toBe(false);
  });

  it("refuses a provider that puts a secret in its per-project config", async () => {
    const { storage } = await machine();
    expect(() =>
      storage.register({
        id: "leaky",
        title: "Leaky",
        configSchema: z.object({ token: z.string().meta({ format: "password" }) }),
        defaults: { token: "" },
        toRemote: () => ({ url: "", branch: "main" })
      })
    ).toThrow(/secret/);
  });

  it("keeps a plugin's tables while the plugin is not loaded, and gives it what it missed when it is", async () => {
    const { ctx, storage, project, dir } = await machine();
    // A plugin that loads after storage — as most do, early in a launch — or is switched off.
    const notes = {
      name: "demo-notes",
      inject: ["db"],
      apply(c: Context) {
        c.db.migrate("demo", [{ version: 1, up: "CREATE TABLE plugin_demo_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT)" }], {
          tables: { plugin_demo_notes: { project: "project_id", export: { order: "id", always: true } } }
        });
      }
    };
    const rows = () => ctx.db.for(project.id).prepare("SELECT id, body FROM plugin_demo_notes ORDER BY id").all();
    let fiber = ctx.plugin(notes);
    await settle();
    ctx.db.for(project.id).prepare("INSERT INTO plugin_demo_notes (id, project_id, body) VALUES ('n1', ?, 'mine')").run(project.id);
    await storage.publish(project.id);
    const file = path.join(dir, ARTIFACT_DIR, "plugins", "demo", "plugin_demo_notes.jsonl");
    const published = fs.readFileSync(file, "utf8");
    expect(published).toContain("mine");

    // Not loaded: its silence is not a deletion, so there is nothing to publish and nothing goes.
    await fiber.dispose();
    expect((await storage.statusFor(project.id)).state).toBe("synced");
    await storage.publish(project.id);
    expect(fs.readFileSync(file, "utf8")).toBe(published);

    // Someone else adds a note while it is off here: it is taken in and not published back over.
    const theirs = readArtifact(dir)!;
    theirs.plugins.demo.plugin_demo_notes.push({ id: "n2", project_id: project.id, body: "theirs" });
    theirs.manifest.snapshot!.digest = digestState(theirs);
    writeArtifact(dir, theirs);
    await storage.refresh(project.id);
    expect(ctx.hub.catalog.project(project.id)?.unimported).toEqual(["demo"]);
    expect((await storage.statusFor(project.id)).state).toBe("synced");
    await storage.publish(project.id);
    expect(fs.readFileSync(file, "utf8")).toContain("theirs");

    // Back on, it starts from the folder's rows, not the ones it left in the cache.
    fiber = ctx.plugin(notes);
    await settle();
    expect(rows()).toEqual([{ id: "n1", body: "mine" }, { id: "n2", body: "theirs" }]);
    expect(ctx.hub.catalog.project(project.id)?.unimported).toEqual([]);
    expect((await storage.statusFor(project.id)).state).toBe("synced");
    await storage.publish(project.id);
    expect(fs.readFileSync(file, "utf8")).toContain("theirs");
    await fiber.dispose();
  });

  it("merges around a plugin that is not loaded: our issue and their note both survive", async () => {
    const { ctx, storage, project, board, items, dir } = await machine();
    const fiber = ctx.plugin({
      name: "demo-notes",
      inject: ["db"],
      apply(c: Context) {
        c.db.migrate("demo", [{ version: 1, up: "CREATE TABLE plugin_demo_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT)" }], {
          tables: { plugin_demo_notes: { project: "project_id", export: { order: "id", always: true } } }
        });
      }
    });
    await settle();
    ctx.db.for(project.id).prepare("INSERT INTO plugin_demo_notes (id, project_id, body) VALUES ('n1', ?, 'mine')").run(project.id);
    await storage.publish(project.id);
    await fiber.dispose();

    items.create({ title: "Ours", projectId: project.id, boardId: board.id, by: "human" });
    const theirs = readArtifact(dir)!;
    theirs.plugins.demo.plugin_demo_notes.push({ id: "n2", project_id: project.id, body: "theirs" });
    theirs.manifest.snapshot!.digest = digestState(theirs);
    writeArtifact(dir, theirs);
    expect((await storage.statusFor(project.id)).state).toBe("diverged");
    await storage.refresh(project.id);
    await storage.publish(project.id);
    expect(read(dir, "state/items.jsonl")).toContain("Ours");
    expect(read(dir, path.join("plugins", "demo", "plugin_demo_notes.jsonl"))).toContain("theirs");
  });

  it("describes what can travel and what does", async () => {
    const { ctx, storage, project, dir } = await machine();
    ctx.db.migrate("demo", [{ version: 1, up: "CREATE TABLE plugin_demo_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)" }], {
      tables: { plugin_demo_notes: { project: "project_id", export: { order: "id" } } }
    });
    ctx.db.migrate("pin", [{ version: 1, up: "CREATE TABLE plugin_pin_binding (project_id TEXT PRIMARY KEY, url TEXT NOT NULL)" }], {
      tables: { plugin_pin_binding: { project: "project_id", export: { order: "project_id", always: true } } }
    });
    ctx.db.for(project.id).prepare("INSERT INTO plugin_pin_binding (project_id, url) VALUES (?, 'git@example.com:docs.git')").run(project.id);
    let info = await storage.info(project.id);
    // The binding is not a choice, so it is not listed.
    expect(info.exportable).toEqual([{ namespace: "demo", tables: ["plugin_demo_notes"], private: false }]);
    info = await storage.setExports(project.id, ["demo", "unknown", "pin"]);
    expect(info.exports).toEqual(["demo"]);
    expect(JSON.parse(read(dir, "project.json")).exports).toEqual(["demo"]);
    expect(fs.existsSync(path.join(dir, ARTIFACT_DIR, "plugins", "demo", "plugin_demo_notes.jsonl"))).toBe(true);
    await storage.setExports(project.id, []);
    expect(fs.existsSync(path.join(dir, ARTIFACT_DIR, "plugins", "demo"))).toBe(false);
    // …and travels with nothing ticked at all.
    expect(read(dir, path.join("plugins", "pin", "plugin_pin_binding.jsonl"))).toContain("git@example.com:docs.git");
  });
});
