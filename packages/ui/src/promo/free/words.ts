import type { Lang } from "../words";

/** Captions of the films that leave the app's window: *stars* mark what is lit, a line break starts a new line. */
export const CAPTIONS = {
  en: {
    pile1: "Terminals pile up.",
    pile2: "Which one needs you?",
    pile3: "*Who knows.*",
    grid: "*Tomrade Terminal.* One window.",
    status: "Who's running. Who *needs you.*",
    ticket: "Every pane knows *its ticket.*",
    quit: "Quit the app. *They keep working.*",
    wait1: "An agent asked.",
    wait2: "You didn't see it.",
    wait3: "*47 minutes,* wasted.",
    told: "*Tomrade* tells you at once.",
    click: "*One click.* It carries on.",
    saved: "*3 seconds.* Not 47 minutes.",
    card1: "Nobody touched",
    card2: "*this card.*",
    claim: "Claimed.",
    branch: "Branched.",
    build: "Built.",
    pr: "Pull request.",
    merged: "*Merged.*",
    own1: "It got there",
    own2: "*on its own.*"
  },
  zh: {
    pile1: "终端越开越多。",
    pile2: "哪个在等你？",
    pile3: "*天知道。*",
    grid: "*Tomrade 终端。*一个窗口，全都在。",
    status: "谁在跑，谁*在等你*，一眼看清。",
    ticket: "每一格，都连着*它的工单*。",
    quit: "关掉应用，它们*照样干活*。",
    wait1: "Agent 问了一句。",
    wait2: "你没看见。",
    wait3: "*47 分钟，*白等。",
    told: "*Tomrade* 马上告诉你。",
    click: "*点一下，*它接着跑。",
    saved: "*3 秒。*不是 47 分钟。",
    card1: "这张卡，",
    card2: "*没人碰过。*",
    claim: "认领。",
    branch: "开分支。",
    build: "写代码。",
    pr: "提 PR。",
    merged: "*合并。*",
    own1: "它是",
    own2: "*自己*走完的。"
  }
} as const satisfies Record<Lang, Record<string, string>>;

/** A terminal pane's ticket and agent; the last pane is a plain shell. */
export const PANES: Record<Lang, { key: string; agent: string; title: string; label: string }[]> = {
  en: [
    { key: "APP-53", agent: "Claude Code", title: "Invoice model and numbering", label: "billing" },
    { key: "APP-55", agent: "Codex", title: "Pay by bank transfer", label: "billing" },
    { key: "APP-54", agent: "Claude Code", title: "Render the invoice as a PDF", label: "billing" },
    { key: "APP-51", agent: "Codex", title: "Rate-limit the public API", label: "api" },
    { key: "APP-56", agent: "Codex", title: "Email the invoice to the customer", label: "billing" },
    { key: "", agent: "", title: "zsh · ~/paperplane", label: "" }
  ],
  zh: [
    { key: "APP-53", agent: "Claude Code", title: "发票模型与编号", label: "账单" },
    { key: "APP-55", agent: "Codex", title: "支持银行转账付款", label: "账单" },
    { key: "APP-54", agent: "Claude Code", title: "把发票渲染成 PDF", label: "账单" },
    { key: "APP-51", agent: "Codex", title: "给公开 API 加限流", label: "api" },
    { key: "APP-56", agent: "Codex", title: "把发票邮件发给客户", label: "账单" },
    { key: "", agent: "", title: "zsh · ~/paperplane", label: "" }
  ]
};

/** What scrolls by in a pane while its agent works, and what a plain shell shows. */
export const LOG: Record<Lang, { work: string[]; shell: string[]; ask: string; answered: string; untitled: string[]; window: string }> = {
  en: {
    work: ["read src/billing/invoice.ts", "wrote 3 files", "pnpm test billing", "12 tests pass", "git commit -m \"invoice model\"", "git push origin HEAD", "gh pr create", "checks running"],
    shell: ["$ pnpm dev", "vite ready in 412 ms", "➜ http://localhost:5173", "hmr update /src/app.tsx"],
    ask: "Overwrite invoice.ts? [y/N]",
    answered: "wrote invoice.ts",
    untitled: ["zsh", "claude", "codex", "zsh", "claude", "node", "codex", "zsh", "claude"],
    window: "Paperplane · Terminal"
  },
  zh: {
    work: ["读取 src/billing/invoice.ts", "写入 3 个文件", "pnpm test billing", "12 个测试通过", "git commit -m \"invoice model\"", "git push origin HEAD", "gh pr create", "检查运行中"],
    shell: ["$ pnpm dev", "vite ready in 412 ms", "➜ http://localhost:5173", "hmr update /src/app.tsx"],
    ask: "覆盖 invoice.ts？[y/N]",
    answered: "已写入 invoice.ts",
    untitled: ["zsh", "claude", "codex", "zsh", "claude", "node", "codex", "zsh", "claude"],
    window: "纸飞机 · 终端"
  }
};

/** The agent that stops to ask: what its terminal shows before, the question, and what follows the answer. */
export const WAIT = {
  en: {
    before: ["read src/billing/transfer.ts", "wrote 4 files"], prompt: "Run `pnpm test`? (y/n)", waited: "waiting", after: ["allowed", "pnpm test", "18 tests pass", "git push origin HEAD", "gh pr create  →  #232"],
    question: { text: "Codex wants to run `pnpm test`. Allow it?", options: ["Allow", "Deny"] }
  },
  zh: {
    before: ["读取 src/billing/transfer.ts", "写入 4 个文件"], prompt: "运行 `pnpm test`？(y/n)", waited: "已等待", after: ["已允许", "pnpm test", "18 个测试通过", "git push origin HEAD", "gh pr create  →  #232"],
    question: { text: "Codex 要运行 `pnpm test`，允许吗？", options: ["允许", "拒绝"] }
  }
} as const satisfies Record<Lang, { before: readonly string[]; prompt: string; waited: string; after: readonly string[]; question: { text: string; options: readonly [string, string] } }>;

/** The lines under the one card, as its agent writes them. */
export const STEPS: Record<Lang, string[]> = {
  en: ["tomrade  claim_ticket APP-53", "git switch -c app-53/invoice-model", "wrote 6 files · 18 tests pass", "gh pr create  →  #231", "checks pass · merged"],
  zh: ["tomrade  claim_ticket APP-53", "git switch -c app-53/invoice-model", "写入 6 个文件 · 18 个测试通过", "gh pr create  →  #231", "检查通过 · 已合并"]
};
