import { defineWords } from "@tomradex/domain";

export const PI_WORDS = defineWords("engine-pi", {
  en: {
    title: "Built-in agent",
    refusedPick: 'The built-in agent cannot run on "{{name}}": it does not call tools itself',
    foreignPick: 'The built-in agent cannot run on "{{name}}": its provider speaks an API the agent does not',
    foreignModels: "The connected models' providers speak APIs the built-in agent does not — it runs on OpenAI-compatible, Anthropic and Gemini models, and on provider plugins that say their endpoint speaks one of those",
    notBundled: "This build has no built-in agent — run `pnpm --filter @tomrade/desktop fetch:pi`",
    noMcp: "The MCP server is not running — enable the mcp plugin",
    noToolModels: "The connected models cannot call tools themselves — the built-in agent needs one that can",
    connectModel: "Connect a model — the built-in agent runs on it",
    testModel: 'Test the model "{{name}}" in Settings → Assistant first — the built-in agent only runs a model that answered its test',
    testFailed: 'The model "{{name}}" did not pass its test: {{detail}}',
    doesNotStart: "The built-in agent does not start: {{detail}}",
    connectModelInSettings: "Connect a model in Settings → Assistant — the built-in agent runs on it",
    reportedError: "Pi reported an error",
    notStarted: "Pi did not start the turn ({{disposition}})"
  },
  zh: {
    title: "内置智能体",
    refusedPick: "内置智能体不能用“{{name}}”：它不能自己调用工具",
    foreignPick: "内置智能体不能用“{{name}}”：它的服务商用的接口内置智能体不支持",
    foreignModels: "已连接模型的服务商用的接口内置智能体都不支持——它能用兼容 OpenAI、Anthropic 和 Gemini 的模型，以及声明了自己用其中一种接口的服务商插件",
    notBundled: "这个版本没有内置智能体——运行 `pnpm --filter @tomrade/desktop fetch:pi`",
    noMcp: "MCP 服务没有运行——请启用 mcp 插件",
    noToolModels: "已连接的模型不能自己调用工具，内置智能体需要一个能调用工具的模型",
    connectModel: "先连接一个模型——内置智能体用它工作",
    testModel: "请先在 设置 → 助手 里测试“{{name}}”——内置智能体只用一个通过测试的模型",
    testFailed: "“{{name}}”没有通过测试：{{detail}}",
    doesNotStart: "内置智能体启动失败：{{detail}}",
    connectModelInSettings: "请在 设置 → 助手 中连接一个模型——内置智能体用它工作",
    reportedError: "Pi 报告了一个错误",
    notStarted: "Pi 没有开始这一轮（{{disposition}}）"
  }
});
