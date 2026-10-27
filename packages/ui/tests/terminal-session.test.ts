import { describe, expect, it } from "vitest";
import type { RecordRead } from "@tomradex/agent";
import { convoFromTail, convoLines, convoRefreshed, convoWithEarlier, delayUntil, isApprovalAsk, mayReadPane, READ_EVERY_MS, saidElsewhere, tailLines } from "../src/lib/terminalSession";

const read = (texts: string[], opts: Partial<RecordRead> = {}): RecordRead => ({ lines: texts.map((text) => ({ who: "agent", text })), cut: false, ...opts });

describe("the strip's lines", () => {
  it("keeps the last lines that say something, box drawing and shortcut hints left out", () => {
    const screen = "❯ Reading files…\n⏺ Scaffold in place. Next: CI.\n╭──────────╮\n│ > │\n╰──────────╯\n? for shortcuts\n";
    expect(tailLines(screen, 2)).toEqual(["❯ Reading files…", "⏺ Scaffold in place. Next: CI."]);
    expect(tailLines("one\n\ntwo\nthree", 2)).toEqual(["two", "three"]);
    expect(tailLines(null, 2)).toEqual([]);
    expect(tailLines("> \n", 2)).toEqual([]);
  });
});

describe("what the panel does with a session", () => {
  it("offers Allow and Deny only on a permission ask, not on a turn that ended or a question", () => {
    expect(isApprovalAsk({ state: "waiting", activity: "needs your approval: Bash" })).toBe(true);
    expect(isApprovalAsk({ state: "waiting", activity: "needs your approval" })).toBe(true);
    expect(isApprovalAsk({ state: "waiting", activity: null })).toBe(false);
    expect(isApprovalAsk({ state: "waiting", activity: "asking you something" })).toBe(false);
    expect(isApprovalAsk({ state: "running", activity: "needs your approval" })).toBe(false);
  });

  it("reads the pane only while the session is shown, has a pane, runs, and the window is visible", () => {
    const all = { shown: true, visible: true, pane: true, live: true };
    expect(mayReadPane(all)).toBe(true);
    for (const off of ["shown", "visible", "pane", "live"] as const) expect(mayReadPane({ ...all, [off]: false })).toBe(false);
  });

  it("spaces reads at least a second apart", () => {
    expect(delayUntil(null, 5000)).toBe(0);
    expect(delayUntil(4200, 5000)).toBe(200);
    expect(delayUntil(1000, 5000)).toBe(0);
    expect(delayUntil(5000, 5000)).toBe(READ_EVERY_MS);
  });
});

describe("the conversation as the panel holds it", () => {
  it("opens on the record's tail and keeps line keys when the tail is read again", () => {
    const state = convoFromTail(read(["hi", "working"], { cut: true, start: 100 }));
    expect(convoLines(state).map((l) => [l.key, l.text])).toEqual([[0, "hi"], [1, "working"]]);
    expect(state.before).toBe(100);
    const again = convoRefreshed(state, read(["hi", "working", "done"], { cut: true, start: 100 }));
    expect(convoLines(again).map((l) => [l.key, l.text])).toEqual([[0, "hi"], [1, "working"], [2, "done"]]);
  });

  it("puts an earlier stretch in on top with keys below the first, and only the stretch it asked for", () => {
    const state = convoFromTail(read(["later"], { cut: true, start: 100 }));
    const late = convoWithEarlier(state, 50, read(["stale"]));
    expect(late).toBe(state);
    const more = convoWithEarlier(state, 100, read(["first", "second"], { cut: true, start: 40 }));
    expect(convoLines(more).map((l) => [l.key, l.text])).toEqual([[-2, "first"], [-1, "second"], [0, "later"]]);
    expect(more.before).toBe(40);
    const start = convoWithEarlier(more, 40, read(["zero"], { cut: false }));
    expect(start.before).toBeNull();
    expect(convoLines(start)[0]).toMatchObject({ key: -3, text: "zero" });
    // the earlier pages stay through a re-read of the tail that starts where it did
    const refreshed = convoRefreshed(start, read(["later", "and more"], { cut: true, start: 100 }));
    expect(convoLines(refreshed).map((l) => l.text)).toEqual(["zero", "first", "second", "later", "and more"]);
  });

  it("starts over from the new tail once the record grew past the page it had, and keeps what it has when a read fails", () => {
    const state = convoWithEarlier(convoFromTail(read(["later"], { cut: true, start: 100 })), 100, read(["first"], { cut: false }));
    const moved = convoRefreshed(state, read(["newer"], { cut: true, start: 2_000_100 }));
    expect(convoLines(moved).map((l) => l.text)).toEqual(["newer"]);
    expect(moved.before).toBe(2_000_100);
    expect(convoRefreshed(state, null)).toBe(state);
    const unreadable = convoFromTail(null);
    expect(unreadable.unreadable).toBe(true);
    expect(convoRefreshed(unreadable, read(["now readable"])).unreadable).toBe(false);
  });
});

it("marks what the person said in the terminal while the panel showed the session, not what the panel typed or said before", () => {
  const lines = [
    { key: 0, who: "person" as const, text: "start TOM-1", at: 100 },
    { key: 1, who: "agent" as const, text: "on it", at: 210 },
    { key: 2, who: "person" as const, text: "typed in the cell", at: 220 },
    { key: 3, who: "person" as const, text: "sent from the panel", at: 230 },
    { key: 4, who: "person" as const, text: "no stamp" }
  ];
  expect(saidElsewhere(lines, 200, new Set(["sent from the panel"]))).toEqual([2]);
});
