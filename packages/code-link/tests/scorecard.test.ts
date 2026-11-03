import { expect, it } from "vitest";
import { scorecardPrs, summarizeScorecard, type CodeLinkView, type DeliveryView, type ScorecardSource, type SessionView } from "@tomradex/code-link";

const link = (over: Partial<CodeLinkView>): CodeLinkView => ({
  id: "l", projectId: "p", itemId: "a", repoId: "r", delivery: 1, branch: "tom-1/x", headSha: null, headAt: null, ahead: 0, behind: 0, mergedSha: null,
  prNumber: null, prUrl: null, prState: null, threadId: null, source: "scan", lastSeenAt: null, createdAt: 10, updatedAt: 10, ...over
});
const delivery = (itemId: string, sequence: number, startedAt: number, completedAt: number | null): DeliveryView => ({
  id: `${itemId}:delivery:${sequence}`, projectId: "p", itemId, sequence, state: completedAt ? "completed" : "active", startedAt, completedAt, updatedAt: completedAt ?? startedAt, bases: {}
});
const session = (over: Partial<SessionView>): SessionView => ({
  id: "s", projectId: "p", repoId: "r", delivery: 1, branch: "tom-1/x", itemIds: ["a"], worked: [], marks: [], asked: 0, mode: "terminal", agent: "codex",
  externalId: null, threadId: null, worktree: null, herdrPane: null, terminal: null, title: null, cwd: null, transcript: null, prompted: true, withoutTicket: null,
  recordSavedAt: null, recordCut: false, state: "ended", lastEventAt: null, lastToolAt: null, lastCommitAt: null, summary: null, activity: null, blocked: null,
  requestedBy: null, autoMerge: false, device: "here", startedAt: 100, endedAt: null, ...over
} as SessionView);

const source = (over: Partial<ScorecardSource>): ScorecardSource => ({ projectId: "p", links: [], deliveries: [], sessions: [], threads: [], runs: [], keys: new Map(), ...over });

it("counts a merged pull request delivered once as a first pass, priced from its engine's runs in the delivery", () => {
  const prs = scorecardPrs(source({
    links: [link({ itemId: "a", prNumber: 7, prUrl: "https://x/pull/7", prState: "merged", threadId: "t1" })],
    deliveries: [delivery("a", 1, 100, 500)],
    threads: [{ id: "t1", engine: "claude-code", itemId: "a" }, { id: "t2", engine: "codex", itemId: "a" }],
    runs: [
      { threadId: "t1", engine: "claude-code", status: "done", startedAt: 200, costUsd: 0.1 },
      { threadId: "t1", engine: "claude-code", status: "done", startedAt: 300, costUsd: 0.2 },
      { threadId: "t1", engine: "claude-code", status: "done", startedAt: 50, costUsd: 9 },
      { threadId: "t1", engine: "claude-code", status: "error", startedAt: 400, costUsd: null },
      { threadId: "t2", engine: "codex", status: "done", startedAt: 300, costUsd: null }
    ],
    keys: new Map([["a", "TOM-1"]])
  }), 0, 1000);
  expect(prs).toEqual([expect.objectContaining({ itemKey: "TOM-1", prNumber: 7, engine: "claude-code", firstPass: true, costUsd: 0.3, pricedRuns: 2, unpricedRuns: 1, mergedAt: 500 })]);
});

it("is not a first pass once the ticket was reopened or a pull request on it closed unmerged", () => {
  const prs = scorecardPrs(source({
    links: [
      link({ id: "1", itemId: "a", prNumber: 1, prState: "merged" }),
      link({ id: "2", itemId: "a", delivery: 2, prNumber: 2, prState: "merged" }),
      link({ id: "3", itemId: "b", prNumber: 3, prState: "closed" }),
      link({ id: "4", itemId: "b", prNumber: 4, prState: "open", mergedSha: "abc" }),
      link({ id: "5", itemId: "c", prNumber: 5, prState: "merged" }),
      link({ id: "6", itemId: "d", branch: "tom-4/local", mergedSha: "def" })
    ],
    deliveries: [delivery("a", 1, 100, 200), delivery("a", 2, 300, 400), delivery("b", 1, 100, 200), delivery("c", 1, 100, 200)],
    sessions: [session({ itemIds: ["c"] })]
  }), 0, 1000);
  expect(prs.map((p) => [p.prNumber, p.firstPass])).toEqual([[1, false], [2, false], [4, false], [5, true]]);
  // No conversation and no Tomrade run: the engine comes from the session, its spend is unknown.
  expect(prs.find((p) => p.prNumber === 5)).toMatchObject({ engine: "codex", costUsd: null, pricedRuns: 0 });
  expect(prs.find((p) => p.prNumber === 1)).toMatchObject({ engine: "" });
});

it("keeps only pull requests whose delivery completed inside the window, and splits a delivery's spend between its pull requests", () => {
  const prs = scorecardPrs(source({
    links: [
      link({ id: "1", itemId: "a", repoId: "r1", prNumber: 1, prState: "merged", threadId: "t" }),
      link({ id: "2", itemId: "a", repoId: "r2", prNumber: 2, prState: "merged", threadId: "t" }),
      link({ id: "3", itemId: "b", prNumber: 3, prState: "merged" })
    ],
    deliveries: [delivery("a", 1, 100, 500), delivery("b", 1, 100, 50)],
    threads: [{ id: "t", engine: "pi", itemId: "a" }],
    runs: [{ threadId: "t", engine: "pi", status: "done", startedAt: 200, costUsd: 0.25 }]
  }), 60, 1000);
  expect(prs.map((p) => [p.prNumber, p.costUsd])).toEqual([[1, 0.125], [2, 0.125]]);
});

it("sums engines without inventing a spend: an engine no run priced reads null, and spend per pull request counts priced ones only", () => {
  const card = summarizeScorecard(
    [
      { projectId: "p", itemId: "a", itemKey: "T-1", delivery: 1, repoId: "r", prNumber: 1, prUrl: null, mergedAt: 3, engine: "claude-code", firstPass: true, costUsd: 0.5, pricedRuns: 1, unpricedRuns: 0 },
      { projectId: "p", itemId: "b", itemKey: "T-2", delivery: 1, repoId: "r", prNumber: 2, prUrl: null, mergedAt: 2, engine: "claude-code", firstPass: false, costUsd: null, pricedRuns: 0, unpricedRuns: 0 },
      { projectId: "p", itemId: "c", itemKey: "T-3", delivery: 1, repoId: "r", prNumber: 3, prUrl: null, mergedAt: 1, engine: "claude-code", firstPass: true, costUsd: 1.5, pricedRuns: 2, unpricedRuns: 0 },
      { projectId: "p", itemId: "d", itemKey: "T-4", delivery: 1, repoId: "r", prNumber: 4, prUrl: null, mergedAt: 4, engine: "codex", firstPass: true, costUsd: null, pricedRuns: 0, unpricedRuns: 3 }
    ],
    { from: 0, to: 10, titles: new Map([["claude-code", "Claude Code"], ["codex", "Codex"]]) }
  );
  expect(card.engines).toEqual([
    { engine: "claude-code", title: "Claude Code", prs: 3, firstPass: 2, firstPassRate: 2 / 3, pricedPrs: 2, costUsd: 2, costPerPrUsd: 1 },
    { engine: "codex", title: "Codex", prs: 1, firstPass: 1, firstPassRate: 1, pricedPrs: 0, costUsd: null, costPerPrUsd: null }
  ]);
  expect(card.totals).toEqual({ prs: 4, firstPass: 3, firstPassRate: 0.75 });
  expect(card.prs.map((p) => p.prNumber)).toEqual([4, 1, 2, 3]);
});
