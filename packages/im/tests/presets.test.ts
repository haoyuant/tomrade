import { describe, expect, it } from "vitest";
import { GROUP_PRESETS, presetOf } from "../src/presets.js";

describe("a group's purpose", () => {
  it("is the preset its switches match, and none once they were changed by hand", () => {
    for (const [name, preset] of Object.entries(GROUP_PRESETS)) expect(presetOf({ ...preset, notify: { ...preset.notify } })).toBe(name);
    expect(presetOf({ ...GROUP_PRESETS.work, notify: { code: true, tickets: true } })).toBe("work");
    expect(presetOf({ ...GROUP_PRESETS.work, groupActivation: "all" })).toBeNull();
    expect(presetOf({ ...GROUP_PRESETS.status, notify: { ...GROUP_PRESETS.status.notify, presence: false } })).toBeNull();
    // A route allowed before purposes: topics on, reply, following what every conversation hears.
    expect(presetOf({ ticketTopics: true, groupActivation: "reply" })).toBeNull();
  });
});
