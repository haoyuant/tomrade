import { expect, it } from "vitest";
import type { ConvoLine } from "../src/lib/convoFold";
import { markLines, returns, segmentFacts } from "../src/lib/sessionSegments";

const say = (k: string, vars?: Record<string, string | number>) => `${k}(${Object.values(vars ?? {}).join(",")})`;
let key = 0;
const line = (who: ConvoLine["who"], text: string, input?: string): ConvoLine => ({ key: key++, who, text, ...(input !== undefined ? { detail: { input } } : {}) });

it("says a ticket's moments as marks in place of the calls that did them, and a return at the top", () => {
  const lines = [line("tool", "mcp__tomrade__claim_ticket · tom-634", "{}"), line("tool", "Edit · a.ts", "{}"), line("tool", "mcp__tomrade__link_code", '{ "prUrl": "https://github.com/o/r/pull/419" }'), line("tool", "link_code", "{}")];
  expect(markLines(lines, "TOM-634", false, say).map((l) => [l.who, l.text])).toEqual([["mark", "markClaimed(TOM-634)"], ["tool", "Edit · a.ts"], ["mark", "markLinkedPr(419)"], ["mark", "markLinked()"]]);
  // back to it with a claim: the claim says so; without one, a mark on top does
  expect(markLines(lines.slice(0, 1), "TOM-634", true, say)[0]!.text).toBe("markBack(TOM-634)");
  const back = markLines([line("person", "回到录制")], "TOM-634", true, say);
  expect(back.map((l) => l.who)).toEqual(["mark", "person"]);
  // a stretch before any ticket keeps its lines as they are
  expect(markLines(lines, null, false, say)).toBe(lines);
});

it("knows which stretches return to a ticket, and what one ends on", () => {
  expect(returns([{ itemId: null }, { itemId: "a" }, { itemId: "b" }, { itemId: "a" }])).toEqual([false, false, false, true]);
  expect(segmentFacts({ pr: { number: 419, state: "open", url: null }, commits: 3, status: "doing" }, say, (s) => s.toUpperCase())).toBe("commits(3) · prOpen(419) · DOING");
  expect(segmentFacts(undefined, say, (s) => s)).toBeNull();
});
