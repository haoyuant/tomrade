import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AppSettings,
  Board,
  BoardPatch,
  ChatTurn,
  CreateBoardInput,
  CreatedBoard,
  CreateItemInput,
  CreateProjectInput,
  CreateViewInput,
  ExtractCandidate,
  GapCandidate,
  Item,
  ListItemsFilter,
  OplogEntry,
  Patch,
  Project,
  UndoResult,
  View,
  ViewPatch
} from "@tomrade/core";

export type AiChatResult =
  | { kind: "text"; reply: string }
  | { kind: "tool"; tool: string; result: unknown; reply?: string }
  | { kind: "error"; tool?: string; error: string };

/** What the shell knows about its own frame that CSS cannot ask for. */
export interface WindowChrome {
  /** macOS draws the traffic lights over our header — reserve a gutter. */
  trafficLights: boolean;
}

export interface AiExtractResult {
  candidates: ExtractCandidate[];
  dedup: Record<number, { isDuplicate: boolean; duplicates: { id: string; reason: string }[] }>;
}

const api = {
  list: (filter?: ListItemsFilter): Promise<Item[]> => ipcRenderer.invoke("tomrade:list", filter),
  get: (id: string): Promise<Item | null> => ipcRenderer.invoke("tomrade:get", id),
  create: (input: Omit<CreateItemInput, "by">): Promise<Item> => ipcRenderer.invoke("tomrade:create", input),
  update: (id: string, patch: Patch, baseVersion: number): Promise<Item> => ipcRenderer.invoke("tomrade:update", id, patch, baseVersion),
  remove: (id: string): Promise<void> => ipcRenderer.invoke("tomrade:delete", id),
  /** Permanent — no snapshot survives it and undo will not bring it back. */
  purge: (id: string, baseVersion: number): Promise<void> => ipcRenderer.invoke("tomrade:purge", id, baseVersion),
  undo: (entityId?: string): Promise<UndoResult | null> => ipcRenderer.invoke("tomrade:undo", entityId),
  recentOplog: (limit?: number): Promise<OplogEntry[]> => ipcRenderer.invoke("tomrade:recentOplog", limit),
  historyFor: (id: string, limit?: number): Promise<OplogEntry[]> => ipcRenderer.invoke("tomrade:historyFor", id, limit),
  labels: (projectId: string): Promise<string[]> => ipcRenderer.invoke("tomrade:labels", projectId),
  mcpUrl: (): Promise<string | null> => ipcRenderer.invoke("tomrade:mcpUrl"),
  dbPath: (): Promise<string> => ipcRenderer.invoke("tomrade:dbPath"),

  projectsList: (): Promise<Project[]> => ipcRenderer.invoke("tomrade:projects:list"),
  projectsCreate: (input: CreateProjectInput): Promise<Project> => ipcRenderer.invoke("tomrade:projects:create", input),
  projectsUpdate: (id: string, patch: Partial<Project>): Promise<Project | null> => ipcRenderer.invoke("tomrade:projects:update", id, patch),
  projectsRemove: (id: string): Promise<void> => ipcRenderer.invoke("tomrade:projects:remove", id),

  boardsList: (projectId: string): Promise<Board[]> => ipcRenderer.invoke("tomrade:boards:list", projectId),
  boardsCreate: (input: CreateBoardInput): Promise<CreatedBoard> => ipcRenderer.invoke("tomrade:boards:create", input),
  boardsUpdate: (id: string, patch: BoardPatch): Promise<Board> => ipcRenderer.invoke("tomrade:boards:update", id, patch),
  boardsRemove: (id: string): Promise<void> => ipcRenderer.invoke("tomrade:boards:remove", id),
  boardsMoveItems: (from: string, to: string, itemIds: string[]): Promise<number> => ipcRenderer.invoke("tomrade:boards:moveItems", from, to, itemIds),

  viewsList: (projectId: string): Promise<View[]> => ipcRenderer.invoke("tomrade:views:list", projectId),
  viewsCreate: (input: CreateViewInput): Promise<View> => ipcRenderer.invoke("tomrade:views:create", input),
  viewsUpdate: (id: string, patch: ViewPatch): Promise<View> => ipcRenderer.invoke("tomrade:views:update", id, patch),
  viewsRemove: (id: string): Promise<void> => ipcRenderer.invoke("tomrade:views:remove", id),
  viewRanks: (viewId: string): Promise<Record<string, number>> => ipcRenderer.invoke("tomrade:views:ranks", viewId),
  viewSetRank: (viewId: string, itemId: string, rank: number): Promise<void> => ipcRenderer.invoke("tomrade:views:setRank", viewId, itemId, rank),

  settingsGet: (): Promise<AppSettings> => ipcRenderer.invoke("tomrade:settings:get"),
  settingsSet: (s: AppSettings): Promise<AppSettings> => ipcRenderer.invoke("tomrade:settings:set", s),
  aiExtract: (text: string): Promise<AiExtractResult> => ipcRenderer.invoke("tomrade:ai:extract", text),
  aiGap: (requirement: string): Promise<GapCandidate[]> => ipcRenderer.invoke("tomrade:ai:gap", requirement),
  aiCreateFromCandidate: (c: ExtractCandidate | GapCandidate, parentId: string | null, boardId?: string): Promise<Item> =>
    ipcRenderer.invoke("tomrade:ai:createFromCandidate", c, parentId, boardId),
  aiChat: (text: string, history: ChatTurn[], projectId?: string): Promise<AiChatResult> => ipcRenderer.invoke("tomrade:ai:chat", text, history, projectId),

  /** Subscribe to the shell's frame state; returns the unsubscribe. */
  onWindowChrome: (cb: (state: WindowChrome) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, state: WindowChrome) => cb(state);
    ipcRenderer.on("tomrade:chrome", listener);
    return () => ipcRenderer.off("tomrade:chrome", listener);
  }
};

contextBridge.exposeInMainWorld("tomrade", api);

export type TomradeApi = typeof api;
