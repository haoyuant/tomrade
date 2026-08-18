/// <reference types="vite/client" />

import type { CreateItemInput, Item, ListItemsFilter, OplogEntry, Patch } from "@tomrade/core";

declare global {
  interface Window {
    tomrade: {
      list: (filter?: ListItemsFilter) => Promise<Item[]>;
      get: (id: string) => Promise<Item | null>;
      create: (input: Omit<CreateItemInput, "by">) => Promise<Item>;
      update: (id: string, patch: Patch, baseVersion: number) => Promise<Item>;
      remove: (id: string) => Promise<void>;
      undo: (entityId?: string) => Promise<Item | null>;
      recentOplog: (limit?: number) => Promise<OplogEntry[]>;
    };
  }
}
export {};
