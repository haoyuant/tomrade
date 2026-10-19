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
    installYourself: "Install herdr yourself: {{command}}",
    terminalFailed: "herdr did not open a terminal — is it running?",
    closeFailed: "herdr did not answer; the terminal is still open",
    sessionsUnreadable: "Code sessions could not be read just now; new terminals still open",
    unmatched: "An agent claimed a ticket, but Tomrade cannot tell which terminal it runs in — this stays a plain terminal",
    stateUnreadable: "The saved layout could not be read, so this window starts from one cell",
    presetName: "Layout",
    switchFailed: "Could not bring {{app}} forward"
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
    installYourself: "请自行安装 herdr：{{command}}",
    terminalFailed: "herdr 没能打开终端，它在运行吗？",
    closeFailed: "herdr 没有响应，终端还开着",
    sessionsUnreadable: "暂时读不到代码会话，新终端照常可以打开",
    unmatched: "有 agent 认领了工单，但 Tomrade 分不清它在哪个终端里，这里先保持为普通终端",
    stateUnreadable: "读不到保存的布局，这个窗口先从一个格子开始",
    presetName: "布局",
    switchFailed: "没能切到 {{app}}"
  }
});
