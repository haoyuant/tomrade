export const deleteIssueDialog = {
  en: {
    activityTrail: "its whole activity trail — every oplog row this issue ever wrote",
    labelLinkOne: "{{n}} label link",
    labelLinkMany: "{{n}} label links",
    blocksRelationOne: "{{n}} blocks relation, cut in both directions",
    blocksRelationMany: "{{n}} blocks relations, cut in both directions",
    manualOrder: "its place in every saved view's manual order",

    dialogLabelWithKey: "Delete {{key}} permanently",
    dialogLabelEmpty: "Delete issue",
    headTitle: "Delete permanently",

    notUndoable: "This is {{strong}}. Every other write in Tomrade can be walked back with {{cmdz}}, because the oplog keeps a snapshot — this one deletes that history too, so there is nothing left to restore from.",
    notUndoableStrong: "not undoable",
    alsoTakes: "Deleting {{key}} also takes:",
    childrenNoteOne: "{{n}} issue sits under it. It is released to “No epic”, not deleted — and that reparenting is not undoable either.",
    childrenNoteMany: "{{n}} issues sit under it. They are released to “No epic”, not deleted — and that reparenting is not undoable either.",
    keyRetired: "The key {{key}} is retired with it — the project counter never rewinds, so nothing is ever handed that number again.",

    cancel: "Cancel",
    deleting: "Deleting…",
    deleteForever: "Delete {{key}} forever",
    alsoDeleteAttachments: "Also delete its {{n}} attached files — Files keeps them in its history",

    deletedToast: "Permanently deleted {{key}} — {{cmdz}} cannot bring it back",
    conflictToast: "An agent rewrote {{key}} while this was open — it re-read, so check it still deserves deleting."
  },
  zh: {
    activityTrail: "它的整条活动记录——这个工作项写下的每一条操作日志",
    labelLinkOne: "{{n}} 个标签关联",
    labelLinkMany: "{{n}} 个标签关联",
    blocksRelationOne: "{{n}} 个阻塞关系（两个方向都会一并切断）",
    blocksRelationMany: "{{n}} 个阻塞关系（两个方向都会一并切断）",
    manualOrder: "它在每个已保存视图手动排序中的位置",

    dialogLabelWithKey: "永久删除 {{key}}",
    dialogLabelEmpty: "删除工作项",
    headTitle: "永久删除",

    notUndoable: "这个操作{{strong}}。Tomrade 中其他所有写入都可以用 {{cmdz}} 撤回，因为操作日志保留着快照——唯独这一次会连同历史一起删除，所以之后没有任何东西可以恢复。",
    notUndoableStrong: "不可撤销",
    alsoTakes: "删除 {{key}} 还会一并带走：",
    childrenNoteOne: "有 {{n}} 个工作项挂在它下面。它会被释放为「无需求组」，而不是被删除——但这次重新归属同样不可撤销。",
    childrenNoteMany: "有 {{n}} 个工作项挂在它下面。它们会被释放为「无需求组」，而不是被删除——但这次重新归属同样不可撤销。",
    keyRetired: "编号 {{key}} 会随之退役——项目计数器不会回退，这个编号不会再分配给任何工作项。",

    cancel: "取消",
    deleting: "正在删除…",
    deleteForever: "永久删除 {{key}}",
    alsoDeleteAttachments: "同时删除它的 {{n}} 个附件（Files 的历史中仍可恢复）",

    deletedToast: "已永久删除 {{key}} —— {{cmdz}} 无法找回它",
    conflictToast: "此对话框打开期间，有智能体重写了 {{key}}——内容已重新读取，请确认它是否仍需要删除。"
  }
};
