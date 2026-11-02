import { defineWords } from "@tomradex/domain";

export const PR_FEEDBACK_WORDS = defineWords("pr-feedback", {
  en: {
    sectionTitle: "PR feedback",
    sectionDescription: "Failed CI, reviews and people's comments on a ticket's pull request reach the agent working that ticket. Each wake is a run of that agent, and costs what a run costs.",
    enabledTitle: "Wake agents on pull request feedback",
    enabledDescription: "Tomrade looks at open pull requests of tickets started from this machine, while it runs.",
    maxWakesTitle: "Wakes per ticket",
    maxWakesDescription: "After this many, new feedback waits for you instead.",
    allowedLoginsTitle: "Also allow these GitHub accounts",
    allowedLoginsDescription: "Separated by commas. The pull request's author and people with access to the repository are always allowed; anyone else is only recorded.",
    noticeCapped: "PR #{{number}}: automatic wakes are used up ({{max}}). New GitHub feedback waits for you.",
    noticeUnreachable: "PR #{{number}} has new GitHub feedback. This agent cannot be woken from Tomrade, so it is yours to pass on.",
    noticeLocked: "PR #{{number}} has new GitHub feedback. The ticket is locked, so Tomrade did not wake its agent.",
    noticeRefused: "PR #{{number}}: Tomrade could not pass on new GitHub feedback: {{why}}",
    noticeUnreadable: "PR #{{number}}: Tomrade cannot read this pull request's feedback on GitHub."
  },
  zh: {
    sectionTitle: "PR 反馈",
    sectionDescription: "工单 PR 上的 CI 失败、review 和人的评论，会送到做这张工单的 agent。每次唤醒都是这个 agent 的一次运行，按一次运行计费。",
    enabledTitle: "收到 PR 反馈时唤醒 agent",
    enabledDescription: "Tomrade 运行时，会查看从这台电脑开工的工单的打开的 PR。",
    maxWakesTitle: "每张工单的唤醒次数",
    maxWakesDescription: "达到这个次数后，新的反馈改为等你处理。",
    allowedLoginsTitle: "另外允许这些 GitHub 账号",
    allowedLoginsDescription: "用逗号分隔。PR 作者和有仓库权限的人始终允许，其他人只记录。",
    noticeCapped: "PR #{{number}}：自动唤醒次数已用完（{{max}} 次），新的 GitHub 反馈等你处理。",
    noticeUnreachable: "PR #{{number}} 有新的 GitHub 反馈。这个 agent 无法从 Tomrade 唤醒，需要你转告。",
    noticeLocked: "PR #{{number}} 有新的 GitHub 反馈。工单已锁定，Tomrade 没有唤醒它的 agent。",
    noticeRefused: "PR #{{number}}：Tomrade 无法转交新的 GitHub 反馈：{{why}}",
    noticeUnreadable: "PR #{{number}}：Tomrade 读不到这个 PR 在 GitHub 上的反馈。"
  }
});
