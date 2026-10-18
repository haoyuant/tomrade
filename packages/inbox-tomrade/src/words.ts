import { defineWords } from "@tomradex/domain";

export const FEEDBACK_WORDS = defineWords("inbox-tomrade", {
  en: {
    source: "Tomrade feedback",
    signIn: "Sign in to your Tomrade account first",
    notMaintainer: "Only Tomrade's maintainers receive this feedback",
    status: "Feedback",
    statusTitle: "Tell Tomrade's developer about a bug, or send feedback or an idea",
    command: "Send feedback…",
    group: "Help",
    from: "Tomrade {{version}} · {{platform}}"
  },
  zh: {
    source: "Tomrade 反馈",
    signIn: "先登录 Tomrade 账号",
    notMaintainer: "只有 Tomrade 的维护者能收到这些反馈",
    status: "反馈",
    statusTitle: "告诉 Tomrade 的开发者一个问题，或者提反馈、建议",
    command: "发送反馈…",
    group: "帮助",
    from: "Tomrade {{version}} · {{platform}}"
  }
});
