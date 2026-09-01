export const boardSettingsDialog = {
  en: {
    dialogLabel: "Board settings",

    boardNameLabel: "Board name",
    sidebarGlyphLabel: "Sidebar glyph",
    workspacePkgLabel: "Workspace package",
    workspacePkgPlaceholder: "packages/…",

    issuesOnBoard: "Issues on this board",
    issuesCarryBoardId: "{{n}} issues carry {{boardId}}",
    aiWritesClause: ", {{n}} last written by the agent",
    lockedClause: ", {{n}} locked against agent writes",

    moveToAnotherBoard: "Move issues to another board",
    whichIssuesAria: "Which issues to move",
    destinationBoardAria: "Destination board",
    moveButton: "Move",
    noOtherBoard: "No other board in this project to move work to.",
    moveCount: "{{n}} issues would change board.",
    moveNote: "Status, rank and history stay — moving a workstream is a deliberate act, which is why dragging a card never does it.",
    allIssues: "All {{n}} issues",
    statusScope: "Status · {{label}} ({{n}})",
    labelScope: "Label · {{label}} ({{n}})",

    movedToast: "Moved {{n}} issues to {{name}}",
    savedToast: "Saved {{name}}",

    cancel: "Cancel",
    saveBoard: "Save board"
  },
  zh: {
    dialogLabel: "看板设置",

    boardNameLabel: "看板名称",
    sidebarGlyphLabel: "侧栏图标",
    workspacePkgLabel: "工作区包路径",
    workspacePkgPlaceholder: "packages/…",

    issuesOnBoard: "此看板上的工作项",
    issuesCarryBoardId: "{{n}} 个工作项携带 {{boardId}}",
    aiWritesClause: "，其中 {{n}} 个由智能体最后写入",
    lockedClause: "，{{n}} 个已锁定禁止智能体写入",

    moveToAnotherBoard: "将工作项移动到其他看板",
    whichIssuesAria: "要移动的工作项范围",
    destinationBoardAria: "目标看板",
    moveButton: "移动",
    noOtherBoard: "此项目中没有其他看板可以接收工作项。",
    moveCount: "{{n}} 个工作项将变更看板。",
    moveNote: "状态、顺序与历史都会保留——移动工作流是一次审慎的操作，这也是拖拽卡片从不触发它的原因。",
    allIssues: "全部 {{n}} 个工作项",
    statusScope: "状态 · {{label}}（{{n}}）",
    labelScope: "标签 · {{label}}（{{n}}）",

    movedToast: "已将 {{n}} 个工作项移动到 {{name}}",
    savedToast: "已保存 {{name}}",

    cancel: "取消",
    saveBoard: "保存看板"
  }
};
