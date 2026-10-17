import { defineWords } from "@tomradex/domain";

export const PI_WORDS = defineWords({
  en: {
    title: "Built-in agent",
    refusedPick: 'The built-in agent cannot run on "{{name}}": it does not call tools itself',
    notBundled: "This build has no built-in agent — run `pnpm --filter @tomrade/desktop fetch:pi`",
    noMcp: "The MCP server is not running — enable the mcp plugin",
    noToolModels: "The connected models cannot call tools themselves — the built-in agent needs one that can",
    connectModel: "Connect a model — the built-in agent runs on it",
    doesNotStart: "The built-in agent does not start: {{detail}}"
  },
  zh: {
    title: "内置智能体",
    refusedPick: "内置智能体不能用“{{name}}”：它不能自己调用工具",
    notBundled: "这个版本没有内置智能体——运行 `pnpm --filter @tomrade/desktop fetch:pi`",
    noMcp: "MCP 服务没有运行——请启用 mcp 插件",
    noToolModels: "已连接的模型不能自己调用工具，内置智能体需要一个能调用工具的模型",
    connectModel: "先连接一个模型——内置智能体用它工作",
    doesNotStart: "内置智能体启动失败：{{detail}}"
  }
});
