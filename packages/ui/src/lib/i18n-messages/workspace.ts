export const workspace = {
  en: {
    itemsReadFailed: "This project's tickets could not be read — the backlog is not empty, it did not load.",
    conflictBanner: "Version conflict on “{{title}}”. An agent wrote to it while this view was open — the view re-fetched, so try the move again.",
    dismiss: "Dismiss",
    unplacedOne: "The workstream “{{board}}” has no local repository on this machine ({{repo}}), so its tickets cannot start here.",
    unplacedMany: "{{n}} workstreams have no local repository on this machine: {{list}}. Their tickets cannot start here.",
    unplacedFix: "Set local repository…",
    nothingToUndo: "Nothing left to undo",
    nothingToRedo: "Nothing left to redo",
    undoing: "Undoing…",
    redoing: "Redoing…",
    undoingLong: "Still undoing — the files store is putting things back. Repeated [[cmd:undo]] presses are ignored until it is done.",
    redoingLong: "Still redoing — the files store is applying the change again. Repeated presses are ignored until it is done.",
    untitledView: "View {{n}}",
    createdViewToast: "Created view {{name}}"
  },
  zh: {
    itemsReadFailed: "没能读取这个项目的工单——不是待办为空，而是没加载出来。",
    conflictBanner: "「{{title}}」出现版本冲突。有智能体在此视图打开期间写入了它——视图已重新拉取，请重试这次移动。",
    dismiss: "关闭",
    unplacedOne: "工作流「{{board}}」的仓库 {{repo}} 在这台电脑上没有关联本地目录，它的工单在这里无法启动。",
    unplacedMany: "{{n}} 个工作流的仓库在这台电脑上没有关联本地目录：{{list}}。它们的工单在这里无法启动。",
    unplacedFix: "指定本地仓库…",
    nothingToUndo: "没有可撤销的操作了",
    nothingToRedo: "没有可重做的操作了",
    undoing: "撤销中…",
    redoing: "重做中…",
    undoingLong: "仍在撤销 — 文件存储正在恢复内容。完成前重复按 [[cmd:undo]] 会被忽略。",
    redoingLong: "仍在重做 — 文件存储正在重新应用改动。完成前重复按键会被忽略。",
    untitledView: "视图 {{n}}",
    createdViewToast: "已创建视图 {{name}}"
  }
};
