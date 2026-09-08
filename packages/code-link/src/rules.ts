import type { ItemStatus } from "@tomrade/domain";

export type PrState = "open" | "merged" | "closed";

/** What git and the forge say about one ticket in one repository. */
export interface Evidence {
  /** A branch carrying the key exists, locally or on the remote. */
  branch: boolean;
  /** Commits on that branch the default branch does not have. */
  ahead: number;
  /** The work reached the default branch: the branch was merged, or a default-branch commit names the key. */
  merged: boolean;
  pr: PrState | null;
  /** The branch head moved after the ticket was marked done. */
  movedAfterDone: boolean;
}

export interface RulePolicy {
  /** A merge marks the ticket done by itself; off, it is proposed. */
  autoDone: boolean;
  /** A human-locked ticket is never moved by evidence, only asked about. */
  humanLocked: boolean;
}

export type Decision = { kind: "auto"; to: ItemStatus; reason: string } | { kind: "propose"; to: ItemStatus; reason: string } | { kind: "flag"; reason: string };

const BEFORE_DONE: ReadonlySet<ItemStatus> = new Set(["backlog", "todo", "doing", "verifying"]);

/**
 * The sync matrix. Evidence only moves a ticket forward (doing → verifying →
 * done); anything that would move it back is proposed, and a ticket that says
 * more than the code does is flagged. Nothing here writes — the caller does.
 */
export function decide(status: ItemStatus, e: Evidence, policy: RulePolicy): Decision[] {
  const out: Decision[] = [];
  const forward = (to: ItemStatus, reason: string) => out.push(policy.humanLocked ? { kind: "propose", to, reason } : { kind: "auto", to, reason });
  const propose = (to: ItemStatus, reason: string) => out.push({ kind: "propose", to, reason });
  const flag = (reason: string) => out.push({ kind: "flag", reason });

  if (status === "cancelled") {
    if (e.merged || e.pr !== null || (e.branch && e.ahead > 0)) flag("cancelled, but the code is still moving");
    return out;
  }
  if (e.merged) {
    if (BEFORE_DONE.has(status)) {
      if (policy.autoDone) forward("done", "merged into the default branch");
      else propose("done", "merged into the default branch");
    }
    return out;
  }
  if (status === "done") {
    if (e.pr === "open") {
      flag("done, but the pull request is still open");
      propose("verifying", "the pull request is still open");
    } else if (e.pr === "closed") {
      flag("done, but the pull request was closed without merging");
    } else if (e.branch && e.ahead > 0) {
      flag("done, but the branch is not merged");
      propose("verifying", "the branch is not merged");
    }
    if (e.movedAfterDone) flag("new commits after done");
    return out;
  }
  if (e.pr === "open") {
    if (status !== "verifying") forward("verifying", "pull request opened");
    return out;
  }
  if (e.pr === "closed") {
    if (status === "verifying") propose("todo", "pull request closed without merging");
    return out;
  }
  if (e.branch && e.ahead > 0 && (status === "backlog" || status === "todo")) forward("doing", "commits on the branch");
  return out;
}
