import { z } from "zod";
import type { Context } from "cordis";
import type { SettingsSection } from "@tomradex/settings";
import { DESKTOP_WORDS } from "./words.js";

export type OpenAtStart = "main" | "terminal" | "both";
export interface SessionPrefs {
  /** The assistant panel's session bar: cards on a wide panel and dots on a narrow one, or always one of them. */
  sessionBar: "auto" | "rail" | "cards";
  /** Hovering a dot of the folded bar shows what that session is doing. */
  peek: boolean;
  openAtStart: OpenAtStart;
  afterAnswer: "next" | "stay";
  /** A terminal start runs in a background pane watched in the panel, or brings up the Terminal window too. */
  newWhere: "pane" | "window";
  /** The `tomrade` command on the person's PATH (tomrade-command.ts). */
  commandOnPath: boolean;
}

const en = DESKTOP_WORDS("en");
const zh = DESKTOP_WORDS("zh");

/** Settings › Sessions: how sessions open. A user section, so it travels with the person's other settings. */
export const SESSIONS_SECTION: SettingsSection<SessionPrefs> = {
  id: "sessions",
  title: en("sessionsTitle"),
  description: en("sessionsDescription"),
  schema: z.object({
    sessionBar: z.enum(["auto", "rail", "cards"]).default("auto").meta({ title: en("sessionBarTitle") }).describe(en("sessionBarDescription")),
    peek: z.boolean().default(true).meta({ title: en("peekTitle") }).describe(en("peekDescription")),
    openAtStart: z.enum(["main", "terminal", "both"]).default("main").meta({ title: en("openAtStartTitle") }).describe(en("openAtStartDescription")),
    afterAnswer: z.enum(["next", "stay"]).default("next").meta({ title: en("afterAnswerTitle") }).describe(en("afterAnswerDescription")),
    newWhere: z.enum(["pane", "window"]).default("pane").meta({ title: en("newWhereTitle") }).describe(en("newWhereDescription")),
    commandOnPath: z.boolean().default(true).meta({ title: en("commandOnPathTitle") }).describe(en("commandOnPathDescription"))
  }),
  defaults: { sessionBar: "auto", peek: true, openAtStart: "main", afterAnswer: "next", newWhere: "pane", commandOnPath: true },
  order: 16,
  scope: "user",
  agent: "read",
  words: {
    en: { fields: { sessionBar: { options: { auto: en("sessionBarAuto"), rail: en("sessionBarRail"), cards: en("sessionBarCards") } }, openAtStart: { options: { main: en("openAtStartMain"), terminal: en("openAtStartTerminal"), both: en("openAtStartBoth") } }, afterAnswer: { options: { next: en("afterAnswerNext"), stay: en("afterAnswerStay") } }, newWhere: { options: { pane: en("newWherePane"), window: en("newWhereWindow") } } } },
    zh: {
      title: zh("sessionsTitle"),
      description: zh("sessionsDescription"),
      fields: {
        sessionBar: { title: zh("sessionBarTitle"), description: zh("sessionBarDescription"), options: { auto: zh("sessionBarAuto"), rail: zh("sessionBarRail"), cards: zh("sessionBarCards") } },
        peek: { title: zh("peekTitle"), description: zh("peekDescription") },
        openAtStart: { title: zh("openAtStartTitle"), description: zh("openAtStartDescription"), options: { main: zh("openAtStartMain"), terminal: zh("openAtStartTerminal"), both: zh("openAtStartBoth") } },
        afterAnswer: { title: zh("afterAnswerTitle"), description: zh("afterAnswerDescription"), options: { next: zh("afterAnswerNext"), stay: zh("afterAnswerStay") } },
        newWhere: { title: zh("newWhereTitle"), description: zh("newWhereDescription"), options: { pane: zh("newWherePane"), window: zh("newWhereWindow") } },
        commandOnPath: { title: zh("commandOnPathTitle"), description: zh("commandOnPathDescription") }
      }
    }
  }
};

export function openAtStart(ctx: Context): OpenAtStart {
  const value = (ctx.get("settings")?.get().sessions as Partial<SessionPrefs> | undefined)?.openAtStart;
  return value === "terminal" || value === "both" ? value : "main";
}

/** Whether the `tomrade` command should be on PATH: on unless the person turned it off. */
export function commandOnPath(ctx: Context): boolean {
  return (ctx.get("settings")?.get().sessions as Partial<SessionPrefs> | undefined)?.commandOnPath !== false;
}

/** Which windows a start opens: the main window unless the person chose the Terminal window alone and there is one to open. */
export function startWindows(choice: OpenAtStart, hasTerminal: boolean): { main: boolean; terminal: boolean } {
  if (!hasTerminal) return { main: true, terminal: false };
  return { main: choice !== "terminal", terminal: choice !== "main" };
}
