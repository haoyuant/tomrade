import { defineWords } from "@tomradex/domain";

export const WATCHDOG_WORDS = defineWords("watchdog", {
  en: {
    sectionTitle: "Watchdog",
    sectionDescription: "Tells you when a run Tomrade started seems stuck, repeats itself or goes nowhere. It only tells you: a run is never stopped or changed. Sessions in a terminal are not watched.",
    enabledTitle: "Watch running agents",
    enabledDescription: "You hear about it the way you hear an agent stopped, under Notifications.",
    silentMinutesTitle: "Minutes without activity",
    silentMinutesDescription: "Time spent waiting for your answer does not count.",
    judgeTitle: "Ask the worker model about long runs",
    judgeDescription: "A run past an hour is checked once an hour, at most 10 times a day. Each check is one small request, shown under worker usage.",
    noticeSilent: "No activity for {{minutes}} min.",
    noticeSilentStep: "No activity for {{minutes}} min. Last step: {{step}}",
    noticeLooping: "Called {{tool}} {{times}} times in a row with the same arguments.",
    noticeDrifting: "Running for {{minutes}} min: {{reason}}"
  },
  zh: {
    sectionTitle: "巡检",
    sectionDescription: "Tomrade 启动的运行看起来卡住、重复或没有进展时提醒你。只提醒，不会停止或改动运行。不看终端里的会话。",
    enabledTitle: "巡检运行中的 agent",
    enabledDescription: "提醒方式与 agent 停下时相同，在「通知」里设置。",
    silentMinutesTitle: "多少分钟没有动静",
    silentMinutesDescription: "等你回答的时间不算在内。",
    judgeTitle: "让 worker 模型检查长时间运行",
    judgeDescription: "运行超过一小时后，每小时检查一次，每天最多 10 次。每次是一个小请求，计入 worker 用量。",
    noticeSilent: "{{minutes}} 分钟没有动静。",
    noticeSilentStep: "{{minutes}} 分钟没有动静。最后一步：{{step}}",
    noticeLooping: "用相同参数连续调用了 {{times}} 次 {{tool}}。",
    noticeDrifting: "已运行 {{minutes}} 分钟：{{reason}}"
  }
});
