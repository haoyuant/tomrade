/// <reference types="vite/client" />

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

type AiChatResult =
  | { kind: "text"; reply: string }
  | { kind: "tool"; tool: string; result: unknown; reply?: string }
  | { kind: "error"; tool?: string; error: string };

interface WindowChrome {
  trafficLights: boolean;
}

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
      undo: (entityId?: string) => Promise<UndoResult | null>;
      recentOplog: (limit?: number) => Promise<OplogEntry[]>;
      historyFor: (id: string, limit?: number) => Promise<OplogEntry[]>;
      labels: (projectId: string) => Promise<string[]>;
      mcpUrl: () => Promise<string | null>;
      dbPath: () => Promise<string>;

      projectsList: () => Promise<Project[]>;
      projectsCreate: (input: CreateProjectInput) => Promise<Project>;
      projectsUpdate: (id: string, patch: Partial<Project>) => Promise<Project | null>;
      projectsRemove: (id: string) => Promise<void>;

      boardsList: (projectId: string) => Promise<Board[]>;
      boardsCreate: (input: CreateBoardInput) => Promise<CreatedBoard>;
      boardsUpdate: (id: string, patch: BoardPatch) => Promise<Board>;
      boardsRemove: (id: string) => Promise<void>;
      boardsMoveItems: (from: string, to: string, itemIds: string[]) => Promise<number>;

      viewsList: (projectId: string) => Promise<View[]>;
      viewsCreate: (input: CreateViewInput) => Promise<View>;
      viewsUpdate: (id: string, patch: ViewPatch) => Promise<View>;
      viewsRemove: (id: string) => Promise<void>;
      viewRanks: (viewId: string) => Promise<Record<string, number>>;
      viewSetRank: (viewId: string, itemId: string, rank: number) => Promise<void>;

      settingsGet: () => Promise<AppSettings>;
      settingsSet: (s: AppSettings) => Promise<AppSettings>;
      aiExtract: (text: string) => Promise<AiExtractResult>;
      aiGap: (requirement: string) => Promise<GapCandidate[]>;
      aiCreateFromCandidate: (c: ExtractCandidate | GapCandidate, parentId: string | null, boardId?: string) => Promise<Item>;
      aiChat: (text: string, history: ChatTurn[], projectId?: string) => Promise<AiChatResult>;
      onWindowChrome: (cb: (state: WindowChrome) => void) => () => void;
    };
  }
}
export {};
