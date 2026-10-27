import { defineWords } from "@tomradex/domain";

export const ITEMS_WORDS = defineWords("items", {
  en: {
    reviewAccept: "Accept",
    reviewSendBack: "Send back",
    reviewConfirm: "The agent will record your verdict on {{key}}'s delivery: {{verdict}}. On your words: “{{userSaid}}”",
    cancel: "Cancel",
    closedWindowTitle: "Done and cancelled columns",
    closedWindowDescription: "Per project: how many done and cancelled tickets a board loads at first. Older ones load on request and stay reachable by search and by key."
  },
  zh: {
    reviewAccept: "验收通过",
    reviewSendBack: "退回修改",
    reviewConfirm: "智能体要替你记下对 {{key}} 交付的结论：{{verdict}}。依据你说的：“{{userSaid}}”",
    cancel: "取消",
    closedWindowTitle: "已完成与已取消列",
    closedWindowDescription: "按项目设置：看板一开始加载多少张已完成、已取消的工单。更早的按需加载，搜索和按 key 仍能找到。"
  }
});
