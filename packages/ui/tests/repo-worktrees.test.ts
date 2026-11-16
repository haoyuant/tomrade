import { expect, it } from "vitest";
import { diskSize, removalSummary, worktreeState } from "../src/lib/codeLink";

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
