import type { Item, Patch } from "@tomradex/domain";

/**
 * The latest submission, when finishing the ticket now would pass over it: it was sent back, or a
 * coding ticket's is still unreviewed. A General ticket's pending submission is accepted by
 * finishing it, so that is not a surprise.
 */
export function overriddenSubmission(item: Item, patch: Patch) {
  if (patch.status !== "done" || item.kind !== "ticket" || item.status === "done" || item.status === "cancelled") return null;
  const submission = item.evidence.submissions.at(-1);
  if (!submission) return null;
  const reviews = item.evidence.reviews.filter((r) => r.submissionId === submission.id);
  if (reviews.some((r) => r.decision === "accepted")) return null;
  const sentBack = reviews.length > 0;
  return sentBack || item.workType === "coding" ? { submission, sentBack } : null;
}
