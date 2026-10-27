import { describe, expect, it } from "vitest";
import type { SessionRow, TerminalRow, ThreadRow } from "@tomradex/code-sessions";
import { away, bundles, canAnswer, sessionName, sidebarRows, statusOf } from "../src/code-sessions/lists";

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
  agentName: "Claude Code",
  agentTitle: null,
  pane: null,
  where: "outside",
  terminal: null,
  switchable: false,
  threadId: null,
  prUrl: null,
  worktree: null,
  startedAt: 1,
  endedAt: null,
  continuedIn: null,
  recordSaved: null,
  ranIn: null,
  approval: false,
  prompt: null,
  lastEventAt: null,
  rawOutput: false,
  ...over
});

const thread = (id: string, over: Partial<ThreadRow> = {}): ThreadRow => ({ id, title: `thread ${id}`, engine: "loop", engineName: "Tomrade assistant", itemId: null, key: null, ticketTitle: null, running: false, wait: null, createdAt: 1, updatedAt: 1, ...over });

const terminal = (over: Partial<TerminalRow> & { id: string }): TerminalRow => ({ title: "repo", cwd: "/repo", pane: null, startedAt: 1, agentTitle: null, sessionId: null, note: null, ...over });

describe("the Terminal window's sidebar", () => {
  it("lists what this window shows in one list, groups what runs elsewhere, and closes with an ended one a cell shows", () => {
    const sessions = [
      row({ id: "pane", itemId: "i1", key: "TOM-1", where: "herdr", pane: "w1:p1", startedAt: 3 }),
      row({ id: "run", itemId: "i2", where: "tomrade", mode: "run" }),
      row({ id: "iterm", terminal: "iTerm2" }),
      row({ id: "laptop", where: "elsewhere" }),
      row({ id: "ended", where: "herdr", pane: "w1:p8", state: "ended", endedAt: 5 })
    ];
    const { here, away: elsewhere } = sidebarRows(sessions, [terminal({ id: "t1", pane: "w1:p2", startedAt: 9 })]);
    // The state carries an ended session only while a cell shows it: a done card, with what came of it.
    expect(here.map((r) => [r.kind, r.id])).toEqual([
      ["session", "pane"],
      ["terminal", "t1"],
      ["session", "ended"]
    ]);
    // The assistant panel's runs are elsewhere too: this window has no screen for them.
    expect(elsewhere.map((s) => s.id)).toEqual(["run", "iterm", "laptop"]);
    expect(away(row({ id: "x", state: "ended", endedAt: 9 }))).toBe(false);
  });

  it("shows an agent without a ticket as its terminal, and the same row as the ticket once it claims one", () => {
    const chatting = row({ id: "s1", where: "herdr", pane: "w1:p1", branch: "" });
    const open = terminal({ id: "t1", pane: "w1:p1", agentTitle: "选中面板与侧边栏会话联动" });
    const before = sidebarRows([chatting], [open]).here;
    expect(before.map((r) => [r.kind, r.id, r.session?.id ?? null])).toEqual([["terminal", "t1", null]]);
    // Claimed: the window folds the session into its terminal; still one row, now the ticket's.
    const claimed = { ...chatting, itemId: "i1", key: "TOM-7", title: "Ship it" };
    const after = sidebarRows([claimed], [{ ...open, sessionId: "s1" }]).here;
    expect(after.map((r) => [r.kind, r.id, r.session?.key ?? null])).toEqual([["terminal", "t1", "TOM-7"]]);
  });

  it("puts what waits on the person first, then what runs by when it started, then idle rows", () => {
    const sessions = [
      row({ id: "old-ticket", itemId: "i1", key: "TOM-1", where: "herdr", pane: "w1:p1", startedAt: 1 }),
      row({ id: "new-ticket", itemId: "i2", key: "TOM-2", where: "herdr", pane: "w1:p2", startedAt: 5 }),
      row({ id: "needs", itemId: "i3", key: "TOM-3", where: "herdr", pane: "w1:p3", startedAt: 2, needsYou: true, state: "waiting" }),
      // In a pane this window did not open, with no ticket: a row of its own, named by its conversation.
      row({ id: "loose", where: "herdr", pane: "w2:p1", branch: "", agentTitle: "整理测试", startedAt: 8 })
    ];
    const terminals = [terminal({ id: "t-old", pane: "w1:p8", startedAt: 3 }), terminal({ id: "t-new", pane: "w1:p9", startedAt: 7 })];
    expect(sidebarRows(sessions, terminals).here.map((r) => r.id)).toEqual(["needs", "loose", "new-ticket", "old-ticket", "t-new", "t-old"]);
  });

  it("lists the assistant's conversations beside the sessions, in the session bar's order, with an ended one a cell reads last", () => {
    const threads = [thread("idle", { updatedAt: 9 }), thread("busy", { running: true, createdAt: 3 }), thread("asks", { wait: { kind: "question", text: "可以吗？", since: 7 } })];
    const sessions = [
      row({ id: "cell", where: "herdr", pane: "w1:p1", startedAt: 4, lastEventAt: 50 }),
      row({ id: "waits", where: "herdr", pane: "w1:p2", state: "waiting", needsYou: true, lastEventAt: 2 }),
      row({ id: "old", where: "herdr", state: "ended", endedAt: 8, activity: "PR #1 merged" }),
      // Its pane goes on under another ticket: that row speaks for it.
      row({ id: "carried", where: "herdr", state: "ended", endedAt: 9, continuedIn: "cell" })
    ];
    const { here } = sidebarRows(sessions, [], threads);
    expect(here.map((r) => [r.kind, r.id, statusOf(r)])).toEqual([
      ["session", "waits", "wait"],
      ["thread", "asks", "wait"],
      ["session", "cell", "run"],
      ["thread", "busy", "run"],
      ["thread", "idle", "idle"],
      ["session", "old", "done"]
    ]);
    // The order holds while output streams: waiting by how long, running by start, never by the last event.
    expect(sidebarRows([{ ...sessions[0]!, lastEventAt: 1 }, { ...sessions[1]!, lastEventAt: 3 }], [], threads).here.map((r) => r.id)).toEqual(["waits", "asks", "cell", "busy", "idle"]);
  });

  it("shows a headless session once, on its conversation; one with a pane here stays a row of its own", () => {
    const threads = [thread("t")];
    const headless = row({ id: "s", mode: "run", where: "tomrade", threadId: "t", activity: "Bash · pnpm test" });
    const { here, away: elsewhere } = sidebarRows([headless], [], threads);
    expect(here.map((r) => [r.kind, r.id, r.session?.id ?? null, statusOf(r)])).toEqual([["thread", "t", "s", "run"]]);
    expect(elsewhere).toEqual([]);
    const inPane = row({ id: "p", where: "herdr", pane: "w1:p1", threadId: "t" });
    expect(sidebarRows([inPane], [], threads).here.map((r) => [r.kind, r.session?.id ?? null])).toEqual([["session", "p"], ["thread", null]]);
    // A plain terminal's agent, as herdr reads it.
    expect(statusOf({ kind: "terminal", id: "t1", terminal: terminal({ id: "t1", agentStatus: "blocked" }), session: null })).toBe("wait");
    expect(statusOf({ kind: "terminal", id: "t1", terminal: terminal({ id: "t1" }), session: null })).toBe("idle");
  });

  it("answers a permission from a card only when its agent declared the keys and its screen shows the prompt", () => {
    const asks = row({ id: "a", state: "waiting", needsYou: true, activity: "needs your approval: Bash", approval: true, prompt: "allow" });
    expect(canAnswer(asks)).toBe(true);
    expect(canAnswer({ ...asks, prompt: "deny" })).toBe(true);
    // a folder's trust, another menu, or a screen that could not be read
    expect(canAnswer({ ...asks, prompt: null })).toBe(false);
    expect(canAnswer({ ...asks, approval: false })).toBe(false);
    expect(canAnswer({ ...asks, activity: "asking you something" })).toBe(false);
    expect(canAnswer({ ...asks, state: "ended", endedAt: 1 })).toBe(false);
  });

  it("keeps the tickets one agent works side by side in one pane together, where the first of them sorts", () => {
    const sessions = [
      row({ id: "441", itemId: "i1", key: "TOM-441", where: "herdr", pane: "w1:pF", startedAt: 1 }),
      row({ id: "442", itemId: "i2", key: "TOM-442", where: "herdr", pane: "w1:pF", startedAt: 4 }),
      row({ id: "445", itemId: "i5", key: "TOM-445", where: "herdr", pane: "w1:pJ", startedAt: 6 }),
      row({ id: "444", itemId: "i4", key: "TOM-444", where: "herdr", pane: "w1:pF", startedAt: 7 })
    ];
    // The terminal the agent was opened in claimed one of them: its row is the pane's too.
    const terminals = [terminal({ id: "t1", pane: "w1:pF", sessionId: "441", startedAt: 0 }), terminal({ id: "t2", pane: "w1:p9", startedAt: 9 })];
    const { here } = sidebarRows(sessions, terminals);
    expect(here.map((r) => r.id)).toEqual(["444", "442", "t1", "445", "t2"]);
    expect(bundles(here).map((b) => b.map((r) => r.id))).toEqual([["444", "442", "t1"], ["445"], ["t2"]]);
    // Rows without a pane yet never bundle.
    const starting = [terminal({ id: "a", startedAt: 2 }), terminal({ id: "b", startedAt: 1 })];
    expect(bundles(sidebarRows([], starting).here).map((b) => b.length)).toEqual([1, 1]);
  });

  it("names a session by its ticket, else its branch, else its agent", () => {
    expect(sessionName(row({ id: "a", key: "TOM-9" }))).toBe("TOM-9");
    expect(sessionName(row({ id: "b", branch: "fix/x" }))).toBe("fix/x");
    expect(sessionName(row({ id: "c", branch: "" }))).toBe("Claude Code");
    expect(sessionName(row({ id: "d", branch: "", agentName: null, agent: "cursor" }))).toBe("cursor");
  });
});

describe("a conversation writing code in the background", () => {
  it("sits right under the conversation it writes for, set in, where the more urgent of the two comes", () => {
    const { here } = sidebarRows([row({ id: "pane", where: "herdr", pane: "w1:p1", startedAt: 3 })], [], [thread("parent", { updatedAt: 2 }), thread("child", { parentId: "parent", running: true, createdAt: 5 }), thread("other", { running: true, createdAt: 9 })]);
    // running rows come newest first: the child (5) lifts its idle parent to its own place, ahead of the pane (3)
    expect(here.map((r) => [r.id, r.kind === "thread" ? (r.depth ?? 0) : null])).toEqual([["other", 0], ["parent", 0], ["child", 1], ["pane", null]]);
    // a child whose parent this window does not list stands on its own
    expect(sidebarRows([], [], [thread("child", { parentId: "gone" })]).here.map((r) => [r.id, r.kind === "thread" ? (r.depth ?? 0) : null])).toEqual([["child", 0]]);
  });
});
