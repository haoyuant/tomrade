export const projectRules = {
  en: {
    label: "Rules",
    lede: "How every agent in this project should work — the assistant, coding agents in Tomrade, and agents you start in a terminal. One short line each. A repository's CLAUDE.md or AGENTS.md still decides how its code is written.",
    placeholder: "- Write tickets in Chinese\n- Never touch the billing module without asking\n- Prefer small pull requests",
    count: "{{n}} / {{max}} characters",
    save: "Save rules",
    revert: "Revert",
    saved: "Rules saved — every new turn follows them.",
    where: "Kept in {{file}}, so they travel with the project's folder.",
    proposeNote: "When you correct an agent in a way that should always hold, it may offer to add a rule here; nothing is added without your yes."
  },
  zh: {
    label: "规则",
    lede: "这个项目里所有智能体的做事方式：助手、Tomrade 里的编码代理，以及你在终端里启动的代理。每条一句话。代码怎么写，仍以仓库里的 CLAUDE.md 或 AGENTS.md 为准。",
    placeholder: "- 工单用中文写\n- 没问过我之前不要动计费模块\n- PR 尽量小",
    count: "{{n}} / {{max}} 字符",
    save: "保存规则",
    revert: "还原",
    saved: "规则已保存，之后的每一轮都会遵守。",
    where: "保存在 {{file}}，随项目文件夹一起同步。",
    proposeNote: "你纠正智能体、而这条纠正应当一直有效时，它可能会提议把它加到这里；没有你的同意，什么都不会加入。"
  }
};
