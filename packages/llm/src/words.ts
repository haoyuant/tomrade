import { defineWords } from "@tomradex/domain";

export const LLM_WORDS = defineWords({
  en: {
    noProfile: "No model profile configured — add one in Settings → Assistant",
    noApiKey: "Profile \"{{profile}}\" has no API key",
    workerUnavailable: "The worker is set to {{name}}, which cannot answer right now — sign it in, or pick another in Settings → Assistant"
  },
  zh: {
    noProfile: "还没有配置模型——去 设置 → 助手 里添加一个",
    noApiKey: "配置“{{profile}}”没有 API Key",
    workerUnavailable: "执行模型选的是 {{name}}，但它现在用不了——先登录它，或在 设置 → 助手 里换一个"
  }
});
