import { defineWords } from "@tomradex/domain";

export const INBOX_WORDS = defineWords("inbox", {
  en: {
    module: "Inbox",
    sourceField: "Source",
    kindField: "Kind",
    kindBug: "Bug",
    kindFeedback: "Feedback",
    kindIdea: "Idea",
    view: "From feedback",
    /** The derived column counting a ticket's feedback. */
    feedbackField: "Feedback",
    section: "Feedback",
    sectionOnce: "Came in once.",
    sectionTimes: "Came in {{n}} times.",
    received: "Received",
    quoted: "From {{source}}, {{when}}",
    reporter: "Reported by",
    notConfigured: "This source is not set up here",
    noReply: "{{source}} takes no replies",
    noTriager: "Nothing here suggests triage",
    noSuggestion: "There is no suggestion to confirm yet"
  },
  zh: {
    module: "收件箱",
    sourceField: "来源",
    kindField: "类型",
    kindBug: "缺陷",
    kindFeedback: "反馈",
    kindIdea: "建议",
    view: "用户反馈来的",
    feedbackField: "反馈数",
    section: "反馈",
    sectionOnce: "共收到 1 份。",
    sectionTimes: "共收到 {{n}} 份。",
    received: "收到",
    quoted: "来自 {{source}}，{{when}}",
    reporter: "反馈人",
    notConfigured: "这个来源在这里还没设置好",
    noReply: "{{source}} 不能回复",
    noTriager: "这里没有能给分诊建议的插件",
    noSuggestion: "还没有可以确认的建议"
  }
});

export type InboxWords = ReturnType<typeof INBOX_WORDS>;
