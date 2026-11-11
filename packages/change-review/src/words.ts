import { defineWords } from "@tomradex/domain";

export const CHANGE_REVIEW_WORDS = defineWords("change-review", {
  en: {
    emptyComment: "A comment needs some words.",
    sendFailed: "The comments did not reach {{agent}}: {{why}}",
    paneRefused: "{{agent}}'s terminal did not take the comments, so nothing was sent."
  },
  zh: {
    emptyComment: "评论不能为空。",
    sendFailed: "评论没有送到 {{agent}}：{{why}}",
    paneRefused: "{{agent}} 的终端没有接收评论，所以什么都没发出。"
  }
});
