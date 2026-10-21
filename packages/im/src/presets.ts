import type { ImRoute } from "./config.js";

type Preset = Pick<ImRoute, "ticketTopics" | "groupActivation" | "notify">;

/** What each kind of channel hears and wakes on; everything else is a route's default. */
export const GROUP_PRESETS = {
  work: { ticketTopics: true, groupActivation: "reply", notify: { tickets: true, code: true } },
  status: { ticketTopics: false, groupActivation: "mention", notify: { tickets: true, code: true, routines: true, presence: true } },
  chat: { ticketTopics: false, groupActivation: "reply", notify: { tickets: false, code: false, routines: false } }
} as const satisfies Record<string, Preset>;
export type GroupPreset = keyof typeof GROUP_PRESETS;

/** The preset a group's route is set as; null once its switches were changed by hand. */
export function presetOf(route: Preset): GroupPreset | null {
  const same = (a: object | undefined, b: object) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b).sort());
  for (const [name, preset] of Object.entries(GROUP_PRESETS) as [GroupPreset, Preset][]) {
    if ((route.ticketTopics ?? true) === preset.ticketTopics && (route.groupActivation ?? "reply") === preset.groupActivation && same(route.notify, preset.notify!)) return name;
  }
  return null;
}
