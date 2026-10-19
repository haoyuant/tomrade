import { defineWords } from "@tomradex/domain";

/** What the code sessions plugin says outside its window: the command, the sidebar door, the window's title and its notes. */
export const CODE_SESSIONS_WORDS = defineWords("codeSessions", {
  en: {
    open: "Open code sessions window",
    group: "Code link",
    sidebar: "Code sessions",
    windowTitle: "Code sessions — {{project}}",
    openProject: "Open a project first",
    noTerminal: "This session has no herdr terminal on this computer",
    noTicket: "This session has no ticket",
    noWorktree: "No worktree for this session on this computer",
    installing: "Installing herdr in a terminal — come back when it is done",
    installYourself: "Install herdr yourself: {{command}}"
  },
  zh: {
    open: "打开代码会话窗口",
    group: "代码关联",
    sidebar: "代码会话",
    windowTitle: "代码会话 — {{project}}",
    openProject: "请先打开一个项目",
    noTerminal: "这个会话在本机没有 herdr 终端",
    noTicket: "这个会话没有关联工单",
    noWorktree: "这个会话在本机没有 worktree",
    installing: "正在终端里安装 herdr，装好后回来即可",
    installYourself: "请自行安装 herdr：{{command}}"
  }
});
