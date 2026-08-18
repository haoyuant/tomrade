/**
 * Projects: create/list/rename/remove + default seed + item scoping.
 */
import { describe, expect, it } from "vitest";
import { openDb, ItemsRepository, ProjectsRepository } from "../src/index.js";

function fresh() {
  const db = openDb(":memory:");
  return { db, projects: new ProjectsRepository(db), items: new ItemsRepository(db) };
}

describe("projects", () => {
  it("seeds a default project", () => {
    const { projects } = fresh();
    const d = projects.ensureDefault();
    expect(d.id).toBe("default");
    expect(projects.list().length).toBe(1);
  });

  it("create/list/rename/remove projects", () => {
    const { projects } = fresh();
    projects.ensureDefault();
    const p = projects.create({ name: "Acme App", description: "v2" });
    expect(projects.list().length).toBe(2);
    expect(projects.get(p.id)?.description).toBe("v2");
    const renamed = projects.rename(p.id, "Acme App 2");
    expect(renamed?.name).toBe("Acme App 2");
    projects.remove(p.id);
    expect(projects.get(p.id)).toBeNull();
  });

  it("items are scoped per project; removing a project cascades its items", () => {
    const { projects, items } = fresh();
    projects.ensureDefault();
    const p = projects.create({ name: "P" });
    items.create({ title: "in P", projectId: p.id, by: "human" });
    items.create({ title: "in default", by: "human" });
    expect(items.list({ projectId: p.id }).length).toBe(1);
    expect(items.list({ projectId: "default" }).length).toBe(1);
    projects.remove(p.id);
    expect(items.list({ projectId: p.id }).length).toBe(0);
    expect(items.list({ projectId: "default" }).length).toBe(1);
  });
});
