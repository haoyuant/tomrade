import { expect, it } from "vitest";
import { apartBranch, ticketTimeline, type CodeLinkView, type SessionView } from "@tomradex/code-link";

const session = (over: Partial<SessionView> & { id: string; startedAt: number }): SessionView => ({
  projectId: "p", repoId: "r", delivery: 1, branch: "tom-634/raw-output", itemIds: ["i"], worked: [], marks: [], asked: 0, mode: "terminal", agent: "claude-code",
  externalId: null, threadId: null, worktree: "/wt/tom-634", herdrPane: null, terminal: null, title: null, cwd: null, transcript: null, prompted: true, withoutTicket: null,
  recordSavedAt: null, recordCut: false, state: "ended", lastEventAt: null, lastToolAt: null, lastCommitAt: null, summary: null, activity: null, blocked: null,
  requestedBy: null, autoMerge: false, device: "here", endedAt: null, ...over
});
const link = (over: Partial<CodeLinkView>): CodeLinkView => ({
  id: "l", projectId: "p", itemId: "i", repoId: "r", delivery: 1, branch: "tom-634/raw-output", headSha: null, headAt: null, ahead: 0, behind: 0, mergedSha: null,
  prNumber: null, prUrl: null, prState: null, threadId: null, source: "branch", lastSeenAt: null, createdAt: 1, updatedAt: 1, ...over
} as CodeLinkView);

it("makes one entry of a conversation taken up again in a cell and back, saying where it went and what came of it", () => {
  const t = ticketTimeline(
    [
      session({ id: "back", startedAt: 300, mode: "headless", threadId: "t1", endedAt: 400, summary: "Recording split by pane, 20 MB each; tests pass", asked: 1 }),
      session({ id: "first", startedAt: 100, mode: "headless", threadId: "t1", endedAt: 200, summary: "Read the pane output API", externalId: "cc-1" }),
      session({ id: "cell", startedAt: 200, threadId: "t1", herdrPane: "w1:p2", endedAt: 300, externalId: "cc-1" })
    ],
    [link({ ahead: 5, prNumber: 420, prState: "open", prUrl: "https://example.test/pr/420" })],
    7
  );
  expect(t.entries).toHaveLength(1);
  expect(t.entries[0]).toMatchObject({ id: "first", live: false, latest: "back", endedAt: 400, continued: 2, asked: 1, commits: 5, outcome: "Recording split by pane, 20 MB each; tests pass" });
  expect(t.entries[0]!.stops.map((s) => s.where)).toEqual(["panel", "cell", "panel"]);
  expect(t.delivered).toEqual({ pr: { number: 420, state: "open", url: "https://example.test/pr/420" }, commits: 5, sessions: 1, files: 7 });
  expect(t.clash).toBeNull();
});

it("keeps conversations apart by when each began, joins a resume by its agent's id, and says what a live one is doing", () => {
  const t = ticketTimeline(
    [
      session({ id: "codex", agent: "codex", startedAt: 500, state: "running", herdrPane: "w1:p3", activity: "Bash · pnpm test", summary: "raising the limit to 50 MB", worktree: "/wt/tom-634" }),
      session({ id: "old", startedAt: 100, externalId: "cc-9", endedAt: 150, terminal: "iTerm.app", summary: "first try" }),
      session({ id: "resumed", startedAt: 160, externalId: "cc-9", endedAt: 170, herdrPane: "w1:p1" })
    ],
    []
  );
  expect(t.entries.map((e) => [e.id, e.continued, e.live])).toEqual([["old", 1, false], ["codex", 0, true]]);
  expect(t.entries[0]!.stops.map((s) => [s.where, s.terminal])).toEqual([["terminal", "iTerm.app"], ["cell", null]]);
  expect(t.entries[1]!.outcome).toBe("Bash · pnpm test");
  expect(t.delivered).toEqual({ pr: null, commits: 0, sessions: 2, files: null });
});

it("warns when two live conversations work in one folder, naming the later one to move or stop", () => {
  const sessions = [
    session({ id: "a", startedAt: 100, state: "running", worktree: "/wt/tom-634" }),
    session({ id: "b", startedAt: 200, state: "idle", threadId: "t2", mode: "headless", worktree: "/wt/tom-634" }),
    session({ id: "c", startedAt: 300, state: "running", worktree: "/wt/tom-634-b", branch: "tom-634/raw-output-b" })
  ];
  expect(ticketTimeline(sessions, []).clash).toEqual({ folder: "/wt/tom-634", branch: "tom-634/raw-output", earlier: "a", later: "b", laterSession: "b" });
  // one of them in a folder of its own: nothing to warn about
  expect(ticketTimeline([sessions[0]!, sessions[2]!], []).clash).toBeNull();
  // an ended one is not at work
  expect(ticketTimeline([sessions[0]!, { ...sessions[1]!, state: "ended" }], []).clash).toBeNull();
});

it("gives a second session a branch beside the ticket's own that nothing has yet", () => {
  expect(apartBranch("tom-634/raw-output", ["tom-634/raw-output"])).toBe("tom-634/raw-output-b");
  expect(apartBranch("tom-634/raw-output", ["tom-634/raw-output", "tom-634/raw-output-b", "tom-634/raw-output-c"])).toBe("tom-634/raw-output-d");
});
