import type { ReviewComment } from "./store.js";

const where = (c: ReviewComment): string => {
  const lines = c.endLine > c.line ? `lines ${c.line}-${c.endLine}` : `line ${c.line}`;
  return `${c.path}, ${lines} (${c.side === "old" ? "old side: lines this change removed" : "new side"})`;
};

/**
 * What the agent working a ticket is told of a person's review: every comment with its file, its lines and the lines
 * as they were, so a comment still finds its place after the code under it moved. `branchOf` names a comment's branch
 * when the ticket's comments are on more than one.
 */
export function reviewPrompt(key: string, comments: ReviewComment[], branchOf?: (linkId: string) => string | null): string {
  const several = new Set(comments.map((c) => c.linkId)).size > 1;
  const blocks = comments.map((c, i) => {
    const branch = several ? branchOf?.(c.linkId) : null;
    const quoted = c.quote ? c.quote.split("\n").map((line) => `> ${line}`) : [];
    return [`${i + 1}. ${branch ? `[${branch}] ` : ""}${where(c)}`, ...quoted, c.body].join("\n");
  });
  const count = comments.length === 1 ? "1 comment" : `${comments.length} comments`;
  return [
    `<review-comments ticket="${key}">`,
    `The person reviewed this ticket's changes in Tomrade and left ${count}. Address each one, then say in a line what you did about each. Line numbers are those of when the comment was written; the quoted lines say where it belongs if the code has moved since.`,
    "",
    blocks.join("\n\n"),
    "</review-comments>"
  ].join("\n");
}
