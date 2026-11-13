import type { SeedLocale } from "@tomradex/db";
import { DEFAULT_KEYS } from "@tomradex/keybindings/chord";

/** One ticket of the sample, keyed so the learning path can name it in either language. */
export interface SampleTicket {
  key: string;
  title: string;
  body: string;
  /** A code ticket, done in the example's repository; the rest are general. */
  coding?: true;
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
  /** The workstream of the core loop's lessons, the project's first. */
  tour: string;
  /** The workstream of every other lesson. */
  more: string;
  /** The workstream the tour's exercises act on, standing for the example's repository. */
  example: string;
  /** The graph view drawing the tour's dependencies. */
  path: string;
  /** Start first, then the rest, each group in the order it is taught. */
  tickets: SampleTicket[];
  examples: SampleTicket[];
  feedback: SampleFeedback[];
}

/**
 * The core loop, in the order it is taught: an idea becomes tickets, an agent
 * does one on its own branch, the person merges or accepts it, and anything
 * the assistant did is undone. These lead the tour, in their own workstream.
 */
export const START: readonly string[] = ["b4", "c1", "c3", "b3"];

/**
 * The learning path, blocker first: only what a lesson really needs. B4 comes
 * first and is the only lesson that starts the path: it is where an AI first
 * answers, so Start (C1), tidying (B2), rules (B5) and a chat app (D3) wait on
 * it, and undoing waits for the run it undoes. Merging waits for a delivery,
 * and linking a repository of one's own, or sending a ticket to another
 * computer, for Start. The rest need nothing.
 */
export const PATH: readonly [string, string][] = [
  ["b4", "c1"],
  ["c1", "c3"],
  ["b4", "b3"],
  ["b4", "b2"],
  ["b4", "b5"],
  ["b4", "d3"],
  ["c1", "c2"],
  ["c1", "d5"]
];

/**
 * The example's code: a small git repository in the sample's folder, with no
 * remote, so a Pomodoro code ticket goes Start → branch → merge here → Done
 * without GitHub. Code, so in English whatever the tour's language.
 */
export const SAMPLE_REPO = {
  folder: "pomodoro",
  branch: "main",
  message: "Pomodoro timer that starts and pauses",
  files: {
    "README.md": `# Pomodoro

The example app of the Tomrade tour: a 25-minute timer.

- Open \`index.html\` in a browser to use it.
- \`npm test\` runs the tests (Node 20 or later, nothing to install).

This repository is on your computer only and has no remote. An agent works on a
branch of its own; Tomrade merges that branch into \`main\` right here.
`,
    "AGENTS.md": `# Pomodoro

Plain ES modules, no dependencies.

- The timer's logic lives in \`timer.js\`, apart from the page, and is tested in \`timer.test.js\`.
- \`index.html\` is the page: buttons call the timer.
- Run \`npm test\` before handing work back.
`,
    "package.json": `${JSON.stringify({ name: "pomodoro", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    "timer.js": `/** A pomodoro: 25 minutes of work, counted down while it runs. */
export const WORK_SECONDS = 25 * 60;

/** \`now\` is a clock in milliseconds, so tests can move time themselves. */
export function createTimer({ seconds = WORK_SECONDS, now = () => Date.now() } = {}) {
  let left = seconds * 1000;
  let startedAt = null;
  const remaining = () => (startedAt === null ? left : Math.max(0, left - (now() - startedAt)));
  return {
    start() {
      if (startedAt === null) startedAt = now();
    },
    pause() {
      if (startedAt === null) return;
      left = remaining();
      startedAt = null;
    },
    get running() {
      return startedAt !== null;
    },
    remaining
  };
}

/** Milliseconds as the clock face shows them: 25:00. */
export function format(ms) {
  const total = Math.ceil(ms / 1000);
  return \`\${String(Math.floor(total / 60)).padStart(2, "0")}:\${String(total % 60).padStart(2, "0")}\`;
}
`,
    "timer.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimer, format } from "./timer.js";

test("starts at 25:00", () => {
  assert.equal(format(createTimer().remaining()), "25:00");
});

test("counts down only while it runs", () => {
  let t = 0;
  const timer = createTimer({ now: () => t });
  timer.start();
  t += 60_000;
  timer.pause();
  t += 60_000;
  assert.equal(format(timer.remaining()), "24:00");
  assert.equal(timer.running, false);
});
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Pomodoro</title>
  </head>
  <body>
    <h1 id="time">25:00</h1>
    <button id="start">Start</button>
    <button id="pause">Pause</button>
    <script type="module">
      import { createTimer, format } from "./timer.js";
      const timer = createTimer();
      const time = document.getElementById("time");
      document.getElementById("start").onclick = () => timer.start();
      document.getElementById("pause").onclick = () => timer.pause();
      setInterval(() => (time.textContent = format(timer.remaining())), 250);
    </script>
  </body>
</html>
`
  } as Record<string, string>
};

/** The default keys the lessons teach. */
interface LessonKeys {
  palette: string;
  searchNotes: string;
  undo: string;
}

/** A chord as the shortcuts sheet writes it: "Mod+Shift+F" is ⇧⌘F on a Mac and Ctrl+Shift+F elsewhere. */
function keyText(chord: string, platform: NodeJS.Platform = process.platform): string {
  const mods = chord.split("+");
  const key = mods.pop() ?? "";
  const has = (m: string) => mods.includes(m);
  if (platform === "darwin") return `${has("Ctrl") ? "⌃" : ""}${has("Alt") ? "⌥" : ""}${has("Shift") ? "⇧" : ""}${has("Mod") ? "⌘" : ""}${key}`;
  return [...(has("Mod") || has("Ctrl") ? ["Ctrl"] : []), ...(has("Alt") ? ["Alt"] : []), ...(has("Shift") ? ["Shift"] : []), key].join("+");
}

const en = (keys: LessonKeys): SampleWords => ({
  name: "Tomrade tour",
  description: "A project that teaches Tomrade with its own tickets. It lives on this computer only — delete it whenever you like.",
  tour: "Start here",
  more: "More",
  example: "Example: Pomodoro app",
  path: "Learning path",
  tickets: [
    {
      key: "b4",
      title: "Turn an idea into tickets",
      body: `Welcome to Tomrade. This project is the tutorial, and **Start here** is the whole loop in four tickets: an idea becomes tickets, an agent does one on its own branch, you merge it and the ticket is Done, and anything the assistant did can be undone. **More** has the rest. Move each lesson to Done when you have finished it.

1. In the assistant panel on the right, type *I want to build …* and describe an idea of your own.
2. The assistant asks a few questions, then plans it as a set of tickets with dependencies, in a new workstream in the sidebar.

The plan is written by your model — or, with no model connected, by the local agent you are signed in to. Neither yet? The setup card at the top of the assistant panel connects one.

This project stays on this computer and never syncs to your account.

**Now:** click the message box at the bottom of the assistant panel and type your idea.`
    },
    {
      key: "c1",
      title: "Hand a code ticket to an agent with Start",
      body: `**Start** gives a ticket to an agent on this computer, which works on it in the background.

**Example: Pomodoro app** comes with a small git repository in this project's folder, with no remote: a timer that starts and pauses. **Timer: add a Reset button** is a code ticket for it.

1. With a model connected, the **built-in agent** is ready — nothing to install. Claude Code or Codex work too, once installed and signed in.
2. Open **Timer: add a Reset button** in the Example: Pomodoro app workstream and click **Start** at the top right of the ticket.
3. The agent works in a copy of the repository, on the ticket's own branch; follow it in the assistant panel. When it hands the branch back, the ticket moves to **Verifying**.

**Now:** open **Timer: add a Reset button** and click **Start**.`
    },
    {
      key: "c3",
      title: "Merge the delivery so its ticket is Done",
      body: `When the agent hands **Timer: add a Reset button** back, its branch waits on this computer for your word.

1. Open the ticket. Its **Code** section shows the branch and how many commits it is ahead of main.
2. Click the **Pull request** row — *none — no remote · merge into main*. Tomrade merges the branch into main in the example's repository, here, and the ticket moves to **Done**. The card in the agent's conversation has the same **Merge** button.
3. Work that is not code comes back as a report instead. Start **Write a one-page user guide** too: its **Delivery** section shows the report — **Accept delivery** finishes it, **Request changes** with a comment sends it back.

**Now:** open **Timer: add a Reset button** and click the **Pull request** row in its **Code** section.`
    },
    {
      key: "b3",
      title: "Undo what the assistant did",
      body: `Every write the assistant makes can be taken back — the plan from **Turn an idea into tickets** included.

- **Revert** in a run's footer undoes that whole run at once: the planned tickets and their workstream go.
- **History** — the clock at the bottom, beside Undo and Redo — lists every write and rolls back to any of them. ${keys.undo} undoes the newest.

**Now:** scroll the assistant panel to the run that planned your idea and click **Revert** in its footer.`
    },
    {
      key: "a1",
      title: "Drag this ticket to Done",
      body: `Tickets move across the board as work goes on; each lesson is finished by moving it to Done.

- The sidebar holds your workstreams, views and files; the board is in the middle; the assistant is on the right.
- Some tickets wait for others — they are linked by *blocks* — and **Open the Learning path view** shows you how to see that.

No model or agent connected yet? Connect one first, in the setup card at the top of the assistant panel: the lessons in **Start here** need it.

**Now:** move this card to Done. Drag it to the right — the board scrolls on its own when you hold it near the edge — or open it and set **Status** to Done.`
    },
    {
      key: "b1",
      title: "Connect a model",
      body: `The assistant needs a language model to talk, tidy the backlog and plan work. A model also runs the **built-in agent**, so Start works with nothing else installed.

1. In the setup card at the top of the assistant panel — or Settings → **Assistant** — pick the provider your key is from. A model running on this computer needs no key.
2. Paste the API key and click **Connect**. Tomrade checks it and picks a model.

Already signed in to a local agent such as Claude Code or Codex? Then this is already done: the assistant runs on it and plans with its model.

**Now:** open the setup card at the top of the assistant panel, or Settings → **Assistant**.`
    },
    {
      key: "a2",
      title: "Open the Learning path view",
      body: `Some lessons wait for others: the ones that need a working assistant wait for **Turn an idea into tickets**, for instance. The **Learning path** view in the sidebar draws that as a graph.

1. Follow the arrows: a ticket whose blockers are all done is ready to do, and one with no arrow into it is ready now. Arrows from finished tickets fade.
2. Any view can be drawn this way — switch it to **Graph** in the row above the board, next to Board and Table.

**Now:** click **Learning path** under Views in the sidebar, then move this ticket to Done.`
    },
    {
      key: "a5",
      title: `Find anything with ${keys.palette}`,
      body: `The command palette is the quickest way around: ${keys.palette}, or **Search** in the title bar.

1. Type part of a ticket's key or title — *pomodoro* — and press Enter to open it.
2. Type a file's name, or a command: *New ticket*, *Routines…*, *History*, a theme.
3. Press **?** anywhere outside a text box: the **Keyboard shortcuts** sheet lists every key, and **Change keys…** rebinds them. **N** makes a new ticket.

**Now:** press ${keys.palette}, then move this ticket to Done.`
    },
    {
      key: "a3",
      title: "Write a note and add it to this ticket",
      body: `Files and notes are plain text in the project's folder, so you can read, back up and commit them.

1. Write a few lines in the new note.
2. In the note's toolbar, click **Add to a ticket…** and pick this ticket. The note now shows on this ticket.
3. ${keys.searchNotes} searches every note.

**Now:** in the sidebar, next to **Files**, click **+** → **New note**.`
    },
    {
      key: "a4",
      title: "Add a field and save a view",
      body: `Fields decide what each ticket records; views decide how you look at them.

1. Add a field — say *Estimate*, a number.
2. On the board, filter the workstream to **Example: Pomodoro app**, then choose **Save as new…** in the filter bar. The new view stays in the sidebar.

**Now:** click **Fields** in the row above the board, next to **View**.`
    },
    {
      key: "a6",
      title: "Make a routine",
      body: `Routines are things you do again and again: a daily to-do, a checklist, a question for the assistant. Run one when you like, or put it on a schedule.

1. Under **Suggestions**, click **Add** next to **Daily to-do**, then **Run now**. A to-do card lands in this workstream — drag it to Done.
2. Open the routine, click **+ Schedule**, pick **Weekdays** and a time. **Run on schedule** turns it on or off.

Schedules run on this computer while Tomrade is open.

**Now:** click **Routines** in the sidebar.`
    },
    {
      key: "a7",
      title: "Triage the inbox",
      body: `Feedback and bug reports wait in the **Inbox** until you decide what they become. Three Pomodoro app users have written in; the **To triage** tab holds their reports.

1. The timer bug: **Accept as ticket** → **Create ticket**. It joins the backlog, linked to the report.
2. The longer-break request: **Merge into a ticket** and pick **Settings page** — it already covers that.
3. The calendar idea: **Won't do**. **Duplicate** is for a report you have already had.

In your own projects, **Sources** brings in GitHub issues. With a model connected, **Suggest triage** proposes what to do with each one.

**Now:** click **Inbox** in the sidebar.`
    },
    {
      key: "b2",
      title: "Let the assistant tidy the example backlog",
      body: `**Example: Pomodoro app** has a duplicate ticket and one that is far too big, on purpose.

1. Watch the assistant merge the duplicate and split the big one. Cards it changed carry the AI mark.
2. When the run ends, its footer says how many things changed — and **Revert** there takes them all back.

**Now:** in the assistant panel, pick **Tidy up the backlog** — or ask: *Tidy the Example: Pomodoro app workstream*.`
    },
    {
      key: "b5",
      title: "Give the assistant your project's rules",
      body: `Rules are how this project works, written once: the assistant and coding agents read them before they act.

1. Write a line such as *Every ticket title starts with a verb.* and click **Save rules**.
2. Ask the assistant: *Add a ticket for a dark mode* — its title follows the rule.
3. When the assistant notices a convention of yours, it offers to keep it: **Add rule** or **Don't add**.

The rules are a file in the project's folder, so they travel with it.

**Now:** open Project settings → **Rules**.`
    },
    {
      key: "c2",
      title: "Link a repository of your own (optional)",
      body: `The Pomodoro example came with its repository. For your own code — otherwise drag this to Done:

1. Add a git repository and choose its checkout on this computer.
2. Under the repository, in **Its code is for:**, tick a workstream. (Or hover the workstream in the sidebar and click **Connect a repository**.)
3. Start a ticket in that workstream: the agent works on its own branch and worktree. With a remote it opens a pull request when it is done; without one, you merge its branch here, as in the example.

**Now:** open Project settings → **Repositories** → **Add repository**.`
    },
    {
      key: "d1",
      title: "Add a plugin",
      body: `Much of Tomrade is plugins: the inbox, routines, the pet above the assistant, each chat app. You can add more.

1. **Official only** shows the ones made by Tomrade.
2. Click **Install** on one, check what it may do, and **Install** again. A plugin with settings gets its own page under Settings → Plugins.
3. The tomato at the right of the status bar is the Pomodoro plugin: click it to start a focus session.

**Now:** open Settings → **Manage plugins** → **Browse**.`
    },
    {
      key: "d2",
      title: "Reach Tomrade from Claude Code or Codex in your terminal (optional)",
      body: `Agents you open yourself can read and update this backlog too.

1. In Settings → **Assistant**, open Claude Code, Codex or another agent → **Sessions you open yourself** → **Connect to Tomrade**.
2. In that agent, ask: *What's on my Tomrade backlog?*
3. For a code repository, Project settings → **Repositories** → **Connect to coding agents** adds the instructions to the repository, so an agent claims a ticket and works on its branch.

**Now:** open Settings → **Assistant**.`
    },
    {
      key: "d3",
      title: "Talk to Tomrade from a chat app (optional)",
      body: `The assistant also answers in Discord, Slack, Feishu, Telegram and others, and tells you there when something needs you.

1. Pick the platform and follow its steps to create a bot.
2. Under **People**, click **Make a pairing code** and send it to the bot in a direct message, then confirm it here.
3. **What conversations hear** decides what else reaches your chats: ticket changes, pull requests, questions while you are away.

**Now:** open Settings → **IM** → **Connect a bot**.`
    },
    {
      key: "d4",
      title: "Keep your projects on more than one computer (optional)",
      body: `Each project is a folder on this computer. An account carries the list of your projects and your preferences to your other computers.

1. Sign in, or create an account.
2. To share a project's content, Project settings → **Storage** → **Publish here** on a git remote.

This tour project never syncs — it is this computer's alone.

**Now:** open Settings → **Hub** → **Tomrade account** → **Sign in**.`
    },
    {
      key: "d5",
      title: "Send a ticket to another of your computers (optional)",
      body: `A ticket need not run on the computer you plan on: a Windows fix can go to your Windows computer and be worked on there while you carry on here. Only one computer? Drag this to Done.

1. On the other computer, sign in to the same account. Both computers then appear under Settings → **Devices**.
2. Still on that computer, in Settings → **Devices**, turn on **Accept work from my other devices**. It is off until you do: it lets an agent run there and change code there, within the limits you set beside it.
3. Back here, open a code ticket of a project both computers have and open its Start dialog: **Start**, or the arrow beside it → **Full settings…** once Start remembers how you last started. Under **Run on**, choose that computer, then **Send**.

The agent there works on the ticket's own branch, with that computer's sign-in. The work comes back as commits and a pull request, and the ticket says where it runs. The free plan covers two computers.

The Pomodoro example cannot be sent: this tour project lives on this computer alone.

**Now:** open Settings → **Devices** to see which of your computers are signed in.`
    }
  ],
  examples: [
    {
      key: "e1",
      title: "Timer: add a Reset button",
      coding: true,
      body: `The \`pomodoro\` repository's timer can start and pause. Add **Reset**: it stops the timer and puts it back to 25:00.

- \`reset()\` in \`timer.js\`, with a test in \`timer.test.js\`; \`npm test\` passes.
- A **Reset** button in \`index.html\`, beside Start and Pause.`
    },
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
});

const zh = (keys: LessonKeys): SampleWords => ({
  name: "Tomrade 入门",
  description: "用 Tomrade 自己的工单教你用 Tomrade。只存在这台电脑上，随时可以删掉。",
  tour: "开始",
  more: "更多",
  example: "示例：番茄钟 App",
  path: "学习路径",
  tickets: [
    {
      key: "b4",
      title: "把一个想法拆成工单",
      body: `欢迎来到 Tomrade。这个项目本身就是教程，**开始** 里的四个工单走完一整圈：想法拆成工单，智能体在自己的分支上做完一张，你合并后工单变成「已完成」，助手做过的事都能撤销。其余的课在 **更多** 里。每学完一课，就把它移到「已完成」。

1. 在右边的助手面板里输入「我想做一个……」，说说你自己的想法。
2. 助手会先问几个问题，再把它规划成一组带依赖关系的工单，放进侧边栏里一个新的工作流。

规划由你接上的模型来写；没接模型时，由你登录的本地智能体来写。两样都还没有？助手面板顶部的设置卡片可以接上一个。

这个项目只在这台电脑上，不会同步到账号。

**现在**：点助手面板底部的输入框，写下你的想法。`
    },
    {
      key: "c1",
      title: "用「开始」把一张代码工单交给智能体",
      body: `**开始** 把一个工单交给这台电脑上的智能体，在后台完成。

**示例：番茄钟 App** 附带一个小小的 git 仓库，就在这个项目的文件夹里，没有远端：一个能开始、暂停的计时器。**计时器：加一个重置按钮** 就是给它的代码工单。

1. 接上模型后，**内置智能体**就能用，不用安装任何东西。Claude Code 或 Codex 装好并登录后也可以。
2. 打开「示例：番茄钟 App」工作流里的 **计时器：加一个重置按钮**，点工单右上角的 **开始**。
3. 智能体在仓库的一份副本里、在这个工单自己的分支上改代码，你可以在助手面板里看着它。它把分支交回后，工单进入 **验证中**。

**现在**：打开 **计时器：加一个重置按钮**，点 **开始**。`
    },
    {
      key: "c3",
      title: "合并交付，让工单变成「已完成」",
      body: `智能体把 **计时器：加一个重置按钮** 交回后，它的分支留在这台电脑上，等你点头。

1. 打开这个工单。**代码** 区里是它的分支，以及比 main 多几个提交。
2. 点 **拉取请求** 那一行——「无——没有远端 · 合并进 main」。Tomrade 就在本机把分支合并进示例仓库的 main，工单变成 **已完成**。智能体对话里的卡片上也有同样的 **合并** 按钮。
3. 不是代码的工作，交回的是一份报告。把 **写一页使用说明** 也点 **开始**：它的 **交付** 区里是报告——点 **验收通过** 就完成了；不满意就写上意见，点 **退回修改**。

**现在**：打开 **计时器：加一个重置按钮**，点 **代码** 区里的 **拉取请求** 那一行。`
    },
    {
      key: "b3",
      title: "撤销助手做过的修改",
      body: `助手的每一次写入都可以撤回，**把一个想法拆成工单** 里做的规划也一样。

- 点那次运行底部的 **撤销**，整次运行一起撤回：规划出的工单和它们的工作流都会去掉。
- **历史**——底部撤销、重做旁边的时钟——列出每一次写入，可以回滚到任意一条。${keys.undo} 撤销最近的一次。

**现在**：在助手面板里找到规划你想法的那次运行，点它底部的 **撤销**。`
    },
    {
      key: "a1",
      title: "把这个工单拖到「已完成」",
      body: `工单随着进度在看板上移动；每学完一课，就把它移到「已完成」。

- 左边是工作流、视图和文件，中间是看板，右边是助手。
- 有些工单要等别的工单先完成——它们用 *blocks* 关系连着——**打开「学习路径」视图** 会教你怎么看到它。

还没接上模型或智能体？先在助手面板顶部的设置卡片里接一个：**开始** 里的课都要用到它。

**现在**：把这张卡片移到「已完成」。往右拖，拖到看板边缘停一下，看板会自己滚过去；或者打开它，把**状态**改成「已完成」。`
    },
    {
      key: "b1",
      title: "接上一个模型",
      body: `助手需要一个语言模型，才能对话、整理 backlog、规划工作。接上模型后，**内置智能体**也能用了，「开始」不用再装别的东西。

1. 在助手面板顶部的设置卡片里（或设置 → **助手**）选你的 key 来自哪家服务商。本机运行的模型不需要 key。
2. 粘贴 API key，点 **连接**。Tomrade 会检查它并选好模型。

已经登录了 Claude Code、Codex 这类本地智能体？那这一步已经完成了：助手会用它来对话，也用它的模型来规划。

**现在**：打开助手面板顶部的设置卡片，或者设置 → **助手**。`
    },
    {
      key: "a2",
      title: "打开「学习路径」视图",
      body: `有些课要等别的课先完成，比如需要助手能用的那几课，要等 **把一个想法拆成工单**。侧边栏视图里的 **学习路径** 把这种关系画成关系图。

1. 顺着箭头看：前置都完成了的工单就可以做了，没有箭头指向的工单现在就能做。从已完成的工单出发的箭头会变淡。
2. 任何视图都可以这样画——在看板上方那一行，把「看板」「表格」切到 **关系图**。

**现在**：点侧边栏视图里的 **学习路径**，然后把这个工单移到「已完成」。`
    },
    {
      key: "a5",
      title: `用 ${keys.palette} 找到任何东西`,
      body: `命令面板是最快的入口：按 ${keys.palette}，或者点标题栏的 **搜索**。

1. 输入工单编号或标题的一部分，比如「番茄」，回车打开。
2. 也可以输入文件名，或者命令：「新建工单」「例行事务…」「历史」、某个主题。
3. 在输入框以外的地方按 **?**：**键盘快捷键** 列出所有按键，点 **修改按键…** 可以改。按 **N** 新建工单。

**现在**：按 ${keys.palette}，然后把这个工单移到「已完成」。`
    },
    {
      key: "a3",
      title: "写一篇笔记，添加到这个工单上",
      body: `文件和笔记都是项目文件夹里的纯文本，可以直接阅读、备份和提交。

1. 在新笔记里随便写几句。
2. 在笔记的工具栏里点 **添加到工单…**，选中这个工单。这篇笔记就会出现在这个工单上。
3. ${keys.searchNotes} 可以搜索所有笔记。

**现在**：在侧边栏 **文件** 旁边点 **+** → **新建笔记**。`
    },
    {
      key: "a4",
      title: "加一个字段，存一个视图",
      body: `字段决定每个工单记录什么，视图决定你怎么看这些工单。

1. 加一个字段，比如数字类型的「预计时长」。
2. 在看板上把工作流筛选成 **示例：番茄钟 App**，再点筛选栏里的 **另存为新视图…**。新视图会一直留在侧边栏。

**现在**：点看板上方那一行里、**视图** 旁边的 **字段**。`
    },
    {
      key: "a6",
      title: "建一个例行事务",
      body: `例行事务是你反复要做的事：每天的待办、一张清单、问助手的一个问题。想做就运行一次，也可以定时。

1. 在 **推荐模板** 里，点 **每日待办** 旁边的 **添加**，再点 **立即运行**。这个工作流里会出现一张待办卡片——把它拖到「已完成」。
2. 打开这个例行事务，点 **+ 定时**，选 **工作日** 和时刻。**按时自动运行** 可以随时开关。

定时只在这台电脑上、Tomrade 开着的时候运行。

**现在**：点侧边栏的 **例行事务**。`
    },
    {
      key: "a7",
      title: "分诊收件箱",
      body: `用户反馈和 bug 先进 **收件箱**，由你决定它们变成什么。番茄钟 App 的三位用户来信了，**待分诊** 里有三条。

1. 计时器的 bug：**接受为工单** → **创建工单**。它进了 backlog，并和这条反馈关联。
2. 想要更长休息的那条：**并入已有工单**，选 **设置页**——它已经包含这件事。
3. 日历的想法：**不做**。已经收到过的反馈用 **重复**。

在你自己的项目里，**来源** 可以接入 GitHub Issues。接上模型后，**给个分诊建议** 会替每一条想好怎么处理。

**现在**：点侧边栏的 **收件箱**。`
    },
    {
      key: "b2",
      title: "让助手整理示例 backlog",
      body: `**示例：番茄钟 App** 里故意放了一个重复的工单和一个太大的工单。

1. 看助手合并重复的工单、拆开太大的工单。它改过的卡片会带 AI 标记。
2. 运行结束时，底部会写明改了几处；点那里的 **撤销** 就能全部撤回。

**现在**：在助手面板里点 **整理一下 backlog**，或者直接说：*整理「示例：番茄钟 App」这个工作流*。`
    },
    {
      key: "b5",
      title: "把项目的规则告诉助手",
      body: `规则是这个项目的做事方式，写一次就行：助手和编码智能体动手前都会先读。

1. 写一句，比如「每个工单的标题以动词开头。」，点 **保存规则**。
2. 跟助手说：*加一个深色模式的工单*——它起的标题会照着规则来。
3. 助手发现你的习惯时，会问要不要记下来：**加入规则** 或 **不加**。

规则是项目文件夹里的一个文件，跟着项目走。

**现在**：打开项目设置 → **规则**。`
    },
    {
      key: "c2",
      title: "绑定你自己的仓库（可选）",
      body: `番茄钟示例自带仓库。要让智能体改你自己的代码，按下面做；不需要的话直接拖到「已完成」。

1. 添加一个 git 仓库，选好它在这台电脑上的 checkout。
2. 在这个仓库下的 **用于工作流：** 里勾上一个工作流。（也可以在侧边栏把鼠标移到工作流上，点 **连接仓库**。）
3. 在这个工作流里的工单上点 **开始**：智能体会在独立的分支和工作树里改代码。有远端的仓库，做完会开 PR；没有远端的，像示例一样在本机合并它的分支。

**现在**：打开项目设置 → **代码仓库** → **添加仓库**。`
    },
    {
      key: "d1",
      title: "装一个插件",
      body: `Tomrade 的很多功能都是插件：收件箱、例行事务、助手上方的宠物、每个聊天软件。你还可以再装。

1. **仅官方** 只显示 Tomrade 官方做的插件。
2. 在一个插件上点 **安装**，看清它要用哪些权限，再点一次 **安装**。有设置项的插件，会在 设置 → 插件 下面有自己的一页。
3. 状态栏右边的番茄就是番茄钟插件：点它开始一段专注。

**现在**：打开设置 → **管理插件** → **浏览**。`
    },
    {
      key: "d2",
      title: "在终端里的 Claude Code 或 Codex 中使用 Tomrade（可选）",
      body: `你自己打开的智能体，也能读写这个 backlog。

1. 在设置 → **助手** 里展开 Claude Code、Codex 或其他智能体 → **你自己开的会话** → **连接到 Tomrade**。
2. 在那个智能体里问：*我的 Tomrade backlog 里有什么？*
3. 代码仓库的话，项目设置 → **代码仓库** → **连接到编码智能体**，会把说明写进仓库，智能体就会认领工单、在它的分支上干活。

**现在**：打开设置 → **助手**。`
    },
    {
      key: "d3",
      title: "在聊天软件里和 Tomrade 对话（可选）",
      body: `助手也能在 Discord、Slack、飞书、Telegram 等软件里回复你，有事需要你处理时也会在那里提醒。

1. 选平台，按步骤建一个机器人。
2. 在 **成员** 里点 **生成配对码**，私信发给机器人，再回到这里确认。
3. **会话里推送什么** 决定还有哪些消息会推到聊天里：工单状态变化、PR、你离开时的提问。

**现在**：打开设置 → **IM** → **连接机器人**。`
    },
    {
      key: "d4",
      title: "在多台电脑上用同一批项目（可选）",
      body: `每个项目都是这台电脑上的一个文件夹。登录账号后，项目列表和偏好设置会带到你的其他电脑上。

1. 登录，或者注册一个账号。
2. 要共享某个项目的内容：项目设置 → **存储**，在一个 git 远端上点 **发布到此处**。

这个入门项目永远不会同步——它只属于这台电脑。

**现在**：打开设置 → **主目录** → **Tomrade 账号** → **登录**。`
    },
    {
      key: "d5",
      title: "把工单派到你的另一台电脑上做（可选）",
      body: `工单不一定要在你做规划的这台电脑上做：一张 Windows 的修复可以派到你的 Windows 电脑上，由那里的智能体开工，你在这边继续。只有一台电脑的话，直接拖到「已完成」。

1. 在另一台电脑上登录同一个账号。两台电脑都会出现在设置 → **设备** 里。
2. 还是在那台电脑上，在设置 → **设备** 里打开 **接受我其他设备派来的工作**。它默认关闭：打开就是允许智能体在那台电脑上运行、修改那里的代码，范围由旁边的限制决定。
3. 回到这台电脑，打开一张两台电脑都有的项目里的代码工单，打开它的开工对话框：点 **开始**；如果「开始」已经记住了上次的选择，点它旁边的箭头 → **完整设置…**。在 **在哪台电脑上运行** 里选那台电脑，再点 **派给…**。

那边的智能体用那台电脑自己的登录，在工单自己的分支上做。成果以提交和 PR 的形式回来，工单上会写明它在哪台电脑上运行。免费版最多两台电脑。

番茄钟示例派不出去：这个入门项目只在这台电脑上。

**现在**：打开设置 → **设备**，看看你的哪些电脑登录了账号。`
    }
  ],
  examples: [
    {
      key: "e1",
      title: "计时器：加一个重置按钮",
      coding: true,
      body: `\`pomodoro\` 仓库里的计时器能开始、暂停。加上 **重置**：停下计时器，回到 25:00。

- 在 \`timer.js\` 里加 \`reset()\`，在 \`timer.test.js\` 里加测试；\`npm test\` 通过。
- 在 \`index.html\` 里 Start、Pause 旁边加一个 **Reset** 按钮。`
    },
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
});

/** The sample in `locale`, its shortcuts written as `platform`'s keyboard shows them. */
export function sampleWords(locale: SeedLocale, platform: NodeJS.Platform = process.platform): SampleWords {
  const keys = { palette: keyText(DEFAULT_KEYS.palette[0], platform), searchNotes: keyText(DEFAULT_KEYS.searchNotes[0], platform), undo: keyText(DEFAULT_KEYS.undo[0], platform) };
  return (locale === "zh" ? zh : en)(keys);
}

/** The sample for this machine, which seeds it. */
export const SAMPLE: Record<SeedLocale, SampleWords> = { en: sampleWords("en"), zh: sampleWords("zh") };
