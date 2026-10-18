import { defineWords } from "@tomradex/domain";

export const BACKLOG_WORDS = defineWords({
  en: {
    planAsk: "This plan writes {{writes}} (1 root epic, {{epics}}, {{tickets}}). Write it to the backlog?",
    item: "{{n}} item",
    items: "{{n}} items",
    epic: "{{n}} epic",
    epics: "{{n}} epics",
    ticket: "{{n}} ticket",
    tickets: "{{n}} tickets",
    planApply: "Apply",
    planCancel: "Cancel",
    checkingDependencies: "Checking dependencies…",
    dependenciesIntro: "These changes affect dependencies between tickets (A → B: B waits for A). Suggested:",
    dependencyReason: " — {{reason}}",
    dependenciesQuestion: "Update them now?",
    dependenciesApply: "Update now",
    dependenciesSkip: "Not now",
    dependenciesUpdated: "Dependencies updated: {{added}} added, {{removed}} removed.",
    dependenciesNotUpdated: " Not updated: {{failed}}"
  },
  zh: {
    planAsk: "这份计划会写入 {{writes}}（1 个总 epic、{{epics}}、{{tickets}}）。写入 backlog 吗？",
    item: "{{n}} 项",
    items: "{{n}} 项",
    epic: "{{n}} 个 epic",
    epics: "{{n}} 个 epic",
    ticket: "{{n}} 张工单",
    tickets: "{{n}} 张工单",
    planApply: "写入",
    planCancel: "取消",
    checkingDependencies: "正在检查依赖…",
    dependenciesIntro: "刚才的改动影响到工单之间的依赖（A → B：B 要等 A 完成）。建议：",
    dependencyReason: "：{{reason}}",
    dependenciesQuestion: "现在更新吗？",
    dependenciesApply: "现在更新",
    dependenciesSkip: "暂不",
    dependenciesUpdated: "依赖已更新：新增 {{added}} 条，移除 {{removed}} 条。",
    dependenciesNotUpdated: "未能更新：{{failed}}"
  }
});
