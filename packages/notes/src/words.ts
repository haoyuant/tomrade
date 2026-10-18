import { defineWords } from "@tomradex/domain";

/** The notes settings card. */
export const NOTES_WORDS = defineWords("notes", {
  en: {
    title: "Notes",
    description: "Links between the project's notes, and where a day's journal goes.",
    updateLinksTitle: "Update links when a note is renamed or moved",
    journalFolderTitle: "Journal folder"
  },
  zh: {
    title: "笔记",
    description: "项目笔记之间的链接，以及每天的日志放在哪里。",
    updateLinksTitle: "笔记重命名或移动时更新链接",
    journalFolderTitle: "日志文件夹"
  }
});
