import { z } from "zod";
import type { Context } from "cordis";
import type { SettingsSection } from "@tomradex/settings";
import { DESKTOP_WORDS } from "./words.js";

export type OpenAtStart = "main" | "terminal" | "both";
export interface SessionPrefs {
  openAtStart: OpenAtStart;
  afterAnswer: "next" | "stay";
}

const en = DESKTOP_WORDS("en");
const zh = DESKTOP_WORDS("zh");

/** Settings › Sessions: how sessions open. A user section, so it travels with the person's other settings. */
export const SESSIONS_SECTION: SettingsSection<SessionPrefs> = {
  id: "sessions",
  title: en("sessionsTitle"),
  description: en("sessionsDescription"),
  schema: z.object({
    openAtStart: z.enum(["main", "terminal", "both"]).default("main").meta({ title: en("openAtStartTitle") }).describe(en("openAtStartDescription")),
    afterAnswer: z.enum(["next", "stay"]).default("next").meta({ title: en("afterAnswerTitle") }).describe(en("afterAnswerDescription"))
  }),
  defaults: { openAtStart: "main", afterAnswer: "next" },
  order: 16,
  scope: "user",
  agent: "read",
  words: {
    en: { fields: { openAtStart: { options: { main: en("openAtStartMain"), terminal: en("openAtStartTerminal"), both: en("openAtStartBoth") } }, afterAnswer: { options: { next: en("afterAnswerNext"), stay: en("afterAnswerStay") } } } },
    zh: {
      title: zh("sessionsTitle"),
      description: zh("sessionsDescription"),
      fields: {
        openAtStart: { title: zh("openAtStartTitle"), description: zh("openAtStartDescription"), options: { main: zh("openAtStartMain"), terminal: zh("openAtStartTerminal"), both: zh("openAtStartBoth") } },
        afterAnswer: { title: zh("afterAnswerTitle"), description: zh("afterAnswerDescription"), options: { next: zh("afterAnswerNext"), stay: zh("afterAnswerStay") } }
      }
    }
  }
};

export function openAtStart(ctx: Context): OpenAtStart {
  const value = (ctx.get("settings")?.get().sessions as Partial<SessionPrefs> | undefined)?.openAtStart;
  return value === "terminal" || value === "both" ? value : "main";
}

/** Which windows a start opens: the main window unless the person chose the Terminal window alone and there is one to open. */
export function startWindows(choice: OpenAtStart, hasTerminal: boolean): { main: boolean; terminal: boolean } {
  if (!hasTerminal) return { main: true, terminal: false };
  return { main: choice !== "terminal", terminal: choice !== "main" };
}
