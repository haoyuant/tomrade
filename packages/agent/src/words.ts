/** What the platform itself writes into a conversation, in the person's language at the moment it is written. */
export type Locale = "en" | "zh";

const en = {
  humanTookOver: "The human took over this delivery. Agent execution has stopped.",
  cancelledWaiting: "Cancelled the waiting question — the engine changed.",
  engineSwitched: (title: string) => `Engine switched to ${title}.`,
  reverted: (n: number, kept: { labels: string; reason: string } | null) => `Reverted ${n} change${n === 1 ? "" : "s"} from this run${kept ? `; kept ${kept.labels} (${kept.reason})` : ""}.`,
  workflowGone: (name: string) => `The waiting workflow "${name}" is no longer installed.`,
  stopped: "Stopped.",
  timeLimit: (ms: number) => `Stopped: the run reached its time limit (${ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`}).`,
  budget: "Stopped after its step budget for one turn — say “continue” to pick up from here.",
  interrupted: "Interrupted — the app closed while this run was in progress.",
  recommendedByType: "Picked from the kind of work the ticket describes.",
  reasonLanguage: "English"
};

export type AgentWords = typeof en;

const zh: AgentWords = {
  humanTookOver: "人工接手了这次交付，智能体已停止执行。",
  cancelledWaiting: "引擎换了，等待中的问题已取消。",
  engineSwitched: (title: string) => `已切换到引擎 ${title}。`,
  reverted: (n: number, kept: { labels: string; reason: string } | null) => `已撤销这次运行的 ${n} 处改动${kept ? `；保留了 ${kept.labels}（${kept.reason}）` : ""}。`,
  workflowGone: (name: string) => `等待中的工作流程“${name}”已经不在了。`,
  stopped: "已停止。",
  timeLimit: (ms: number) => `已停止：这次运行到了时间上限（${ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`}）。`,
  budget: "这一轮的步数用完了，已停下——说“继续”就能接着做。",
  interrupted: "已中断——这次运行进行中时应用关闭了。",
  recommendedByType: "根据工作项描述的工作类型选出。",
  reasonLanguage: "Simplified Chinese"
};

export const AGENT_WORDS: Record<Locale, AgentWords> = { en, zh };
