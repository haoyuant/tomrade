import { defineWords } from "@tomradex/domain";

export const GITHUB_WORDS = defineWords("inbox-github", {
  en: {
    source: "GitHub issues",
    connect: "Connect a GitHub account first — from a project's destination or Files settings",
    noRepo: "None of this project's repositories is on GitHub",
    noAccess: "GitHub refused {{repo}}'s issues ({{why}}). The Tomrade GitHub App needs the Issues permission on it; a personal access token with the repo scope works too.",
    repoFailed: "{{repo}} was skipped this time: {{why}}. Its issues are caught up once it can be read again.",
    releaseFailed: "Could not check releases for shipped tickets: {{why}}. Tried again next time.",
    comment: "Comment on the issue",
    commentHelp: "When it is accepted, merged into a ticket, closed, or its ticket ships",
    close: "Close the issue",
    closeHelp: "As completed once its ticket ships; as not planned when it won't be done or is a duplicate"
  },
  zh: {
    source: "GitHub Issues",
    connect: "先连接 GitHub 账号——在项目的存储位置或文件设置里",
    noRepo: "这个项目的仓库都不在 GitHub 上",
    noAccess: "GitHub 拒绝访问 {{repo}} 的 issues（{{why}}）。Tomrade GitHub App 需要这个仓库的 Issues 权限；也可以改用带 repo 范围的个人访问令牌。",
    repoFailed: "这次跳过了 {{repo}}：{{why}}。能读取后会补上这段时间的 issue。",
    releaseFailed: "没能检查已完成工单所在的发版：{{why}}。下次再试。",
    comment: "在 issue 下评论",
    commentHelp: "接受、并入工单、关闭，或工单发版时",
    close: "关闭 issue",
    closeHelp: "工单发版后以 completed 关闭；不做或重复的以 not planned 关闭"
  }
});
