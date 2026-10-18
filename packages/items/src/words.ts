import { defineWords } from "@tomradex/domain";

export const ITEMS_WORDS = defineWords("items", {
  en: {
    reviewAccept: "Accept",
    reviewSendBack: "Send back",
    reviewConfirm: "The agent will record your verdict on {{key}}'s delivery: {{verdict}}. On your words: “{{userSaid}}”",
    cancel: "Cancel"
  },
  zh: {
    reviewAccept: "验收通过",
    reviewSendBack: "退回修改",
    reviewConfirm: "智能体要替你记下对 {{key}} 交付的结论：{{verdict}}。依据你说的：“{{userSaid}}”",
    cancel: "取消"
  }
});
