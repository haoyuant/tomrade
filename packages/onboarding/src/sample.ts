import type { SeedLocale } from "@tomradex/db";

/** One ticket of the sample, keyed so the learning path can name it in either language. */
export interface SampleTicket {
  key: string;
  title: string;
  body: string;
}

/** A piece of feedback waiting in the sample's inbox, for the triage exercise. */
export interface SampleFeedback {
  key: string;
  kind: "bug" | "feedback" | "idea";
  reporter: string;
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
  feedback: SampleFeedback[];
}

/**
 * The learning path, blocker first. A needs nothing set up, B needs a model,
 * C a local coding agent, D reaches past this window; A1 opens all four.
 */
export const PATH: readonly [string, string][] = [
  ["a1", "a2"],
  ["a2", "a3"],
  ["a3", "a4"],
  ["a4", "a5"],
  ["a5", "a6"],
  ["a6", "a7"],
  ["a1", "b1"],
  ["b1", "b2"],
  ["b2", "b3"],
  ["b3", "b4"],
  ["b4", "b5"],
  ["a1", "c1"],
  ["c1", "c2"],
  ["a1", "d1"],
  ["d1", "d2"],
  ["d2", "d3"],
  ["d3", "d4"]
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
3. Any view can be drawn this way — switch it to **Graph** in the row above the board, next to Board and Table.

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

1. Click **Fields** in the row above the board, next to **View**, and add a field — say *Estimate*, a number.
2. On the board, filter the workstream to **Example: Pomodoro app**, then choose **Save as new…** in the filter bar.

The new view stays in the sidebar.`
    },
    {
      key: "a5",
      title: "Find anything with ⌘K",
      body: `The command palette is the quickest way around: ⌘K, or **Search** in the title bar.

1. Press ⌘K and type part of a ticket's key or title — *pomodoro* — and press Enter to open it.
2. Type a file's name, or a command: *New ticket*, *Routines…*, *History*, a theme.
3. Press **?** anywhere outside a text box: the **Keyboard shortcuts** sheet lists every key, and **Change keys…** rebinds them. **N** makes a new ticket.

Then move this ticket to Done.`
    },
    {
      key: "a6",
      title: "Make a routine",
      body: `Routines are things you do again and again: a daily to-do, a checklist, a question for the assistant. Run one when you like, or put it on a schedule.

1. Click **Routines** in the sidebar.
2. Under **Suggestions**, click **Add** next to **Daily to-do**, then **Run now**. A to-do card lands in this workstream — drag it to Done.
3. Open the routine, click **+ Schedule**, pick **Weekdays** and a time. **Run on schedule** turns it on or off.

Schedules run on this computer while Tomrade is open.`
    },
    {
      key: "a7",
      title: "Triage the inbox",
      body: `Feedback and bug reports wait in the **Inbox** until you decide what they become. Three Pomodoro app users have written in.

1. Click **Inbox** in the sidebar. The **To triage** tab holds the three reports.
2. The timer bug: **Accept as ticket** → **Create ticket**. It joins the backlog, linked to the report.
3. The longer-break request: **Merge into a ticket** and pick **Settings page** — it already covers that.
4. The calendar idea: **Won't do**. **Duplicate** is for a report you have already had.

In your own projects, **Sources** brings in GitHub issues. With a model connected, **Suggest triage** proposes what to do with each one.`
    },
    {
      key: "b1",
      title: "Connect a model",
      body: `The assistant needs a language model to talk, tidy the backlog and plan work. A model also runs the **built-in agent**, so Start works with nothing else installed.

1. In the setup card at the top of the assistant panel — or Settings → **Assistant** — pick the provider your key is from. A model running on this computer needs no key.
2. Paste the API key and click **Connect**. Tomrade checks it and picks a model.

Already signed in to a local agent such as Claude Code or Codex? Then this is already done: the assistant runs on it and plans with its model.`
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
- **History** — the clock at the bottom, beside Undo and Redo — lists every write and rolls back to any of them. ⌘Z undoes the newest.

After the undo the example backlog is as it was.`
    },
    {
      key: "b4",
      title: "Turn an idea into tickets",
      body: `Type *I want to build …* in the assistant panel and describe an idea of your own.

The assistant asks a few questions, then plans it as a set of tickets with dependencies in a new workstream. Not what you wanted? Revert it like any other run.

The plan is written by your model — or, with no model connected, by the local agent you are signed in to.`
    },
    {
      key: "b5",
      title: "Give the assistant your project's rules",
      body: `Rules are how this project works, written once: the assistant and coding agents read them before they act.

1. Project settings → **Rules**: write a line such as *Every ticket title starts with a verb.* and click **Save rules**.
2. Ask the assistant: *Add a ticket for a dark mode* — its title follows the rule.
3. When the assistant notices a convention of yours, it offers to keep it: **Add rule** or **Don't add**.

The rules are a file in the project's folder, so they travel with it.`
    },
    {
      key: "c1",
      title: "Hand a ticket to a local agent with Start",
      body: `**Start** gives a ticket to an agent on this computer, which works on it in the background.

1. With a model connected, the **built-in agent** is ready — nothing to install. Claude Code or Codex work too, once installed and signed in.
2. Open **Write a one-page user guide** in the example workstream and click **Start**.
3. When it is done it submits its result and the ticket moves to **Verifying**. Open the ticket: the **Delivery** section shows the report. Click **Accept delivery** to finish it, or **Request changes** with a comment to send it back.`
    },
    {
      key: "c2",
      title: "Link a repository and let an agent write code (optional)",
      body: `Only if you write code — otherwise drag this to Done.

1. Project settings → **Repositories** → **Add repository**: add a git repository and choose its checkout on this computer.
2. Under the repository, in **Its code is for:**, tick a workstream. (Or hover the workstream in the sidebar and click **Connect a repository**.)
3. Start a ticket in that workstream: the agent works on its own branch and worktree, and opens a pull request when it is done.`
    },
    {
      key: "d1",
      title: "Add a plugin",
      body: `Much of Tomrade is plugins: the inbox, routines, the pet above the assistant, each chat app. You can add more.

1. Settings → **Manage plugins** → **Browse**. **Official only** shows the ones made by Tomrade.
2. Click **Install** on one, check what it may do, and **Install** again.
3. The tomato at the right of the status bar is the Pomodoro plugin: click it to start a focus session.

A plugin with settings gets its own page under Settings → Plugins.`
    },
    {
      key: "d2",
      title: "Reach Tomrade from Claude Code or Codex in your terminal (optional)",
      body: `Agents you open yourself can read and update this backlog too.

1. Settings → **Assistant** → open Claude Code, Codex or another agent → **Sessions you open yourself** → **Connect to Tomrade**.
2. In that agent, ask: *What's on my Tomrade backlog?*
3. For a code repository, Project settings → **Repositories** → **Connect to coding agents** adds the instructions to the repository, so an agent claims a ticket and works on its branch.`
    },
    {
      key: "d3",
      title: "Talk to Tomrade from a chat app (optional)",
      body: `The assistant also answers in Discord, Slack, Feishu, Telegram and others, and tells you there when something needs you.

1. Settings → **IM** → **Connect a bot**: pick the platform and follow its steps to create a bot.
2. Under **People**, click **Make a pairing code** and send it to the bot in a direct message, then confirm it here.
3. **What conversations hear** decides what else reaches your chats: ticket changes, pull requests, questions while you are away.`
    },
    {
      key: "d4",
      title: "Keep your projects on more than one computer (optional)",
      body: `Each project is a folder on this computer. An account carries the list of your projects and your preferences to your other computers.

1. Settings → **Hub** → **Tomrade account** → **Sign in** (or create one).
2. To share a project's content, Project settings → **Storage** → **Publish here** on a git remote.

This tour project never syncs — it is this computer's alone.`
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
  ],
  feedback: [
    {
      key: "f1",
      kind: "bug",
      reporter: "Mia",
      title: "The timer stops when my laptop goes to sleep",
      body: "I closed the lid in the middle of a pomodoro. When I opened it ten minutes later the timer had not moved."
    },
    {
      key: "f2",
      kind: "feedback",
      reporter: "Leo",
      title: "Could the long break be longer?",
      body: "Fifteen minutes is not enough after four rounds. I'd like to set it myself."
    },
    {
      key: "f3",
      kind: "idea",
      reporter: "Sam",
      title: "Put my pomodoros in my calendar",
      body: "It would be nice to see each finished pomodoro as an event in Google Calendar."
    }
  ]
};

const zh: SampleWords = {
  name: "Tomrade 入门",
  description: "用 Tomrade 自己的工单教你用 Tomrade。只存在这台电脑上，随时可以删掉。",
  tour: "入门",
  example: "示例：番茄钟 App",
  path: "学习路径",
  tickets: [
    {
      key: "a1",
      title: "把这个工单拖到「已完成」",
      body: `欢迎来到 Tomrade。这个项目本身就是教程：**入门**里的每个工单教一个功能，做完就把它移到「已完成」。

- 左边是工作流、视图和文件，中间是看板，右边是助手。
- 这些工单用 *blocks* 关系串成一条路径，下一个工单会教你怎么看到它。
- 这个项目只在这台电脑上，不会同步到账号。学完可以在项目设置里删掉。

**现在**：把这张卡片移到「已完成」。往右拖，拖到看板边缘停一下，看板会自己滚过去；或者打开它，把**状态**改成「已完成」。`
    },
    {
      key: "a2",
      title: "打开「学习路径」视图",
      body: `这里的每个工单都卡着后面的工单。侧边栏视图里的 **学习路径** 把这种关系画成关系图。

1. 点视图里的 **学习路径**。
2. 顺着箭头看：前置都完成了的工单就可以做了，从已完成的工单出发的箭头会变淡。
3. 任何视图都可以这样画——在看板上方那一行，把「看板」「表格」切到 **关系图**。

然后把这个工单移到「已完成」。`
    },
    {
      key: "a3",
      title: "写一篇笔记，添加到这个工单上",
      body: `文件和笔记都是项目文件夹里的纯文本，可以直接阅读、备份和提交。

1. 在侧边栏 **文件** 旁边点 **+** → **新建笔记**，随便写几句。
2. 在笔记的工具栏里点 **添加到工单…**，选中这个工单。
3. ⇧⌘F 可以搜索所有笔记。

这篇笔记就会出现在这个工单上。`
    },
    {
      key: "a4",
      title: "加一个字段，存一个视图",
      body: `字段决定每个工单记录什么，视图决定你怎么看这些工单。

1. 点看板上方那一行里、**视图** 旁边的 **字段**，加一个字段，比如数字类型的「预计时长」。
2. 在看板上把工作流筛选成 **示例：番茄钟 App**，再点筛选栏里的 **另存为新视图…**。

新视图会一直留在侧边栏。`
    },
    {
      key: "a5",
      title: "用 ⌘K 找到任何东西",
      body: `命令面板是最快的入口：按 ⌘K，或者点标题栏的 **搜索**。

1. 按 ⌘K，输入工单编号或标题的一部分，比如「番茄」，回车打开。
2. 也可以输入文件名，或者命令：「新建工单」「例行事务…」「历史」、某个主题。
3. 在输入框以外的地方按 **?**：**键盘快捷键** 列出所有按键，点 **修改按键…** 可以改。按 **N** 新建工单。

然后把这个工单移到「已完成」。`
    },
    {
      key: "a6",
      title: "建一个例行事务",
      body: `例行事务是你反复要做的事：每天的待办、一张清单、问助手的一个问题。想做就运行一次，也可以定时。

1. 点侧边栏的 **例行事务**。
2. 在 **推荐模板** 里，点 **每日待办** 旁边的 **添加**，再点 **立即运行**。这个工作流里会出现一张待办卡片——把它拖到「已完成」。
3. 打开这个例行事务，点 **+ 定时**，选 **工作日** 和时刻。**按时自动运行** 可以随时开关。

定时只在这台电脑上、Tomrade 开着的时候运行。`
    },
    {
      key: "a7",
      title: "分诊收件箱",
      body: `用户反馈和 bug 先进 **收件箱**，由你决定它们变成什么。番茄钟 App 的三位用户来信了。

1. 点侧边栏的 **收件箱**，**待分诊** 里有三条。
2. 计时器的 bug：**接受为工单** → **创建工单**。它进了 backlog，并和这条反馈关联。
3. 想要更长休息的那条：**并入已有工单**，选 **设置页**——它已经包含这件事。
4. 日历的想法：**不做**。已经收到过的反馈用 **重复**。

在你自己的项目里，**来源** 可以接入 GitHub Issues。接上模型后，**给个分诊建议** 会替每一条想好怎么处理。`
    },
    {
      key: "b1",
      title: "接上一个模型",
      body: `助手需要一个语言模型，才能对话、整理 backlog、规划工作。接上模型后，**内置智能体**也能用了，「开始」不用再装别的东西。

1. 在助手面板顶部的设置卡片里（或设置 → **助手**）选你的 key 来自哪家服务商。本机运行的模型不需要 key。
2. 粘贴 API key，点 **连接**。Tomrade 会检查它并选好模型。

已经登录了 Claude Code、Codex 这类本地智能体？那这一步已经完成了：助手会用它来对话，也用它的模型来规划。`
    },
    {
      key: "b2",
      title: "让助手整理示例 backlog",
      body: `**示例：番茄钟 App** 里故意放了一个重复的工单和一个太大的工单。

1. 在助手面板里点 **整理一下 backlog**，或者直接说：*整理「示例：番茄钟 App」这个工作流*。
2. 看它合并重复的工单、拆开太大的工单。它改过的卡片会带 AI 标记。
3. 运行结束时，底部会写明改了几处。`
    },
    {
      key: "b3",
      title: "撤销助手刚才的修改",
      body: `助手的每一次写入都可以撤回。

- 点那次运行底部的 **撤销**，整次运行一起撤回。
- **历史**——底部撤销、重做旁边的时钟——列出每一次写入，可以回滚到任意一条。⌘Z 撤销最近的一次。

撤销之后，示例 backlog 会回到原样。`
    },
    {
      key: "b4",
      title: "把一个想法拆成工单",
      body: `在助手面板里输入「我想做一个……」，说说你自己的想法。

助手会先问几个问题，再把它规划成一组带依赖关系的工单，放进一个新的工作流。不满意的话，像其他运行一样撤销就行。

规划由你接上的模型来写；没接模型时，由你登录的本地智能体来写。`
    },
    {
      key: "b5",
      title: "把项目的规则告诉助手",
      body: `规则是这个项目的做事方式，写一次就行：助手和编码智能体动手前都会先读。

1. 项目设置 → **规则**：写一句，比如「每个工单的标题以动词开头。」，点 **保存规则**。
2. 跟助手说：*加一个深色模式的工单*——它起的标题会照着规则来。
3. 助手发现你的习惯时，会问要不要记下来：**加入规则** 或 **不加**。

规则是项目文件夹里的一个文件，跟着项目走。`
    },
    {
      key: "c1",
      title: "用「开始」把一个工单交给本地智能体",
      body: `**开始** 把一个工单交给这台电脑上的智能体，在后台完成。

1. 接上模型后，**内置智能体**就能用，不用安装任何东西。Claude Code 或 Codex 装好并登录后也可以。
2. 打开示例工作流里的 **写一页使用说明**，点 **开始**。
3. 做完后它会提交成果，工单进入 **验证中**。打开工单，**交付** 区里是它的报告：点 **验收通过** 就完成了；不满意就写上意见，点 **退回修改**。`
    },
    {
      key: "c2",
      title: "绑定仓库，让智能体写代码（可选）",
      body: `写代码的人才需要这一张，否则直接拖到「已完成」。

1. 项目设置 → **代码仓库** → **添加仓库**：添加一个 git 仓库，选好它在这台电脑上的 checkout。
2. 在这个仓库下的 **用于工作流：** 里勾上一个工作流。（也可以在侧边栏把鼠标移到工作流上，点 **连接仓库**。）
3. 在这个工作流里的工单上点 **开始**：智能体会在独立的分支和工作树里改代码，做完开 PR。`
    },
    {
      key: "d1",
      title: "装一个插件",
      body: `Tomrade 的很多功能都是插件：收件箱、例行事务、助手上方的宠物、每个聊天软件。你还可以再装。

1. 设置 → **管理插件** → **浏览**。**仅官方** 只显示 Tomrade 官方做的插件。
2. 在一个插件上点 **安装**，看清它要用哪些权限，再点一次 **安装**。
3. 状态栏右边的番茄就是番茄钟插件：点它开始一段专注。

有设置项的插件，会在 设置 → 插件 下面有自己的一页。`
    },
    {
      key: "d2",
      title: "在终端里的 Claude Code 或 Codex 中使用 Tomrade（可选）",
      body: `你自己打开的智能体，也能读写这个 backlog。

1. 设置 → **助手** → 展开 Claude Code、Codex 或其他智能体 → **你自己开的会话** → **连接到 Tomrade**。
2. 在那个智能体里问：*我的 Tomrade backlog 里有什么？*
3. 代码仓库的话，项目设置 → **代码仓库** → **连接到编码智能体**，会把说明写进仓库，智能体就会认领工单、在它的分支上干活。`
    },
    {
      key: "d3",
      title: "在聊天软件里和 Tomrade 对话（可选）",
      body: `助手也能在 Discord、Slack、飞书、Telegram 等软件里回复你，有事需要你处理时也会在那里提醒。

1. 设置 → **IM** → **连接机器人**：选平台，按步骤建一个机器人。
2. 在 **成员** 里点 **生成配对码**，私信发给机器人，再回到这里确认。
3. **会话里推送什么** 决定还有哪些消息会推到聊天里：工单状态变化、PR、你离开时的提问。`
    },
    {
      key: "d4",
      title: "在多台电脑上用同一批项目（可选）",
      body: `每个项目都是这台电脑上的一个文件夹。登录账号后，项目列表和偏好设置会带到你的其他电脑上。

1. 设置 → **主目录** → **Tomrade 账号** → **登录**（或者注册一个）。
2. 要共享某个项目的内容：项目设置 → **存储**，在一个 git 远端上点 **发布到此处**。

这个入门项目永远不会同步——它只属于这台电脑。`
    }
  ],
  examples: [
    { key: "e1", title: "计时器：开始、暂停、重置", body: "其他功能都依赖的 25 分钟计时器。" },
    { key: "e2", title: "一个番茄结束时提醒我休息", body: "25 分钟到了弹出通知并响铃，然后开始 5 分钟的休息计时。" },
    { key: "e3", title: "统计每天完成的番茄数", body: "主界面显示当天完成的数量，保留最近 30 天。" },
    { key: "e4", title: "每日番茄数统计", body: "显示我今天完成了几个番茄。" },
    { key: "e5", title: "设置页", body: "工作和休息时长、每 4 轮一次长休息、提示音和音量、主题、快捷键、开机启动、导出 CSV、多设备同步。" },
    { key: "e6", title: "写一页使用说明", body: "给第一次用的人写一页说明：什么是番茄钟，怎么开始、暂停、重置，设置在哪里。存成「文件」里的一篇笔记。" }
  ],
  feedback: [
    { key: "f1", kind: "bug", reporter: "小林", title: "电脑睡眠后计时器停了", body: "番茄钟进行到一半我合上了盖子，十分钟后打开，计时器一点没走。" },
    { key: "f2", kind: "feedback", reporter: "阿杰", title: "长休息能不能再长一点？", body: "四轮之后休息 15 分钟不太够，希望能自己设。" },
    { key: "f3", kind: "idea", reporter: "Sam", title: "把番茄记录同步到日历", body: "如果每个完成的番茄都能在 Google 日历里显示成一个事件就好了。" }
  ]
};

export const SAMPLE: Record<SeedLocale, SampleWords> = { en, zh };
