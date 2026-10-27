import { z } from "zod";
import type { ClosedWindow } from "@tomradex/domain";
import type { SettingsSection } from "@tomradex/settings";
import { ITEMS_WORDS } from "./words.js";

const en = ITEMS_WORDS("en");
const zh = ITEMS_WORDS("zh");

const bound = z.number().int().min(1).max(100_000).nullable();

/** Each project's window by project id; a project absent here takes DEFAULT_CLOSED_WINDOW. Drawn in the project's settings, not the Settings pane. */
export const CLOSED_WINDOW_SECTION: SettingsSection<Record<string, ClosedWindow>> = {
  id: "closedWindow",
  title: en("closedWindowTitle"),
  description: en("closedWindowDescription"),
  schema: z.record(z.string(), z.object({ limit: bound, days: bound })),
  defaults: {},
  order: 30,
  scope: "user",
  agent: "write",
  words: {
    en: { title: en("closedWindowTitle"), description: en("closedWindowDescription") },
    zh: { title: zh("closedWindowTitle"), description: zh("closedWindowDescription") }
  }
};
