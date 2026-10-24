export const projectBrief = {
  en: {
    label: "Project brief",
    lede: "What every agent is told about this product before it plans or writes anything: what it is, the stack, where its data comes from, the vocabulary. Agents write it as they learn; correct it here and they start from your words.",
    placeholder: "Nothing written yet. An agent fills this in when it first reads the repository, or write it yourself: what the product is, the stack and commands, where the data comes from, what is managed here and what is fetched.",
    count: "{{n}} / {{max}} characters — every run reads it, so shorter is cheaper",
    updated: "Last updated {{when}}",
    never: "Not written yet",
    save: "Save brief",
    revert: "Revert",
    saved: "Brief saved — every new turn starts from it.",
    restore: "Back to the previous version",
    restored: "The previous brief is back; the one it replaced is kept one step back.",
    compact: "Compact with the worker model",
    compacting: "Compacting…",
    compacted: "Brief compacted to {{n}} characters, facts kept; the long one is one step back."
  },
  zh: {
    label: "项目简报",
    lede: "每个智能体在规划或动手之前都会读到的项目认识：产品是什么、技术栈、数据从哪来、领域词汇。智能体边了解边写；在这里改正，它们就从你的话开始。",
    placeholder: "还没有内容。智能体第一次读仓库时会写入，你也可以自己写：产品是什么、技术栈和命令、数据从哪来、哪些在本地维护、哪些是拉取的。",
    count: "{{n}} / {{max}} 字符。每一轮运行都会读它，越短越省",
    updated: "最近更新 {{when}}",
    never: "尚未写入",
    save: "保存简报",
    revert: "还原",
    saved: "简报已保存，之后的每一轮都从它开始。",
    restore: "回到上一版",
    restored: "已回到上一版，被替换的那版保留为上一版。",
    compact: "用 worker 模型压缩",
    compacting: "压缩中…",
    compacted: "简报已压缩到 {{n}} 字符，事实保留；长版本留在上一版。"
  }
};
