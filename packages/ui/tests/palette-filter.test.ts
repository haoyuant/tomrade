import { expect, it } from "vitest";
import { LOOK_BACK, paletteFilter } from "../src/lib/paletteFilter";

it("finds what ran before only by its title or ticket, not by what it said", () => {
  // the digits of TOM-822 are spread through what it last said: a fuzzy match would list it
  expect(paletteFilter("Hey claude-code Handled it - 8 drafts, 22 sent thread:1", "TOM-822", [LOOK_BACK, "", "Hey"])).toBe(0);
  expect(paletteFilter("TOM-822 Export work thread:2", "TOM-822", [LOOK_BACK, "TOM-822", "Export work"])).toBeGreaterThan(0);
  expect(paletteFilter("Export work thread:3", "export", [LOOK_BACK, "", "Export work"])).toBeGreaterThan(0);
});

it("ranks what ran before below every other row that matches", () => {
  const history = paletteFilter("TOM-822 Export work", "TOM-822", [LOOK_BACK, "TOM-822", "Export work"]);
  const ticket = paletteFilter("TOM-822 Ship the export", "TOM-822");
  const loose = paletteFilter("Settings preferences", "set");
  expect(history).toBeLessThanOrEqual(0.5);
  expect(ticket).toBeGreaterThan(history);
  expect(loose).toBeGreaterThan(history);
  expect(paletteFilter("Settings", "zzz")).toBe(0);
});
