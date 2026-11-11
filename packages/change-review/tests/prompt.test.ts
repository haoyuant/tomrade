import { expect, it } from "vitest";
import { reviewPrompt, type ReviewComment } from "@tomradex/change-review";

const comment = (over: Partial<ReviewComment>): ReviewComment => ({ id: "c", itemId: "i", linkId: "l1", path: "src/a.ts", side: "new", line: 3, endLine: 3, quote: "const a = 1;", body: "Rename this.", state: "open", createdAt: 1, updatedAt: 1, sentAt: null, ...over });

it("gives each comment its file, its lines, its side, the lines as they were and the words", () => {
  const text = reviewPrompt("AL-7", [comment({}), comment({ id: "d", path: "src/b.ts", side: "old", line: 10, endLine: 12, quote: "one\n\nthree", body: "Why did this go?\nIt was used." })]);
  expect(text).toBe(
    [
      '<review-comments ticket="AL-7">',
      "The person reviewed this ticket's changes in Tomrade and left 2 comments. Address each one, then say in a line what you did about each. Line numbers are those of when the comment was written; the quoted lines say where it belongs if the code has moved since.",
      "",
      "1. src/a.ts, line 3 (new side)",
      "> const a = 1;",
      "Rename this.",
      "",
      "2. src/b.ts, lines 10-12 (old side: lines this change removed)",
      "> one",
      "> ",
      "> three",
      "Why did this go?",
      "It was used.",
      "</review-comments>"
    ].join("\n")
  );
});

it("says one comment as one, and names the branch only when comments are on several", () => {
  const branchOf = (id: string) => (id === "l1" ? "al-7/one" : "al-7/two");
  const one = reviewPrompt("AL-7", [comment({ quote: "" })], branchOf);
  expect(one).toContain("left 1 comment.");
  expect(one).toContain("1. src/a.ts, line 3 (new side)\nRename this.");
  const two = reviewPrompt("AL-7", [comment({}), comment({ id: "d", linkId: "l2" })], branchOf);
  expect(two).toContain("1. [al-7/one] src/a.ts, line 3 (new side)");
  expect(two).toContain("2. [al-7/two] src/a.ts, line 3 (new side)");
});
