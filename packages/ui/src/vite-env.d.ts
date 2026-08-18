/// <reference types="vite/client" />

import type { CreateItemInput, ExtractCandidate, GapCandidate, Item, ListItemsFilter, OplogEntry, Patch, ProviderConfig } from "@tomrade/core";

interface AiExtractResult {
  candidates: ExtractCandidate[];
  dedup: Record<number, { isDuplicate: boolean; duplicates: { id: string; reason: string }[] }>;
}

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
      mcpUrl: () => Promise<string | null>;
      settingsGet: () => Promise<ProviderConfig>;
      settingsSet: (s: ProviderConfig) => Promise<ProviderConfig>;
      aiExtract: (text: string) => Promise<AiExtractResult>;
      aiGap: (requirement: string) => Promise<GapCandidate[]>;
      aiCreateFromCandidate: (c: ExtractCandidate | GapCandidate, parentId: string | null) => Promise<Item>;
    };
  }
}
export {};