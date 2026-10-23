import { defineWords } from "@tomradex/domain";

/** The analytics settings card and the words the app's own surfaces use. */
export const ANALYTICS_WORDS = defineWords("analytics", {
  en: {
    title: "Data & privacy",
    description: "Anonymous feature usage — how often each feature is used and for how long. Never project content, file names, paths or anything that identifies a person.",
    enabledTitle: "Anonymous usage statistics",
    enabledDescription: "Count feature use and its duration. The identifier is random, kept on this machine, and rotates every 12 months. Turning this off stops collection, clears what has not been sent and deletes the identifier.",
    identifierTitle: "Anonymous identifier",
    identifierDescription: "The identifier the cloud sees. It is not an account and cannot be used to sign in. Say this id if you want its data deleted."
  },
  zh: {
    title: "数据与隐私",
    description: "匿名的功能使用情况：每个功能用了多少次、用了多久。绝不包含项目内容、文件名、路径或任何能识别个人的信息。",
    enabledTitle: "匿名使用统计",
    enabledDescription: "统计功能的使用次数与时长。标识是随机生成的，只保存在这台机器上，每 12 个月轮换一次。关闭后会立即停止采集、清空尚未上报的数据并删除标识。",
    identifierTitle: "匿名标识",
    identifierDescription: "云端看到的标识。它不是账号，不能用于登录。如需删除该标识对应的数据，请提供这个标识。"
  }
});
