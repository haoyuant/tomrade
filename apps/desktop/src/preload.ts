import { contextBridge, ipcRenderer } from "electron";
import type { CreateItemInput, Item, ListItemsFilter, OplogEntry, Patch } from "@tomrade/core";

const api = {
  list: (filter?: ListItemsFilter): Promise<Item[]> => ipcRenderer.invoke("tomrade:list", filter),
  get: (id: string): Promise<Item | null> => ipcRenderer.invoke("tomrade:get", id),
  create: (input: Omit<CreateItemInput, "by">): Promise<Item> => ipcRenderer.invoke("tomrade:create", input),
  update: (id: string, patch: Patch, baseVersion: number): Promise<Item> => ipcRenderer.invoke("tomrade:update", id, patch, baseVersion),
  remove: (id: string): Promise<void> => ipcRenderer.invoke("tomrade:delete", id),
  undo: (entityId?: string): Promise<Item | null> => ipcRenderer.invoke("tomrade:undo", entityId),
  recentOplog: (limit?: number): Promise<OplogEntry[]> => ipcRenderer.invoke("tomrade:recentOplog", limit),
  mcpUrl: (): Promise<string | null> => ipcRenderer.invoke("tomrade:mcpUrl")
};

contextBridge.exposeInMainWorld("tomrade", api);

export type TomradeApi = typeof api;