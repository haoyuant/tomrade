import { expect, it } from "vitest";
import type { WorktreeGroup, WorktreeView } from "@tomradex/code-link";
import { diskSize, removalSummary, worktreeBucket, worktreeState, worktreeTotals } from "../src/lib/codeLink";

it("says why a worktree is still there, or when it goes", () => {
  const now = 1_000_000;
  expect(worktreeState({ owner: "ticket", hold: "open", removeAt: null }, now)).toEqual({ key: "repositories.worktreeHold_open" });
  expect(worktreeState({ owner: "conversation", hold: "open", removeAt: null }, now)).toEqual({ key: "repositories.worktreeHold_openConversation" });
  expect(worktreeState({ owner: "ticket", hold: "dirty", removeAt: null }, now)).toEqual({ key: "repositories.worktreeHold_dirty" });
  expect(worktreeState({ owner: "ticket", hold: "busy", removeAt: null }, now)).toEqual({ key: "repositories.worktreeHold_busy" });
  expect(worktreeState({ owner: "ticket", hold: "loose", removeAt: null }, now)).toEqual({ key: "repositories.worktreeHold_loose" });
  // Nothing holds it: cleanup takes a finished ticket's at its time, and nobody's waits for a person.
  expect(worktreeState({ owner: "ticket", hold: null, removeAt: now + 60_000 }, now)).toEqual({ key: "repositories.worktreeDue", at: now + 60_000 });
  expect(worktreeState({ owner: "ticket", hold: null, removeAt: now - 1 }, now)).toEqual({ key: "repositories.worktreeDueNow" });
  expect(worktreeState({ owner: "none", hold: null, removeAt: null }, now)).toEqual({ key: "repositories.worktreeFree" });
});

it("sums up a removal by how many went and why the first that stayed did", () => {
  expect(removalSummary([{ dir: "/a", removed: true, reason: null }, { dir: "/b", removed: true, reason: null }])).toEqual({ removed: 2, kept: 0, reason: null });
  expect(removalSummary([{ dir: "/a", removed: true, reason: null }, { dir: "/b", removed: false, reason: "dirty" }, { dir: "/c", removed: false, reason: "busy" }])).toEqual({ removed: 1, kept: 2, reason: "dirty" });
});

it("writes what an install weighs in gigabytes", () => {
  expect(diskSize(18_500)).toBe("19 KB");
  expect(diskSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
  expect(diskSize(460 * 1024 * 1024)).toBe("460 MB");
  expect(diskSize(37 * 1024 * 1024 * 1024)).toBe("37.0 GB");
});

it("adds every repository's worktrees up by whether each can go, with the sizes read so far", () => {
  const tree = (dir: string, hold: WorktreeView["hold"]): WorktreeView => ({ repoId: "r", dir, threadId: dir, branch: "b", owner: "ticket", tickets: [], hold, removeAt: null });
  expect([null, "open", "busy", "dirty", "loose"].map((hold) => worktreeBucket({ hold: hold as WorktreeView["hold"] }))).toEqual(["free", "open", "held", "held", "held"]);
  const groups: WorktreeGroup[] = [
    { projectId: "p1", project: "Alpha", repoId: "small", repo: "site", trees: [tree("/a", null)] },
    { projectId: "p2", project: "Beta", repoId: "big", repo: "app", trees: [tree("/b", null), tree("/c", "dirty"), tree("/d", "open"), tree("/e", "open")] }
  ];
  // /e has not been measured yet, and /d could not be read.
  const totals = worktreeTotals(groups, new Map<string, number | null>([["/a", 100], ["/b", 400], ["/c", 300], ["/d", null]]));
  expect(totals).toMatchObject({ count: 5, measured: 4, bytes: 800 });
  expect(totals.buckets).toEqual({ free: { n: 2, bytes: 500 }, held: { n: 1, bytes: 300 }, open: { n: 2, bytes: 0 } });
  // The one that takes most comes first.
  expect(totals.repos.map((repo) => [repo.repo, repo.project, repo.n, repo.bytes])).toEqual([["app", "Beta", 4, 700], ["site", "Alpha", 1, 100]]);
});
