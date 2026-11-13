import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AgentReviewView, ReviewComment, ReviewDraft, ReviewEdit, ReviewSent, ReviewTarget, ReviewerChoices } from "@tomradex/change-review";
import type { ChangedFile, ChangeFileOptions, ChangeReviewed, ChangeScope, ChangesOptions, ChangesView, Editor } from "@tomradex/code-link";
import { invoke } from "./api";
import { keys } from "./queries";

/** Where a changed file went: an editor, the system's own opener, or nowhere (it is not on this machine). */
export type OpenedIn = Editor | "system" | null;

/** Where a ticket's changes are read from: the app window asks over IPC, the Terminal window over its bridge. */
export interface ChangesSource {
  /** What this source's reads are kept under. */
  key: readonly unknown[];
  changes(opts: ChangesOptions): Promise<ChangesView | null>;
  file(opts: ChangesOptions & ChangeFileOptions): Promise<ChangedFile | null>;
  open(opts: { linkId?: string; path: string }): Promise<OpenedIn>;
  /** What the ticket's comments are kept under; whoever hears them change asks again by it. */
  commentsKey: readonly unknown[];
  comments(): Promise<ReviewComment[]>;
  addComment(draft: ReviewDraft): Promise<ReviewComment>;
  editComment(id: string, edit: ReviewEdit): Promise<ReviewComment | null>;
  removeComment(id: string): Promise<boolean>;
  /** Where the comments would go: the session working the ticket, or nowhere. */
  reviewTarget(): Promise<ReviewTarget>;
  /** Every open comment not yet sent, handed over in one go; `deliver: false` only gives the text back. */
  sendComments(opts?: { deliver?: boolean }): Promise<ReviewSent>;
  /** What is on this machine now, recorded as reviewed; null where there is nothing to record. */
  markReviewed(opts?: { linkId?: string }): Promise<ChangeReviewed | null>;
  /** The coding agents on this machine, and which of them can review these changes. */
  reviewers(role?: string): Promise<ReviewerChoices>;
  /** The reviews agents made of the ticket's changes, newest first. */
  reviews(): Promise<AgentReviewView[]>;
  /** Starts an agent's review in a session of its own; the one already going comes back instead of a second. */
  startReview(opts?: { engine?: string; role?: string }): Promise<AgentReviewView>;
  /** The person has seen the findings that waited on them. */
  releaseReview(): Promise<void>;
}

/** A ticket's changes in the app window. Kept under code link's keys, so its events ask again. */
export const ticketChanges = (projectId: string, itemId: string): ChangesSource => ({
  key: keys.codeLink.changes(projectId, itemId),
  changes: (opts) => invoke("codeLink.changes", projectId, itemId, opts),
  file: (opts) => invoke("codeLink.changeFile", projectId, itemId, opts),
  open: async (opts) => {
    const opened = await invoke("codeLink.openInEditor", projectId, itemId, opts);
    if (!opened) return null;
    if (opened.editor) return opened.editor;
    return (await invoke("shell.openPath", opened.file)) ? "system" : null;
  },
  commentsKey: keys.changeReview.comments(projectId, itemId),
  comments: () => invoke("changeReview.comments", projectId, itemId),
  addComment: (draft) => invoke("changeReview.add", projectId, itemId, draft),
  editComment: (id, edit) => invoke("changeReview.edit", projectId, id, edit),
  removeComment: (id) => invoke("changeReview.remove", projectId, id),
  reviewTarget: () => invoke("changeReview.target", projectId, itemId),
  sendComments: (opts) => invoke("changeReview.send", projectId, itemId, opts),
  markReviewed: (opts) => invoke("codeLink.markReviewed", projectId, itemId, opts),
  reviewers: (role) => invoke("changeReview.reviewers", projectId, itemId, role),
  reviews: () => invoke("changeReview.reviews", projectId, itemId),
  startReview: (opts) => invoke("changeReview.review", projectId, itemId, opts),
  releaseReview: () => invoke("changeReview.release", projectId, itemId)
});

export const scopeValue = (scope: ChangeScope): string => (scope.kind === "commit" ? `commit:${scope.sha}` : scope.kind === "run" ? `run:${scope.id}` : scope.kind);
export const scopeOf = (value: string): ChangeScope =>
  value.startsWith("run:") ? { kind: "run", id: value.slice(4) } : value.startsWith("commit:") ? { kind: "commit", sha: value.slice(7) } : value === "uncommitted" ? { kind: "uncommitted" } : value === "since" ? { kind: "since" } : { kind: "branch" };

/**
 * One read of a ticket's changes. The last answer stays up while the next is read, so the view keeps its place and
 * its viewed marks; it is read again when the window is looked at again, the nearest thing to hearing a working tree change.
 */
export const useChanges = (source: ChangesSource, opts: { linkId?: string; scope: ChangeScope; ignoreWhitespace: boolean }) =>
  useQuery({
    queryKey: [...source.key, opts.linkId ?? "", scopeValue(opts.scope), opts.ignoreWhitespace],
    queryFn: () => source.changes(opts),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: "always",
    staleTime: 0
  });

/** How much the ticket's branch changes; null when it has no branch git can show here. */
export const useChangesSummary = (projectId: string, itemId: string, enabled: boolean) =>
  useQuery({ queryKey: keys.codeLink.changesSummary(projectId, itemId), queryFn: () => invoke("codeLink.changesSummary", projectId, itemId), enabled, refetchOnWindowFocus: "always" });

/** The comments on a ticket's changes, on every code link it has. */
export const useChangeComments = (source: Pick<ChangesSource, "commentsKey" | "comments">, enabled = true) => useQuery({ queryKey: source.commentsKey, queryFn: () => source.comments(), enabled });

/** Where the comments would go. Kept with the changes: what moves a session asks for both again. */
export const useReviewTarget = (source: ChangesSource) => useQuery({ queryKey: [...source.key, "reviewTarget"], queryFn: () => source.reviewTarget() });

/** How often a review that is going is asked about again: its end is heard too, this only covers a missed word. */
const REVIEW_POLL_MS = 5000;

/** The agent reviews of a ticket's changes. Kept under the comments' key: what changes one changes the other. */
export const useAgentReviews = (source: Pick<ChangesSource, "commentsKey" | "reviews">, enabled = true) =>
  useQuery({
    queryKey: [...source.commentsKey, "reviews"],
    queryFn: () => source.reviews(),
    enabled,
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => (query.state.data?.some((review) => review.state === "running") ? REVIEW_POLL_MS : false)
  });

/** Who could review here. Asked again each time the window is looked at: an agent may have been signed in meanwhile. */
export const useReviewers = (source: Pick<ChangesSource, "key" | "reviewers">, enabled = true, role?: string) =>
  useQuery({ queryKey: [...source.key, "reviewers", role ?? ""], queryFn: () => source.reviewers(role), enabled, staleTime: 30_000, placeholderData: keepPreviousData });
