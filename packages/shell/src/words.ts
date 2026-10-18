import { defineWords } from "@tomradex/domain";

/** What the shell asks the person before a command runs. */
export const SHELL_WORDS = defineWords("shell", {
  en: { once: "Allow once", turn: "Allow for this turn", deny: "Deny", question: "Run this command in {{cwd}}?\n\n{{command}}" },
  zh: { once: "允许这一次", turn: "这一轮都允许", deny: "拒绝", question: "在 {{cwd}} 里运行这条命令？\n\n{{command}}" }
});
