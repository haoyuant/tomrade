import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, ItemsRepository } from "@tomrade/core";
import type { Author, CreateItemInput, ListItemsFilter, Patch } from "@tomrade/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let repo: ItemsRepository;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Tomrade",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    // Production: load the built React app from packages/ui/dist
    void win.loadFile(path.join(__dirname, "../../../packages/ui/dist/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("tomrade:list", (_e, filter: ListItemsFilter = {}) => repo.list(filter));
  ipcMain.handle("tomrade:get", (_e, id: string) => repo.get(id));
  ipcMain.handle("tomrade:create", (_e, input: Omit<CreateItemInput, "by">) => repo.create({ ...input, by: "ai:mcp" }));
  ipcMain.handle("tomrade:update", (_e, id: string, patch: Patch, baseVersion: number) => repo.update(id, patch, "human", { baseVersion }));
  ipcMain.handle("tomrade:delete", (_e, id: string) => repo.delete(id, "human"));
  ipcMain.handle("tomrade:undo", (_e, entityId?: string) => repo.undo(entityId));
  ipcMain.handle("tomrade:recentOplog", (_e, limit?: number) => repo.recentOplog(limit ?? 20));
}

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath("userData"), "tomrade.db");
  repo = new ItemsRepository(openDb(dbPath));
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

export type { Author };
