import type { Lang, TicketWords } from "../words";

/** Captions: *stars* mark what is lit in the sun's colours, a line break starts a new line. */
export const CAPTIONS = {
  en: {
    hook1: "So many agents.",
    hook2: "One babysitter.",
    hook3: "*You.*",
    meet: "Meet *Tomrade.*",
    claim: "Agents *claim* their own tickets.",
    build: "Branch. Build. *Pull request.*",
    report: "And report back *on their own.*",
    ask: "They only ask\nwhen it's *your call.*",
    bed: "So go to bed.",
    wake: "Wake up to *merged* pull requests.",
    proof1: "Claude Code. Codex.\n*Any MCP agent.*",
    proof2: "Local-first.\n*No account.*",
    proof3: "Free.\n*Open source.*"
  },
  zh: {
    hook1: "一堆 Agent。",
    hook2: "一个保姆。",
    hook3: "*就是你。*",
    meet: "试试 *Tomrade。*",
    claim: "Agent *自己认领*工单。",
    build: "开分支，写代码，*提 PR。*",
    report: "做完了，*自己来汇报。*",
    ask: "只有要你*拍板*时，\n才来找你。",
    bed: "所以，去睡吧。",
    wake: "醒来，PR *已经合并。*",
    proof1: "Claude Code、Codex，\n*任何 MCP Agent。*",
    proof2: "本地优先，\n*不用注册。*",
    proof3: "免费，\n*开源。*"
  }
} as const satisfies Record<Lang, Record<string, string>>;

export type CaptionKey = keyof (typeof CAPTIONS)["en"];

/** The sample project's tickets, in the order the simulation numbers them. */
export const TICKETS: Record<Lang, TicketWords[]> = {
  en: [
    { title: "Sign in with a magic link", label: "auth" },
    { title: "Rate-limit the public API", label: "api" },
    { title: "Export invoices as PDF", label: "billing" },
    { title: "Fix the timezone bug in reports", label: "bug" },
    { title: "Retry failed webhooks with backoff", label: "api" },
    { title: "Dark mode for the dashboard", label: "ui" },
    { title: "Search across every project", label: "ui" },
    { title: "Onboarding checklist for new teams", label: "growth" },
    { title: "Move the build to Vite 6", label: "infra" },
    { title: "Paginate the audit log", label: "api" },
    { title: "Invite teammates by email", label: "auth" }
  ],
  zh: [
    { title: "用魔法链接登录", label: "登录" },
    { title: "给公开 API 加限流", label: "api" },
    { title: "把发票导出为 PDF", label: "账单" },
    { title: "修复报表里的时区问题", label: "缺陷" },
    { title: "Webhook 失败后退避重试", label: "api" },
    { title: "仪表盘的深色模式", label: "界面" },
    { title: "跨项目搜索", label: "界面" },
    { title: "新团队的上手清单", label: "增长" },
    { title: "把构建迁到 Vite 6", label: "基建" },
    { title: "审计日志分页", label: "api" },
    { title: "通过邮件邀请成员", label: "登录" }
  ]
};

export interface PaneWords { title: string; log: [string, string]; ask: string }

/** The opening's terminals: each one stopped on a question. */
export const PANES: Record<Lang, PaneWords[]> = {
  en: [
    { title: "claude · auth", log: ["read src/auth/session.ts", "wrote 2 files"], ask: "Send the link from which address?" },
    { title: "codex · api", log: ["edited middleware/limit.ts", "3 tests added"], ask: "Run `pnpm test`? (y/n)" },
    { title: "codex · billing", log: ["read invoice.ts", "found 2 date fields"], ask: "Overwrite invoice.ts? [y/N]" },
    { title: "claude · reports", log: ["ran 41 tests", "2 failed"], ask: "Tests failed. Try again? (y/n)" },
    { title: "claude · webhooks", log: ["wrote retry.ts", "needs the network"], ask: "Allow `curl` to the staging API? (y/n)" },
    { title: "codex · dashboard", log: ["edited 14 files", "build passed"], ask: "Done. What next?" }
  ],
  zh: [
    { title: "claude · 登录", log: ["读取 src/auth/session.ts", "写入 2 个文件"], ask: "链接从哪个邮箱发出？" },
    { title: "codex · api", log: ["修改 middleware/limit.ts", "新增 3 个测试"], ask: "运行 `pnpm test`？(y/n)" },
    { title: "codex · 账单", log: ["读取 invoice.ts", "发现 2 个日期字段"], ask: "覆盖 invoice.ts？[y/N]" },
    { title: "claude · 报表", log: ["跑了 41 个测试", "2 个失败"], ask: "测试失败，再试一次？(y/n)" },
    { title: "claude · webhook", log: ["写入 retry.ts", "需要访问网络"], ask: "允许 `curl` 访问预发 API？(y/n)" },
    { title: "codex · 仪表盘", log: ["修改 14 个文件", "构建通过"], ask: "做完了，接下来呢？" }
  ]
};

/** The one question an agent brings to the person. */
export const QUESTION = {
  en: { text: "Invoices carry two dates. Which one goes on the PDF?", options: ["Issue date", "Paid date"] },
  zh: { text: "发票上有两个日期，PDF 上印哪一个？", options: ["开票日期", "付款日期"] }
} as const satisfies Record<Lang, { text: string; options: readonly [string, string] }>;
