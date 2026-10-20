import { expect, it } from "vitest";
import { defaultStartMode } from "../src/lib/codeLink";

const fresh = { latest: null, remembered: null, terminalWindow: true, coding: true, agentInTerminal: true } as const;

it("starts coding work in Tomrade's terminal when the Terminal window shows it, over a remembered run here", () => {
  expect(defaultStartMode(fresh)).toBe("terminal");
  expect(defaultStartMode({ ...fresh, remembered: "run" })).toBe("terminal");
});

it("keeps how this delivery last ran, and the old default where the window cannot take it", () => {
  expect(defaultStartMode({ ...fresh, latest: "headless" })).toBe("run");
  expect(defaultStartMode({ ...fresh, terminalWindow: false, latest: "terminal" })).toBe("terminal");
  // No window, General work, or an agent with no terminal: as Start was last left here.
  expect(defaultStartMode({ ...fresh, terminalWindow: false })).toBe("run");
  expect(defaultStartMode({ ...fresh, terminalWindow: false, remembered: "terminal" })).toBe("terminal");
  expect(defaultStartMode({ ...fresh, coding: false, remembered: "run" })).toBe("run");
  expect(defaultStartMode({ ...fresh, agentInTerminal: false })).toBe("run");
});
