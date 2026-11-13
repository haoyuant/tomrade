import { defineWords } from "@tomradex/domain";

export const DISPATCH_WORDS = defineWords("dispatch", {
  en: {
    sectionTitle: "Work from my other devices",
    sectionDescription: "Whether this computer takes tickets sent from the other computers signed in to your account, and within which limits. Taking one means an agent runs here and changes code here. Off unless you turn it on.",
    acceptTitle: "Accept work from my other devices",
    acceptDescription: "Lets your other computers start an agent on this one.",
    allProjectsTitle: "For every project",
    projectsTitle: "Only these projects",
    ceilingTitle: "Most a sent session may do without asking",
    maxConcurrentTitle: "Sessions at once",
    onlyWhenIdleTitle: "Only while this computer is idle",
    onlyOnPowerTitle: "Only while plugged in",
    askSend: "Send {{key}} “{{title}}” to {{where}}? A coding agent starts on it there, with that computer's own sign-in and within the limits that computer set.",
    anyPlatform: "any {{platform}} computer",
    askYes: "Send",
    askNo: "Don't send",
    askedHere: "{{who}} asks to run {{key}} “{{title}}” on this computer. It waits for your yes."
  },
  zh: {
    sectionTitle: "来自我其他设备的工作",
    sectionDescription: "这台电脑是否接受登录了你账号的其他电脑派来的工单，以及在什么范围内接受。接单意味着 agent 会在这台电脑上运行并修改代码。默认关闭。",
    acceptTitle: "接受我其他设备派来的工作",
    acceptDescription: "允许你的其他电脑在这台电脑上启动 agent。",
    allProjectsTitle: "所有项目",
    projectsTitle: "仅这些项目",
    ceilingTitle: "派来的会话不经询问最多能做什么",
    maxConcurrentTitle: "同时进行的会话数",
    onlyWhenIdleTitle: "仅在这台电脑空闲时",
    onlyOnPowerTitle: "仅在接通电源时",
    askSend: "把 {{key}}「{{title}}」派给{{where}}？那台电脑会用它自己的登录、在它设定的限制内启动 coding agent 开工。",
    anyPlatform: "任意一台 {{platform}} 电脑",
    askYes: "派过去",
    askNo: "不派",
    askedHere: "{{who}} 请求在这台电脑上运行 {{key}}「{{title}}」，等你同意。"
  }
});
