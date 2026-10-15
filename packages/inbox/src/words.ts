export type Locale = "en" | "zh";

export const WORDS = {
  en: {
    module: "Inbox",
    sourceField: "Source",
    kindField: "Kind",
    kinds: { bug: "Bug", feedback: "Feedback", idea: "Idea" },
    view: "From feedback",
    section: "Feedback",
    sectionText: (n: number) => (n === 1 ? "Came in once." : `Came in ${n} times.`),
    received: "Received",
    quoted: (source: string, when: string) => `From ${source}, ${when}`,
    reporter: "Reported by",
    notConfigured: "This source is not set up here",
    noReply: (source: string) => `${source} takes no replies`
  },
  zh: {
    module: "收件箱",
    sourceField: "来源",
    kindField: "类型",
    kinds: { bug: "缺陷", feedback: "反馈", idea: "建议" },
    view: "用户反馈来的",
    section: "反馈",
    sectionText: (n: number) => `共收到 ${n} 份。`,
    received: "收到",
    quoted: (source: string, when: string) => `来自 ${source}，${when}`,
    reporter: "反馈人",
    notConfigured: "这个来源在这里还没设置好",
    noReply: (source: string) => `${source} 不能回复`
  }
} satisfies Record<Locale, unknown>;

export type Words = (typeof WORDS)["en"];
