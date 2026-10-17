export const errors = {
  en: {
    conflict: "This was changed somewhere else while you were working on it. Check the latest version, then try again.",
    humanLocked: "A person has locked this ticket; only a person can change it.",
    notFound: "That is no longer here — it may have been deleted somewhere else.",
    inUse: "That is still in use. Move or remove what depends on it first, then try again.",
    cycle: "That would make the dependencies loop back on themselves: {{path}}"
  },
  zh: {
    conflict: "你操作期间，它在别处被改过了。请看一下最新内容，再试一次。",
    humanLocked: "这张工单已被人锁定，只有人可以修改。",
    notFound: "它已经不在了，可能已在别处被删除。",
    inUse: "它仍在被使用。请先移走或删除依赖它的内容，再试一次。",
    cycle: "这样会让依赖关系首尾相连，形成循环：{{path}}"
  }
};
