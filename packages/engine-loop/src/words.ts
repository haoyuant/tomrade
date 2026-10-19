import { defineWords } from "@tomradex/domain";

/** What the engine itself says in the conversation. */
export const LOOP_WORDS = defineWords("engine-loop", {
  en: {
    holding: "No model is connected, so {{engine}} is holding this conversation.",
    retryWithoutThinking: "The model used its whole output allowance thinking. Trying again without extended thinking.",
    keptGoing: "A plugin asked the assistant to keep going before it finishes.",
    nativeSearchRefused: "The model's own web search was turned down here, so for the rest of this turn web search goes through Tomrade's web search plugin.",
    imageRefused: "The model turned down making images itself here, so for the rest of this turn it is not asked to again.",
    audioRefused: "The model turned down speaking itself here, so for the rest of this turn it is not asked to again.",
    noImageMaker: "None of your models can make images. To get pictures, add a model profile with the OpenAI Images API in Settings → Assistant.",
    noAudioMaker: "None of your models can speak. To hear replies, add a model profile whose model can produce audio in Settings → Assistant.",
    mediaRefused: "This model cannot read {{kinds}}, so this turn went on without them, and they will not be sent to it again.",
    kind_image: "images",
    kind_pdf: "PDFs",
    kind_audio: "audio",
    kind_video: "video",
    kindJoin: " or ",
    outputLimitMidAnswer: "The model reached its output limit ({{max}} tokens) mid-answer. Ask for something smaller, or pick a lower effort for this thread.",
    outputLimitBeforeAnswer: "The model reached its output limit ({{max}} tokens) before answering. Ask for something smaller, or pick a lower effort for this thread."
  },
  zh: {
    holding: "还没有可用的模型，这段对话由 {{engine}} 接手。",
    retryWithoutThinking: "模型把整个输出额度都用在了思考上，换成不深度思考再试一次。",
    keptGoing: "有插件要求助手先继续，再结束这一轮。",
    nativeSearchRefused: "模型自带的联网搜索在这里被拒绝了，本轮剩下的联网搜索改由 Tomrade 的联网搜索插件来做。",
    imageRefused: "模型在这里拒绝了自己生成图片，本轮剩下的时间里不再让它生成。",
    audioRefused: "模型在这里拒绝了自己生成语音，本轮剩下的时间里不再让它生成。",
    noImageMaker: "你的模型都不能生成图片。想要图片，请在 设置 → 助手 里添加一个使用 OpenAI 图像接口的模型配置。",
    noAudioMaker: "你的模型都不能生成语音。想听语音回复，请在 设置 → 助手 里添加一个能输出音频的模型配置。",
    mediaRefused: "这个模型读不了{{kinds}}，本轮已去掉它们继续，以后也不会再发给它。",
    kind_image: "图片",
    kind_pdf: "PDF",
    kind_audio: "音频",
    kind_video: "视频",
    kindJoin: "和",
    outputLimitMidAnswer: "模型在回答到一半时就到了输出上限（{{max}} 个 token）。换个小一点的请求，或者给这个对话选低一点的推理强度。",
    outputLimitBeforeAnswer: "模型在开始回答前就到了输出上限（{{max}} 个 token）。换个小一点的请求，或者给这个对话选低一点的推理强度。"
  }
});
