import { describe, expect, it } from "vitest";
import type { SessionRow } from "@tomradex/code-sessions";
import { matchesChord } from "../src/lib/keybindings";
import { away, foldChord, sessionGroups } from "../src/code-sessions/lists";

const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  itemId: null,
  key: null,
  title: null,
  branch: "b",
  state: "running",
  needsYou: false,
  activity: null,
  mode: "terminal",
  agent: "claude-code",
  pane: null,
  where: "outside",
  terminal: null,
  switchable: false,
  threadId: null,
  prUrl: null,
  worktree: null,
  startedAt: 1,
  endedAt: null,
  ...over
});

describe("the Terminal window's lists", () => {
  it("lists what it shows or Tomrade runs, groups what runs elsewhere, and leaves ended ones to the archive", () => {
    const sessions = [
      row({ id: "pane", where: "herdr", pane: "w1:p1" }),
      row({ id: "run", where: "tomrade", mode: "run" }),
      row({ id: "iterm", terminal: "iTerm2" }),
      row({ id: "laptop", where: "elsewhere" }),
      row({ id: "ended", where: "herdr", state: "ended", endedAt: 5 })
    ];
    const { here, away: elsewhere } = sessionGroups(sessions);
    expect(here.map((s) => s.id)).toEqual(["pane", "run"]);
    expect(elsewhere.map((s) => s.id)).toEqual(["iterm", "laptop"]);
    // Once it ends, an outside one is the archive's like the rest.
    expect(away(row({ id: "x", state: "ended", endedAt: 9 }))).toBe(false);
  });

  it("folds on ⌘B on a Mac and on Ctrl+Shift+B elsewhere, never on the shell's Ctrl+B", () => {
    const key = (over: Partial<KeyboardEvent>) => ({ key: "b", code: "KeyB", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over }) as KeyboardEvent;
    expect(matchesChord(key({ metaKey: true }), foldChord(true), { mac: true })).toBe(true);
    expect(matchesChord(key({ ctrlKey: true }), foldChord(true), { mac: true })).toBe(false);
    expect(matchesChord(key({ ctrlKey: true, shiftKey: true, key: "B" }), foldChord(false), { mac: false })).toBe(true);
    expect(matchesChord(key({ ctrlKey: true }), foldChord(false), { mac: false })).toBe(false);
  });
});
