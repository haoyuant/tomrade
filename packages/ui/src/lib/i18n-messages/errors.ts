export const errors = {
  en: {
    conflict: "This was changed somewhere else while you were working on it. Check the latest version, then try again.",
    humanLocked: "A person has locked this ticket; only a person can change it.",
    notFound: "That is no longer here — it may have been deleted somewhere else.",
    // The backend's own reason already reads well in English and says what to do.
    inUse: "{{reason}}",
    inUseWorkstreamHolds: "{{reason}}",
    inUseLastWorkstream: "{{reason}}",
    inUseLastView: "{{reason}}",
    inUseUndoHolds: "{{reason}}",
    inUseRepository: "{{reason}}",
    cycle: "That would make the dependencies loop back on themselves: {{path}}",
    unpublishedEdits: "This machine has edits the folder does not hold yet ({{reason}}). The cache was kept so they are not lost — sync first, then rebuild."
  },
  zh: {
    conflict: "你操作期间，它在别处被改过了。请看一下最新内容，再试一次。",
    humanLocked: "这张工单已被人锁定，只有人可以修改。",
    notFound: "它已经不在了，可能已在别处被删除。",
    inUse: "它仍在被使用：{{reason}}",
    inUseWorkstreamHolds: "工作流「{{name}}」里还有 {{count}} 个工作项——请先把它们移走。",
    inUseLastWorkstream: "「{{name}}」是这个项目的最后一个工作流，新的工作项需要有地方放。",
    inUseLastView: "「{{name}}」是这个项目的最后一个视图。",
    inUseUndoHolds: "这个工作流现在有 {{count}} 个工作项——请先把它们移走，再撤销。",
    inUseRepository: "「{{name}}」仍是 {{count}} 个工作流的代码仓库。",
    cycle: "这样会让依赖关系首尾相连，形成循环：{{path}}",
    unpublishedEdits: "本机还有文件夹里没有的编辑（{{reason}}）。缓存已保留，编辑不会丢失——请先同步，再重建。"
  }
};
