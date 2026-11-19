import type { Lang } from "../words";

/** The poster film's words: most land one to a beat. */
export const POSTER_WORDS = {
  en: {
    have: ["You have", "a lot of", "agents."], write: ["They", "write", "fast."], who: ["But", "who's", "watching", "them?"], you: "You.", each: ["One", "by one."],
    hand: ["Hand it", "over."], verbs: ["Talk", "Split", "Build", "Merge"], own: ["They claim their own tickets.", "And report back."], no: ["No", "baby-", "sitting."],
    ask: ["They only ask", "when it's", "your call."], ok: "Done.", sleep: "You sleep.", merged: "merged", count: "Eight.", dawn: ["Good", "mor", "ning", "."], facts: ["Local.", "Free.", "Open."]
  },
  zh: {
    have: ["你有", "一堆", "Agent。"], write: ["它们", "很能", "写。"], who: ["可是", "谁来", "盯着", "它们？"], you: "你。", each: ["挨个", "盯着。"],
    hand: ["把活", "交出去。"], verbs: ["说", "拆", "做", "合"], own: ["它们自己认领。", "自己汇报。"], no: ["不用", "你", "盯。"],
    ask: ["只有", "要你拍板时", "才来找你。"], ok: "好。", sleep: "你睡觉。", merged: "已合并", count: "8 个。", dawn: ["天", "亮", "了", "。"], facts: ["本地。", "免费。", "开源。"]
  }
} as const satisfies Record<Lang, Record<string, string | readonly string[]>>;

/** The lantern film's lines, each with the beats it is up from and until. */
export const RIVER_LINES: Record<Lang, [string, number, number][]> = {
  en: [
    ["Eleven at night.", 0, 3.6], ["You turn what you want into eight tickets.", 4, 9.6], ["And you go to bed.", 10, 13.6],
    ["Agents claim them, branch, and write the code.", 14, 18.6], ["Only what passes its checks is merged.", 19, 24.6],
    ["The one it isn't sure about, it keeps for you.", 25, 29.6], ["Morning.", 30, 33.6], ["Seven merged. One question waiting.", 34, 37.6], ["You answer in a word.", 38, 40.6]
  ],
  zh: [
    ["晚上十一点。", 0, 3.6], ["你把想做的事，交代成八张工单。", 4, 9.6], ["然后，去睡了。", 10, 13.6],
    ["Agent 各自认领，开分支，写代码。", 14, 18.6], ["过了检查的，才会合并。", 19, 24.6],
    ["拿不准的那一件，它留着等你。", 25, 29.6], ["天亮了。", 30, 33.6], ["七个已经合并，一个问题在等你。", 34, 37.6], ["你答了一句。", 38, 40.6]
  ]
};

/** What the terminal film types and prints. */
export const TTY_WORDS = {
  en: {
    who: "babysitter", waits: "waiting on you (y/n)", count: "WAITING ON YOU", facts: "# local-first · no account · free and open source",
    columns: ["To Do", "Doing", "Verifying", "Done"], notes: ["# agents claim, branch and open the PR themselves", "# they only ask when it's your call", "# merged only when checks pass"],
    claim: "claimed", pr: "opened PR", merge: "checks pass, merged", ask: "codex › match transfers by reference or by amount? [1/2] ", merged: "merged", after: "someone who slept all night"
  },
  zh: {
    who: "保姆", waits: "等你回答 (y/n)", count: "等你回答", facts: "# 本地优先 · 不用注册 · 免费开源",
    columns: ["待办", "进行中", "验证中", "完成"], notes: ["# Agent 自己认领、开分支、提 PR", "# 只在要你拍板时才问", "# 检查通过才合并"],
    claim: "认领了", pr: "提了 PR", merge: "检查通过，已合并", ask: "codex › 银行转账按附言还是按金额对账？[1/2] ", merged: "已合并", after: "睡了一整晚的人"
  }
} as const satisfies Record<Lang, Record<string, string | readonly string[]>>;

/** The sequencer film's captions, each with the beats it is up from and until, and the machine's own labels. */
export const SEQ_WORDS = {
  en: {
    lines: [["Say one sentence.", -2, 3.8], ["It becomes *eight tickets.*", 4, 7.8], ["Agents *claim them* and branch.", 8, 15.8], ["Pull requests, checks. *The board keeps up.*", 16, 26.3], ["Only this beat *waits for you.*", 26.5, 27.9], ["One tap, and *it goes on.*", 28, 31.8], ["Go to bed. *Auto run* merges all night.", 32, 43.8], ["*N pull requests.* You watched none.", 44, 48]] as [string, number, number][],
    rows: ["To Do", "Doing", "Verifying", "Done"], run: "AUTO RUN", merged: "merged", facts: "Local-first · No account · Free and open source"
  },
  zh: {
    lines: [["说一句话。", -2, 3.8], ["它被拆成*八张工单*。", 4, 7.8], ["Agent *自己认领*，开分支。", 8, 15.8], ["提 PR，过检查。*看板自己跟上。*", 16, 26.3], ["只有这一拍，*等你*。", 26.5, 27.9], ["你点一下，*接着走*。", 28, 31.8], ["去睡吧。*自动运行*，一夜合并。", 32, 43.8], ["*N 个 PR*，一个没让你盯。", 44, 48]] as [string, number, number][],
    rows: ["待办", "进行中", "验证中", "完成"], run: "自动运行", merged: "已合并", facts: "本地优先 · 不用注册 · 免费开源"
  }
};

/** The metro film: its captions by beat, its stations, and the map's small print. */
export const METRO_WORDS = {
  en: {
    lines: [["Every agent, *a line of its own.*", -2, 7.8], ["Claim, branch, pull request, checks: *stop by stop, on their own.*", 8, 19.8], ["The map *updates itself.*", 20, 23.8], ["One station is yours: *your call.*", 24, 31.5], ["Last train? There isn't one. *Auto run* goes all night.", 32, 41.3], ["Terminus: *N pull requests, merged.*", 41.5, 48]] as [string, number, number][],
    stops: ["To Do", "Claim", "Branch", "PR", "Checks", "Merge", "Done"], you: "You", title: "Tomrade lines", any: "any MCP agent", night: "night service · auto run", merged: "merged", facts: "Local-first · No account · Free and open source"
  },
  zh: {
    lines: [["每个 Agent，*一条线*。", -2, 7.8], ["认领、开分支、提 PR、过检查，*一站一站自己走*。", 8, 19.8], ["线路图*自己更新*，不用你报站。", 20, 23.8], ["只有一站要换乘：*等你拍板*。", 24, 31.5], ["末班车？没有。*自动运行*跑通宵。", 32, 41.3], ["终点站：*N 个 PR，已合并*。", 41.5, 48]] as [string, number, number][],
    stops: ["待办", "认领", "开分支", "提 PR", "检查", "合并", "完成"], you: "你", title: "Tomrade 线路图", any: "任何 MCP Agent", night: "夜间线路 · 自动运行", merged: "已合并", facts: "本地优先 · 不用注册 · 免费开源"
  }
};

/** The keys film: what each key is for, one or two bars each. */
export const KEY_WORDS = {
  en: {
    hook: ["With Tomrade,", "it's a few keys."],
    slots: [
      { title: "Say it", sub: "One sentence becomes a ticket" }, { title: "Say \"split\"", sub: "One becomes five, a pull request each" }, { title: "Find anything", sub: "Tickets · Files · Notes · Commands" },
      { title: "Split the terminal", sub: "Claude Code, Codex, a shell: one window" }, { title: "It asks, you press one key", sub: "Only when it's your call" }, { title: "Take the whole run back", sub: "Every agent write carries its name" }
    ],
    rest: "The rest takes *no keys at all.*", night: "Auto run merges overnight, once checks pass", merged: "merged", facts: "Local-first · No account · Free and open source"
  },
  zh: {
    hook: ["用 Tomrade，", "就这几个键。"],
    slots: [
      { title: "说一句话", sub: "它变成一张工单" }, { title: "再说一句：拆", sub: "一张变五张，每张一个 PR" }, { title: "搜一切", sub: "工单 · 文件 · 笔记 · 命令" },
      { title: "终端分屏", sub: "Claude Code、Codex、shell，一个窗口" }, { title: "它问，你按一个键", sub: "只在要你拍板时才问" }, { title: "整次撤回", sub: "Agent 的每次修改，都记着是谁改的" }
    ],
    rest: "剩下的，*一个键都不用按*。", night: "自动运行，检查通过才合并，跑一整夜", merged: "已合并", facts: "本地优先 · 不用注册 · 免费开源"
  }
};

/** The phone film: the chat, who says each line, and the captions beside it by beat. */
export const PHONE_WORDS = {
  en: {
    chat: ["Switch sign-in to a magic link", "Ticket APP-61 created", "Codex claimed it and opened a branch", "PR #240: checks pass ✓", "Merge it?", "Merge", "Merged ✓ APP-61 is done", "And sort out the inbox", "3 pieces of feedback sorted. Replies drafted, waiting for your OK", "Send", "3 replies sent ✓"],
    apps: "Feishu · Slack · Telegram · Discord · DingTalk · WeCom", name: "Tomrade", merge: ["Merge", "Not yet"],
    lines: [["You're out. *Your computer is home.*", -2, 3.8], ["Say it *from your phone.*", 4, 8.8], ["At home, *the work starts.*", 9, 14.8], ["It only asks for *your nod.*", 15, 23.8], ["Feedback too: *sorted, drafted, yours to confirm.*", 24, 35.8], ["Straight from your computer. *No server of ours between.*", 36, 44]] as [string, number, number][],
    home: "at home", columns: ["To Do", "Doing", "Verifying", "Done"], facts: "Local-first · No account · Free and open source"
  },
  zh: {
    chat: ["把登录改成魔法链接", "已建工单 APP-61", "Codex 认领了，开了分支", "PR #240 检查通过 ✓", "要合并吗？", "合并", "已合并 ✓ APP-61 完成", "再把收件箱整理一下", "3 条反馈已分类，回复草稿写好了，等你确认", "发", "已回复 3 条 ✓"],
    apps: "飞书 · Slack · Telegram · Discord · 钉钉 · 企业微信", name: "Tomrade", merge: ["合并", "再等等"],
    lines: [["人在外面，*电脑在家*。", -2, 3.8], ["*手机上*说一句。", 4, 8.8], ["家里的电脑*开始干活*。", 9, 14.8], ["要你点头的，*才来问*。", 15, 23.8], ["用户反馈也一样：*分好类，写好稿，等你确认*。", 24, 35.8], ["直连你的电脑，*中间没有我们的服务器*。", 36, 44]] as [string, number, number][],
    home: "家里的电脑", columns: ["待办", "进行中", "验证中", "完成"], facts: "本地优先 · 不用注册 · 免费开源"
  }
};

/** The numbers film: a number to a bar, what it counts, and the line under it. How many agents and pull requests is N:
 * a figure there would read as a limit. */
export const NUMBER_WORDS = {
  en: {
    hook: "Tomrade, by the numbers.",
    slots: [
      ["1", "sentence", "Say it, and it's a ticket"], ["5", "tickets", "The assistant splits it, a pull request each"], ["N", "agents at once", "Claude Code · Codex · Cursor · any MCP agent"], ["1", "terminal window", "Split panes: who's running, who needs you"],
      ["1", "question", "They only ask when it's your call"], ["1", "click back", "Every agent write is named; a whole run undone"], ["N", "pull requests", "Auto run merges overnight, once checks pass"], ["0", "babysitting", "The board keeps up on its own"],
      ["0", "accounts", "Local-first: it lives on your machine"], ["0", "to pay", "Free and open source"], ["3", "systems", "macOS · Windows · Linux"]
    ] as [string, string, string][]
  },
  zh: {
    hook: "Tomrade，用数字说。",
    slots: [
      ["1", "句话", "说出来，就是一张工单"], ["5", "张工单", "助手拆好，每张刚好一个 PR"], ["N", "个 Agent 同时开工", "Claude Code · Codex · Cursor · 任何 MCP Agent"], ["1", "个终端窗口", "分屏看着它们：谁在跑，谁在等你"],
      ["1", "个问题", "只在要你拍板时，才来找你"], ["1", "键撤回", "Agent 的每次修改都记名，整次撤回"], ["N", "个 PR", "自动运行，检查通过才合并，一夜做完"], ["0", "次盯着", "看板自己跟上进度"],
      ["0", "个账号", "本地优先，数据就在你电脑上"], ["0", "元", "免费，开源"], ["3", "个系统", "macOS · Windows · Linux"]
    ] as [string, string, string][]
  }
};
