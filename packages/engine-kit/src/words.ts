import type { Context } from "cordis";
import { localeOf } from "@tomradex/contracts";
import { defineWords } from "@tomradex/domain";

/** What every local-agent engine says when its process or connection fails. */
export const KIT_WORDS = defineWords("engine-kit", {
  en: {
    noMcp: "The MCP server is not running",
    notRunning: "{{name}} is not running",
    noAnswer: "{{name}} did not answer {{method}} within {{seconds}}s",
    exited: "{{name}} exited with {{code}}",
    stoppedReading: "{{name}} stopped reading",
    refused: "{{name}} refused {{method}}",
    closed: "{{name}} closed",
    runtimeClosed: "{{name}} runtime closed",
    inputEnded: "{{name}} input stream ended before the runtime was closed",
    lostSession: "{{name}} no longer has session {{session}}",
    outputLimit: "The model reached its output limit before it finished"
  },
  zh: {
    noMcp: "MCP 服务没有运行",
    notRunning: "{{name}} 没有在运行",
    noAnswer: "{{name}} 在 {{seconds}} 秒内没有回应 {{method}}",
    exited: "{{name}} 已退出，退出码 {{code}}",
    stoppedReading: "{{name}} 不再读取输入",
    refused: "{{name}} 拒绝了 {{method}}",
    closed: "{{name}} 的连接已关闭",
    runtimeClosed: "{{name}} 运行时已关闭",
    inputEnded: "{{name}} 的输入流在运行时关闭前就结束了",
    lostSession: "{{name}} 已经没有会话 {{session}}",
    outputLimit: "模型在完成前达到了输出上限"
  }
});

/** The person's language, for an engine's words; English without a settings service. */
export const engineLocale = (ctx: Context): string | undefined => localeOf(ctx);
