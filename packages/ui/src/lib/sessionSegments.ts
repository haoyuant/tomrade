import { claimedKey, type Cut } from "@tomradex/code-link/segments";
import type { ReviewTicket } from "@tomradex/code-link";
import type { ConvoLine } from "./convoFold";
import { outcomeParts, type OutcomeWords } from "./review";

export type MarkWord = (key: "markClaimed" | "markBack" | "markLinkedPr" | "markLinked", vars?: Record<string, string | number>) => string;

/** A `link_code` call as a record shows it: the tool, however its MCP client prefixes the name. */
const LINK_LINE = /(?:^|[^a-z])link_code\b/i;

/** The pull request a `link_code` call named, from its input. */
const prOf = (line: ConvoLine): number | null => {
  const hit = /pull\/(\d+)|"prNumber"\s*:\s*(\d+)/.exec(line.detail?.input ?? "");
  return hit ? Number(hit[1] ?? hit[2]) : null;
};

/**
 * A ticket's stretch with its moments said as marks: the claim that opened it ("● Claimed TOM-634"), a pull request
 * linked ("● Linked PR #419"), and a return to a ticket worked before ("● Back to TOM-634") — in place of the tool
 * calls that did them. `again`: the ticket had a stretch before this one.
 */
export function markLines(lines: ConvoLine[], key: string | null, again: boolean, say: MarkWord): ConvoLine[] {
  if (!key) return lines;
  const out = lines.map((line): ConvoLine => {
    const claimed = claimedKey(line);
    if (claimed) return { key: line.key, who: "mark", text: say(again ? "markBack" : "markClaimed", { key: claimed }) };
    if (line.who === "tool" && LINK_LINE.test(line.text)) {
      const pr = prOf(line);
      return { key: line.key, who: "mark", text: pr !== null ? say("markLinkedPr", { n: pr }) : say("markLinked") };
    }
    return line;
  });
  // came back to it without a claim the record shows: the return is said at the top
  if (again && out[0]?.who !== "mark") out.unshift({ key: (out[0]?.key ?? 0) - 0.5, who: "mark", text: say("markBack", { key }) });
  return out;
}

/** What a ticket's stretch ends on: its commits, its pull request, where the ticket stands — "3 commits · PR #419 open · Doing". */
export function segmentFacts(ticket: Pick<ReviewTicket, "pr" | "commits" | "status"> | null | undefined, say: OutcomeWords, status: (s: ReviewTicket["status"]) => string): string | null {
  if (!ticket) return null;
  return [...outcomeParts({ pr: ticket.pr, commits: ticket.commits, asked: null }, say).reverse(), status(ticket.status)].join(" · ");
}

/** Which of a run of stretches return to a ticket worked in an earlier one. */
export const returns = <L>(cuts: Cut<L>[]): boolean[] => {
  const seen = new Set<string>();
  return cuts.map((c) => {
    if (!c.itemId) return false;
    const again = seen.has(c.itemId);
    seen.add(c.itemId);
    return again;
  });
};
