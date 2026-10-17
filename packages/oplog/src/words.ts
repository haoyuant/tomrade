import { defineWords } from "@tomradex/domain";

/** What ⌘Z and ⇧⌘Z say they did. */
export const OPLOG_WORDS = defineWords({
  en: {
    undoCreate: "Removed {{label}}",
    undoDelete: "Restored {{label}}",
    undoRank: "Moved back {{label}}",
    undoChange: "Reverted {{label}}",
    redoCreate: "Re-created {{label}}",
    redoDelete: "Deleted again {{label}}",
    redoRank: "Moved again {{label}}",
    redoChange: "Re-applied {{label}}"
  },
  zh: {
    undoCreate: "已移除 {{label}}",
    undoDelete: "已恢复 {{label}}",
    undoRank: "已移回 {{label}}",
    undoChange: "已撤销 {{label}}",
    redoCreate: "已重新创建 {{label}}",
    redoDelete: "已再次删除 {{label}}",
    redoRank: "已再次移动 {{label}}",
    redoChange: "已重做 {{label}}"
  }
});
