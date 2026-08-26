import { openDb, BoardsRepository, ItemsRepository, ProjectsRepository, ViewsRepository } from "../src/index.js";

/** A fresh in-memory database with the default project, its board and views seeded. */
export function fresh() {
  const db = openDb(":memory:");
  const projects = new ProjectsRepository(db);
  const boards = new BoardsRepository(db);
  const views = new ViewsRepository(db);
  const items = new ItemsRepository(db);
  const project = projects.ensureDefault();
  const board = boards.list(project.id).find((b) => !b.across)!;
  return { db, projects, boards, views, items, project, board };
}
