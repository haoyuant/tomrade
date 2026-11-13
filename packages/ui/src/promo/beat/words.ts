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
