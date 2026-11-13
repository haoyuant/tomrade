import { defineWords } from "@tomradex/domain";

export const ROLES_WORDS = defineWords("roles", {
  en: {
    implementer: "Implementer",
    reviewer: "Reviewer",
    needsTitle: "A role needs a name.",
    titleTaken: "Another role is already called {{title}}.",
    unknownRole: "This project has no role {{id}}.",
    stageFixed: "{{title}} is built in: its stage cannot change.",
    badEngine: "{{engine}} is not the id of a coding agent."
  },
  zh: {
    implementer: "实现者",
    reviewer: "审查者",
    needsTitle: "角色需要一个名称。",
    titleTaken: "已经有一个叫「{{title}}」的角色。",
    unknownRole: "这个项目没有角色 {{id}}。",
    stageFixed: "「{{title}}」是内置角色，不能改变它的阶段。",
    badEngine: "{{engine}} 不是一个编码 Agent 的 id。"
  }
});
