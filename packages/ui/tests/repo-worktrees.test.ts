import { expect, it } from "vitest";
import type { WorktreeGroup, WorktreeView } from "@tomradex/code-link";
import { diskSize, removalSummary, worktreeBucket, worktreeCanGo, worktreePlace, worktreeState as stateOf, worktreeTotals } from "../src/lib/codeLink";

it("says why a worktree is still there, or when it goes", () => {
  const now = 1_000_000;
  const worktreeState = (tree: Omit<Parameters<typeof stateOf>[0], "stray"> & { stray?: boolean }, at: number) => stateOf({ stray: false, ...tree }, at);
  expect(worktreeState({ owner: "ticket", hold: "open", removeAt: null }, now)).toEqual({ key: "repositories.worktreeHold_open" });
  expect(worktreeState({ owner: "conversation", hold: "open", removeAt: null }, now)).toEqual({ key: "repositories.worktreeHold_openConversation" });
  expect(worktreeState({ owner: "ticket", hold: "dirty", removeAt: null }, now)).toEqual({ key: "repositories.worktreeHold_dirty" });
  expect(worktreeState({ owner: "ticket", hold: "busy", removeAt: null }, now)).toEqual({ key: "repositories.worktreeHold_busy" });
  expect(worktreeState({ owner: "ticket", hold: "loose", removeAt: null }, now)).toEqual({ key: "repositories.worktreeHold_loose" });
  // Nothing holds it: cleanup takes a finished ticket's at its time, and nobody's waits for a person.
  expect(worktreeState({ owner: "ticket", hold: null, removeAt: now + 60_000 }, now)).toEqual({ key: "repositories.worktreeDue", at: now + 60_000 });
  expect(worktreeState({ owner: "ticket", hold: null, removeAt: now - 1 }, now)).toEqual({ key: "repositories.worktreeDueNow" });
  expect(worktreeState({ owner: "none", hold: null, removeAt: null }, now)).toEqual({ key: "repositories.worktreeFree" });
  // One git no longer knows waits for a person too, and says nothing of what would be lost; what holds it is still said.
  expect(worktreeState({ owner: "none", hold: null, removeAt: null, stray: true }, now)).toEqual({ key: "repositories.worktreeStrayFree" });
  expect(worktreeState({ owner: "ticket", hold: "open", removeAt: null, stray: true }, now)).toEqual({ key: "repositories.worktreeHold_open" });
  expect([{ hold: null, stray: false }, { hold: null, stray: true }, { hold: "dirty" as const, stray: false }].map(worktreeCanGo)).toEqual([true, false, false]);
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
  const tree = (dir: string, hold: WorktreeView["hold"], stray = false): WorktreeView => ({ repoId: "r", dir, threadId: dir, branch: "b", owner: "ticket", tickets: [], hold, removeAt: null, stray, outside: false });
  expect([null, "open", "busy", "dirty", "loose"].map((hold) => worktreeBucket({ hold: hold as WorktreeView["hold"], stray: false }))).toEqual(["free", "open", "held", "held", "held"]);
  expect([null, "open"].map((hold) => worktreeBucket({ hold: hold as WorktreeView["hold"], stray: true }))).toEqual(["stray", "stray"]);
  // One on no ticket, made outside the Hub, is the person's own: it counts as in use, never as something that can go.
  expect(worktreeBucket({ hold: "unticketed", stray: false })).toBe("open");
  expect(worktreeCanGo({ hold: "unticketed", stray: false })).toBe(false);
  expect([worktreePlace("/Users/dev/Projects/app-wt/tom-12"), worktreePlace("C:\\code\\app-wt\\tom-12"), worktreePlace("/solo")]).toEqual(["app-wt/tom-12", "app-wt/tom-12", "solo"]);
  const groups: WorktreeGroup[] = [
    { projectId: "p1", project: "Alpha", repoId: "small", repo: "site", trees: [tree("/a", null)] },
    { projectId: "p2", project: "Beta", repoId: "big", repo: "app", trees: [tree("/b", null), tree("/c", "dirty"), tree("/d", "open"), tree("/e", "open"), tree("/f", null, true)] }
  ];
  // /e has not been measured yet, and /d could not be read.
  const totals = worktreeTotals(groups, new Map<string, number | null>([["/a", 100], ["/b", 400], ["/c", 300], ["/d", null], ["/f", 50]]));
  expect(totals).toMatchObject({ count: 6, measured: 5, bytes: 850 });
  // What git no longer knows is counted, apart from what can go.
  expect(totals.buckets).toEqual({ free: { n: 2, bytes: 500 }, held: { n: 1, bytes: 300 }, open: { n: 2, bytes: 0 }, stray: { n: 1, bytes: 50 } });
  // The one that takes most comes first.
  expect(totals.repos.map((repo) => [repo.repo, repo.project, repo.n, repo.bytes])).toEqual([["app", "Beta", 5, 750], ["site", "Alpha", 1, 100]]);
});
