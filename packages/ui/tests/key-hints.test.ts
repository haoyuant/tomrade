import { describe, expect, it } from "vitest";
import { en, zh } from "../src/lib/i18n-messages";
import * as locales from "../src/lib/i18n-messages/locales";
import { formatChord } from "../src/lib/keybindings";

// Hints that name a key: the key comes in as a slot, written for the platform and the person's own binding.
const HINTS = [
  ["sessionBar", "showCards"],
  ["sessionBar", "showRail"],
  ["agentPanel", "queueOrSteerPlaceholder"],
  ["card", "keyboardHint"],
  ["commandPalette", "shiftEnterHint"],
  ["commandPalette", "startNeedsWords"],
  ["review", "hint"],
  ["setup", "terminalWindowFailed"]
] as const;

const GLYPHS = /[⌃⌥⇧⌘↵]/;

describe("a hint that names a key", () => {
  it("writes no Mac key into any language's words", () => {
    const dicts = { en, zh, ...locales } as Record<string, Record<string, Record<string, string> | undefined>>;
    for (const [lang, dict] of Object.entries(dicts)) {
      for (const [ns, key] of HINTS) {
        const text = dict[ns]?.[key];
        if (text === undefined) continue;
        expect(text, `${lang} ${ns}.${key}`).not.toMatch(GLYPHS);
        expect(text, `${lang} ${ns}.${key}`).toMatch(/\{\{\w+\}\}/);
      }
    }
  });

  it("reads as words off a Mac and as glyphs on one", () => {
    for (const chord of ["Mod+Enter", "Alt+Enter", "Shift+Enter", "Enter", "Mod+K", "Mod+\\"]) expect(formatChord(chord, false)).not.toMatch(GLYPHS);
    expect(formatChord("Mod+Enter", false)).toBe("Ctrl+Enter");
    expect(formatChord("Alt+Enter", false)).toBe("Alt+Enter");
    expect(formatChord("Mod+\\", true)).toBe("⌘\\");
  });
});
