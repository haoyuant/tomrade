import { defineWords } from "@tomradex/domain";
import type { FilesSyncState } from "./types.js";

/** The status bar's and the palette's words. */
export const FILES_WORDS = defineWords("files", {
  en: {
    conflicts: "Files · conflicts",
    offline: "Files · offline",
    error: "Files · error",
    sync: "Sync files now",
    group: "Files",
    openProject: "Open a project first",
    synced: "Files: {{state}}",
    syncedDetail: "Files: {{state}} — {{detail}}",
    stateSynced: "synced",
    stateConflicted: "conflicted",
    stateOffline: "offline",
    stateError: "error"
  },
  zh: {
    conflicts: "文件 · 有冲突",
    offline: "文件 · 离线",
    error: "文件 · 出错",
    sync: "立即同步文件",
    group: "文件",
    openProject: "请先打开一个项目",
    synced: "文件：{{state}}",
    syncedDetail: "文件：{{state}}——{{detail}}",
    stateSynced: "已同步",
    stateConflicted: "有冲突",
    stateOffline: "离线",
    stateError: "出错"
  }
});

/** The states with a word of their own; any other is shown as it is. */
export const FILES_STATE_WORD: Partial<Record<FilesSyncState, "stateSynced" | "stateConflicted" | "stateOffline" | "stateError">> = {
  synced: "stateSynced",
  conflicted: "stateConflicted",
  offline: "stateOffline",
  error: "stateError"
};
