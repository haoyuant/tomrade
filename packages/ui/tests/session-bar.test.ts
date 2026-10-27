import { expect, it } from "vitest";
import type { ThreadSummary } from "@tomradex/agent";
import type { SessionView } from "@tomradex/code-link";
import { paletteSessionGroups, sessionBarRows } from "../src/lib/sessionBar";
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
    sessions: [session("cell", { startedAt: 4 }), session("old", { state: "ended", endedAt: 8, summary: "PR #1 merged" })],
    attention: [waiting("thread:asks", 7)]
  });
  expect(out.map((r) => [r.key, r.status])).toEqual([
    ["thread:asks", "wait"], ["session:cell", "run"], ["thread:busy", "run"], ["thread:idle", "idle"], ["session:old", "done"]
  ]);
  expect(out.find((r) => r.key === "thread:asks")?.wait).toEqual({ kind: "permission", text: "may I?" });
  expect(out.find((r) => r.key === "session:old")?.outcome).toBe("PR #1 merged");
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
