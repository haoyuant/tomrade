import type { Lang } from "../words";

/** What every launch film says, whatever it looks like: the definition, the six things Tomrade does, and where to get it. */
export const LAUNCH = {
  en: {
    hook: ["Your agents write fast.", "*Who's running the work?*"],
    name: "Tomrade",
    define: "The local workbench for AI coding agents.",
    defineMore: "A board your agents keep up themselves, and a terminal that shows every one of them.",
    features: [
      { key: "say", verb: "Say", title: "One sentence, split into tickets", line: "Each sized for one pull request" },
      { key: "build", verb: "Build", title: "Agents work in your own terminal", line: "The board follows git on its own" },
      { key: "watch", verb: "Watch", title: "One terminal for every agent", line: "See at once who needs you" },
      { key: "ask", verb: "Ask", title: "They ask only when it's your call", line: "One click, and it carries on" },
      { key: "undo", verb: "Undo", title: "Every write carries a name", line: "A whole run, one click back" },
      { key: "night", verb: "Merge", title: "Auto run, overnight", line: "Down the dependency graph, once checks pass" }
    ],
    facts: ["Local-first", "No account", "Free and open source", "macOS · Windows · Linux"],
    get: "Download free",
    site: "tomrade.com"
  },
  zh: {
    hook: ["你的 Agent 很能写。", "*谁来管住这些活？*"],
    name: "Tomrade",
    define: "给 AI 编程 Agent 的本地工作台。",
    defineMore: "一块 Agent 自己会更新的看板，加一个看得见每个 Agent 的终端。",
    features: [
      { key: "say", verb: "说", title: "一句话，拆成工单", line: "每张刚好一个 PR" },
      { key: "build", verb: "做", title: "Agent 在你自己的终端里干", line: "看板跟着 git 自己往前走" },
      { key: "watch", verb: "看", title: "一个终端，看住每个 Agent", line: "谁在等你，一眼看清" },
      { key: "ask", verb: "问", title: "只在要你拍板时才来问", line: "点一下，它接着跑" },
      { key: "undo", verb: "撤", title: "每次修改都署名", line: "整次运行，一键撤回" },
      { key: "night", verb: "合", title: "自动运行，一夜做完", line: "顺着依赖图，检查通过才合并" }
    ],
    facts: ["本地优先", "不用注册", "免费开源", "macOS · Windows · Linux"],
    get: "免费下载",
    site: "tomrade.com"
  }
} as const satisfies Record<Lang, unknown>;

export type FeatureKey = (typeof LAUNCH)["en"]["features"][number]["key"];

/** What the small scenes themselves show. */
export const SCENE = {
  en: {
    idea: "Let customers pay by invoice",
    tickets: ["Invoice model and numbering", "Render the invoice as a PDF", "Pay by bank transfer", "Email the invoice to the customer", "Invoices page in settings"],
    label: "billing",
    lines: ["tomrade  claim_ticket APP-53", "git switch -c app-53/invoice-model", "gh pr create  →  #231", "checks pass · merged"],
    rail: ["To Do", "Doing", "Verifying", "Done"],
    prompt: "Run `pnpm test`? (y/n)",
    question: { text: "Match a bank transfer by reference, or by amount?", options: ["By reference", "By amount"] as const },
    reply: "Split APP-52 into five tickets, each sized for one pull request.",
    merged: "merged"
  },
  zh: {
    idea: "让客户可以按发票付款",
    tickets: ["发票模型与编号", "把发票渲染成 PDF", "支持银行转账付款", "把发票邮件发给客户", "设置里的发票页面"],
    label: "账单",
    lines: ["tomrade  claim_ticket APP-53", "git switch -c app-53/invoice-model", "gh pr create  →  #231", "检查通过 · 已合并"],
    rail: ["待办", "进行中", "验证中", "完成"],
    prompt: "运行 `pnpm test`？(y/n)",
    question: { text: "银行转账怎么对上发票：按附言，还是按金额？", options: ["按附言", "按金额"] as const },
    reply: "把 APP-52 拆成了五张工单，每张刚好一个 PR。",
    merged: "已合并"
  }
} as const satisfies Record<Lang, unknown>;
