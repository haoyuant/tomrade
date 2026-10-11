export const playbooks = {
  en: {
    conflictBody: "Playbook “{{title}}” has more than one version — using {{source}}.",
    keepCurrent: "Keep",
    useSource: "Use {{source}}",
    sourcePlugin: "the built-in version",
    sourceUser: "your version (this machine)",
    sourceProject: "the project's version",

    settingsTitle: "Playbooks",
    settingsLede:
      "Methodology the assistant follows for multi-step jobs. Plugins ship some; your own live as SKILL.md folders and may reuse an id to replace a built-in one — when versions collide, pick which wins.",
    settingsEmpty: "No playbooks registered.",
    versionLabel: "Version in effect",
    tagPlugin: "built-in",
    tagUser: "yours",
    tagProject: "project",
    methodAssistWhen: "Plans, carries out or keeps track of the work — including the steps you do yourself.",
    methodDesignWhen: "Explores options and delivers a design from the ticket's audience, constraints and references.",
    methodDocumentWhen: "Writes or revises a document — the ticket's deliverable, or a note kept in Files.",
    methodMediaWhen: "Makes music, animation or other media with a generation service you have set up."
  },
  zh: {
    conflictBody: "Playbook“{{title}}”存在多个版本——当前使用{{source}}。",
    keepCurrent: "保持",
    useSource: "改用{{source}}",
    sourcePlugin: "内置版本",
    sourceUser: "你的版本（本机）",
    sourceProject: "项目内版本",

    settingsTitle: "Playbook",
    settingsLede: "助手在多步骤任务中遵循的方法论。插件会自带一些；你自己的以 SKILL.md 文件夹存在，可以沿用同一 id 覆盖内置版——版本冲突时由你决定谁生效。",
    settingsEmpty: "尚未注册任何 playbook。",
    versionLabel: "生效版本",
    tagPlugin: "内置",
    tagUser: "本机",
    tagProject: "项目",
    methodAssistWhen: "规划、执行或跟进这项工作，包括需要你亲自去做的部分。",
    methodDesignWhen: "根据工作项里的受众、约束和参考资料，探索方案并交付设计。",
    methodDocumentWhen: "撰写或修改文档——可以是工作项的交付物，也可以是存放在 Files 里的笔记。",
    methodMediaWhen: "用你已经配置的生成服务制作音乐、动画等媒体。"
  }
};
