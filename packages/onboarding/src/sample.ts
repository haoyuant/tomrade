import type { SeedLocale } from "@tomradex/db";

/** One ticket of the sample, keyed so the learning path can name it in either language. */
export interface SampleTicket {
  key: string;
  title: string;
  body: string;
}

export interface SampleWords {
  name: string;
  description: string;
  /** The workstream the tour tickets live in. */
  tour: string;
  /** The workstream the tour's exercises act on. */
  example: string;
  /** The graph view drawing the tour's dependencies. */
  path: string;
  tickets: SampleTicket[];
  examples: SampleTicket[];
}

/**
 * The learning path, blocker first. A needs nothing set up, B needs a model,
 * C a local coding agent; A1 opens all three.
 */
export const PATH: readonly [string, string][] = [
  ["a1", "a2"],
  ["a2", "a3"],
  ["a3", "a4"],
  ["a1", "b1"],
  ["b1", "b2"],
  ["b2", "b3"],
  ["b3", "b4"],
  ["a1", "c1"],
  ["c1", "c2"]
];

const en: SampleWords = {
  name: "Tomrade tour",
  description: "A project that teaches Tomrade with its own tickets. It lives on this computer only — delete it whenever you like.",
  tour: "Getting started",
  example: "Example: Pomodoro app",
  path: "Learning path",
  tickets: [
    {
      key: "a1",
      title: "Drag this ticket to Done",
      body: `Welcome to Tomrade. This project is the tutorial: each ticket in **Getting started** teaches one thing, and you finish it by moving it to Done.

- The sidebar holds your workstreams, views and files; the board is in the middle; the assistant is on the right.
- The tickets are linked by *blocks*, so they form a path — the next ticket shows you how to see it.
- This project stays on this computer and never syncs to your account. Delete it from its project settings when you are done.

**Now:** move this card to Done. Drag it to the right — the board scrolls on its own when you hold it near the edge — or open it and set **Status** to Done.`
    },
    {
      key: "a2",
      title: "Open the Learning path view",
      body: `Every ticket here blocks the ones that come after it. The **Learning path** view in the sidebar draws that as a graph.

1. Click **Learning path** under Views.
2. Follow the arrows: a ticket whose blockers are all done is ready to do. Arrows from finished tickets fade.
3. Any view can be drawn this way — switch its layout to Graph in the title bar.

Then move this ticket to Done.`
    },
    {
      key: "a3",
      title: "Write a note and add it to this ticket",
      body: `Files and notes are plain text in the project's folder, so you can read, back up and commit them.

1. In the sidebar, next to **Files**, click **+** → **New note** and write a few lines.
2. In the note's toolbar, click **Add to a ticket…** and pick this ticket.
3. ⇧⌘F searches every note.

The note now shows on this ticket.`
    },
    {
      key: "a4",
      title: "Add a field and save a view",
      body: `Fields decide what each ticket records; views decide how you look at them.

1. Click **Fields** at the bottom of the sidebar and add a field — say *Estimate*, a number.
2. On the board, filter the workstream to **Example: Pomodoro app**, then choose **Save as new…** in the filter bar.

The new view stays in the sidebar.`
    },
    {
      key: "b1",
      title: "Connect a model",
      body: `The assistant needs a language model to talk, tidy the backlog and plan work. A model also runs the **built-in agent**, so Start works with nothing else installed.

1. In the setup card at the top of the assistant panel — or Settings → **Assistant** — pick a provider: DeepSeek, Kimi, Anthropic, OpenAI, OpenRouter, or Ollama on this computer, which needs no key.
2. Paste the API key and click **Connect**. Tomrade checks it and picks a model.

Signed in to Claude Code, WorkBuddy or Codex? Then this is already done: the assistant runs on it and plans with its model.`
    },
    {
      key: "b2",
      title: "Let the assistant tidy the example backlog",
      body: `**Example: Pomodoro app** has a duplicate ticket and one that is far too big, on purpose.

1. In the assistant panel, pick **Tidy up the backlog** — or ask: *Tidy the Example: Pomodoro app workstream*.
2. Watch it merge the duplicate and split the big one. Cards it changed carry the AI mark.
3. When the run ends, its footer says how many things changed.`
    },
    {
      key: "b3",
      title: "Undo what the assistant just did",
      body: `Every write the assistant makes can be taken back.

- **Revert** in a run's footer undoes that whole run at once.
- **History** — the clock in the title bar — lists every write and rolls back to any of them. ⌘Z undoes the newest.

After the undo the example backlog is as it was.`
    },
    {
      key: "b4",
      title: "Turn an idea into tickets",
      body: `Type *I want to build …* in the assistant panel and describe an idea of your own.

The assistant asks a few questions, then plans it as a set of tickets with dependencies in a new workstream. Not what you wanted? Revert it like any other run.

The plan is written by your model — or, with no model connected, by the local agent you are signed in to: Claude Code, WorkBuddy, Codex or Gemini CLI.`
    },
    {
      key: "c1",
      title: "Hand a ticket to a local agent with Start",
      body: `**Start** gives a ticket to an agent on this computer, which works on it in the background.

1. With a model connected, the **built-in agent** is ready — nothing to install. Claude Code or Codex work too, once installed and signed in.
2. Open **Write a one-page user guide** in the example workstream and click **Start**.
3. When it is done it submits its result for review. The ticket is finished when you accept it.`
    },
    {
      key: "c2",
      title: "Link a repository and let an agent write code (optional)",
      body: `Only if you write code — otherwise drag this to Done.

1. Project settings → **Repositories**: add a git repository and choose its checkout on this computer.
2. Sidebar → **Fields** → the workstream: point a workstream at that repository.
3. Start a ticket in that workstream: the agent works on its own branch and worktree, and opens a pull request when it is done.`
    }
  ],
  examples: [
    { key: "e1", title: "Timer: start, pause and reset", body: "The 25-minute timer every other feature hangs on." },
    { key: "e2", title: "Remind me to take a break when a pomodoro ends", body: "A notification and a sound when the 25 minutes are up, then a 5-minute break timer." },
    { key: "e3", title: "Count the pomodoros finished each day", body: "A daily tally on the main screen, kept for the last 30 days." },
    { key: "e4", title: "Daily pomodoro count", body: "Show how many pomodoros I finished today." },
    {
      key: "e5",
      title: "Settings page",
      body: "Work and break lengths, a long break every 4 rounds, sounds and volume, themes, keyboard shortcuts, launch at login, CSV export, and sync across devices."
    },
    {
      key: "e6",
      title: "Write a one-page user guide",
      body: "One page for a first-time user: what a pomodoro is, how to start, pause and reset, and where the settings are. Save it as a note in Files."
    }
  ]
};

const zh: SampleWords = {
  name: "Tomrade 入门",
  description: "用 Tomrade 自己的工作项教你用 Tomrade。只存在这台电脑上，随时可以删掉。",
  tour: "入门",
  example: "示例：番茄钟 App",
  path: "学习路径",
  tickets: [
    {
      key: "a1",
      title: "把这个工作项拖到「已完成」",
      body: `欢迎来到 Tomrade。这个项目本身就是教程：**入门**里的每个工作项教一个功能，做完就把它移到「已完成」。

- 左边是工作流、视图和文件，中间是看板，右边是助手。
- 这些工作项用 *blocks* 关系串成一条路径，下一个工作项会教你怎么看到它。
- 这个项目只在这台电脑上，不会同步到账号。学完可以在项目设置里删掉。

**现在**：把这张卡片移到「已完成」。往右拖，拖到看板边缘停一下，看板会自己滚过去；或者打开它，把**状态**改成「已完成」。`
    },
    {
      key: "a2",
      title: "打开「学习路径」视图",
      body: `这里的每个工作项都卡着后面的工作项。侧边栏视图里的 **学习路径** 把这种关系画成关系图。

1. 点视图里的 **学习路径**。
2. 顺着箭头看：前置都完成了的工作项就可以做了，从已完成的工作项出发的箭头会变淡。
3. 任何视图都可以这样画——在标题栏把布局切到「关系图」。

然后把这个工作项移到「已完成」。`
    },
    {
      key: "a3",
      title: "写一篇笔记，添加到这个工作项上",
      body: `文件和笔记都是项目文件夹里的纯文本，可以直接阅读、备份和提交。

1. 在侧边栏 **文件** 旁边点 **+** → **新建笔记**，随便写几句。
2. 在笔记的工具栏里点 **添加到工作项…**，选中这个工作项。
3. ⇧⌘F 可以搜索所有笔记。

这篇笔记就会出现在这个工作项上。`
    },
    {
      key: "a4",
      title: "加一个字段，存一个视图",
      body: `字段决定每个工作项记录什么，视图决定你怎么看这些工作项。

1. 点侧边栏底部的 **字段**，加一个字段，比如数字类型的「预计时长」。
2. 在看板上把工作流筛选成 **示例：番茄钟 App**，再点筛选栏里的 **另存为新视图…**。

新视图会一直留在侧边栏。`
    },
    {
      key: "b1",
      title: "接上一个模型",
      body: `助手需要一个语言模型，才能对话、整理 backlog、规划工作。接上模型后，**内置智能体**也能用了，「开始」不用再装别的东西。

1. 在助手面板顶部的设置卡片里（或设置 → **助手**）选一个服务商：DeepSeek、Kimi、Anthropic、OpenAI、OpenRouter，或者本机的 Ollama（不需要 key）。
2. 粘贴 API key，点 **连接**。Tomrade 会检查它并选好模型。

已经登录了 Claude Code、WorkBuddy 或 Codex？那这一步已经完成了：助手会用它来对话，也用它的模型来规划。`
    },
    {
      key: "b2",
      title: "让助手整理示例 backlog",
      body: `**示例：番茄钟 App** 里故意放了一个重复的工作项和一个太大的工作项。

1. 在助手面板里点 **整理一下 backlog**，或者直接说：*整理「示例：番茄钟 App」这个工作流*。
2. 看它合并重复的工作项、拆开太大的工作项。它改过的卡片会带 AI 标记。
3. 运行结束时，底部会写明改了几处。`
    },
    {
      key: "b3",
      title: "撤销助手刚才的修改",
      body: `助手的每一次写入都可以撤回。

- 点那次运行底部的 **撤销**，整次运行一起撤回。
- **历史**——标题栏上的时钟——列出每一次写入，可以回滚到任意一条。⌘Z 撤销最近的一次。

撤销之后，示例 backlog 会回到原样。`
    },
    {
      key: "b4",
      title: "把一个想法拆成工作项",
      body: `在助手面板里输入「我想做一个……」，说说你自己的想法。

助手会先问几个问题，再把它规划成一组带依赖关系的工作项，放进一个新的工作流。不满意的话，像其他运行一样撤销就行。

规划由你接上的模型来写；没接模型时，由你登录的本地智能体来写：Claude Code、WorkBuddy、Codex 或 Gemini CLI。`
    },
    {
      key: "c1",
      title: "用「开始」把一个工作项交给本地智能体",
      body: `**开始** 把一个工作项交给这台电脑上的智能体，在后台完成。

1. 接上模型后，**内置智能体**就能用，不用安装任何东西。Claude Code 或 Codex 装好并登录后也可以。
2. 打开示例工作流里的 **写一页使用说明**，点 **开始**。
3. 做完后它会提交成果等你验收。你接受了，这个工作项才算完成。`
    },
    {
      key: "c2",
      title: "绑定仓库，让智能体写代码（可选）",
      body: `写代码的人才需要这一张，否则直接拖到「已完成」。

1. 项目设置 → **代码仓库**：添加一个 git 仓库，选好它在这台电脑上的 checkout。
2. 侧边栏 → **字段** → 工作流：让某个工作流指向这个仓库。
3. 在这个工作流里的工作项上点 **开始**：智能体会在独立的分支和工作树里改代码，做完开 PR。`
    }
  ],
  examples: [
    { key: "e1", title: "计时器：开始、暂停、重置", body: "其他功能都依赖的 25 分钟计时器。" },
    { key: "e2", title: "一个番茄结束时提醒我休息", body: "25 分钟到了弹出通知并响铃，然后开始 5 分钟的休息计时。" },
    { key: "e3", title: "统计每天完成的番茄数", body: "主界面显示当天完成的数量，保留最近 30 天。" },
    { key: "e4", title: "每日番茄数统计", body: "显示我今天完成了几个番茄。" },
    { key: "e5", title: "设置页", body: "工作和休息时长、每 4 轮一次长休息、提示音和音量、主题、快捷键、开机启动、导出 CSV、多设备同步。" },
    { key: "e6", title: "写一页使用说明", body: "给第一次用的人写一页说明：什么是番茄钟，怎么开始、暂停、重置，设置在哪里。存成「文件」里的一篇笔记。" }
  ]
};

export const SAMPLE: Record<SeedLocale, SampleWords> = { en, zh };
