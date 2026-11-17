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

export type FeatureWords = Words;
