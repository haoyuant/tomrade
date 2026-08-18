/// <reference types="vite/client" />

import type { ChatTurn, CreateItemInput, CreateProjectInput, ExtractCandidate, GapCandidate, Item, ListItemsFilter, OplogEntry, Patch, Project, ProviderConfig } from "@tomrade/core";

type AiChatResult =
  | { kind: "text"; reply: string }
  | { kind: "tool"; tool: string; result: unknown; reply?: string }
  | { kind: "error"; tool?: string; error: string };

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
      aiChat: (text: string, history: ChatTurn[], projectId?: string) => Promise<AiChatResult>;
      projectsList: () => Promise<Project[]>;
      projectsCreate: (input: CreateProjectInput) => Promise<Project>;
      projectsRemove: (id: string) => Promise<void>;
    };
  }
}
export {};