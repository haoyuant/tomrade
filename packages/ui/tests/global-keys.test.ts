import { expect, it } from "vitest";
import { chordFromEvent, COMMANDS, globalChordProblem } from "../src/lib/keybindings";

it("takes a key for the whole computer only with ⌘ or ⌥, never one led by Ctrl or one other apps answer to", () => {
  expect(globalChordProblem("Alt+Space", true)).toBeNull();
  expect(globalChordProblem("Mod+Alt+T", true)).toBeNull();
  expect(globalChordProblem("F12", true)).toBe("bare");
  expect(globalChordProblem("T", true)).toBe("bare");
  expect(globalChordProblem("Ctrl+Alt+T", true)).toBe("ctrl");
  expect(globalChordProblem("Mod+Shift+T", true)).toBe("common");
  expect(globalChordProblem("Mod+Space", true)).toBe("common");
  // off a Mac, Mod is Ctrl: alone it is the shell's, with Alt it is fair
  expect(globalChordProblem("Mod+Shift+D", false)).toBe("ctrl");
  expect(globalChordProblem("Mod+Alt+T", false)).toBeNull();
  expect(globalChordProblem("Alt+Tab", false)).toBe("common");
});

it("has no key for the whole computer until the person picks one", () => {
  expect(COMMANDS.find((c) => c.id === "terminalWindowGlobal")).toMatchObject({ group: "global", defaults: [] });
});

it("records ⌥Space as Alt+Space although a Mac types a no-break space for it", () => {
  expect(chordFromEvent({ key: "\u00a0", code: "Space", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }, true)).toBe("Alt+Space");
});
