import type { Lang } from "../words";

/** A caption and the beats of its step it is up from and until. */
type Line = [string, number, number];
/** What every feature film has: its name and one line for a page to print, its hook, a step's captions, and why it matters. */
interface Words { title: string; about: string; hook: [string, string]; steps: [Line[], Line[], Line[]]; why: string }

/** "Everything is a plugin": what ships as plugins, having an agent write one, and the store. */
export const PLUGIN_WORDS = {
  en: {
    title: "Everything is a plugin",
    about: "Switch off what you don't want, have an agent write what's missing, find more in the store.",
    hook: ["Everything is *a plugin.*", "*Even the cat.*"],
    steps: [
      [["The pet, the inbox, routines: *each one is a plugin.*", 0, 3.4], ["Don't want one? *Switch it off.*", 3.5, 8]],
      [["Missing one? *Describe it, and an agent writes it.*", 0, 4.4], ["It loads only *once you confirm the build.*", 4.5, 8]],
      [["More in *the plugin store*: official, and community.", 0, 8]]
    ],
    why: "Write your own with the open SDK.\n*Your plugin is yours.*",
    name: "stale-in-doing",
    store: [["Pomodoro", "A pomodoro in the status bar: 25 minutes on, 5 off."], ["Discord", "Message the assistant from Discord: same project, same tools."]]
  },
  zh: {
    title: "一切皆插件",
    about: "不想要的关掉，没有的让 Agent 写，更多的去商店装。",
    hook: ["一切皆*插件*。", "*连猫都是。*"],
    steps: [
      [["桌宠、收件箱、例行事务：*每一块都是插件*。", 0, 3.4], ["不想要的，*关掉就行*。", 3.5, 8]],
      [["没有的？*说一句，让 Agent 写*。", 0, 4.4], ["*你确认了*，它才会加载。", 4.5, 8]],
      [["更多的在*插件商店*：官方一级，社区一级。", 0, 8]]
    ],
    why: "用开源 SDK 自己写，\n*插件归你*。",
    name: "stale-in-doing",
    store: [["Pomodoro", "状态栏里的番茄钟：专注 25 分钟，休息 5 分钟。"], ["Discord", "在 Discord 里给助手发消息：同一个项目，同一套工具。"]]
  }
} satisfies Record<Lang, Words & { name: string; store: [string, string][] }>;

/** "Themes": the eight built in, one made from a picture, and switching by the hour. */
export const THEME_WORDS = {
  en: {
    title: "Themes, and your own",
    about: "Eight built in, one made from any picture, and a schedule that turns them by the hour.",
    hook: ["Your dark mode *says a lot about you.*", "*So have a few more.*"],
    steps: [
      [["*Eight built-in themes.* One click, the whole app.", 0, 8]],
      [["Or *give it a picture*: the palette follows it.", 0, 8]],
      [["*On a schedule* too: Sunrise by day, Daybreak at night.", 0, 8]]
    ],
    why: "You look at it all day.\n*Make it yours.*",
    column: "To Do",
    tickets: ["Renew the passport", "Book the dentist", "Plan Saturday's hike"],
    label: "home"
  },
  zh: {
    title: "内置主题，外加你自己的",
    about: "八套内置，任意一张图片也能做一套，还能按时间自动切换。",
    hook: ["你的深色模式，*暴露了你*。", "*那就多给你几套。*"],
    steps: [
      [["*八套内置主题*，点一下，整个应用都换。", 0, 8]],
      [["或者*给它一张图*，配色跟着图走。", 0, 8]],
      [["还能*按时间自动换*：白天晨曦，晚上破晓。", 0, 8]]
    ],
    why: "天天看的东西，\n*得是你喜欢的样子*。",
    column: "待办",
    tickets: ["续签护照", "约牙医", "规划周六爬山"],
    label: "日常"
  }
} satisfies Record<Lang, Words & { column: string; tickets: string[]; label: string }>;

/** "The inbox": feedback waits in front of the backlog, is read and sorted, and one click settles it. */
export const INBOX_WORDS = {
  en: {
    title: "An inbox that triages itself",
    about: "Feedback waits at the door; the assistant sorts it and drafts the reply; you confirm.",
    hook: ["Feedback comes in, *the backlog fills up?*", "*Make it wait at the door.*"],
    steps: [
      [["GitHub issues and feedback *land in the inbox first.*", 0, 8]],
      [["The assistant reads each one: *new, known, or a duplicate.*", 0, 4.4], ["It even *drafts the reply.*", 4.5, 8]],
      [["You just *click Confirm.*", 0, 3.4], ["The reply goes *back where they asked.*", 3.5, 8]]
    ],
    why: "The backlog\n*has a bouncer now.*",
    entries: [["#128", "bug", "CSV export drops the last row", "2h"], ["#131", "idea", "A print view for the board?", "5h"], ["#127", "bug", "Images won't paste into notes on Linux", "1d"]],
    source: "GitHub issues", who: "@mira", by: "Worker model",
    body: "Exported 120 rows, the file has 119. Every time, on 0.11.",
    ticket: ["TOM-42", "CSV export loses rows"],
    reason: "The same off-by-one as TOM-42. This is the third report.",
    reply: "Thanks, Mira! It's a known bug, tracked as TOM-42. We'll post here when the fix ships."
  },
  zh: {
    title: "会自己分诊的收件箱",
    about: "反馈先在门口等着；助手分好类、拟好回复；你点一下确认。",
    hook: ["反馈一来，*需求池就乱*？", "*先让它们在门口等着。*"],
    steps: [
      [["GitHub issue 和各种反馈，*先落进收件箱*。", 0, 8]],
      [["助手先看一遍：*新工单、老问题，还是重复*。", 0, 4.4], ["连*回复*都替你拟好了。", 4.5, 8]],
      [["你只要*点一下确认*。", 0, 3.4], ["回复，*回到对方提问的地方*。", 3.5, 8]]
    ],
    why: "需求池门口，\n*有保安了*。",
    entries: [["#128", "bug", "导出 CSV 少了最后一行", "2 小时前"], ["#131", "idea", "看板能不能加个打印视图？", "5 小时前"], ["#127", "bug", "Linux 上笔记里粘贴不了图片", "1 天前"]],
    source: "GitHub Issues", who: "@mira", by: "工作模型",
    body: "导出 120 行，文件里只有 119 行。0.11 上每次都这样。",
    ticket: ["TOM-42", "CSV 导出丢行"],
    reason: "和 TOM-42 是同一个差一错误，这已经是第三次有人报了。",
    reply: "谢谢 Mira！这是已知问题，在 TOM-42 跟进，修好发版后会在这里告诉你。"
  }
} satisfies Record<Lang, Words & Record<string, unknown>>;

/** "Files and notes": the project's folder, notes that link and attach to tickets, and an agent that reads them. */
export const FILE_WORDS = {
  en: {
    title: "Files and notes beside the board",
    about: "Every project has a folder; notes link to each other and to tickets, and your agents can read them.",
    hook: ["Notes in one app, to-dos in another?", "*Your notebook sits beside the board.*"],
    steps: [
      [["Every project has a folder: *notes, docs, pictures.*", 0, 8]],
      [["Notes *link to each other*, and *attach to tickets.*", 0, 8]],
      [["Your agents *can read them too*: look it up, then answer.", 0, 8]]
    ],
    why: "Write it down once.\n*Never explain it again.*",
    tree: [["Journal", 0, true], ["2026-11-12.md", 1, false], ["Travel", 0, true], ["Dali trip.md", 1, false], ["Budget.md", 1, false], ["Route.html", 0, false]] as [string, number, boolean][],
    open: 3,
    note: { title: "Dali trip", lines: ["Leave on 22 November, three nights.", "Train there, bikes round the lake."], see: "Costs are in ", link: "Budget", tag: "#travel" },
    backlinks: [["Week in review", "Journal/2026-11-12.md:4", "Saturday: book the tickets for [[Dali trip]]."], ["Budget", "Travel/Budget.md:2", "Rooms and trains for [[Dali trip]]."]],
    ticket: ["HOME-12", "Book the train to Dali", "travel"],
    ask: "When do we leave for Dali?",
    answer: "On 22 November, for three nights.",
    from: "Travel/Dali trip.md"
  },
  zh: {
    title: "看板旁边，就是你的笔记本",
    about: "每个项目自带一个文件夹；笔记互相链接、挂到工单上，你的 Agent 也读得到。",
    hook: ["笔记一个应用，待办又一个？", "*看板旁边，就是你的笔记本。*"],
    steps: [
      [["每个项目自带文件夹：*笔记、文档、图片*都放这。", 0, 8]],
      [["笔记*互相链接*，还能*挂到工单上*。", 0, 8]],
      [["你的 Agent *也读得到*：先查笔记，再回答。", 0, 8]]
    ],
    why: "写过一遍的，\n*不用再讲一遍*。",
    tree: [["Journal", 0, true], ["2026-11-12.md", 1, false], ["旅行", 0, true], ["大理行程.md", 1, false], ["预算.md", 1, false], ["路线图.html", 0, false]] as [string, number, boolean][],
    open: 3,
    note: { title: "大理行程", lines: ["11 月 22 日出发，在古城住三晚。", "坐火车去，环湖骑车。"], see: "花销见 ", link: "预算", tag: "#旅行" },
    backlinks: [["周回顾", "Journal/2026-11-12.md:4", "周六：把 [[大理行程]] 的车票订了。"], ["预算", "旅行/预算.md:2", "[[大理行程]] 的住宿和车票。"]],
    ticket: ["HOME-12", "订去大理的火车票", "旅行"],
    ask: "去大理是哪天出发？",
    answer: "11 月 22 日出发，在古城住三晚。",
    from: "旅行/大理行程.md"
  }
} satisfies Record<Lang, Words & Record<string, unknown>>;

/** "Routines": something saved once and given a time; on the hour it files its tickets, or asks the assistant. */
export const ROUTINE_WORDS = {
  en: {
    title: "Routines",
    about: "Save what you ask for again and again; on its hour it files the tickets or asks the assistant.",
    hook: ["Something you ask for every single day?", "*Say it once.*"],
    steps: [
      [["Save it as *a routine*, and *give it a time.*", 0, 8]],
      [["On the hour, it *files the tickets itself.*", 0, 8]],
      [["Or it *asks the assistant*, and the answer waits for you.", 0, 8]]
    ],
    why: "What has to happen\n*happens without you asking.*",
    routines: [
      { name: "Daily to-dos", about: "The three things today is for.", next: "tomorrow 08:00", at: "08:00" },
      { name: "Weekend clean", about: "Kitchen, laundry, the bike.", next: "Sat 10:00", at: "10:00" },
      { name: "Week in review", about: "What got done? What is stuck?", next: "Fri 17:00", at: "17:00" }
    ],
    tickets: ["Renew the passport", "Book the dentist", "Plan Saturday's hike"],
    label: "home", column: "To Do", friday: "Fri",
    answer: "Nine tickets done this week. Two are stuck: the dentist needs a time from you, and the passport photo isn't taken."
  },
  zh: {
    title: "例行事务",
    about: "一遍遍要交代的事存一次；到点它自己建工单，或者去问助手。",
    hook: ["每天都要交代一遍的事？", "*说一次就够。*"],
    steps: [
      [["存成*例行事务*，再给它*定个时间*。", 0, 8]],
      [["到点，它*自己把工单建好*。", 0, 8]],
      [["或者到点*去问助手*，答案等你来看。", 0, 8]]
    ],
    why: "该做的事，\n*不用你每次开口*。",
    routines: [
      { name: "每日待办", about: "今天要办的三件事。", next: "明天 08:00", at: "08:00" },
      { name: "周末大扫除", about: "厨房、洗衣、修自行车。", next: "周六 10:00", at: "10:00" },
      { name: "本周复盘", about: "这周做完了什么？还有什么卡着？", next: "周五 17:00", at: "17:00" }
    ],
    tickets: ["续签护照", "约牙医", "规划周六爬山"],
    label: "日常", column: "待办", friday: "周五",
    answer: "这周完成了 9 张工单。还卡着两件：约牙医要你选个时间，护照照片还没拍。"
  }
} satisfies Record<Lang, Words & Record<string, unknown>>;

/** "Diagrams": one sentence, and Archify's diagram is in the conversation; a path traced, a change said, and it is saved with its source. */
export const ARCHIFY_WORDS = {
  en: {
    title: "Diagrams from one sentence",
    about: "Say what you want to see and Archify draws it: zoom in, trace a path, and change it by saying so.",
    hook: ["Diagrams by *dragging boxes?*", "*Say it. It draws.*"],
    steps: [
      [["Say what you want to see. *It appears in the conversation.*", 0, 8]],
      [["Drag it, zoom it, and *light up one path.*", 0, 8]],
      [["Want a change? *Just say so.*", 0, 4.4], ["Saved to Files, *with its source beside it.*", 4.5, 8]]
    ],
    why: "Five kinds of diagram.\n*One sentence each.*",
    ask: "Draw the architecture of Paperplane's billing",
    change: "Put a queue between the API and the PDF renderer",
    name: "billing.html", folder: "Assistant", boundary: "Paperplane · billing",
    nodes: { web: ["Web app", "Invoices page"], api: ["API", "Invoice service"], db: ["Database", "Invoices, numbers"], pdf: ["PDF renderer", "Invoice template"], mail: ["Mail service", "To the customer"], queue: ["Queue", "Background PDFs"] },
    edges: { order: "request", write: "write", render: "render", send: "send", push: "enqueue", pull: "take" }
  },
  zh: {
    title: "一句话画图",
    about: "说一句想看什么，Archify 就画出来：能缩放、能追踪路径，想改接着说。",
    hook: ["画架构图，*还在自己拖框框*？", "*说一句，让它画。*"],
    steps: [
      [["说一句想看什么，图*直接出现在对话里*。", 0, 8]],
      [["能拖、能缩放，*一条路径点亮给你看*。", 0, 8]],
      [["想改？*接着说就行*。", 0, 4.4], ["存进文件，*源文件一起留着*。", 4.5, 8]]
    ],
    why: "架构图、流程图、时序图……\n*一句话一张*。",
    ask: "画一张纸飞机的账单架构图",
    change: "在 API 和 PDF 渲染之间加一个队列",
    name: "billing.html", folder: "Assistant", boundary: "纸飞机 · 账单",
    nodes: { web: ["Web 应用", "账单页面"], api: ["API", "发票服务"], db: ["数据库", "发票与编号"], pdf: ["PDF 渲染", "发票模板"], mail: ["邮件服务", "发给客户"], queue: ["队列", "后台出 PDF"] },
    edges: { order: "请求", write: "写入", render: "渲染", send: "发送", push: "入队", pull: "取出" }
  }
} satisfies Record<Lang, Words & Record<string, unknown>>;

/** "Anywhere": one ticket taken up in three places, and Tomrade's record of all of it. */
export const ANYWHERE_WORDS = {
  en: {
    title: "Work anywhere, one record",
    about: "A pane in Tomrade, another terminal, Cursor: wherever the agent works, the ticket keeps the record.",
    hook: ["Do the work *wherever you like.*", "*Tomrade keeps the books.*"],
    steps: [
      [["Its own terminal, another one, Cursor: *any of them.*", 0, 8]],
      [["Whoever claims it, *the board says so by itself.*", 0, 8]],
      [["Who did what, for how long, what shipped: *all on the ticket.*", 0, 8]]
    ],
    why: "Change tools.\n*Keep one record.*",
    ticket: ["APP-55", "Pay by bank transfer", "billing"],
    places: [
      { name: "Tomrade Terminal", agent: "Claude Code", at: "09:40", lines: ["tomrade  claim_ticket APP-55", "git switch -c app-55/bank-transfer", "wrote 5 files · 12 tests pass"] },
      { name: "iTerm", agent: "Codex", at: "14:05", lines: ["tomrade  claim_ticket APP-55", "read src/billing/transfer.ts", "matched transfers by reference"] },
      { name: "Cursor", agent: "Cursor", at: "20:30", lines: ["tomrade · claim_ticket APP-55", "fixed rounding in amounts", "gh pr create  →  #232"] }
    ],
    rail: ["To Do", "Doing", "Verifying"],
    note: "Claim, branch, pull request: the board follows git. Nobody drags a card.",
    sessions: [
      { when: "09:40–10:28", outcome: "Built the transfer model, with 12 tests.", commits: 3, asked: 0 },
      { when: "14:05–14:52", outcome: "Matched bank references and added reconciliation.", commits: 3, asked: 2 },
      { when: "20:30–20:47", outcome: "Fixed amount rounding and opened PR #232.", commits: 2, asked: 0 }
    ]
  },
  zh: {
    title: "活在哪儿干都行，账记在 Tomrade",
    about: "Tomrade 的终端格子、别的终端、Cursor：Agent 在哪儿干都行，账都记在工单上。",
    hook: ["活，*在哪儿干都行*。", "*账，记在 Tomrade 上。*"],
    steps: [
      [["自带的终端、别的终端、Cursor：*都行*。", 0, 8]],
      [["谁认领了、做到哪了，*看板自己记上*。", 0, 8]],
      [["谁做的、做了多久、交了什么：*都在工单上*。", 0, 8]]
    ],
    why: "工具随便换，\n*账本只有一本*。",
    ticket: ["APP-55", "支持银行转账付款", "账单"],
    places: [
      { name: "Tomrade 终端", agent: "Claude Code", at: "09:40", lines: ["tomrade  claim_ticket APP-55", "git switch -c app-55/bank-transfer", "写入 5 个文件 · 12 个测试通过"] },
      { name: "iTerm", agent: "Codex", at: "14:05", lines: ["tomrade  claim_ticket APP-55", "读取 src/billing/transfer.ts", "按附言对上了转账"] },
      { name: "Cursor", agent: "Cursor", at: "20:30", lines: ["tomrade · claim_ticket APP-55", "修正金额舍入", "gh pr create  →  #232"] }
    ],
    rail: ["待办", "进行中", "验证中"],
    note: "认领、开分支、提 PR：看板跟着 git 走，不用谁去拖卡片。",
    sessions: [
      { when: "09:40–10:28", outcome: "建好了转账模型，写了 12 个测试。", commits: 3, asked: 0 },
      { when: "14:05–14:52", outcome: "按附言对上了银行转账，补了对账。", commits: 3, asked: 2 },
      { when: "20:30–20:47", outcome: "修了金额舍入，提了 PR #232。", commits: 2, asked: 0 }
    ]
  }
} satisfies Record<Lang, Words & Record<string, unknown>>;

/** "Take over": a repository's unfinished work is read into a draft, and what is ticked becomes tickets. */
export const TAKEOVER_WORDS = {
  en: {
    title: "Take over unfinished work",
    about: "Point it at a repository: it finds the branches, worktrees and issues you left, and you tick what becomes a ticket.",
    hook: ["A repo full of *half-done work?*", "*Let it dig it up.*"],
    steps: [
      [["An empty backlog? *The repository isn't.*", 0, 3.4], ["The scan *only reads*: nothing is changed.", 3.5, 8]],
      [["Forgotten branches, idle worktrees, issues: *all found.*", 0, 4.4], ["Only *what you tick* becomes a ticket.", 4.5, 8]],
      [["One click, and *they are in the backlog.*", 0, 8]]
    ],
    why: "What you started\n*doesn't get lost.*",
    repo: "paperplane", base: "main", column: "To Do", label: "billing",
    entries: [
      { title: "Header on the invoice PDF", sources: [["branch", "app-49/invoice-header", "3", "2 Nov"]] },
      { title: "Usage page, totals by month", sources: [["branch", "usage-monthly", "5", "28 Oct"], ["worktree", "~/paperplane-wt/usage", "4", ""]] },
      { title: "CSV export drops the last row", sources: [["issue", "#128", "@mira", ""]] },
      { title: "Unfinished work in spike", sources: [["worktree", "~/paperplane-wt/spike", "2", ""]] }
    ] as { title: string; sources: [string, string, string, string][] }[]
  },
  zh: {
    title: "接管没做完的活",
    about: "指向一个仓库：它找出你留下的分支、worktree 和 Issue，你勾选的才变成工单。",
    hook: ["仓库里，*躺着多少没做完的活*？", "*让它自己翻出来。*"],
    steps: [
      [["需求池是空的？*仓库里可不是*。", 0, 3.4], ["扫描*只读取*，什么都不改。", 3.5, 8]],
      [["忘了的分支、闲置的 worktree、Issue：*全翻出来*。", 0, 4.4], ["*你勾选的*，才会变成工单。", 4.5, 8]],
      [["点一下，*它们回到需求池*。", 0, 8]]
    ],
    why: "开了头的活，\n*一件都丢不了*。",
    repo: "paperplane", base: "main", column: "待办", label: "账单",
    entries: [
      { title: "发票 PDF 的页眉", sources: [["branch", "app-49/invoice-header", "3", "11月2日"]] },
      { title: "用量页面按月汇总", sources: [["branch", "usage-monthly", "5", "10月28日"], ["worktree", "~/paperplane-wt/usage", "4", ""]] },
      { title: "导出 CSV 少了最后一行", sources: [["issue", "#128", "@mira", ""]] },
      { title: "spike 里没做完的改动", sources: [["worktree", "~/paperplane-wt/spike", "2", ""]] }
    ] as { title: string; sources: [string, string, string, string][] }[]
  }
} satisfies Record<Lang, Words & Record<string, unknown>>;

/** What the takeover's draft says of where an entry came from: the plugin's own words (packages/takeover/src/words.ts), which the interface's dictionary does not carry. */
export const TAKEOVER_SOURCE = {
  en: { branch: "Branch", worktree: "Worktree", issue: "Issue", branchDetail: "ahead of {{base}} by {{ahead}}, last commit {{date}}", worktreeDirty: "uncommitted files: {{n}}", issueDetail: "opened by {{who}}" },
  zh: { branch: "分支", worktree: "Worktree", issue: "Issue", branchDetail: "领先 {{base}} {{ahead}} 个提交，最后提交于 {{date}}", worktreeDirty: "{{n}} 个文件未提交", issueDetail: "{{who}} 提出" }
} as const satisfies Record<Lang, Record<string, string>>;

/** "IM": a bot connected and paired, a sentence in the chat that becomes a ticket, and the ticket's own topic reporting back. */
export const IM_WORDS = {
  en: {
    title: "The assistant in your chat app",
    about: "Connect a bot, pair with a code, and message the assistant from Discord, Slack, Telegram or Lark.",
    hook: ["Opening the laptop *just to say one thing?*", "*Say it in your chat app.*"],
    steps: [
      [["Connect *a bot* in settings,", 0, 3.9], ["send it the pairing code, and *you're in.*", 4, 8]],
      [["Say it in the chat: *a new ticket on the board.*", 0, 4.4], ["One */start*, and your computer gets to work.", 4.5, 8]],
      [["In a channel, *every ticket has its own thread,*", 0, 3.9], ["and it *reports back by itself.*", 4, 8]]
    ],
    why: "In the chat app you already use,\n*the assistant is there.*",
    platform: "Discord", bot: "Tomrade", id: "paperplane-bot", me: "Mira", project: "Paperplane", code: "7K4-92Q",
    // what the bot says: the IM plugin's own words (packages/im/src/words.ts)
    received: "Code received. Confirm the pairing in Tomrade on your computer.",
    paired: "Paired with Tomrade. Send a message to start.",
    dm: "Direct message", channel: "# paperplane-work",
    ask: "The header on the invoice PDF is wrong. File a ticket.",
    filed: "Filed APP-58 “Fix the header on the invoice PDF”. It's in To Do.",
    ticket: ["APP-58", "Fix the header on the invoice PDF", "billing"],
    start: "/start APP-58",
    started: "Started APP-58 with Claude Code.",
    follow: "Its progress and questions come to its thread.",
    column: "To Do", doing: "Doing",
    topic: "This thread follows APP-58: its status, code and deliveries come here, and you can talk about it here.",
    states: ["Doing", "Verifying", "Done"],
    news: ["Status: Doing · Session: Running", "Pull request #236 opened", "Merged"],
    archived: "archived"
  },
  zh: {
    title: "聊天软件里的助手",
    about: "接一个机器人，发个配对码，就能在 Discord、Slack、Telegram、飞书里给助手发消息。",
    hook: ["为了说一句话，*专门开电脑*？", "*在聊天软件里说就行。*"],
    steps: [
      [["在设置里*接一个机器人*，", 0, 3.9], ["私聊发个配对码，*就连上了*。", 4, 8]],
      [["在聊天里说一句，*看板上多一张工单*。", 0, 4.4], ["一句 */start*，电脑就开工。", 4.5, 8]],
      [["群里*每张工单一个话题*，", 0, 3.9], ["做到哪了，*它自己来报*。", 4, 8]]
    ],
    why: "你常用的聊天软件里，\n*就有助手*。",
    platform: "Discord", bot: "Tomrade", id: "paperplane-bot", me: "Mira", project: "纸飞机", code: "7K4-92Q",
    received: "已收到配对码，请在电脑上的 Tomrade 中确认配对。",
    paired: "已与 Tomrade 配对，发消息即可开始。",
    dm: "私聊", channel: "# 纸飞机-工作",
    ask: "发票 PDF 的抬头错了，记一张工单。",
    filed: "已建工单 APP-58「修正发票 PDF 的抬头」，放在待办里了。",
    ticket: ["APP-58", "修正发票 PDF 的抬头", "账单"],
    start: "/start APP-58",
    started: "已用 Claude Code 开工 APP-58。",
    follow: "它的进度和问题会发到它的话题里。",
    column: "待办", doing: "进行中",
    topic: "这个话题跟进 APP-58：它的状态、代码和交付都发到这里，也可以在这里讨论它。",
    states: ["进行中", "待验收", "已完成"],
    news: ["状态：进行中 · 编码会话：运行中", "已开 PR #236", "已合并"],
    archived: "已归档"
  }
} satisfies Record<Lang, Words & Record<string, unknown>>;

export type FeatureWords = Words;
