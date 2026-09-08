import { describe, expect, it } from "vitest";
import { decide, type Evidence } from "@tomrade/code-link";

const none: Evidence = { branch: false, ahead: 0, merged: false, pr: null, movedAfterDone: false };
const branch: Evidence = { ...none, branch: true, ahead: 3 };
const prOpen: Evidence = { ...branch, pr: "open" };
const merged: Evidence = { ...branch, merged: true };
const free = { autoDone: true, humanLocked: false };

describe("the sync matrix", () => {
  it("moves a ticket forward on evidence", () => {
    expect(decide("todo", branch, free)).toEqual([{ kind: "auto", to: "doing", reason: "commits on the branch" }]);
    expect(decide("doing", prOpen, free)).toEqual([{ kind: "auto", to: "verifying", reason: "pull request opened" }]);
    expect(decide("verifying", merged, free)).toEqual([{ kind: "auto", to: "done", reason: "merged into the default branch" }]);
    expect(decide("todo", merged, free)).toEqual([{ kind: "auto", to: "done", reason: "merged into the default branch" }]);
  });

  it("waits for an active coding session before marking merged evidence done", () => {
    expect(decide("doing", { ...merged, working: true }, free)).toEqual([]);
  });

  it("does nothing when the status already says as much, or when a branch has no commits yet", () => {
    expect(decide("doing", branch, free)).toEqual([]);
    expect(decide("verifying", prOpen, free)).toEqual([]);
    expect(decide("done", merged, free)).toEqual([]);
    expect(decide("todo", { ...none, branch: true }, free)).toEqual([]);
    expect(decide("todo", none, free)).toEqual([]);
  });

  it("proposes instead of writing when the ticket is locked or the repository says so", () => {
    expect(decide("todo", branch, { ...free, humanLocked: true })).toEqual([{ kind: "propose", to: "doing", reason: "commits on the branch" }]);
    expect(decide("doing", merged, { ...free, autoDone: false })).toEqual([{ kind: "propose", to: "done", reason: "merged into the default branch" }]);
    expect(decide("doing", merged, { autoDone: true, humanLocked: true })).toEqual([{ kind: "propose", to: "done", reason: "merged into the default branch" }]);
  });

  it("never moves a ticket back by itself", () => {
    expect(decide("verifying", { ...branch, pr: "closed" }, free)).toEqual([{ kind: "propose", to: "todo", reason: "pull request closed without merging" }]);
    expect(decide("done", prOpen, free)).toEqual([
      { kind: "flag", reason: "done, but the pull request is still open" },
      { kind: "propose", to: "verifying", reason: "the pull request is still open" }
    ]);
    expect(decide("done", branch, free)).toEqual([
      { kind: "flag", reason: "done, but the branch is not merged" },
      { kind: "propose", to: "verifying", reason: "the branch is not merged" }
    ]);
    expect(decide("done", { ...branch, pr: "closed" }, free)).toEqual([{ kind: "flag", reason: "done, but the pull request was closed without merging" }]);
    expect(decide("done", { ...branch, movedAfterDone: true }, free)).toEqual([
      { kind: "flag", reason: "done, but the branch is not merged" },
      { kind: "propose", to: "verifying", reason: "the branch is not merged" },
      { kind: "flag", reason: "new commits after done" }
    ]);
  });

  it("only flags a cancelled ticket", () => {
    expect(decide("cancelled", branch, free)).toEqual([{ kind: "flag", reason: "cancelled, but the code is still moving" }]);
    expect(decide("cancelled", merged, free)).toEqual([{ kind: "flag", reason: "cancelled, but the code is still moving" }]);
    expect(decide("cancelled", none, free)).toEqual([]);
  });
});
