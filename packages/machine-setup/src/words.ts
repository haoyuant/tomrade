import { defineWords } from "@tomradex/domain";

/** The machine's git, as the troubleshooter's checklist reads it out. */
export const MACHINE_WORDS = defineWords("machine-setup", {
  en: {
    checkGit: "git",
    gitFound: "git {{version}}",
    gitMissing: "git is not installed — Tomrade works without it, but local-file version history and repository features need it. Install it from git-scm.com/downloads",
    gitBroken: "a git was found at {{path}} but did not answer: {{error}}",
    checkNpm: "npm",
    npmFound: "npm {{version}} — agent installs use it",
    npmMissing: "no npm — agent installs that use it cannot run. Installing Node.js (nodejs.org) brings it",
    npmBroken: "an npm was found at {{path}} but did not answer: {{error}}"
  },
  zh: {
    checkGit: "git",
    gitFound: "git {{version}}",
    gitMissing: "没有安装 git——不装也能用 Tomrade，但本地文件的版本历史和仓库相关功能需要它。可以从 git-scm.com/downloads 安装",
    gitBroken: "在 {{path}} 找到了 git，但它没有正常运行：{{error}}",
    checkNpm: "npm",
    npmFound: "npm {{version}}——安装 agent 用的就是它",
    npmMissing: "没有 npm——要用 npm 安装的 agent 装不了。安装 Node.js（nodejs.org）就有了",
    npmBroken: "在 {{path}} 找到了 npm，但它没有正常运行：{{error}}"
  }
});
