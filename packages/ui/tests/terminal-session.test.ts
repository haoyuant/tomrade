import { describe, expect, it } from "vitest";
import type { RecordRead } from "@tomradex/agent";
import type { SessionAsk } from "@tomradex/code-link";
import { askText, convoContinued, convoFromTail, doingText, convoLines, convoRefreshed, convoWithEarlier, delayUntil, isApprovalAsk, mayReadPane, READ_EVERY_MS, saidElsewhere, tailLines } from "../src/lib/terminalSession";

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
    const permission = { kind: "permission" as const, tool: "Bash", action: "run" as const, detail: "pnpm test" };
    expect(isApprovalAsk({ state: "waiting", ask: permission })).toBe(true);
    expect(isApprovalAsk({ state: "waiting", ask: { kind: "permission", tool: null, action: null, detail: null } })).toBe(true);
    expect(isApprovalAsk({ state: "waiting", ask: null })).toBe(false);
    expect(isApprovalAsk({ state: "waiting", ask: { kind: "question", tool: null, action: null, detail: null } })).toBe(false);
    expect(isApprovalAsk({ state: "running", ask: permission })).toBe(false);
  });

  it("words what a session asks: the command it would run, the file it would change, the tool, or a question", () => {
    const w = (key: string, vars?: Record<string, string>) => `${key.replace("sessionBar.", "")}${vars ? `(${Object.values(vars).join(",")})` : ""}`;
    const ask = (over: Partial<SessionAsk>): SessionAsk => ({ kind: "permission", tool: null, action: null, detail: null, ...over });
    expect(askText(ask({ tool: "Bash", action: "run", detail: "git push -u origin tom-638/x" }), w)).toBe("askRun(git push -u origin tom-638/x)");
    expect(askText(ask({ tool: "Bash", action: "run" }), w)).toBe("askRunAny");
    expect(askText(ask({ tool: "Edit", action: "edit", detail: "src/app.ts" }), w)).toBe("askEdit(src/app.ts)");
    expect(askText(ask({ tool: "Write", action: "edit" }), w)).toBe("askEditAny");
    expect(askText(ask({ tool: "WebFetch", action: "use", detail: "https://x" }), w)).toBe("askTool(WebFetch,https://x)");
    expect(askText(ask({ tool: "mcp__x", action: "use" }), w)).toBe("askToolAny(mcp__x)");
    expect(askText(ask({}), w)).toBe("askApproval");
    expect(askText(ask({ kind: "question" }), w)).toBe("askQuestion");
  });

  it("words what a session does: a tool call that just failed, else its activity as it came", () => {
    const w = (key: string, vars?: Record<string, string>) => `${key.replace("sessionBar.", "")}${vars ? `(${Object.values(vars).join(",")})` : ""}`;
    expect(doingText({ activity: null, failedTool: "Bash" }, w)).toBe("toolFailed(Bash)");
    expect(doingText({ activity: null, failedTool: "" }, w)).toBe("toolFailedAny");
    expect(doingText({ activity: "Read · a.ts", failedTool: null }, w)).toBe("Read · a.ts");
    expect(doingText({ activity: null, failedTool: null }, w)).toBeNull();
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

describe("a conversation read on from where it stopped", () => {
  const person = (text: string) => ({ who: "person" as const, text });
  const call = (output?: string) => ({ who: "tool" as const, text: "Bash · pnpm test", detail: output ? { input: "$ pnpm test", output } : { input: "$ pnpm test" } });

  it("keeps the lines it held, puts the new ones after them under the same keys, and starts over when the read did not go on", () => {
    const first = convoFromTail({ lines: [person("开始"), call()], cut: false, start: 0, next: 40, held: 1 });
    expect([first.next, first.held]).toEqual([40, 1]);
    const next = convoContinued(first, 40, { lines: [call("41 passed"), person("好了")], cut: true, start: 40, next: 120, held: 2 });
    expect(next.tail).toEqual([{ ...person("开始"), key: 0 }, { ...call("41 passed"), key: 1 }, { ...person("好了"), key: 2 }]);
    expect(next.tail[0]).toBe(first.tail[0]);
    expect([next.next, next.held]).toEqual([120, 3]);
    // Nothing came: the same lines.
    expect(convoContinued(next, 120, { lines: [], cut: true, start: 120, next: 120, held: 0 }).tail).toEqual(next.tail);
    // The record shrank or grew past a page: the read starts elsewhere, and the view with it.
    const over = convoContinued(next, 120, { lines: [person("新的开始")], cut: false, start: 0, next: 20, held: 1 });
    expect(over.tail).toEqual([{ ...person("新的开始"), key: 0 }]);
    // An answer to an older ask is dropped; no read leaves the view as it was.
    expect(convoContinued(next, 40, { lines: [person("旧的")], cut: true, start: 40, next: 60, held: 1 })).toBe(next);
    expect(convoContinued(next, 120, null)).toBe(next);
  });
});
