import type { Lang, TicketWords } from "../words";

/** The day's tickets, in the order the story numbers them (story.ts). */
export const TICKETS: Record<Lang, TicketWords[]> = {
  en: [
    { title: "Let customers pay by invoice", label: "billing" },
    { title: "Invoice model and numbering", label: "billing" },
    { title: "Render the invoice as a PDF", label: "billing" },
    { title: "Pay by bank transfer", label: "billing" },
    { title: "Email the invoice to the customer", label: "billing" },
    { title: "Invoices page in settings", label: "ui" },
    { title: "Rate-limit the public API", label: "api" },
    { title: "Usage page for the API", label: "api" },
    { title: "Alert at 80% of the quota", label: "api" },
    { title: "Invite teammates by email", label: "auth" },
    { title: "Sign in with a magic link", label: "auth" }
  ],
  zh: [
    { title: "让客户按发票付款", label: "账单" },
    { title: "发票模型与编号", label: "账单" },
    { title: "把发票渲染成 PDF", label: "账单" },
    { title: "支持银行转账付款", label: "账单" },
    { title: "把发票邮件发给客户", label: "账单" },
    { title: "设置里的发票页面", label: "界面" },
    { title: "给公开 API 加限流", label: "api" },
    { title: "API 用量页面", label: "api" },
    { title: "配额用到 80% 时提醒", label: "api" },
    { title: "通过邮件邀请成员", label: "登录" },
    { title: "用魔法链接登录", label: "登录" }
  ]
};

/** What is said in the assistant's panel. */
export const CHAT = {
  en: {
    idea: "Let customers pay by invoice",
    filed: "On the board as APP-52.",
    tidy: "Tidy up",
    split: "Split APP-52 into five tickets, each sized for one pull request, and linked them in order."
  },
  zh: {
    idea: "让客户可以按发票付款",
    filed: "已经放到看板上：APP-52。",
    tidy: "整理一下",
    split: "把 APP-52 拆成了五张工单，每张刚好一个 PR，并按先后顺序关联好了。"
  }
} as const satisfies Record<Lang, Record<string, string>>;

/** The two agents' terminals, line by line; `$` marks what the person typed. */
export const TERMINAL = {
  en: {
    claude: ["$ work on APP-53", "tomrade  claim_ticket APP-53", "git switch -c app-53/invoice-model", "wrote 6 files · 18 tests pass", "gh pr create  →  #231", "checks pass"],
    codex: ["$ take APP-55", "tomrade  claim_ticket APP-55", "git switch -c app-55/bank-transfer", "wrote 4 files", "tomrade  ask_user", "answered: by reference"]
  },
  zh: {
    claude: ["$ 做 APP-53", "tomrade  claim_ticket APP-53", "git switch -c app-53/invoice-model", "写入 6 个文件 · 18 个测试通过", "gh pr create  →  #231", "检查通过"],
    codex: ["$ 接 APP-55", "tomrade  claim_ticket APP-55", "git switch -c app-55/bank-transfer", "写入 4 个文件", "tomrade  ask_user", "已回答：按附言"]
  }
} as const satisfies Record<Lang, Record<"claude" | "codex", readonly string[]>>;

/** The one question an agent brings to the person. */
export const QUESTION = {
  en: { text: "Match a bank transfer to its invoice by reference, or by amount?", options: ["By reference", "By amount"] },
  zh: { text: "银行转账怎么对上发票：按附言，还是按金额？", options: ["按附言", "按金额"] }
} as const satisfies Record<Lang, { text: string; options: readonly [string, string] }>;

/** Captions: *stars* mark what is lit in the sun's colours; a line break starts a new line in the tall cut. */
export const CAPTIONS = {
  en: {
    open: "It starts with\n*one sentence.*",
    talk: "*Talk.* It becomes\na ticket.",
    split: "*Split.* One pull\nrequest each.",
    back: "Don't like it?\n*One click back.*",
    build: "*Build.* In your\nown terminal.",
    keeps: "The board keeps up\n*on its own.*",
    ask: "They ask when\nit's *your call.*",
    merge: "*Merge.* Or let it\nrun all night.",
    graph: "Down the\ndependency graph.",
    checks: "Merged only when\n*checks pass.*",
    morning: "Good morning.\n*Eight merged.*",
    fact1: "Claude Code. Codex.\n*Any MCP agent.*",
    fact2: "Your own machine.\n*No account.*",
    fact3: "Free.\n*Open source.*",
    ideaTicket: "It becomes\n*a ticket.*",
    ideaSplit: "Then five,\n*one PR each.*",
    undoRewrote: "An agent *rewrote*\nyour backlog.",
    undoBack: "*One click* takes\nit all back.",
    undoForth: "Redo brings\n*it all back.*",
    boardNobody: "Nobody *drags*\nthese cards.",
    boardAgents: "Agents claim,\nbranch, *open the PR.*",
    nightBed: "Pick the tickets.\n*Go to bed.*"
  },
  zh: {
    open: "从*一句话*\n开始。",
    talk: "*说。*一句话，\n变成一张工单。",
    split: "*拆。*每张工单，\n刚好一个 PR。",
    back: "不满意？\n*一键撤回。*",
    build: "*做。*就在你\n自己的终端里。",
    keeps: "看板*自己*\n跟上进度。",
    ask: "要你*拍板*时，\n才来问你。",
    merge: "*合。*或者让它\n跑一整夜。",
    graph: "沿着依赖图，\n一张张往下做。",
    checks: "*检查通过，*\n才会合并。",
    morning: "早上好。\n*八个都合并了。*",
    fact1: "Claude Code、Codex，\n*任何 MCP Agent。*",
    fact2: "就在你的电脑上，\n*不用注册。*",
    fact3: "免费，\n*开源。*",
    ideaTicket: "它变成了\n*一张工单。*",
    ideaSplit: "再拆成五张，\n*每张一个 PR。*",
    undoRewrote: "Agent *改写了*\n你的待办。",
    undoBack: "*一键*，\n全部撤回。",
    undoForth: "重做一下，\n*又都回来了。*",
    boardNobody: "这些卡片，\n*没人去拖。*",
    boardAgents: "Agent 认领、\n开分支、*提 PR。*",
    nightBed: "选好工单，\n*去睡吧。*"
  }
} as const satisfies Record<Lang, Record<string, string>>;

export type CaptionKey = keyof (typeof CAPTIONS)["en"];
