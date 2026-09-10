import { describe, expect, it } from "vitest";
import { CodeLinkStore, MIGRATIONS, TABLES } from "@tomrade/code-link";
import { ProjectDb } from "@tomrade/db";
import { fresh } from "@tomrade/testkit";
import { exportState, importState } from "@tomrade/storage";

describe("code-link delivery migration", () => {
  it("recovers an old artifact with a reopened ticket and keeps recovery idempotent", async () => {
    const { ctx, db, items, project, board } = await fresh();
    ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    const store = new CodeLinkStore(ctx.db);
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Imported revision", status: "todo", by: "human" });
    store.upsertLink(project.id, { itemId: item.id, repoId: "repo", branch: "tom-1/old" }, { mergedSha: "old" });
    const registrations = ctx.db.registrations("project");
    const artifact = exportState(db, project.id, { registrations, exports: ["code_link"] });
    delete artifact.plugins.code_link.plugin_code_link_deliveries;
    for (const link of artifact.plugins.code_link.plugin_code_link_links) delete link.delivery;
    db.prepare("DELETE FROM plugin_code_link_deliveries").run();
    importState(db, artifact, { registrations });
    store.repairLegacyDeliveries(project.id);
    store.repairLegacyDeliveries(project.id);
    expect(store.deliveries(project.id, item.id).map((delivery) => [delivery.sequence, delivery.state])).toEqual([[1, "completed"], [2, "active"]]);
    expect(store.links(project.id, item.id)[0]).toMatchObject({ delivery: 1, mergedSha: "old" });
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
