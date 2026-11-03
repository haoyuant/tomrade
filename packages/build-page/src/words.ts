import { defineWords } from "@tomradex/domain";

export const BUILD_PAGE_WORDS = defineWords("build-page", {
  en: {
    roadmap: "Roadmap",
    inProgress: "In progress",
    planned: "Planned",
    changelog: "Changelog",
    nothingYet: "Nothing here yet.",
    feedback: "Feedback",
    feedbackLede: "Found a bug or have an idea? Tell us in a GitHub issue — you'll hear back there when it ships.",
    feedbackButton: "Send feedback",
    feedbackFooter: "Sent from the public build page.",
    builtWith: "Built with",
    updated: "Updated {{date}}",
    noRepo: "This project has no GitHub repository to publish to. Add one to the project first.",
    notConnected: "Connect a GitHub account in Settings first.",
    stale: "The preview is out of date. Preview again, then publish.",
    noPreview: "Preview the page before publishing it.",
    foreignSite: "The gh-pages branch of {{repo}} already holds a site Tomrade did not make, so nothing was published.",
    pagesElsewhere: "Published to the gh-pages branch, but GitHub Pages for {{repo}} serves {{source}}. Switch it to gh-pages in the repository's Pages settings.",
    pagesFailed: "Published to the gh-pages branch, but GitHub Pages could not be turned on: {{why}}",
    commit: "Update the public build page"
  },
  zh: {
    roadmap: "路线图",
    inProgress: "进行中",
    planned: "计划中",
    changelog: "更新日志",
    nothingYet: "暂时还没有内容。",
    feedback: "反馈",
    feedbackLede: "遇到问题或有想法？在 GitHub Issue 里告诉我们——修好发布后会在那里回复你。",
    feedbackButton: "提交反馈",
    feedbackFooter: "来自公开构建页。",
    builtWith: "Built with",
    updated: "更新于 {{date}}",
    noRepo: "这个项目还没有可以发布的 GitHub 仓库。请先给项目添加一个。",
    notConnected: "请先在设置里连接 GitHub 账号。",
    stale: "预览已过期。请重新预览后再发布。",
    noPreview: "请先预览，再发布。",
    foreignSite: "{{repo}} 的 gh-pages 分支里已经有一个不是 Tomrade 生成的站点，所以没有发布。",
    pagesElsewhere: "已推送到 gh-pages 分支，但 {{repo}} 的 GitHub Pages 现在发布的是 {{source}}。请在仓库的 Pages 设置里改成 gh-pages。",
    pagesFailed: "已推送到 gh-pages 分支，但没能开启 GitHub Pages：{{why}}",
    commit: "Update the public build page"
  }
});

export type BuildPageWords = ReturnType<typeof BUILD_PAGE_WORDS>;
