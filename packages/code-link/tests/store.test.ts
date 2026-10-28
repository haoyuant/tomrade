import { describe, expect, it, vi } from "vitest";
import { BOOKKEEPING_REFRESH_MS, CodeLinkStore, MIGRATIONS, TABLES } from "@tomradex/code-link";
import { ProjectDb, migrateCore } from "@tomradex/db";
import { fresh } from "@tomradex/testkit";
import { exportState, importState } from "@tomradex/storage";

describe("code-link delivery migration", () => {
  it("moves legacy delivery identities and baselines into core and imports them without code-link", async () => {
    const { ctx, db, items, project, board } = await fresh();
    ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Old delivery", by: "human" });
    db.prepare("INSERT INTO plugin_code_link_deliveries (id, project_id, item_id, sequence, state, started_at, completed_at, updated_at, bases_json) VALUES (?, ?, ?, 1, 'completed', 10, 20, 20, ?)")
      .run("legacy-identity", project.id, item.id, '{"repo":"sha"}');
    db.pragma("user_version = 10");
    migrateCore(db.handle);
    expect(items.deliveries.list(project.id, item.id)).toEqual([expect.objectContaining({ id: "legacy-identity", state: "completed", bases: { repo: "sha" }, startedAt: 10, completedAt: 20 })]);
    const snapshot = exportState(db, project.id);
    const oldRows = snapshot.tables.deliveries;
    delete snapshot.tables.deliveries;
    snapshot.plugins.code_link = { plugin_code_link_deliveries: oldRows };
    importState(db, snapshot);
    expect(items.deliveries.list(project.id, item.id)[0].id).toBe("legacy-identity");
    await ctx.fiber.dispose();
  });
  it("recovers an old artifact with a reopened ticket and keeps recovery idempotent", async () => {
    const { ctx, db, items, project, board } = await fresh();
    ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    const store = new CodeLinkStore(ctx.db);
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Imported revision", status: "todo", by: "human" });
    store.upsertLink(project.id, { itemId: item.id, repoId: "repo", branch: "tom-1/old" }, { mergedSha: "old" });
    const registrations = ctx.db.registrations("project");
    const artifact = exportState(db, project.id, { registrations, exports: ["code_link"] });
    delete artifact.plugins.code_link.plugin_code_link_deliveries;
    delete artifact.tables.deliveries;
    for (const link of artifact.plugins.code_link.plugin_code_link_links) delete link.delivery;
    db.prepare("DELETE FROM plugin_code_link_deliveries").run();
    importState(db, artifact, { registrations });
    store.repairLegacyDeliveries(project.id);
    store.repairLegacyDeliveries(project.id);
    expect(store.deliveries(project.id, item.id).map((delivery) => [delivery.sequence, delivery.state])).toEqual([[1, "completed"], [2, "active"]]);
    expect(store.links(project.id, item.id)[0]).toMatchObject({ delivery: 1, mergedSha: "old" });
  });

  it("reads every ticket's current delivery at once as it reads each one alone", async () => {
    const { ctx, db, items, project, board } = await fresh();
    ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    const store = new CodeLinkStore(ctx.db);
    const done = items.create({ projectId: project.id, boardId: board.id, title: "Done twice", by: "human" });
    const reopened = items.create({ projectId: project.id, boardId: board.id, title: "Reopened", by: "human" });
    const none = items.create({ projectId: project.id, boardId: board.id, title: "Never started", by: "human" });
    const insert = db.prepare("INSERT INTO deliveries (id, project_id, item_id, sequence, state, started_at, completed_at, updated_at, bases_json) VALUES (?, ?, ?, ?, ?, 1, NULL, 1, '{}')");
    insert.run("d1", project.id, done.id, 1, "completed");
    insert.run("d2", project.id, done.id, 2, "cancelled");
    // An active delivery stands even when a later one is on record.
    insert.run("r1", project.id, reopened.id, 1, "active");
    insert.run("r2", project.id, reopened.id, 2, "completed");
    const all = store.currentDeliveries(project.id);
    for (const item of [done, reopened, none]) expect(all.get(item.id) ?? null).toEqual(store.currentDelivery(project.id, item.id));
    expect(all.get(reopened.id)?.id).toBe("r1");
    expect(all.get(done.id)?.id).toBe("d2");
    await ctx.fiber.dispose();
  });

  it("keeps the herdr pane a session's hooks report", async () => {
    const { ctx, project } = await fresh();
    ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    const store = new CodeLinkStore(ctx.db);
    const session = store.createSession(project.id, { repoId: "repo", branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: "here" });
    expect(session.herdrPane).toBeNull();
    expect(store.patchSession(project.id, session.id, { herdrPane: "w3:p1" }).herdrPane).toBe("w3:p1");
    expect(store.session(project.id, session.id)!.herdrPane).toBe("w3:p1");
    expect(session.terminal).toBeNull();
    expect(store.patchSession(project.id, session.id, { terminal: "iTerm.app" }).terminal).toBe("iTerm.app");
    await ctx.fiber.dispose();
  });

  it("narrows sessions in the query as the old whole-table filter did, parsing only the rows that match", async () => {
    const { ctx, db, project } = await fresh();
    ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    const store = new CodeLinkStore(ctx.db);
    const make = (i: number, state: string, itemIds: string[], extra: { threadId?: string | null; externalId?: string | null; delivery?: number; worked?: string[] } = {}) => {
      const s = store.createSession(project.id, { repoId: "repo", branch: `b${i}`, itemIds, mode: "terminal", agent: "claude-code", threadId: extra.threadId ?? null, externalId: extra.externalId ?? null, delivery: extra.delivery ?? 1, device: "here" });
      db.prepare("UPDATE plugin_code_link_sessions SET state = ?, started_at = ?, worked_json = ? WHERE id = ?").run(state, i, JSON.stringify((extra.worked ?? []).map((itemId) => ({ itemId, delivery: 1 }))), s.id);
      return s.id;
    };
    for (let i = 0; i < 996; i++) make(i, "ended", [`item-${i % 50}`], { externalId: `ext-${i % 7}`, threadId: i % 3 ? null : `thread-${i % 5}`, delivery: 1 + (i % 2), worked: i % 11 ? [] : ["item-7"] });
    make(996, "lost", ["item-7"], { externalId: "ext-1" });
    make(997, "running", ["item-7", "item-8"], { externalId: "ext-1", threadId: "thread-1", delivery: 2 });
    make(998, "waiting", [], { externalId: "ext-2", worked: ["item-7"] });
    make(999, "idle", ["item-9"]);
    const all = store.sessions(project.id);
    expect(all).toHaveLength(1000);
    expect(all.map((s) => s.startedAt)).toEqual([...all.map((s) => s.startedAt)].sort((a, b) => b - a));
    const ids = (list: { id: string }[]) => list.map((s) => s.id);
    const cases = [
      { live: true },
      { itemId: "item-7" },
      { itemId: "item-7", live: true },
      { itemId: "item-7", delivery: 2 },
      { delivery: 2, live: true },
      { threadId: "thread-1" },
      { threadId: null, live: true },
      { externalId: "ext-1" },
      { externalId: "ext-1", live: true }
    ];
    for (const filter of cases) {
      const old = all.filter((s) => (filter.itemId ? s.itemIds.includes(filter.itemId) : true) && (filter.delivery !== undefined ? s.delivery === filter.delivery : true) && (filter.live ? s.state !== "ended" : true)
        && (filter.threadId !== undefined ? s.threadId === filter.threadId : true) && (filter.externalId ? s.externalId === filter.externalId : true));
      expect(ids(store.sessions(project.id, filter)), JSON.stringify(filter)).toEqual(ids(old));
    }
    expect(ids(store.movedOn(project.id, "item-7"))).toEqual(ids(all.filter((s) => !s.itemIds.includes("item-7") && s.worked.some((w) => w.itemId === "item-7"))));
    // A hook's question — which sessions still go — parses the four live rows, not the thousand.
    const parse = vi.spyOn(JSON, "parse");
    expect(store.sessions(project.id, { live: true })).toHaveLength(4);
    expect(parse.mock.calls.length).toBeLessThanOrEqual(4 * 3);
    parse.mockRestore();
    await ctx.fiber.dispose();
  });

  it("lists every live session and only the newest few that ended lately", async () => {
    const { ctx, db, project } = await fresh();
    ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    const store = new CodeLinkStore(ctx.db);
    const make = (state: string, endedAt: number | null) => {
      const s = store.createSession(project.id, { repoId: "repo", branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: "here" });
      db.prepare("UPDATE plugin_code_link_sessions SET state = ?, ended_at = ? WHERE id = ?").run(state, endedAt, s.id);
      return s.id;
    };
    const running = make("running", null);
    const waiting = make("waiting", null);
    const old = make("ended", 1_000);
    const lost = make("lost", 5_000);
    const recent = [make("ended", 6_000), make("ended", 7_000), make("ended", 8_000)];
    const ids = store.recentSessions(project.id, 2_000, 3).map((s) => s.id);
    expect(ids.slice(0, 2).sort()).toEqual([running, waiting].sort());
    // newest ended first, at most three, and nothing that ended before the cutoff
    expect(ids.slice(2)).toEqual([recent[2], recent[1], recent[0]]);
    expect(ids).not.toContain(old);
    expect(ids).not.toContain(lost);
    expect(store.recentSessions(project.id, 2_000, 8).map((s) => s.id)).toContain(lost);
    await ctx.fiber.dispose();
  });

  it("backfills existing links as delivery 1 without losing merge history", () => {
    const db = new ProjectDb("test", ":memory:");
    db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    for (const migration of MIGRATIONS.slice(0, 4)) {
      if (typeof migration.up === "string") db.exec(migration.up);
    }
    db.prepare("INSERT INTO items (id, status) VALUES ('ticket-1', 'done')").run();
    db.prepare(
      `INSERT INTO plugin_code_link_links
         (id, project_id, item_id, repo_id, branch, merged_sha, created_at, updated_at)
       VALUES ('link-1', 'project-1', 'ticket-1', 'repo-1', 'tom-1/ship', 'abc123', 10, 20)`
    ).run();

    const deliveryMigration = MIGRATIONS[4]!;
    expect(typeof deliveryMigration.up).toBe("function");
    if (typeof deliveryMigration.up === "function") deliveryMigration.up(db.handle);

    expect(db.prepare("SELECT item_id, sequence, state, started_at, completed_at FROM plugin_code_link_deliveries").get()).toEqual({
      item_id: "ticket-1",
      sequence: 1,
      state: "completed",
      started_at: 10,
      completed_at: 20
    });
    expect(db.prepare("SELECT delivery, merged_sha FROM plugin_code_link_links WHERE id = 'link-1'").get()).toEqual({ delivery: 1, merged_sha: "abc123" });
    db.close();
  });
});

describe("the repository's merge policy", () => {
  it("reads the old agent-merge switch as the agent policy, and keeps the switch in step with the policy", async () => {
    const { ctx, db, project } = await fresh();
    ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    const store = new CodeLinkStore(ctx.db);
    db.prepare("INSERT INTO plugin_code_link_repos (repo_id, project_id, readiness, agent_merge, updated_at) VALUES ('old-on', ?, 'scaffolded', 1, 1), ('old-off', ?, 'scaffolded', 0, 1)").run(project.id, project.id);
    expect(store.repoState(project.id, "old-on")).toMatchObject({ mergePolicy: "agent", agentMerge: true });
    expect(store.repoState(project.id, "old-off")).toMatchObject({ mergePolicy: "ask", agentMerge: false });
    expect(store.upsertRepoState(project.id, "old-on", { mergePolicy: "ask" })).toMatchObject({ mergePolicy: "ask", agentMerge: false });
    expect(store.repoState(project.id, "old-on")).toMatchObject({ mergePolicy: "ask", agentMerge: false });
    // The switch still works for callers that only know it.
    expect(store.upsertRepoState(project.id, "old-on", { agentMerge: true })).toMatchObject({ mergePolicy: "agent", agentMerge: true });
    expect(store.upsertRepoState(project.id, "old-on", { agentMerge: false })).toMatchObject({ mergePolicy: "ask", agentMerge: false });
    expect(store.upsertRepoState(project.id, "old-on", { mergePolicy: "human" })).toMatchObject({ mergePolicy: "human", agentMerge: false });
    // A patch about something else leaves the policy alone.
    store.upsertRepoState(project.id, "old-on", { mergePolicy: "ask" });
    expect(store.upsertRepoState(project.id, "old-on", { autoDone: false })).toMatchObject({ mergePolicy: "ask", autoDone: false });
    await ctx.fiber.dispose();
  });
});

describe("a scan that only looks again", () => {
  it("leaves a link and a repository row as they were, and refreshes the sighting once it is old", async () => {
    const { ctx, db, items, project, board } = await fresh();
    ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    const store = new CodeLinkStore(ctx.db);
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Seen again", by: "human" });
    const link = store.upsertLink(project.id, { itemId: item.id, repoId: "repo-1", branch: "tom-1/seen" }, { headSha: "a1", headAt: 10, ahead: 1, lastSeenAt: 1_000 });
    store.upsertRepoState(project.id, "repo-1", { readiness: "scaffolded", remote: "ok", remoteAt: 1_000, scannedSha: "m1", defaultSha: "m1", scannedAt: 1_000 });
    const rows = () => JSON.stringify([db.prepare("SELECT * FROM plugin_code_link_links").all(), db.prepare("SELECT * FROM plugin_code_link_repos").all()]);
    const before = rows();

    store.patchLink(project.id, link.id, { headSha: "a1", headAt: 10, ahead: 1, behind: 0, lastSeenAt: 2_000 });
    store.upsertRepoState(project.id, "repo-1", { readiness: "scaffolded", remote: "ok", remoteAt: 2_000, scannedSha: "m1", defaultSha: "m1", scannedAt: 2_000 });
    expect(rows()).toBe(before);

    // A day on, the sighting is written alone: when the row last changed stays put.
    const later = 1_000 + BOOKKEEPING_REFRESH_MS;
    store.patchLink(project.id, link.id, { headSha: "a1", lastSeenAt: later });
    expect(store.link(project.id, link.id)).toMatchObject({ lastSeenAt: later, updatedAt: link.updatedAt });
    expect(store.upsertRepoState(project.id, "repo-1", { scannedAt: later })).toMatchObject({ scannedAt: later });

    // Real news is written at once, with the sighting.
    expect(store.patchLink(project.id, link.id, { headSha: "a2", lastSeenAt: later + 1 })).toMatchObject({ headSha: "a2", lastSeenAt: later + 1 });
    expect(store.upsertRepoState(project.id, "repo-1", { defaultSha: "m2", scannedAt: later + 1 })).toMatchObject({ defaultSha: "m2", scannedAt: later + 1 });
    await ctx.fiber.dispose();
  });
});
