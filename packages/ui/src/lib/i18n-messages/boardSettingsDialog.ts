export const boardSettingsDialog = {
  en: {
    dialogLabel: "Board settings",

    defGroupedBy: "grouped by {{group}}",
    defLabels: "labels: {{list}}",
    defEpics: "epics: {{list}}",
    defPriority: "priority: {{list}}",
    defLastWrite: "last write: {{list}}",
    defColumns: "{{n}} columns",
    defWip: "WIP {{list}}",
    noneWord: "none",
    epicFallback: "epic",

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

    savedViews: "Saved views",
    openFirstAria: "Open {{name}} first on this board",
    opensFirst: "opens first · ",
    removeFromBoardTitle: "Remove from this board",
    removeFromBoardAria: "Remove {{name}} from this board",
    rosterCount: "{{n}} views · a new one is saved from the bar above the columns",
    rosterNote:
      "Grouping, filters and columns belong to a view and are set on the board itself — this is the roster: which view opens first, and which ones stay.",

    movedToast: "Moved {{n}} issues to {{name}}",
    savedToast: "Saved {{name}}",

    cancel: "Cancel",
    saveBoard: "Save board"
  },
  zh: {
    dialogLabel: "看板设置",

    defGroupedBy: "按{{group}}分组",
    defLabels: "标签：{{list}}",
    defEpics: "需求组：{{list}}",
    defPriority: "优先级：{{list}}",
    defLastWrite: "最后写入：{{list}}",
    defColumns: "{{n}} 列",
    defWip: "WIP {{list}}",
    noneWord: "无",
    epicFallback: "需求组",

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

    savedViews: "已保存的视图",
    openFirstAria: "在此看板上优先打开 {{name}}",
    opensFirst: "优先打开 · ",
    removeFromBoardTitle: "从此看板移除",
    removeFromBoardAria: "从此看板移除 {{name}}",
    rosterCount: "共 {{n}} 个视图 · 新视图可在列上方的工具栏中保存",
    rosterNote: "分组、筛选与列属于视图，且都在看板本身上设置——这里管理的是视图名录：哪个视图优先打开，哪些视图保留。",

    movedToast: "已将 {{n}} 个工作项移动到 {{name}}",
    savedToast: "已保存 {{name}}",

    cancel: "取消",
    saveBoard: "保存看板"
  }
};
