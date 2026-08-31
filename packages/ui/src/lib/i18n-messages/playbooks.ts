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
    tagProject: "project"
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
    tagProject: "项目"
  }
};
