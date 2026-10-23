import { defineWords } from "@tomradex/domain";

/** What the troubleshooter's herdr line says. */
export const HERDR_WORDS = defineWords("herdr", {
  en: {
    notInstalled: "not installed (optional)",
    installedNotRunning: "herdr {{version}} installed; its server is not running",
    running: "herdr {{version}} running · {{socket}}",
    tooOld: "herdr {{version}} is older than {{need}}: terminals cannot open in Tomrade's window until it is upgraded (`{{fix}}`)",
    stale: "herdr {{version}} is installed but its server still runs {{server}}: restart the server (`{{fix}}`, Tomrade starts it again) so terminals can open — running panes end, and their agents resume"
  },
  zh: {
    notInstalled: "未安装（可选）",
    installedNotRunning: "herdr {{version}} 已安装，服务未运行",
    running: "herdr {{version}} 运行中 · {{socket}}",
    tooOld: "herdr {{version}} 低于 {{need}}：升级后才能在 Tomrade 的窗口里打开终端（`{{fix}}`）",
    stale: "已安装 herdr {{version}}，但服务仍在运行 {{server}}：重启服务（`{{fix}}`，Tomrade 会再启动它）后才能打开终端；正在运行的 pane 会结束，其中的 agent 会恢复"
  }
});
