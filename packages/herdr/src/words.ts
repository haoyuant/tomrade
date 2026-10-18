import { defineWords } from "@tomradex/domain";

/** What the troubleshooter's herdr line says. */
export const HERDR_WORDS = defineWords("herdr", {
  en: {
    notInstalled: "not installed (optional: {{install}})",
    installedNotRunning: "herdr {{version}} installed; its server is not running",
    running: "herdr {{version}} running · {{socket}}"
  },
  zh: {
    notInstalled: "未安装（可选，{{install}}）",
    installedNotRunning: "herdr {{version}} 已安装，服务未运行",
    running: "herdr {{version}} 运行中 · {{socket}}"
  }
});
