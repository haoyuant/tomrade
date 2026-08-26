import { ipcMain } from "electron";
import { BoardsRepository, ItemsRepository, ProjectsRepository, ViewsRepository, undoLast } from "@tomrade/core";
import type {
  AppSettings,
  BoardPatch,
  CreateBoardInput,
  CreateItemInput,
  CreateProjectInput,
  CreateViewInput,
  Db,
  ListItemsFilter,
  Patch,
  Project,
  ViewPatch
} from "@tomrade/core";

export interface IpcContext {
  db: Db;
  items: ItemsRepository;
  projects: ProjectsRepository;
  boards: BoardsRepository;
  views: ViewsRepository;
  dbPath: string;
  mcpUrl: () => string | null;
  getSettings: () => AppSettings;
  setSettings: (next: AppSettings) => AppSettings;
  /** AI handlers live in main.ts, which owns the provider. */
  ai?: Record<string, (...args: never[]) => unknown>;
}

/** The board an item lands on when the caller did not name one. */
export function defaultBoardId(ctx: IpcContext, projectId = "default"): string {
  const board = ctx.boards.list(projectId).find((b) => !b.across);
  if (!board) throw new Error(`Project ${projectId} has no board`);
  return board.id;
}

/** Data-plane handlers. One definition, shared by the app and the UI harness. */
export function registerDataIpc(ctx: IpcContext): void {
  ipcMain.handle("tomrade:list", (_e, filter: ListItemsFilter = {}) => ctx.items.list(filter));
  ipcMain.handle("tomrade:get", (_e, id: string) => ctx.items.get(id));
  ipcMain.handle("tomrade:create", (_e, input: Omit<CreateItemInput, "by">) => ctx.items.create({ ...input, by: "human" }));
  ipcMain.handle("tomrade:update", (_e, id: string, patch: Patch, baseVersion: number) => ctx.items.update(id, patch, "human", { baseVersion }));
  ipcMain.handle("tomrade:delete", (_e, id: string) => ctx.items.delete(id, "human"));
  ipcMain.handle("tomrade:undo", (_e, entityId?: string) => undoLast(ctx.db, entityId));
  ipcMain.handle("tomrade:recentOplog", (_e, limit?: number) => ctx.items.recentOplog(limit ?? 20));
  ipcMain.handle("tomrade:historyFor", (_e, id: string, limit?: number) => ctx.items.historyFor(id, limit ?? 20));
  ipcMain.handle("tomrade:labels", (_e, projectId: string) => ctx.items.labelsFor(projectId));
  ipcMain.handle("tomrade:mcpUrl", () => ctx.mcpUrl());
  ipcMain.handle("tomrade:dbPath", () => ctx.dbPath);

  ipcMain.handle("tomrade:projects:list", () => ctx.projects.list());
  ipcMain.handle("tomrade:projects:create", (_e, input: CreateProjectInput) => ctx.projects.create(input));
  ipcMain.handle("tomrade:projects:update", (_e, id: string, patch: Partial<Project>) => ctx.projects.update(id, patch));
  ipcMain.handle("tomrade:projects:remove", (_e, id: string) => ctx.projects.remove(id));

  ipcMain.handle("tomrade:boards:list", (_e, projectId: string) => ctx.boards.list(projectId));
  ipcMain.handle("tomrade:boards:create", (_e, input: CreateBoardInput) => ctx.boards.create(input));
  ipcMain.handle("tomrade:boards:update", (_e, id: string, patch: BoardPatch) => ctx.boards.update(id, patch));
  ipcMain.handle("tomrade:boards:remove", (_e, id: string) => ctx.boards.remove(id));
  ipcMain.handle("tomrade:boards:moveItems", (_e, from: string, to: string, itemIds: string[]) => ctx.boards.moveItems(from, to, itemIds));

  ipcMain.handle("tomrade:views:list", (_e, projectId: string) => ctx.views.listForProject(projectId));
  ipcMain.handle("tomrade:views:create", (_e, input: CreateViewInput) => ctx.views.create(input));
  ipcMain.handle("tomrade:views:update", (_e, id: string, patch: ViewPatch) => ctx.views.update(id, patch));
  ipcMain.handle("tomrade:views:remove", (_e, id: string) => ctx.views.remove(id));
  ipcMain.handle("tomrade:views:ranks", (_e, viewId: string) => ctx.views.ranks(viewId));
  ipcMain.handle("tomrade:views:setRank", (_e, viewId: string, itemId: string, rank: number) => ctx.views.setRank(viewId, itemId, rank));

  ipcMain.handle("tomrade:settings:get", () => ctx.getSettings());
  ipcMain.handle("tomrade:settings:set", (_e, next: AppSettings) => ctx.setSettings(next));
}
