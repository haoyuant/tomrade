import { defineWords } from "@tomradex/domain";

export const MCP_WORDS = defineWords("mcp", {
  en: {
    portClash: "MCP on {{port}} · {{clashPort}} held by {{holder}}",
    portClashTitle: "Agents configured for the usual port reach the other Tomrade and its data, not this one. Quit the other, or give this instance its own port with TOMRADE_MCP_PORT.",
    holderUnknown: "another program",
    holderPackaged: "the installed Tomrade",
    holderDev: "a development Tomrade",
    holder: "{{kind}} {{version}} (pid {{pid}})"
  },
  zh: {
    portClash: "MCP 在 {{port}} 端口 · {{clashPort}} 被{{holder}}占用",
    portClashTitle: "按默认端口配置的智能体连到的是另一个 Tomrade 和它的数据，不是这个。退出另一个，或用 TOMRADE_MCP_PORT 给这个实例指定端口。",
    holderUnknown: "其他程序",
    holderPackaged: "正式版",
    holderDev: "开发版",
    holder: "{{kind}} {{version}}（进程 {{pid}}）"
  }
});

export type McpWords = ReturnType<typeof MCP_WORDS>;
