/**
 * What the Code section, the badges, the status bar and the commands say,
 * in English and Chinese. The backend writes these words, so it picks the
 * language — the person's setting, else the system's — when it writes them.
 */
export type Locale = "en" | "zh";

const STATUS = {
  en: { backlog: "Backlog", todo: "To Do", doing: "Doing", verifying: "Verifying", done: "Done", cancelled: "Cancelled" },
  zh: { backlog: "待处理", todo: "待办", doing: "进行中", verifying: "验证中", done: "已完成", cancelled: "已取消" }
} as const;

const en = {
  section: "Code",
  group: "Code",
  delivery: "Delivery",
  deliveryState: (state: string) => ({ active: "active", completed: "completed", cancelled: "cancelled" })[state] ?? state,
  historical: "historical",
  branch: "Branch",
  repository: "repository",
  pullRequest: "Pull request",
  openIt: "open it",
  prState: (state: string) => state,
  openPr: "Open pull request",
  noRemote: (base: string) => `none — no remote; merge the branch into ${base} here`,
  merged: "Merged",
  mergedOn: (sha: string, branch: string) => `${sha} on ${branch}`,
  lastCommit: "Last commit",
  session: "Session",
  sessionState: (state: string) => ({ running: "running", waiting: "waiting for you", idle: "idle", error: "error", ended: "ended", lost: "lost" })[state] ?? state,
  inTerminal: "in a terminal",
  runByTomrade: "run by Tomrade",
  stopped: "stopped",
  lastSignal: (when: string) => `last signal ${when}`,
  continue: "Continue",
  continueTerminal: "Continue in terminal",
  continueHere: "Continue here",
  conversation: "Conversation",
  openWaiting: "Open it — it is waiting for you",
  openInAssistant: "Open it in the assistant",
  worktree: "Worktree",
  proposal: "Proposal",
  accept: (status: string) => `Accept → ${status}`,
  dismiss: "Dismiss",
  notThisTime: "Not this time",
  status: (status: string): string => STATUS.en[status as keyof typeof STATUS.en] ?? status,
  badgeWaiting: "waiting",
  badgeWaitingTitle: "The coding session is waiting for you",
  badgeStuck: "stuck",
  badgeMismatch: "mismatch",
  badgeMerged: "merged",
  badgeBranch: "branch",
  sessions: (n: number) => `${n} session${n === 1 ? "" : "s"}`,
  waitingCount: (n: number) => `${n} waiting for you`,
  stuckCount: (n: number) => `${n} stuck`,
  unlinked: (n: number) => `${n} unlinked`,
  toConfirm: (n: number) => `${n} to confirm`,
  unreachable: (n: number) => `${n} unreachable`,
  statusLine: (parts: string, scanned: string | null) => `code: ${parts || "in sync"}${scanned ? ` · scanned ${scanned}` : ""}`,
  ago: (s: number) => {
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  },
  selectTicket: "Select a ticket first",
  openProject: "Open a project first",
  started: (continued: boolean, branch: string) => `${continued ? "Continuing" : "Started"}${branch ? ` on ${branch}` : ""}`,
  terminalHasIt: " — your terminal has it",
  runThis: (command: string) => `Run this in a terminal:\n${command}`,
  waitingOn: (question: string) => `It is waiting for your answer: ${question}`,
  noConversation: "This ticket has no conversation yet — start it first",
  noWorktree: "No worktree for this ticket on this machine — start it first",
  opened: (cwd: string) => `Opened ${cwd}`,
  nothingProposed: "Nothing proposed for this ticket",
  movedTo: (status: string) => `Moved to ${status}`,
  dismissed: "Dismissed — asked again only on new evidence",
  pickWorkstream: "Select a ticket on the workstream whose repository to connect",
  scanned: (scanned: number, repos: number, changed: number, proposals: number, skipped: number) =>
    `Scanned ${scanned}/${repos} repositories · ${changed} moved · ${proposals} to confirm${skipped ? ` · ${skipped} skipped` : ""}`,
  cmdStartRun: "Start ticket here",
  cmdStartTerminal: "Open ticket in terminal",
  cmdOpenPr: "Open pull request",
  cmdOpenThread: "Open the ticket's conversation",
  cmdOpenTerminal: "Open worktree in terminal",
  cmdAccept: "Accept the code proposal",
  cmdReject: "Dismiss the code proposal",
  cmdConnect: "Connect repository to coding agents",
  cmdRescan: "Rescan repositories",
  needsApproval: "needs your approval",
  askingYou: "asking you something"
};

export type CodeWords = typeof en;

const zh: CodeWords = {
  section: "代码",
  group: "代码",
  delivery: "交付",
  deliveryState: (state: string) => ({ active: "进行中", completed: "已完成", cancelled: "已取消" })[state] ?? state,
  historical: "历史",
  branch: "分支",
  repository: "仓库",
  pullRequest: "拉取请求",
  openIt: "去打开",
  prState: (state: string) => ({ open: "开启中", merged: "已合并", closed: "已关闭" })[state] ?? state,
  openPr: "发起拉取请求",
  noRemote: (base: string) => `无——没有远端，请在本机把分支合并进 ${base}`,
  merged: "已合并",
  mergedOn: (sha: string, branch: string) => `${sha}，已进入 ${branch}`,
  lastCommit: "最近提交",
  session: "会话",
  sessionState: (state: string) => ({ running: "运行中", waiting: "在等你", idle: "空闲", error: "出错", ended: "已结束", lost: "已丢失" })[state] ?? state,
  inTerminal: "在终端里",
  runByTomrade: "由 Tomrade 运行",
  stopped: "已停止",
  lastSignal: (when: string) => `最近信号 ${when}`,
  continue: "继续",
  continueTerminal: "在终端里继续",
  continueHere: "在这里继续",
  conversation: "对话",
  openWaiting: "打开——它在等你",
  openInAssistant: "在助手里打开",
  worktree: "工作树",
  proposal: "建议",
  accept: (status: string) => `接受 → ${status}`,
  dismiss: "忽略",
  notThisTime: "这次不用",
  status: (status: string) => STATUS.zh[status as keyof typeof STATUS.zh] ?? status,
  badgeWaiting: "在等你",
  badgeWaitingTitle: "编码会话在等你",
  badgeStuck: "卡住",
  badgeMismatch: "不一致",
  badgeMerged: "已合并",
  badgeBranch: "分支",
  sessions: (n: number) => `${n} 个会话`,
  waitingCount: (n: number) => `${n} 个在等你`,
  stuckCount: (n: number) => `${n} 个卡住`,
  unlinked: (n: number) => `${n} 个未关联`,
  toConfirm: (n: number) => `${n} 个待确认`,
  unreachable: (n: number) => `${n} 个连不上`,
  statusLine: (parts: string, scanned: string | null) => `代码：${parts || "已同步"}${scanned ? ` · ${scanned}扫描` : ""}`,
  ago: (s: number) => {
    if (s < 60) return "刚刚";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
  },
  selectTicket: "请先选中一个工作项",
  openProject: "请先打开一个项目",
  started: (continued: boolean, branch: string) => `${continued ? "继续" : "已开始"}${branch ? `，分支 ${branch}` : ""}`,
  terminalHasIt: "——已交给你的终端",
  runThis: (command: string) => `在终端里运行：\n${command}`,
  waitingOn: (question: string) => `它在等你回答：${question}`,
  noConversation: "这个工作项还没有对话——先开始它",
  noWorktree: "这台机器上没有这个工作项的工作树——先开始它",
  opened: (cwd: string) => `已打开 ${cwd}`,
  nothingProposed: "这个工作项没有待处理的建议",
  movedTo: (status: string) => `已移到 ${status}`,
  dismissed: "已忽略——只有出现新依据时才会再问",
  pickWorkstream: "请选中一个工作项，它所在工作流的仓库就是要连接的仓库",
  scanned: (scanned: number, repos: number, changed: number, proposals: number, skipped: number) =>
    `已扫描 ${scanned}/${repos} 个仓库 · ${changed} 处变化 · ${proposals} 个待确认${skipped ? ` · 跳过 ${skipped} 个` : ""}`,
  cmdStartRun: "在这里开始工作项",
  cmdStartTerminal: "在终端里打开工作项",
  cmdOpenPr: "发起拉取请求",
  cmdOpenThread: "打开工作项的对话",
  cmdOpenTerminal: "在终端里打开工作树",
  cmdAccept: "接受代码建议",
  cmdReject: "忽略代码建议",
  cmdConnect: "把仓库连接到编码智能体",
  cmdRescan: "重新扫描仓库",
  needsApproval: "需要你批准",
  askingYou: "在问你问题"
};

export const CODE_WORDS: Record<Locale, CodeWords> = { en, zh };
