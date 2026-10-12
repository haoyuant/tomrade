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
    id: "daily-words",
    group: "everyday",
    cadence: { kind: "daily", at: "08:00" },
    kind: "assistant",
    words: {
      en: {
        name: "5 words a day",
        description: "Five useful English words every morning, with meaning, pronunciation, an example and a way to remember each.",
        prompt: "Give me five useful, frequently used English words for today ({date}). For each: the meaning, the pronunciation (IPA), one natural example sentence, and a short memory hook."
      },
      zh: {
        name: "每日 5 个英语单词",
        description: "每天早上 5 个高频实用的英语单词，带词义、音标、例句和记忆提示。",
        prompt: "给我今天（{date}）的 5 个高频实用英语单词。每个写出：中文词义、音标、一个自然的例句（附中文翻译），以及一句简短的记忆提示。"
      }
    }
  },
  {
    id: "on-this-day",
    group: "everyday",
    cadence: { kind: "daily", at: "08:30" },
    kind: "assistant",
    words: {
      en: {
        name: "On this day",
        description: "One interesting thing that happened on today's date — in science, film, music or elsewhere — in about 200 words.",
        prompt: "Pick one interesting event that happened on this day ({date}, ignore the year) in science, technology, film, music or another field, and tell it in about 200 words: what happened, and why it still matters. Search the web if you can, to get the date right; if you can't check it, say so."
      },
      zh: {
        name: "历史上的今天",
        description: "从科技、电影、音乐等领域挑一件「今天发生过」的有趣事件，200 字左右讲清楚。",
        prompt: "从科技、电影、音乐等领域挑一件在今天（{date}，不看年份）发生过的有趣事件，用 200 字左右讲清楚：发生了什么，为什么到今天还值得一提。能联网搜索就先搜索核对日期；核对不了要说明。"
      }
    }
  },
  {
    id: "daily-why",
    group: "everyday",
    cadence: { kind: "daily", at: "12:00" },
    kind: "assistant",
    words: {
      en: {
        name: "A why a day",
        description: "One curious question a day, asked first and then answered in plain words.",
        prompt: "Ask me one curious everyday \"why\" question (science, nature, language, history — anything), then answer it in plain, friendly words in under 200 words, with one surprising detail."
      },
      zh: {
        name: "每日一个为什么",
        description: "每天抛出一个有趣的问题，先提问再解答，语气轻松、通俗易懂。",
        prompt: "先抛出一个有趣的日常「为什么」问题（科学、自然、语言、历史都可以），再用轻松、通俗的话解答，200 字以内，带一个让人意外的小细节。"
      }
    }
  },
  {
    id: "film-pick",
    group: "everyday",
    cadence: { kind: "weekly", at: "19:00", days: [5] },
    kind: "assistant",
    words: {
      en: {
        name: "A classic film",
        description: "Friday evening, one highly rated classic film: what it's about, what stands out, and why it's worth watching — no spoilers.",
        prompt: "Recommend one highly rated classic film for this weekend. Give a short spoiler-free outline, what stands out, and why it's worth watching."
      },
      zh: {
        name: "经典电影推荐",
        description: "周五晚上推荐一部高分经典电影，简要介绍剧情梗概、亮点和推荐理由，全程不剧透。",
        prompt: "推荐一部适合这个周末看的高分经典电影：简要介绍剧情梗概、亮点和推荐理由，全程不剧透。"
      }
    }
  },
  {
    id: "call-family",
    group: "everyday",
    cadence: { kind: "weekly", at: "10:00", days: [7] },
    kind: "tickets",
    items: [{}],
    words: {
      en: { name: "Call the family", description: "Sunday morning, a reminder to call or message your parents and ask how they are.", title: ["Call or message the family"], labels: ["family"] },
      zh: { name: "父母联系提醒", description: "每周日上午提醒你给家人打个电话或发个消息，问问近况。", title: ["给爸妈打个电话"], labels: ["家人"] }
    }
  },
  {
    id: "checkup-prep",
    group: "everyday",
    kind: "tickets",
    items: [{ priority: 3 }],
    words: {
      en: {
        name: "Health check-up",
        description: "Run it once you have booked a check-up: what to confirm and bring.",
        title: ["Health check-up"],
        body: ["- [ ] Confirm the time and place\n- [ ] ID and insurance card\n- [ ] Fast from the night before if asked\n- [ ] Bring earlier reports"],
        labels: ["health"]
      },
      zh: {
        name: "体检预约提醒",
        description: "约好体检后运行一次：要确认什么、带什么。",
        title: ["体检"],
        body: ["- [ ] 确认体检时间和地点\n- [ ] 带身份证和医保卡\n- [ ] 按要求前一晚开始空腹\n- [ ] 带上以往的体检报告"],
        labels: ["健康"]
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
    id: "ai-news",
    group: "work",
    cadence: { kind: "weekdays", at: "09:00" },
    kind: "assistant",
    words: {
      en: {
        name: "AI news today",
        description: "Each workday, the important AI news, leaning to AI coding and embodied AI, with links.",
        prompt: "Search the web for today's ({date}) important AI news, leaning towards AI coding tools and embodied AI / robotics. Pick at most five items; for each give one or two lines on what happened and why it matters, with a link. If you can't search the web, say so instead of writing from memory."
      },
      zh: {
        name: "每日 AI 新闻推送",
        description: "每个工作日整理当天 AI 领域的重要动态，侧重 AI coding 与具身智能，附链接。",
        prompt: "联网搜索今天（{date}）AI 领域的重要动态，侧重 AI coding 工具和具身智能 / 机器人。最多挑 5 条，每条用一两句话说清发生了什么、为什么重要，并附上链接。如果不能联网搜索，直接说明，不要凭记忆编写。"
      }
    }
  },
  {
    id: "interview-prep",
    group: "work",
    cadence: { kind: "weekdays", at: "09:30" },
    kind: "assistant",
    words: {
      en: {
        name: "Interview practice",
        description: "Each workday, a short review of LLM interview topics and three mock questions to answer.",
        prompt: "Help me prepare for LLM / AI engineering interviews. Pick one topic I should review today (e.g. attention, fine-tuning, RAG, evaluation, inference cost), sum up the key points in a few lines, then give me three mock interview questions on it — don't answer them until I try."
      },
      zh: {
        name: "面试准备提醒",
        description: "每个工作日复习一个大模型面试知识点，并给出 3 个模拟问题。",
        prompt: "帮我准备大模型 / AI 工程方向的面试。挑一个今天该复习的知识点（比如注意力机制、微调、RAG、评测、推理成本），用几句话总结要点，再出 3 个相关的模拟面试题——等我先作答，再给参考答案。"
      }
    }
  },
  {
    id: "meeting-prep",
    group: "work",
    kind: "tickets",
    items: [{ priority: 3 }],
    words: {
      en: {
        name: "Before a meeting",
        description: "Run it before a meeting: agenda, goal, open questions, and the decisions to come away with.",
        title: ["Prepare: meeting {date}"],
        body: ["- [ ] Agenda\n- [ ] What this meeting should achieve\n- [ ] Open questions to settle\n- [ ] Decisions and follow-ups (fill in after)"],
        labels: ["meeting"]
      },
      zh: {
        name: "会议前准备",
        description: "开会前运行一次：整理议题、目标、待确认问题和关键结论。",
        title: ["会前准备 · {date}"],
        body: ["- [ ] 议题\n- [ ] 这次会要达成的目标\n- [ ] 待确认的问题\n- [ ] 关键结论和后续事项（会后补）"],
        labels: ["会议"]
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
