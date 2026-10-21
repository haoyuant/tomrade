import { describe, expect, it } from "vitest";
import { shortcut } from "../src/lib/keys";
import { revealLabel } from "../src/lib/shell";

describe("shortcut", () => {
  it("keeps the Mac glyphs on a Mac", () => {
    expect(shortcut("Undo — ⇧⌘Z", true)).toBe("Undo — ⇧⌘Z");
  });

  it("spells shortcuts out elsewhere, in whole sentences", () => {
    const pc = (text: string) => shortcut(text, false);
    expect(pc("⌘Z")).toBe("Ctrl+Z");
    expect(pc("⇧⌘Z")).toBe("Ctrl+Shift+Z");
    expect(pc("⌘⇧F")).toBe("Ctrl+Shift+F");
    expect(pc("Settings — ⌘,")).toBe("Settings — Ctrl+,");
    expect(pc("Markdown · ⌘↵ to save · Esc to discard")).toBe("Markdown · Ctrl+Enter to save · Esc to discard");
    expect(pc("Repeated ⌘Z presses are ignored")).toBe("Repeated Ctrl+Z presses are ignored");
    expect(pc("展开助手 — ⌘J")).toBe("展开助手 — Ctrl+J");
    expect(pc("Enter queues · ⌘↵ steers now…")).toBe("Enter queues · Ctrl+Enter steers now…");
  });
});

describe("revealLabel", () => {
  it("names the file manager each platform has", () => {
    expect(revealLabel(true, false)).toBe("common.revealMac");
    expect(revealLabel(false, true)).toBe("common.revealWindows");
    expect(revealLabel(false, false)).toBe("common.revealLinux");
  });
});
