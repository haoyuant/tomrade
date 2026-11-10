import { expect, it } from "vitest";
import { Judgement, renderBrief, type Delivery } from "../src/brief.js";
import type { NightShiftTicketView, NightShiftView } from "../src/service.js";
import { NIGHT_SHIFT_WORDS } from "../src/words.js";

const w = NIGHT_SHIFT_WORDS("en");
const ticket = (key: string, state: NightShiftTicketView["state"], note: string | null = null): NightShiftTicketView => ({ itemId: key, key, title: `Do ${key}`, state, why: null, note, threadId: null, branch: null, startedAt: 0, nudgedAt: 0, resumes: 0, limitedUntil: null, merge: "none", mergeAt: null, mergeWaits: 0, conflictRetried: false });
const shift = (tickets: NightShiftTicketView[], over: Partial<NightShiftView> = {}): NightShiftView => ({
  id: "s", projectId: "p", tickets, status: "ended", halt: null, startedAt: 0, deadlineAt: 0, endedAt: 3_600_000, failStreak: 0, spentUsd: 0, briefPath: null, costKnown: false,
  settings: { mode: "run", concurrency: 2, maxMinutes: 60, maxUsd: null, maxFailures: 3, autoMerge: false, keepAwake: true, judge: true },
  steps: [], found: [],
  counts: { queued: 0, running: 0, limited: 0, "needs-you": 0, delivered: 0, done: 0, failed: 0, skipped: 0 }, ...over
});
const judged = (risk: Judgement["risk"]): Judgement => ({ risk, outOfScope: ["Renamed a helper"], unverified: ["The Windows path"], criteria: [{ text: "Exports a CSV", met: "yes", evidence: "export.test.ts covers it" }, { text: "Handles empty boards", met: "unknown", evidence: "it probably does" }] });
const delivery = (over: Partial<Delivery> = {}): Delivery => ({ prUrl: null, stat: null, lines: null, judgement: null, ...over });

it("reports a mixed shift: what to review first, what needs the person, what failed and why", () => {
  const body = renderBrief(
    shift([ticket("A", "delivered"), ticket("B", "delivered"), ticket("C", "done"), ticket("D", "needs-you", "Needs your answer: Which table?"), ticket("E", "failed", "Stopped: boom"), ticket("F", "skipped", "Blocked by E, which did not get through")], { spentUsd: 2.5, costKnown: true }),
    new Map([
      ["A", delivery({ prUrl: "https://x/1", lines: 900, judgement: judged("low") })],
      ["B", delivery({ prUrl: "https://x/2", lines: 10, judgement: judged("high") })],
      ["C", delivery({ prUrl: "https://x/3" })]
    ]),
    w,
    "2026-11-02"
  );
  expect(body).toContain("# Auto run, 2026-11-02");
  expect(body).toContain("2 to review · 1 merged · 1 need you · 1 failed · 1 not started · 60 min · $2.50 spent");
  // riskier first, however small
  expect(body.indexOf("1. B Do B: https://x/2")).toBeGreaterThan(-1);
  expect(body.indexOf("2. A Do A: https://x/1")).toBeGreaterThan(-1);
  expect(body).toContain("- D Do D: Needs your answer: Which table?");
  expect(body).toContain("- E Do E: Stopped: boom");
  expect(body).toContain("- F Do F: Blocked by E, which did not get through");
  expect(body).toContain("- ✓ Exports a CSV: export.test.ts covers it");
  expect(body).toContain("- Renamed a helper");
  expect(body).toContain("- The Windows path");
});

it("never prints evidence for what it could not establish", () => {
  const body = renderBrief(shift([ticket("A", "delivered")]), new Map([["A", delivery({ judgement: judged("medium") })]]), w, "2026-11-02");
  expect(body).toContain("- ? Handles empty boards: no evidence");
  expect(body).not.toContain("it probably does");
});

it("stands without a model: facts only, and it says so", () => {
  const body = renderBrief(shift([ticket("A", "delivered")]), new Map([["A", delivery({ prUrl: "https://x/1", stat: " a.ts | 2 +-" })]]), w, "2026-11-02");
  expect(body).toContain("Not judged: read from git only.");
  expect(body).toContain("a.ts | 2 +-");
  expect(body).toContain("no cost reported");
});

it("says why it stopped early, and leaves out what has nothing to say", () => {
  const body = renderBrief(shift([ticket("A", "skipped", "Not started: the spending limit was reached")], { halt: "budget" }), new Map(), w, "2026-11-02");
  expect(body).toContain("It reached the spending limit.");
  expect(body).not.toContain("Review in this order");
  expect(body).not.toContain("Failed");
});

it("reads a judgement in the shape the prompt asks for", () => {
  const exact = { criteria: [{ text: "Exports a CSV", met: "yes", evidence: "export.test.ts" }], outOfScope: [], unverified: ["Windows"], risk: "low" };
  expect(Judgement.parse(exact)).toEqual(exact);
});

it("accepts an answer in a near shape rather than dropping it", () => {
  expect(Judgement.parse({ criteria: ["Exports a CSV", "Handles empty boards"], risk: "High" })).toEqual({
    criteria: [{ text: "Exports a CSV", met: "unknown", evidence: "" }, { text: "Handles empty boards", met: "unknown", evidence: "" }],
    outOfScope: [],
    unverified: [],
    risk: "high"
  });
  expect(Judgement.parse({ acceptance_criteria: [{ criterion: "Exports a CSV", status: "Met", reason: "export.test.ts" }, { name: "Empty boards", met: false, evidence: "throws on []" }, { description: "Docs", met: "unknown", evidence: "a guess" }], out_of_scope: "Renamed a helper", risk: "severe" })).toEqual({
    criteria: [{ text: "Exports a CSV", met: "yes", evidence: "export.test.ts" }, { text: "Empty boards", met: "no", evidence: "throws on []" }, { text: "Docs", met: "unknown", evidence: "" }],
    outOfScope: ["Renamed a helper"],
    unverified: [],
    risk: "medium"
  });
});

it("still refuses an answer that is no judgement at all", () => {
  expect(Judgement.safeParse({ verdict: "fine" }).success).toBe(false);
  expect(Judgement.safeParse("looks good").success).toBe(false);
});

it("lists what the shift cost by agent and by ticket, and says when terminal runs were not counted", () => {
  const spend = {
    tickets: new Map([["A", { usd: 0.4, runs: 2, unpriced: 0 }], ["B", { usd: 1.25, runs: 3, unpriced: 1 }]]),
    agents: [{ title: "Claude Code", usd: 1.65, runs: 5, unpriced: 1 }]
  };
  const body = renderBrief(shift([ticket("A", "delivered"), ticket("B", "done"), ticket("C", "failed"), ticket("D", "skipped")], { costKnown: false }), new Map(), w, "2026-11-02", spend);
  expect(body).toContain("## What it cost");
  expect(body).toContain("Agents in terminal panes, and some engines, report no cost");
  expect(body).toContain("- Claude Code: $1.65 over 5 runs (1 reported no cost)");
  // costliest ticket first
  expect(body.indexOf("- B Do B: $1.25 over 3 runs (1 reported no cost)")).toBeLessThan(body.indexOf("- A Do A: $0.40 over 2 runs"));
  expect(body).toContain("No in-app runs recorded for C");
  expect(body).not.toContain("recorded for C, D");
  // nothing ran in the app: no section at all
  expect(renderBrief(shift([ticket("A", "delivered")]), new Map(), w, "2026-11-02", { tickets: new Map(), agents: [] })).not.toContain("What it cost");
});
