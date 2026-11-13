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
    const found = c.finding ? ` — found by a reviewing agent (${c.finding.severity}), passed on by the person` : "";
    return [`${i + 1}. ${branch ? `[${branch}] ` : ""}${where(c)}${found}`, ...quoted, c.body].join("\n");
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

/**
 * What a reviewing agent is told: the ticket as its author was told it, and nothing the author said or thought while
 * working. It reads the change through `read_review_changes` and answers only through `submit_review_findings`.
 */
export function reviewerPrompt(ticket: { key: string; title: string; body: string | null }): string {
  return [
    `<review-request ticket="${ticket.key}">`,
    `Review the code changes made for ticket ${ticket.key}. Someone else wrote them; you are an independent reviewer and have none of their conversation. Judge the change by what the ticket asks for and by the code itself.`,
    "",
    "How to work:",
    `- Read the change with the Tomrade tool read_review_changes (key: "${ticket.key}"): first without a path for the list of files, the delivery report and any test results in it, then with a path for each file that matters. Read surrounding code in this folder when a change cannot be judged alone; the folder is a checkout of the repository that is not on the ticket's branch, so the changed files themselves are read through the tool. If the tool is not listed, load the "code" tool kit.`,
    "- Change nothing: no edits, no commits, no pushes, no branch switches. This session is read-only.",
    "- Look for what is wrong as it stands, what is likely to go wrong, acceptance criteria the change does not meet, changes the ticket did not ask for, and behaviour nothing in the change tests. Leave style and taste alone unless the repository's own rules name them.",
    "- Report each problem with submit_review_findings: the code link, file, side and lines exactly as read_review_changes numbered them, the quoted lines, a severity, and what would put it right. Reporting changes no code and is the one thing this session writes.",
    "- With nothing to report, submit nothing.",
    "- Then answer in a few lines: what you checked, how many findings you left, and what you could not verify from the diff alone.",
    "",
    `Ticket ${ticket.key}: ${ticket.title}`,
    "",
    ticket.body?.trim() || "(The ticket has no description.)",
    "</review-request>"
  ].join("\n");
}
