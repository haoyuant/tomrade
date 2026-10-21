import { defineWords } from "@tomradex/domain";

/** Why an ACP agent's turn stopped, as the person reads it. */
export const ACP_WORDS = defineWords("engine-acp", {
  en: {
    noModeSwitch: '{{name}} did not switch to its "{{mode}}" mode: {{reason}}',
    noSuchMode: "it does not offer that mode",
    otherVersion: "{{name}} speaks ACP version {{version}}; Tomrade speaks version 1",
    noHttpMcp: "{{name}} takes no MCP server over HTTP, so it cannot reach Tomrade's tools",
    noSession: "{{name}} did not open a session",
    requestLimit: "{{name}} reached its limit of model requests for one turn",
    stopped: "{{name}} stopped: {{reason}}",
    refusedToGoOn: "{{name}} refused to go on",
    signInFirst: "{{message}} — {{how}}, then try again",
    signInTo: "sign in to {{name}}"
  },
  zh: {
    noModeSwitch: "{{name}} 没有切换到它的“{{mode}}”模式：{{reason}}",
    noSuchMode: "它没有这个模式",
    otherVersion: "{{name}} 使用 ACP 第 {{version}} 版，Tomrade 使用第 1 版",
    noHttpMcp: "{{name}} 不支持通过 HTTP 连接 MCP 服务，所以用不了 Tomrade 的工具",
    noSession: "{{name}} 没有打开会话",
    requestLimit: "{{name}} 达到了单轮模型请求次数上限",
    stopped: "{{name}} 停止了：{{reason}}",
    refusedToGoOn: "{{name}} 拒绝继续",
    signInFirst: "{{message}}——{{how}}，然后再试一次",
    signInTo: "登录 {{name}}"
  }
});
