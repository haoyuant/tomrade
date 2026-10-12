import type { Cadence } from "./cadence.js";
import type { TemplateInput } from "./template.js";

export type SuggestionGroup = "everyday" | "work" | "coding";

/** A ready-made template, offered for one click; once added it is the project's own to change. */
export interface Suggestion {
  id: string;
  group: SuggestionGroup;
  template: TemplateInput;
  /** When it would run, if added with its schedule; none means it is run by hand. */
  cadence?: Cadence;
}

type Words = { name: string; description: string; title?: string[]; body?: string[]; labels?: string[]; prompt?: string };
interface Spec {
  id: string;
  group: SuggestionGroup;
  cadence?: Cadence;
  kind: "tickets" | "assistant";
  /** For tickets: how many, and what each starts as. */
  items?: { status?: "backlog" | "todo"; priority?: number; workType?: "coding" | "general" }[];
  words: Record<"en" | "zh", Words>;
}

const SPECS: Spec[] = [
  {
    id: "daily-todo",
    group: "everyday",
    cadence: { kind: "daily", at: "08:00" },
    kind: "tickets",
    items: [{ priority: 3 }],
    words: {
      en: {
        name: "Daily to-do",
        description: "A fresh to-do for the day every morning, with room for the three things that matter.",
        title: ["To-do · {weekday} {date}"],
        body: ["- [ ] The one thing that matters most today\n- [ ] \n- [ ] "],
        labels: ["daily"]
      },
      zh: {
        name: "每日待办",
        description: "每天早上一张新的当日待办，写下今天最重要的三件事。",
        title: ["待办 · {date} {weekday}"],
        body: ["- [ ] 今天最重要的一件事\n- [ ] \n- [ ] "],
        labels: ["每日"]
      }
    }
  },
  {
    id: "weekly-chores",
    group: "everyday",
    cadence: { kind: "weekly", at: "10:00", days: [6] },
    kind: "tickets",
    items: [{}, {}, {}],
    words: {
      en: { name: "Weekly chores", description: "Saturday's chores as three cards to tick off.", title: ["Laundry", "Groceries", "Clean the kitchen"], labels: ["chores"] },
      zh: { name: "每周家务", description: "周六的家务，三张卡片做完一张划掉一张。", title: ["洗衣服", "买菜", "打扫厨房"], labels: ["家务"] }
    }
  },
  {
    id: "monthly-bills",
    group: "everyday",
    cadence: { kind: "monthly", at: "09:00", day: 1 },
    kind: "tickets",
    items: [{ priority: 3 }],
    words: {
      en: { name: "Monthly bills", description: "On the 1st, a checklist of the bills to pay.", title: ["Bills for {month}"], body: ["- [ ] Rent\n- [ ] Utilities\n- [ ] Phone and internet\n- [ ] Credit card"], labels: ["money"] },
      zh: { name: "每月账单", description: "每月 1 号，一张要交的账单清单。", title: ["{month} 账单"], body: ["- [ ] 房租\n- [ ] 水电燃气\n- [ ] 话费和宽带\n- [ ] 信用卡"], labels: ["钱"] }
    }
  },
  {
    id: "water-plants",
    group: "everyday",
    cadence: { kind: "days", at: "09:00", every: 3 },
    kind: "tickets",
    items: [{}],
    words: {
      en: { name: "Water the plants", description: "Every three days.", title: ["Water the plants"], labels: ["home"] },
      zh: { name: "给植物浇水", description: "每三天一次。", title: ["给植物浇水"], labels: ["家里"] }
    }
  },
  {
    id: "morning-plan",
    group: "everyday",
    cadence: { kind: "weekdays", at: "08:30" },
    kind: "assistant",
    words: {
      en: {
        name: "Plan my day",
        description: "On workdays the assistant picks at most three things for today from what is open, and says why.",
        prompt: "Plan my day ({weekday} {date}). Look at what is open in this project and pick at most three things for today, with one line each on why. Don't change any ticket."
      },
      zh: {
        name: "规划今天",
        description: "工作日早上，助手从没做完的事里挑最多三件今天做，并说明理由。",
        prompt: "帮我规划今天（{date} {weekday}）。看看这个项目里还没做完的事，挑最多三件今天做，每件用一句话说明理由。不要改动任何工作项。"
      }
    }
  },
  {
    id: "weekly-review",
    group: "everyday",
    cadence: { kind: "weekly", at: "18:00", days: [7] },
    kind: "assistant",
    words: {
      en: {
        name: "Weekly review",
        description: "Sunday evening: what got done, what slipped, and three things for next week.",
        prompt: "It's the weekly review for {week}. Look at what was finished this week and what is still open. Write a short review: what got done, what slipped and why, and the three things to focus on next week. Ask me before changing any ticket."
      },
      zh: {
        name: "每周回顾",
        description: "周日晚上：这周做完了什么、什么拖了，下周重点做哪三件。",
        prompt: "这是 {week} 的每周回顾。看看这周做完了什么、还有什么没做完，写一段简短的回顾：做完了什么，什么拖了、为什么，下周重点做哪三件。改动任何工作项之前先问我。"
      }
    }
  },
  {
    id: "weekly-report",
    group: "work",
    cadence: { kind: "weekly", at: "17:00", days: [5] },
    kind: "assistant",
    words: {
      en: {
        name: "Weekly report",
        description: "Friday afternoon, a report from the tickets finished this week, short enough to paste into a message.",
        prompt: "Write this week's report ({week}) from the tickets finished since Monday: what was delivered, what is in progress, what is blocked and on what. Keep it short enough to paste into a message."
      },
      zh: {
        name: "周报",
        description: "周五下午，根据本周完成的工作项写周报，短到能直接贴进消息。",
        prompt: "根据周一以来完成的工作项写本周（{week}）的周报：交付了什么、正在做什么、什么被卡住以及卡在哪里。短到能直接贴进消息里。"
      }
    }
  },
  {
    id: "dependency-sweep",
    group: "work",
    cadence: { kind: "weekdays", at: "09:00" },
    kind: "assistant",
    words: {
      en: {
        name: "Check what is unblocked",
        description: "Each workday, see which waiting tickets can move now.",
        prompt: "Check the tickets that are blocked or waiting on others: is what they wait on done now? List which can move, and ask before changing any status."
      },
      zh: {
        name: "检查哪些解除了阻塞",
        description: "每个工作日看看哪些在等待的工作项现在可以动了。",
        prompt: "检查被阻塞、或在等别的工作项的那些：它们等的东西现在做完了吗？列出可以开始的，改状态之前先问我。"
      }
    }
  },
  {
    id: "release-checklist",
    group: "coding",
    kind: "tickets",
    items: [{ workType: "coding", priority: 3 }],
    words: {
      en: { name: "Release checklist", description: "Run it when you cut a release.", title: ["Release {date}"], body: ["- [ ] Changelog\n- [ ] Version bump\n- [ ] Tag and build\n- [ ] Smoke-test the build\n- [ ] Announce"], labels: ["release"] },
      zh: { name: "发版清单", description: "准备发版时运行一次。", title: ["发版 {date}"], body: ["- [ ] 更新日志\n- [ ] 版本号\n- [ ] 打 tag 并构建\n- [ ] 冒烟测试\n- [ ] 发布通知"], labels: ["发版"] }
    }
  }
];

/** The gallery, in the person's language. */
export function suggestions(locale: "en" | "zh"): Suggestion[] {
  return SPECS.map((spec) => {
    const w = spec.words[locale];
    const template: TemplateInput =
      spec.kind === "assistant"
        ? { name: w.name, description: w.description, action: { kind: "assistant", prompt: w.prompt! } }
        : {
            name: w.name,
            description: w.description,
            action: {
              kind: "tickets",
              items: (spec.items ?? [{}]).map((item, i) => ({
                title: w.title![i]!,
                body: w.body?.[i] ?? "",
                labels: w.labels ?? [],
                ...item
              }))
            }
          };
    return { id: spec.id, group: spec.group, template, ...(spec.cadence ? { cadence: spec.cadence } : {}) };
  });
}
