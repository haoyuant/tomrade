import { contextBridge, ipcRenderer } from "electron";
import type { CreateItemInput, ExtractCandidate, GapCandidate, Item, ListItemsFilter, OplogEntry, Patch, ProviderConfig } from "@tomrade/core";

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
  aiCreateFromCandidate: (c: ExtractCandidate | GapCandidate, parentId: string | null): Promise<Item> => ipcRenderer.invoke("tomrade:ai:createFromCandidate", c, parentId)
};

contextBridge.exposeInMainWorld("tomrade", api);

export type TomradeApi = typeof api;