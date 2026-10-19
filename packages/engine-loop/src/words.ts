import { defineWords } from "@tomradex/domain";

/** What the engine itself says in the conversation. */
export const LOOP_WORDS = defineWords("engine-loop", {
  en: {
    holding: "No model is connected, so {{engine}} is holding this conversation.",
    retryWithoutThinking: "The model used its whole output allowance thinking. Trying again without extended thinking.",
    nativeSearchRefused: "The model's own web search was turned down here, so for the rest of this turn web search goes through Tomrade's web search plugin.",
    outputLimitMidAnswer: "The model reached its output limit ({{max}} tokens) mid-answer. Ask for something smaller, or pick a lower effort for this thread.",
    outputLimitBeforeAnswer: "The model reached its output limit ({{max}} tokens) before answering. Ask for something smaller, or pick a lower effort for this thread."
  },
  zh: {
    holding: "还没有可用的模型，这段对话由 {{engine}} 接手。",
    retryWithoutThinking: "模型把整个输出额度都用在了思考上，换成不深度思考再试一次。",
    nativeSearchRefused: "模型自带的联网搜索在这里被拒绝了，本轮剩下的联网搜索改由 Tomrade 的联网搜索插件来做。",
    outputLimitMidAnswer: "模型在回答到一半时就到了输出上限（{{max}} 个 token）。换个小一点的请求，或者给这个对话选低一点的推理强度。",
    outputLimitBeforeAnswer: "模型在开始回答前就到了输出上限（{{max}} 个 token）。换个小一点的请求，或者给这个对话选低一点的推理强度。"
  }
});
