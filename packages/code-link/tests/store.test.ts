import { describe, expect, it } from "vitest";
import { CodeLinkStore, MIGRATIONS, TABLES } from "@tomradex/code-link";
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
