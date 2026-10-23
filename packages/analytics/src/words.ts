import { defineWords } from "@tomradex/domain";

/** The analytics settings card and the words the app's own surfaces use. */
export const ANALYTICS_WORDS = defineWords("analytics", {
  en: {
    title: "Data & privacy",
    description: "Feature usage counts and active time, a random identifier, app/platform and format versions, and a broad region. No project or ticket content, notes, chats, code, file names, paths, email or account IDs.",
    enabledTitle: "Anonymous usage statistics",
    enabledDescription: "You can turn this off at any time: collection and uploads stop, unsent events are cleared and the local identity secret is deleted. The secret stays on this machine; a derived anonymous identifier is sent and changes every 365 days.",
    identifierTitle: "Anonymous identifier",
    identifierDescription: "The identifier the cloud sees. It is not an account and cannot be used to sign in. Say this id if you want its data deleted."
  },
  zh: {
    title: "数据与隐私",
    description: "统计功能使用次数与有效时长、随机标识、应用/系统类别与格式版本，以及粗粒度地区。不含项目或工单内容、笔记、聊天、代码、文件名、路径、邮箱或账号 ID。",
    enabledTitle: "匿名使用统计",
    enabledDescription: "可随时关闭：停止采集和上报，清空待发事件并删除本地身份密钥。密钥留在本机，派生的匿名标识会随事件发送，每 365 天变化一次。",
    identifierTitle: "匿名标识",
    identifierDescription: "云端看到的标识。它不是账号，不能用于登录。如需删除该标识对应的数据，请提供这个标识。"
  }
});
