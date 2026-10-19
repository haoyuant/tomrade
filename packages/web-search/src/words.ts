import { defineWords } from "@tomradex/domain";

/** The card a conversation gets when it cannot search the web. */
export const WEB_SEARCH_WORDS = defineWords("web-search", {
  en: {
    unavailableHeadline: "Web search is unavailable",
    unavailableBody: "This model does not search the web on its own, and no web search API key is set up. Switch to a model that supports web search, or set up a web search key.",
    switchModel: "Switch model",
    setUpSearch: "Set up web search"
  },
  zh: {
    unavailableHeadline: "联网搜索用不了",
    unavailableBody: "这个模型不自带联网搜索，也还没有配置联网搜索的 API key。换一个支持联网搜索的模型，或者配置一个联网搜索 key。",
    switchModel: "换模型",
    setUpSearch: "设置联网搜索"
  }
});
