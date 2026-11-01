export { Takeover, Takeover as default, type TakeoverApplied, type TakeoverDraft, type TakeoverOffer, type TakeoverScan } from "./service.js";
export { buildEntries, issueNumbers, markCovered, markSimilar, organize, ticketBody, type Facts, type TakeoverEntry, type TakeoverSource, type TakeoverSourceKind } from "./draft.js";
export { baseRef, readBranches, readSession, readWorktree, worktreeFolders, IDLE_MS, MAX_BRANCHES, type BranchFact, type IssueFact, type SessionFact, type WorktreeFact } from "./facts.js";
