import { defineWords } from "@tomradex/domain";

export const STORAGE_WORDS = defineWords("storage", {
  en: {
    stateLocal: "local",
    stateAhead: "ahead",
    stateBehind: "behind",
    stateDiverged: "diverged",
    stateSyncing: "syncing",
    stateOffline: "offline",
    stateError: "error",
    stateUnavailable: "unavailable",
    unsynced: "{{n}} unsynced"
  },
  zh: {
    stateLocal: "仅本机",
    stateAhead: "待发布",
    stateBehind: "待读取",
    stateDiverged: "两边都改了",
    stateSyncing: "同步中",
    stateOffline: "离线",
    stateError: "出错",
    stateUnavailable: "不可用",
    unsynced: "{{n}} 条未同步"
  }
});
