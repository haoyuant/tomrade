import { defineWords } from "@tomradex/domain";

/** What the troubleshooter's line about the built-in terminal host says. */
export const PTY_HOST_WORDS = defineWords("pty-host", {
  en: {
    missing: "this build carries no ConPTY runtime for {{arch}}: terminals open outside Tomrade",
    idle: "ready; starts with the first terminal",
    running: "running (pid {{pid}}) · {{panes}} terminals"
  },
  zh: {
    missing: "这个版本没有 {{arch}} 的 ConPTY 运行时：终端会在 Tomrade 之外打开",
    idle: "就绪；打开第一个终端时启动",
    running: "运行中（pid {{pid}}）· {{panes}} 个终端"
  }
});
