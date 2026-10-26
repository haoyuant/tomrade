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
    unsynced: "{{n}} unsynced",
    tornTitle: "{{name}} has stopped syncing",
    tornDetail:
      "The files in .tomrade have not matched project.json for {{minutes}} min, so Tomrade neither reads nor writes this folder. A sync tool or a hand edit usually changed them without the manifest. Let the sync finish, or restore .tomrade from git in {{dir}} (git status, then git checkout -- .tomrade), then choose Sync now."
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
    unsynced: "{{n}} 条未同步",
    tornTitle: "{{name}} 已停止同步",
    tornDetail:
      ".tomrade 里的文件已有 {{minutes}} 分钟和 project.json 对不上，Tomrade 暂不读取也不写入这个文件夹。通常是同步工具或手动编辑改了文件、却没有更新清单。请等同步完成，或在 {{dir}} 里用 git 恢复 .tomrade（先 git status，再 git checkout -- .tomrade），然后点“立即同步”。"
  }
});
