import { defineWords } from "@tomradex/domain";

/** The Tavily settings card. The name and the key's title read the same in both languages. */
export const TAVILY_WORDS = defineWords("web-search-tavily", {
  en: {
    title: "Tavily",
    description:
      "Web search and page reading for the assistant when its model does not search the web on its own (one that does needs no key), through Tavily with your own API key from app.tavily.com. A search costs 1 credit (2 at advanced depth); reading pages costs 1 credit per 5. The key stays on this machine and no agent can read it.",
    apiKeyTitle: "API key",
    apiKeyDescription: "tvly-… — empty uses TAVILY_API_KEY from the environment",
    searchDepthTitle: "Search depth",
    searchDepthDescription: "advanced: more relevant excerpts per result, at twice the credits",
    searchDepthBasic: "Basic",
    searchDepthAdvanced: "Advanced"
  },
  zh: {
    title: "Tavily",
    description: "模型不自带联网搜索时，通过 Tavily 为助手提供网页搜索和网页阅读（自带联网搜索的模型不需要 key），使用你在 app.tavily.com 申请的 API key。一次搜索消耗 1 积分（高级深度为 2）；每读取 5 个网页消耗 1 积分。key 只保存在这台机器上，任何智能体都读不到。",
    apiKeyTitle: "API key",
    apiKeyDescription: "tvly-…；留空则使用环境变量 TAVILY_API_KEY",
    searchDepthTitle: "搜索深度",
    searchDepthDescription: "高级：每条结果给出更相关的摘录，消耗的积分翻倍",
    searchDepthBasic: "基础",
    searchDepthAdvanced: "高级"
  }
});
