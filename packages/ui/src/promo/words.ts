/** The films' own words, in the two languages the app is complete in. Words the app shows are read from its dictionaries instead. */
export type Lang = "en" | "zh";

/** What every film ends on. In a caption, *stars* mark what is lit in the sun's colours and a line break starts a new line. */
export const OUTRO = {
  en: { tagline: "From idea to delivery,\nside by side.", get: "tomrade.com", platforms: "Free for macOS, Windows and Linux" },
  zh: { tagline: "从想法到交付，\n并肩作战。", get: "tomrade.com", platforms: "免费，支持 macOS、Windows 和 Linux" }
} as const satisfies Record<Lang, Record<string, string>>;

/**
 * What the code-link plugin says on a card (packages/code-link/src/words.ts). Its package runs in the main process,
 * so the film keeps a copy of these few.
 */
export const CODE_WORDS = {
  en: { session: "{{agent}} at work · {{where}} · {{time}}", pane: "in a terminal pane", minutes: "{{n}} min", hours: "{{n}} h", waiting: "waiting", merged: "merged", branch: "branch", waitingForYou: "waiting for you" },
  zh: { session: "{{agent}} 在做 · {{where}} · {{time}}", pane: "终端格子里", minutes: "{{n}} 分钟", hours: "{{n}} 小时", waiting: "在等你", merged: "已合并", branch: "分支", waitingForYou: "在等你" }
} as const satisfies Record<Lang, Record<string, string>>;

export interface TicketWords { title: string; label: string }

export const PROJECT = { en: "Paperplane", zh: "纸飞机" } as const satisfies Record<Lang, string>;
