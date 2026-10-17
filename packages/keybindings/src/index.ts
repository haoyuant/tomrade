import type { Context } from "cordis";
import { z } from "zod";
import type { SettingsSection } from "@tomradex/settings";
import { CHORD } from "./chord.js";
import { KEYBINDINGS_WORDS } from "./words.js";

export { CHORD } from "./chord.js";

export interface KeybindingsSettings {
  /**
   * The commands the person rebound, by command id, each to its whole list of
   * chords; an empty list unbinds it. A command left out keeps its default,
   * so new defaults still reach someone who changed something else.
   */
  overrides: Record<string, string[]>;
}

const en = KEYBINDINGS_WORDS("en");
const zh = KEYBINDINGS_WORDS("zh");

export const KEYBINDINGS_SECTION: SettingsSection<KeybindingsSettings> = {
  id: "keybindings",
  title: en("title"),
  description: en("description"),
  schema: z.object({
    overrides: z.record(z.string().regex(/^[a-zA-Z][\w.:-]{0,79}$/), z.array(z.string().regex(CHORD)).max(4)).default({})
  }),
  defaults: { overrides: {} },
  order: 3,
  // The person's hands, not the machine's: the keys travel with the Hub, and with the account when it syncs.
  scope: "user",
  agent: "read",
  words: {
    zh: { title: zh("title"), description: zh("description") }
  }
};

export default {
  name: "keybindings",
  inject: ["settings"],
  apply(ctx: Context) {
    ctx.settings.register(KEYBINDINGS_SECTION);
  }
};
