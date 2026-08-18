import { contextBridge, ipcRenderer } from "electron";
import type { ChatTurn, CreateItemInput, CreateProjectInput, ExtractCandidate, GapCandidate, Item, ListItemsFilter, OplogEntry, Patch, Project, ProviderConfig } from "@tomrade/core";

export type AiChatResult =
  | { kind: "text"; reply: string }
  | { kind: "tool"; tool: string; result: unknown; reply?: string }
  | { kind: "error"; tool?: string; error: string };

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
  undo: (entityId?: string): Promise<Item | null> => ipcRenderer.invoke("tomrade:undo", entityId),
  recentOplog: (limit?: number): Promise<OplogEntry[]> => ipcRenderer.invoke("tomrade:recentOplog", limit),
  mcpUrl: (): Promise<string | null> => ipcRenderer.invoke("tomrade:mcpUrl"),
  settingsGet: (): Promise<ProviderConfig> => ipcRenderer.invoke("tomrade:settings:get"),
  settingsSet: (s: ProviderConfig): Promise<ProviderConfig> => ipcRenderer.invoke("tomrade:settings:set", s),
  aiExtract: (text: string): Promise<AiExtractResult> => ipcRenderer.invoke("tomrade:ai:extract", text),
  aiGap: (requirement: string): Promise<GapCandidate[]> => ipcRenderer.invoke("tomrade:ai:gap", requirement),
  aiCreateFromCandidate: (c: ExtractCandidate | GapCandidate, parentId: string | null): Promise<Item> => ipcRenderer.invoke("tomrade:ai:createFromCandidate", c, parentId),
  aiChat: (text: string, history: ChatTurn[], projectId?: string): Promise<AiChatResult> => ipcRenderer.invoke("tomrade:ai:chat", text, history, projectId),
  projectsList: (): Promise<Project[]> => ipcRenderer.invoke("tomrade:projects:list"),
  projectsCreate: (input: CreateProjectInput): Promise<Project> => ipcRenderer.invoke("tomrade:projects:create", input),
  projectsRemove: (id: string): Promise<void> => ipcRenderer.invoke("tomrade:projects:remove", id)
};

contextBridge.exposeInMainWorld("tomrade", api);

export type TomradeApi = typeof api;