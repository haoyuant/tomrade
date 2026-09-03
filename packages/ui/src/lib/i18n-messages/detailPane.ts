export const detailPane = {
  en: {
    fieldStatus: "Status",
    fieldPriority: "Priority",
    fieldEpic: "Epic",
    fieldLabelsCol: "Labels",
    fieldBlockedBy: "Blocked by",
    fieldBlocks: "Blocks",
    fieldBoard: "Workstream",
    fieldVersion: "Version",
    fieldLastWrite: "Last write",
    versionWord: "version",

    lockedNoticeStrong: "human-locked",
    lockedNotice:
      "Title and body are {{strong}}. Agents can still read this issue and change its status, but a write to the locked fields is rejected with a typed error rather than merged.",

    activityHeading: "Activity · append-only oplog",
    noWritesYet: "No writes recorded yet.",
    ledgerFooter: "Every row above is reversible. {{cmdz}} walks the oplog backwards, newest first.",

    collapseTitle: "Collapse",
    expandTitle: "Expand",
    collapseDetailAria: "Collapse detail",
    expandDetailAria: "Expand detail",
    closeDetailAria: "Close detail"
  },
  zh: {
    fieldStatus: "状态",
    fieldPriority: "优先级",
    fieldEpic: "需求组",
    fieldLabelsCol: "标签",
    fieldBlockedBy: "依赖",
    fieldBlocks: "阻塞",
    fieldBoard: "工作流",
    fieldVersion: "版本",
    fieldLastWrite: "最后写入",
    versionWord: "版本",

    lockedNoticeStrong: "锁定",
    lockedNotice: "标题与描述已{{strong}}。智能体仍可读取该工作项并修改其状态，但对已锁定字段的写入会被以类型化错误拒绝，而不会被合并。",

    activityHeading: "活动 · 仅追加的操作日志",
    noWritesYet: "尚无任何写入记录。",
    ledgerFooter: "以上每一行都可撤销。{{cmdz}} 会按时间从新到旧依次撤销操作日志。",

    collapseTitle: "折叠",
    expandTitle: "展开",
    collapseDetailAria: "折叠详情面板",
    expandDetailAria: "展开详情面板",
    closeDetailAria: "关闭详情面板"
  }
};
