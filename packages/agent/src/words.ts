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
  reasonLanguage: "English",
  limited: (when: string, known: boolean, resumes: boolean) =>
    `Hit a usage limit${known ? `; it lifts at ${when}` : ` — it did not say when it lifts, so the next try is at ${when}`}. ${resumes ? "Tomrade continues this conversation then." : "Continue it then."}`,
  limitGaveUp: (n: number) => `Still limited after ${n} tries in a row, so Tomrade stops trying on its own. Continue it once the limit has lifted.`,
  continueAfterLimit: "The usage limit has lifted. Continue where you left off.",
  proposeRule: (rule: string) => `Add this to the project's rules, for every agent from now on?\n\n${rule}`,
  addRule: "Add rule",
  skipRule: "Don't add",
  archivedReadOnly: "This conversation is archived. Restore it from the archive to keep talking.",
  reopenToContinue: (key: string) => `${key} is done. Reopen it to keep working in this conversation.`,
  finishedNoWorktree: (key: string) => `${key} is done and its worktree is gone. Reopen the ticket and Start it to bring the work back.`
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
  reasonLanguage: "Simplified Chinese",
  limited: (when: string, known: boolean, resumes: boolean) =>
    `用量到了上限${known ? `，${when} 解除` : `，没说什么时候解除，下次在 ${when} 再试`}。${resumes ? "到时 Tomrade 会自动接着做。" : "到时请继续。"}`,
  limitGaveUp: (n: number) => `连续 ${n} 次都被限流，Tomrade 不再自动重试。等额度恢复后请手动继续。`,
  continueAfterLimit: "用量限制已经解除，请从刚才停下的地方继续。",
  proposeRule: (rule: string) => `把这条加进项目规则吗？以后这个项目里的所有智能体都会遵守：\n\n${rule}`,
  addRule: "加入规则",
  skipRule: "不加",
  archivedReadOnly: "这段对话已归档。从归档里恢复后才能继续对话。",
  reopenToContinue: (key: string) => `${key} 已完成。重新打开工单后才能在这段对话里继续。`,
  finishedNoWorktree: (key: string) => `${key} 已完成，它的 worktree 也已删除。重新打开这张工单再开始，才会把工作带回来。`
};

export const AGENT_WORDS: Record<Locale, AgentWords> = { en, zh };
