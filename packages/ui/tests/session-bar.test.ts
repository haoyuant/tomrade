import { expect, it } from "vitest";
import type { ThreadSummary } from "@tomradex/agent";
import type { SessionView } from "@tomradex/code-link";
import { barModeFor, barPrefsOf, barShown, DONE_SHOWN_FOR_MS, paletteSessionGroups, sessionBarRows, THREAD_DONE_AFTER_MS } from "../src/lib/sessionBar";
import type { AttentionEntry } from "../src/lib/attention";

const thread = (id: string, over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id, projectId: "p", boardId: null, itemId: null, branch: null, title: `thread ${id}`, engine: "loop", surface: "assistant",
  archived: false, createdAt: 1, updatedAt: 1, ...over
});
const session = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id, projectId: "p", repoId: "r", delivery: 1, branch: "", itemIds: [], worked: [], mode: "terminal", agent: "claude-code",
  externalId: null, threadId: null, worktree: null, herdrPane: "w1:p1", terminal: null, title: `session ${id}`, cwd: null, transcript: null,
  prompted: true, withoutTicket: null, recordSavedAt: null, recordCut: false, state: "running", lastEventAt: 5, lastToolAt: null, lastCommitAt: null,
  summary: null, activity: null, blocked: null, requestedBy: null, autoMerge: false, device: "here", startedAt: 1, endedAt: null, ...over
});
const waiting = (key: string, since: number, text = "may I?"): AttentionEntry => ({ key, projectId: "p", threadId: null, itemId: null, itemKey: null, kind: "permission", who: null, text, since });
const rows = (input: Partial<Parameters<typeof sessionBarRows>[0]>) =>
  sessionBarRows({ threads: [], sessions: [], attention: [], itemTitle: () => null, openThreadId: null, ...input });

it("puts what waits on the person first, then what runs, then idle conversations, then what ended", () => {
  const out = rows({
    threads: [thread("idle", { updatedAt: 9 }), thread("busy", { running: true, createdAt: 3 }), thread("asks", { createdAt: 2 })],
    sessions: [session("cell", { startedAt: 4 }), session("old", { state: "ended", endedAt: 8, summary: "PR #1 merged", asked: 1 })],
    attention: [waiting("thread:asks", 7)]
  });
  expect(out.map((r) => [r.key, r.status])).toEqual([
    ["thread:asks", "wait"], ["session:cell", "run"], ["thread:busy", "run"], ["thread:idle", "idle"], ["session:old", "done"]
  ]);
  expect(out.find((r) => r.key === "thread:asks")?.wait).toEqual({ kind: "permission", text: "may I?" });
  expect(out.find((r) => r.key === "session:old")?.outcome).toEqual({ pr: null, commits: 0, asked: 1, said: "PR #1 merged" });
});

it("shows a headless session once, on its conversation", () => {
  const out = rows({ threads: [thread("t")], sessions: [session("s", { mode: "headless", threadId: "t", herdrPane: null, activity: "Bash · pnpm test" })] });
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ key: "thread:t", sessionId: "s", where: "panel", status: "run", activity: "Bash · pnpm test" });
});

it("lists a terminal session whose conversation is not the panel's, and says where it runs", () => {
  const out = rows({ sessions: [session("pane", { threadId: "code-thread" }), session("iterm", { herdrPane: null, terminal: "iTerm.app", state: "waiting", activity: "needs your approval" })] });
  expect(out.map((r) => r.key)).toEqual(["session:iterm", "session:pane"]);
  expect(out[0]).toMatchObject({ where: "outside", terminalApp: "iTerm.app", status: "wait", wait: { kind: "waiting", text: "needs your approval" } });
  expect(out[1]).toMatchObject({ where: "pane", status: "run" });
});

it("keeps the order still while output streams: running by start, waiting by how long it waited", () => {
  const first = rows({ sessions: [session("a", { startedAt: 1, lastEventAt: 50 }), session("b", { startedAt: 2, lastEventAt: 10 })], attention: [waiting("session:x", 9), waiting("session:y", 3)] });
  expect(first.map((r) => r.key)).toEqual(["session:b", "session:a"]);
  const queue = rows({ sessions: [session("x", { state: "waiting" }), session("y", { state: "waiting" })], attention: [waiting("session:x", 9), waiting("session:y", 3)] });
  expect(queue.map((r) => r.key)).toEqual(["session:y", "session:x"]);
});

it("caps idle conversations but never drops the open one or archived ones back in", () => {
  const threads = Array.from({ length: 12 }, (_, i) => thread(`t${i}`, { updatedAt: 100 - i }));
  const out = rows({ threads: [...threads, thread("gone", { archived: true })], openThreadId: "t11", idleLimit: 3 });
  expect(out.map((r) => r.threadId)).toEqual(["t0", "t1", "t2", "t11"]);
});

it("names an untitled session after its ticket", () => {
  const out = rows({ sessions: [session("s", { title: null, itemIds: ["i1"] })], itemTitle: (id) => (id === "i1" ? "Record pane output" : null), itemKey: () => "TOM-634" });
  expect(out[0]).toMatchObject({ title: "Record pane output", ticket: "TOM-634" });
});

it("never drops the terminal session the panel shows, however idle it is", () => {
  const sessions = Array.from({ length: 6 }, (_, i) => session(`s${i}`, { state: "idle", lastEventAt: 100 - i }));
  const out = rows({ sessions, openSessionId: "s5", idleLimit: 2 });
  expect(out.map((r) => r.sessionId)).toEqual(["s0", "s1", "s5"]);
  expect(rows({ sessions, idleLimit: 2 }).map((r) => r.sessionId)).toEqual(["s0", "s1"]);
});

it("gives ⌘K the bar's rows in three groups, each in the bar's order: waiting, in progress, ended", () => {
  const out = paletteSessionGroups(rows({
    threads: [thread("idle", { updatedAt: 9 }), thread("busy", { running: true, createdAt: 3 }), thread("asks", { createdAt: 2 })],
    sessions: [session("cell", { startedAt: 4 }), session("old", { state: "ended", endedAt: 8, summary: "PR #1 merged" })],
    attention: [waiting("thread:asks", 7)]
  }));
  expect(out.waiting.map((r) => r.key)).toEqual(["thread:asks"]);
  expect(out.active.map((r) => r.key)).toEqual(["session:cell", "thread:busy", "thread:idle"]);
  expect(out.history.map((r) => r.key)).toEqual(["session:old"]);
});

it("sets a conversation writing code in the background right under the one it writes for, where the more urgent of the two would be", () => {
  const out = rows({
    threads: [thread("other", { running: true, createdAt: 9 }), thread("parent", { updatedAt: 2 }), thread("child", { parentId: "parent", running: true, createdAt: 5 })]
  });
  expect(out.map((r) => [r.threadId, r.depth, r.status])).toEqual([["other", 0, "run"], ["parent", 0, "idle"], ["child", 1, "run"]]);
  expect(out.find((r) => r.threadId === "child")?.parentKey).toBe("thread:parent");
  // a waiting child lifts its parent to the top of the bar with it
  const lifted = rows({ threads: [thread("other", { running: true }), thread("parent"), thread("child", { parentId: "parent" })], attention: [waiting("thread:child", 3)] });
  expect(lifted.map((r) => r.threadId)).toEqual(["parent", "child", "other"]);
  // a parent the idle cap would drop stays for its child; a child whose parent is gone stands on its own
  const capped = rows({ threads: [...Array.from({ length: 4 }, (_, i) => thread(`t${i}`, { updatedAt: 100 - i })), thread("parent", { updatedAt: 1 }), thread("child", { parentId: "parent", running: true })], idleLimit: 2 });
  expect(capped.map((r) => [r.threadId, r.depth])).toEqual([["parent", 0], ["child", 1], ["t0", 0], ["t1", 0]]);
  expect(rows({ threads: [thread("child", { parentId: "gone" })] }).map((r) => [r.threadId, r.depth, r.parentKey])).toEqual([["child", 0, null]]);
});

it("carries what opened a conversation and when a usage limit lets it continue, for the cards and the peek", () => {
  const out = rows({ threads: [thread("t", { origins: ["Routine"], parkedUntil: 1234 })], sessions: [session("s")] });
  expect(out.find((r) => r.key === "thread:t")).toMatchObject({ origins: ["Routine"], parkedUntil: 1234 });
  expect(out.find((r) => r.key === "session:s")).toMatchObject({ origins: [], parkedUntil: null });
});

it("carries what came of an ended session as the look back reads it, and the cell that shows a live one", () => {
  const outcome = { pr: { number: 407, state: "merged" as const, url: null }, commits: 4, asked: 2, said: "done" };
  const out = rows({ sessions: [session("cell"), session("away", { herdrPane: null, terminal: "iTerm.app" }), { ...session("old", { state: "ended", endedAt: 8 }), outcome }], cells: { cell: 2, old: 3 } });
  expect(out.find((r) => r.key === "session:cell")?.cell).toBe(2);
  expect(out.find((r) => r.key === "session:away")?.cell).toBeNull();
  // ended, it is looked back on: no cell, and its outcome as the history has it
  expect(out.find((r) => r.key === "session:old")).toMatchObject({ cell: null, outcome });
});

it("lets a waiting terminal session's card answer only the prompt its screen shows, for an agent that declared its keys", () => {
  const permission = { kind: "permission" as const, tool: "Bash", action: "run" as const, detail: "pnpm test" };
  const asks = (id: string, over: Partial<SessionView> & { approval?: boolean; prompt?: "allow" | "deny" | null }) => ({ ...session(id, { state: "waiting", ask: permission }), approval: true, prompt: "allow" as const, ...over });
  const out = rows({ sessions: [asks("yes", {}), asks("no", { prompt: "deny" }), asks("mute", { approval: false }), asks("idle", { ask: { kind: "question", tool: null, action: null, detail: null } }), session("runs", { approval: true, prompt: "allow" } as never)] });
  expect(Object.fromEntries(out.map((r) => [r.sessionId, r.prompt]))).toEqual({ yes: "allow", no: "deny", mute: null, idle: null, runs: null });
});

it("carries a live terminal session's last pane lines for its card and peek, and none once it ended", () => {
  const out = rows({ sessions: [{ ...session("live"), tail: ["● Bash(pnpm test)", "  ⎿ 12 passed"] }, { ...session("old", { state: "ended", endedAt: 8 }), tail: ["gone"] }] });
  expect(out.find((r) => r.key === "session:live")?.tail).toEqual(["● Bash(pnpm test)", "  ⎿ 12 passed"]);
  expect(out.find((r) => r.key === "session:old")?.tail).toBeNull();
});

it("cards a conversation with what it said last, and reads it as done once its ticket is or it sat untouched a good while", () => {
  const now = 10 * THREAD_DONE_AFTER_MS;
  const out = rows({
    threads: [
      thread("talking", { updatedAt: now - 60_000, said: "Found 3 duplicates." }),
      thread("shipped", { updatedAt: now - 60_000, itemId: "i1", said: "Wrote releases/0.21.md." }),
      thread("quiet", { updatedAt: now - THREAD_DONE_AFTER_MS - 1, said: "Done." }),
      thread("busy", { updatedAt: now - THREAD_DONE_AFTER_MS - 1, running: true, said: "Reading." })
    ],
    itemDone: (id) => id === "i1",
    now
  });
  const by = (key: string) => out.find((r) => r.key === key)!;
  expect(by("thread:talking")).toMatchObject({ status: "idle", activity: "Found 3 duplicates.", outcome: null });
  expect(by("thread:shipped")).toMatchObject({ status: "done", activity: null, outcome: { pr: null, commits: 0, asked: null, said: "Wrote releases/0.21.md." } });
  expect(by("thread:quiet")).toMatchObject({ status: "done", outcome: { said: "Done." } });
  // a run going is never done, however long ago it last moved
  expect(by("thread:busy").status).toBe("run");
  // without a clock nothing is done for being quiet
  expect(rows({ threads: [thread("quiet", { said: "Done." })] })[0]).toMatchObject({ status: "idle", activity: "Done." });
});

it("folds the bar by the panel's width unless Settings › Sessions says always, and peeks unless switched off", () => {
  expect(barPrefsOf(undefined)).toEqual({ bar: "auto", peek: true });
  expect(barPrefsOf({ sessionBar: "cards", peek: false })).toEqual({ bar: "cards", peek: false });
  expect(barPrefsOf({ sessionBar: "sideways" }).bar).toBe("auto");
  expect([barModeFor("auto", true), barModeFor("auto", false)]).toEqual(["cards", "rail"]);
  expect([barModeFor("rail", true), barModeFor("cards", false)]).toEqual(["rail", "cards"]);
});

it("carries what a waiting terminal session asks, for the card and peek to word, and nothing once it moves on", () => {
  const ask = { kind: "permission" as const, tool: "Bash", action: "run" as const, detail: "git push" };
  const out = rows({ sessions: [session("asks", { state: "waiting", ask }), session("runs", { ask })] });
  expect(out.find((r) => r.key === "session:asks")).toMatchObject({ status: "wait", ask });
  expect(out.find((r) => r.key === "session:runs")?.ask).toBeNull();
});

it("keeps in the bar what still goes and the last few to end; the rest are History's, and ⌘K's history keeps them all", () => {
  const now = 10 * DONE_SHOWN_FOR_MS;
  const ended = Array.from({ length: 90 }, (_, i) => session(`old${i}`, { state: "ended", endedAt: 1000 + i }));
  const recent = Array.from({ length: 5 }, (_, i) => session(`new${i}`, { state: "ended", endedAt: now - 1000 * (i + 1) }));
  const all = rows({ threads: [thread("idle", { updatedAt: now - 1000 })], sessions: [session("live"), ...ended, ...recent], now });
  const shown = barShown(all, "session:old3", now);
  expect(shown.map((r) => r.key)).toEqual(["session:live", "thread:idle", "session:new0", "session:new1", "session:new2", "session:old3"]);
  expect(paletteSessionGroups(all).history).toHaveLength(95);
});

it("keeps a parent the bar would drop when a child under it stays", () => {
  const now = 10 * DONE_SHOWN_FOR_MS;
  const all = rows({ threads: [thread("parent", { updatedAt: 1 }), thread("child", { parentId: "parent", running: true })], now });
  expect(barShown(all, null, now).map((r) => r.key)).toEqual(["thread:parent", "thread:child"]);
});

it("waits on the person for a conversation the app's closing interrupted, as stopped, with the desktop's words when it lists it, and never reads it as done", () => {
  const interrupted = thread("cut", { interrupted: true, updatedAt: 1 });
  const alone = rows({ threads: [thread("idle", { updatedAt: 9 }), interrupted], now: 10 + THREAD_DONE_AFTER_MS });
  expect(alone.map((r) => [r.key, r.status])).toEqual([["thread:cut", "wait"], ["thread:idle", "done"]]);
  expect(alone[0]?.wait).toEqual({ kind: "stuck", text: null });
  expect(paletteSessionGroups(alone).waiting.map((r) => r.key)).toEqual(["thread:cut"]);

  const listed = rows({ threads: [interrupted], attention: [{ ...waiting("thread:cut", 4, "Interrupted — the app closed while this run was in progress."), kind: "stuck" }] });
  expect(listed[0]).toMatchObject({ status: "wait", wait: { kind: "stuck", text: "Interrupted — the app closed while this run was in progress." }, at: 4 });
  // continued: it runs, and waits on nobody
  expect(rows({ threads: [thread("cut", { interrupted: true, running: true })] })[0]).toMatchObject({ status: "run", wait: null });
});
