import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  openDb,
  BoardsRepository,
  ItemsRepository,
  ProjectsRepository,
  ViewsRepository,
  OpenAICompatibleProvider,
  checkDuplicate,
  extractTickets,
  gapAnalysis,
  routeIntent
} from "@tomrade/core";
import type {
  AppSettings,
  ChatTurn,
  ExtractCandidate,
  GapCandidate,
  ItemKind,
  ItemStatus,
  Patch,
  Priority,
  ToolName
} from "@tomrade/core";
import { startTomradeMcpServer } from "@tomrade/mcp";
import { defaultBoardId as boardIdFor, registerDataIpc, type IpcContext } from "./ipc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let db: ReturnType<typeof openDb>;
let repo: ItemsRepository;
let projectsRepo: ProjectsRepository;
let boardsRepo: BoardsRepository;
let viewsRepo: ViewsRepository;
let mcpUrl: string | null = null;
let dbPath = "";
let settingsPath = "";
let settings: AppSettings = {
  llm: {
    apiKey: process.env.LLM_API_KEY ?? "",
    baseURL: process.env.LLM_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.LLM_MODEL ?? "deepseek-chat"
  },
  theme: "system"
};
const provider = new OpenAICompatibleProvider(() => settings.llm);

function loadSettings(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Partial<AppSettings>;
    settings = {
      llm: { ...settings.llm, ...(raw.llm ?? {}) },
      theme: raw.theme ?? "system"
    };
  } catch {
    // first run: defaults
  }
}

function saveSettings(next: AppSettings): void {
  settings = next;
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), "utf8");
}

function existingSummary() {
  return repo.list().map((i) => ({ id: i.id, title: i.title, body: i.body }));
}

async function executeTool(tool: ToolName, args: Record<string, unknown>, projectId?: string): Promise<unknown> {
  switch (tool) {
    case "list_items": {
      const items = repo.list({
        projectId,
        boardId: typeof args.boardId === "string" ? args.boardId : undefined,
        status: typeof args.status === "string" ? (args.status as ItemStatus) : undefined,
        kind: typeof args.kind === "string" ? (args.kind as ItemKind) : undefined,
        parentId: typeof args.parentId === "string" || args.parentId === null ? (args.parentId as string | null) : undefined
      });
      const q = typeof args.search === "string" ? args.search.toLowerCase() : null;
      const filtered = q ? items.filter((i) => i.title.toLowerCase().includes(q) || (i.body ?? "").toLowerCase().includes(q)) : items;
      return filtered.map((i) => ({ id: i.id, key: i.key, title: i.title, kind: i.kind, status: i.status, priority: i.priority, parentId: i.parentId }));
    }
    case "create_item": {
      if (typeof args.title !== "string" || !args.title.trim()) throw new Error("create_item requires a title");
      return repo.create({
        title: args.title.trim(),
        body: typeof args.body === "string" ? args.body : null,
        kind: args.kind === "epic" ? "epic" : "ticket",
        parentId: typeof args.parentId === "string" ? args.parentId : null,
        boardId: typeof args.boardId === "string" ? args.boardId : defaultBoardId(projectId),
        projectId,
        by: "ai:assistant"
      });
    }
    case "update_item": {
      if (typeof args.id !== "string") throw new Error("update_item requires an id");
      const existing = repo.get(args.id);
      if (!existing) throw new Error(`Item ${args.id} not found`);
      const patch: Patch = {};
      if (typeof args.status === "string") patch.status = args.status as ItemStatus;
      if (typeof args.title === "string") patch.title = args.title;
      if (typeof args.body === "string") patch.body = args.body;
      if (typeof args.priority === "number") patch.priority = args.priority as Priority;
      if (typeof args.parentId === "string" || args.parentId === null) patch.parentId = args.parentId;
      if (Object.keys(patch).length === 0) throw new Error("update_item requires status/title/body/priority/parentId");
      return repo.update(args.id, patch, "ai:assistant", { baseVersion: existing.version });
    }
    case "delete_item": {
      if (typeof args.id !== "string") throw new Error("delete_item requires an id");
      repo.delete(args.id, "ai:assistant");
      return { deleted: args.id };
    }
    case "extract_tickets": {
      if (typeof args.text !== "string" || !args.text.trim()) throw new Error("extract_tickets requires text");
      return extractTickets(provider, args.text);
    }
    case "gap_analysis": {
      if (typeof args.requirement !== "string" || !args.requirement.trim()) throw new Error("gap_analysis requires requirement");
      return gapAnalysis(provider, { requirement: args.requirement, existing: existingSummary() });
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

async function extractWithDedup(
  text: string
): Promise<{ candidates: ExtractCandidate[]; dedup: Record<number, { isDuplicate: boolean; duplicates: { id: string; reason: string }[] }> }> {
  const candidates = await extractTickets(provider, text);
  const dedup: Record<number, { isDuplicate: boolean; duplicates: { id: string; reason: string }[] }> = {};
  const existing = existingSummary();
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      dedup[i] = await checkDuplicate(provider, { title: candidates[i].title, body: candidates[i].body, existing });
    } catch {
      dedup[i] = { isDuplicate: false, duplicates: [] };
    }
  }
  return { candidates, dedup };
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Tomrade",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  /* The traffic lights sit inside the renderer's own header (hiddenInset), so
     the header has to keep a gutter for them — but only while windowed: in
     full screen macOS hands them back to the auto-hiding menu bar. Only this
     window is frameless, so the shell tells the page rather than the page
     guessing. */
  const sendChrome = (): void => {
    if (win.isDestroyed()) return;
    win.webContents.send("tomrade:chrome", { trafficLights: process.platform === "darwin" && !win.isFullScreen() });
  };
  win.webContents.on("did-finish-load", sendChrome);
  win.on("enter-full-screen", sendChrome);
  win.on("leave-full-screen", sendChrome);

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    // Production: load the built React app from packages/ui/dist
    void win.loadFile(path.join(__dirname, "../../../packages/ui/dist/index.html"));
  }
}

let ipcContext: IpcContext;

/** The board an item lands on when the caller did not name one. */
function defaultBoardId(projectId = "default"): string {
  return boardIdFor(ipcContext, projectId);
}

function registerIpc(): void {
  registerDataIpc(ipcContext);

  ipcMain.handle("tomrade:ai:extract", (_e, text: string) => extractWithDedup(text));
  ipcMain.handle("tomrade:ai:gap", (_e, requirement: string) => gapAnalysis(provider, { requirement, existing: existingSummary() }));
  ipcMain.handle("tomrade:ai:createFromCandidate", (_e, candidate: ExtractCandidate | GapCandidate, parentId: string | null, boardId?: string) =>
    repo.create({ title: candidate.title, body: candidate.body, kind: candidate.kind, parentId, boardId: boardId ?? defaultBoardId(), by: "ai:extraction" })
  );
  ipcMain.handle("tomrade:ai:chat", async (_e, text: string, history: ChatTurn[] = [], projectId?: string) => {
    const turns: ChatTurn[] = [...history, { role: "user", content: text }];
    const route = await routeIntent(provider, turns);
    if (!route.needsTool || !route.tool) {
      return { kind: "text", reply: route.reply ?? "I don't need a tool for that." };
    }
    try {
      const result = await executeTool(route.tool, route.args ?? {}, projectId);
      return { kind: "tool", tool: route.tool, result, reply: route.reply };
    } catch (err) {
      return { kind: "error", tool: route.tool, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

app.whenReady().then(async () => {
  dbPath = path.join(app.getPath("userData"), "tomrade.db");
  settingsPath = path.join(app.getPath("userData"), "settings.json");
  loadSettings();
  db = openDb(dbPath);
  repo = new ItemsRepository(db);
  projectsRepo = new ProjectsRepository(db);
  boardsRepo = new BoardsRepository(db);
  viewsRepo = new ViewsRepository(db);
  projectsRepo.ensureDefault();
  ipcContext = {
    db,
    items: repo,
    projects: projectsRepo,
    boards: boardsRepo,
    views: viewsRepo,
    dbPath,
    mcpUrl: () => mcpUrl,
    getSettings: () => settings,
    setSettings: (next) => {
      saveSettings(next);
      return settings;
    }
  };
  try {
    const mcp = await startTomradeMcpServer(repo, boardsRepo);
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
