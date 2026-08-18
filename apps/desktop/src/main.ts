import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { openDb, ItemsRepository, OpenAICompatibleProvider, checkDuplicate, extractTickets, gapAnalysis } from "@tomrade/core";
import type { ExtractCandidate, GapCandidate, ProviderConfig } from "@tomrade/core";
import { startTomradeMcpServer } from "@tomrade/mcp";
import type { Author, CreateItemInput, ListItemsFilter, Patch } from "@tomrade/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let repo: ItemsRepository;
let mcpUrl: string | null = null;
let settingsPath = "";
let settings: ProviderConfig = {
  apiKey: process.env.LLM_API_KEY ?? "",
  baseURL: process.env.LLM_BASE_URL ?? "https://api.deepseek.com",
  model: process.env.LLM_MODEL ?? "deepseek-chat"
};
const provider = new OpenAICompatibleProvider(() => settings);

function loadSettings(): void {
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    settings = { ...settings, ...(JSON.parse(raw) as Partial<ProviderConfig>) };
  } catch {
    // first run: defaults
  }
}

function saveSettings(next: ProviderConfig): void {
  settings = next;
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), "utf8");
}

function existingSummary() {
  return repo.list().map((i) => ({ id: i.id, title: i.title, body: i.body }));
}

async function extractWithDedup(text: string): Promise<{ candidates: ExtractCandidate[]; dedup: Record<number, { isDuplicate: boolean; duplicates: { id: string; reason: string }[] }> }> {
  const candidates = await extractTickets(provider, text);
  const dedup: Record<number, { isDuplicate: boolean; duplicates: { id: string; reason: string }[] }> = {};
  const existing = existingSummary();
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      dedup[i] = await checkDuplicate(provider, {
        title: candidates[i].title,
        body: candidates[i].body,
        existing
      });
    } catch {
      dedup[i] = { isDuplicate: false, duplicates: [] };
    }
  }
  return { candidates, dedup };
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Tomrade",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
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
  ipcMain.handle("tomrade:create", (_e, input: Omit<CreateItemInput, "by">) => repo.create({ ...input, by: "human" }));
  ipcMain.handle("tomrade:update", (_e, id: string, patch: Patch, baseVersion: number) => repo.update(id, patch, "human", { baseVersion }));
  ipcMain.handle("tomrade:delete", (_e, id: string) => repo.delete(id, "human"));
  ipcMain.handle("tomrade:undo", (_e, entityId?: string) => repo.undo(entityId));
  ipcMain.handle("tomrade:recentOplog", (_e, limit?: number) => repo.recentOplog(limit ?? 20));
  ipcMain.handle("tomrade:mcpUrl", () => mcpUrl);

  ipcMain.handle("tomrade:settings:get", () => settings);
  ipcMain.handle("tomrade:settings:set", (_e, next: ProviderConfig) => {
    saveSettings(next);
    return settings;
  });
  ipcMain.handle("tomrade:ai:extract", (_e, text: string) => extractWithDedup(text));
  ipcMain.handle("tomrade:ai:gap", (_e, requirement: string) => gapAnalysis(provider, { requirement, existing: existingSummary() }));
  ipcMain.handle("tomrade:ai:createFromCandidate", (_e, candidate: ExtractCandidate | GapCandidate, parentId: string | null) =>
    repo.create({ title: candidate.title, body: candidate.body, kind: candidate.kind, parentId, by: "ai:extraction" })
  );
}

app.whenReady().then(async () => {
  const dbPath = path.join(app.getPath("userData"), "tomrade.db");
  settingsPath = path.join(app.getPath("userData"), "settings.json");
  loadSettings();
  repo = new ItemsRepository(openDb(dbPath));
  try {
    const mcp = await startTomradeMcpServer(repo);
    mcpUrl = mcp.url;
    console.log(`[tomrade] MCP server ready: ${mcp.url}`);
  } catch (err) {
    console.error("[tomrade] MCP server failed to start:", err);
  }
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