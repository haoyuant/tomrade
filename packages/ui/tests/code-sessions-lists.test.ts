import { describe, expect, it } from "vitest";
import type { SessionRow, TerminalRow } from "@tomradex/code-sessions";
import { away, bundles, sessionName, sidebarRows } from "../src/code-sessions/lists";

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
  ...over
});

const terminal = (over: Partial<TerminalRow> & { id: string }): TerminalRow => ({ title: "repo", cwd: "/repo", pane: null, startedAt: 1, agentTitle: null, sessionId: null, note: null, ...over });

describe("the Terminal window's sidebar", () => {
  it("lists what this window shows in one list, groups what runs elsewhere, and leaves ended ones to the archive", () => {
    const sessions = [
      row({ id: "pane", itemId: "i1", key: "TOM-1", where: "herdr", pane: "w1:p1", startedAt: 3 }),
      row({ id: "run", itemId: "i2", where: "tomrade", mode: "run" }),
      row({ id: "iterm", terminal: "iTerm2" }),
      row({ id: "laptop", where: "elsewhere" }),
      row({ id: "ended", where: "herdr", pane: "w1:p8", state: "ended", endedAt: 5 })
    ];
    const { here, away: elsewhere } = sidebarRows(sessions, [terminal({ id: "t1", pane: "w1:p2", startedAt: 9 })]);
    expect(here.map((r) => [r.kind, r.id])).toEqual([
      ["session", "pane"],
      ["terminal", "t1"]
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

  it("puts needs-you first, then ticket work, then plain terminals, newest first within each", () => {
    const sessions = [
      row({ id: "old-ticket", itemId: "i1", key: "TOM-1", where: "herdr", pane: "w1:p1", startedAt: 1 }),
      row({ id: "new-ticket", itemId: "i2", key: "TOM-2", where: "herdr", pane: "w1:p2", startedAt: 5 }),
      row({ id: "needs", itemId: "i3", key: "TOM-3", where: "herdr", pane: "w1:p3", startedAt: 2, needsYou: true, state: "waiting" }),
      // In a pane this window did not open, with no ticket: a row of its own, named by its conversation.
      row({ id: "loose", where: "herdr", pane: "w2:p1", branch: "", agentTitle: "整理测试", startedAt: 8 })
    ];
    const terminals = [terminal({ id: "t-old", pane: "w1:p8", startedAt: 3 }), terminal({ id: "t-new", pane: "w1:p9", startedAt: 7 })];
    expect(sidebarRows(sessions, terminals).here.map((r) => r.id)).toEqual(["needs", "new-ticket", "old-ticket", "loose", "t-new", "t-old"]);
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
