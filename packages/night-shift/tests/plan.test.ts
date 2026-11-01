import { describe, expect, it } from "vitest";
import type { Item } from "@tomradex/domain";
import { PlanReply, planUser, readPlan } from "@tomradex/night-shift";

const item = (key: string, over: Partial<Item> = {}): Item =>
  ({ id: key, key, title: `Do ${key}`, body: null, kind: "ticket", workType: "coding", status: "todo", priority: 2, rank: 0, labels: [], blocks: [], blockedBy: [], ...over }) as Item;
const reply = (over: Partial<PlanReply>): PlanReply => ({ summary: "", suggested: [], excluded: [], dependencies: [], concurrency: null, concurrencyWhy: "", ...over });

describe("a plan with no model", () => {
  it("takes To Do's coding work and says why it leaves general work out", () => {
    const plan = readPlan([item("A"), item("B", { status: "backlog" }), item("C", { workType: "general" })], null, "needs a person");
    expect(plan.analyzed).toBe(false);
    expect(plan.nodes).toEqual([
      { itemId: "A", key: "A", suggested: true, why: null },
      { itemId: "B", key: "B", suggested: false, why: null },
      { itemId: "C", key: "C", suggested: false, why: "needs a person" }
    ]);
    expect(plan.proposed).toEqual([]);
  });

  it("offers neither epics nor work under way", () => {
    const plan = readPlan([item("E", { kind: "epic" }), item("D", { status: "doing" }), item("V", { status: "verifying" })], null, "");
    expect(plan.nodes).toEqual([]);
  });
});

describe("a model's plan", () => {
  it("carries how many it would run at once, and drops a number outside the range", () => {
    const plan = readPlan([item("A")], reply({ concurrency: 3, concurrencyWhy: " Far apart. " }), "");
    expect(plan).toMatchObject({ concurrency: 3, concurrencyWhy: "Far apart." });
    const parsed = PlanReply.parse({ summary: "", suggested: [], excluded: [], dependencies: [], concurrency: 40 });
    expect(readPlan([item("A")], parsed, "")).toMatchObject({ concurrency: null, concurrencyWhy: null });
  });

  it("can suggest Backlog work and leave To Do work out, with its reason", () => {
    const plan = readPlan([item("A"), item("B", { status: "backlog" })], reply({ summary: " Ship it. ", suggested: ["B"], excluded: [{ key: "A", why: "needs a decision" }] }), "");
    expect(plan.summary).toBe("Ship it.");
    expect(plan.nodes.map((n) => [n.key, n.suggested, n.why])).toEqual([["A", false, "needs a decision"], ["B", true, null]]);
  });

  it("cannot put general work on the run, or name a ticket that is not there", () => {
    const plan = readPlan([item("A"), item("G", { workType: "general" })], reply({ suggested: ["A", "G", "NOPE"] }), "needs a person");
    expect(plan.nodes.map((n) => [n.key, n.suggested])).toEqual([["A", true], ["G", false]]);
  });

  it("a ticket both suggested and excluded stays out", () => {
    const plan = readPlan([item("A")], reply({ suggested: ["A"], excluded: [{ key: "A", why: "too vague" }] }), "");
    expect(plan.nodes[0]).toMatchObject({ suggested: false, why: "too vague" });
  });

  it("offers a new dependency with both ends named", () => {
    const plan = readPlan([item("A"), item("B")], reply({ dependencies: [{ before: "A", after: "B", why: "B builds on A" }] }), "");
    expect(plan.proposed).toEqual([{ from: "A", to: "B", fromKey: "A", toKey: "B", why: "B builds on A" }]);
  });

  it("does not offer a dependency that repeats one, even along a chain", () => {
    const items = [item("A", { blocks: ["B"] }), item("B", { blocks: ["C"], blockedBy: ["A"] }), item("C", { blockedBy: ["B"] })];
    const plan = readPlan(items, reply({ dependencies: [{ before: "A", after: "B", why: "" }, { before: "A", after: "C", why: "" }] }), "");
    expect(plan.proposed).toEqual([]);
  });

  it("does not offer a loop: against the record, against itself, or onto one ticket", () => {
    const items = [item("A", { blocks: ["B"] }), item("B", { blockedBy: ["A"] }), item("C")];
    const plan = readPlan(items, reply({ dependencies: [{ before: "B", after: "A", why: "" }, { before: "C", after: "C", why: "" }, { before: "B", after: "C", why: "first" }, { before: "C", after: "A", why: "closes it" }] }), "");
    expect(plan.proposed.map((e) => [e.fromKey, e.toKey])).toEqual([["B", "C"]]);
  });

  it("a mangled reply costs only the part that was mangled", () => {
    const parsed = PlanReply.parse({ summary: 3, suggested: ["A"], excluded: "none", dependencies: [{ before: 1 }] });
    expect(parsed).toEqual({ summary: "", suggested: ["A"], excluded: [], dependencies: [], concurrency: null, concurrencyWhy: "" });
  });
});

describe("what the planner is shown", () => {
  it("lists open work, known dependencies and what is taken, To Do first", () => {
    const text = planUser([item("B", { status: "backlog", priority: 4 }), item("A", { blocks: ["B"], labels: ["docs"], body: "Some  words\nhere" }), item("D", { status: "doing" }), item("X", { status: "done" })], "It is an app.");
    expect(text).toContain("It is an app.");
    expect(text.indexOf("- A (")).toBeLessThan(text.indexOf("- B ("));
    expect(text).toContain("labels docs");
    expect(text).toContain("Some words here");
    expect(text).toContain("- A before B");
    expect(text).toContain("- D: Do D");
    expect(text).not.toContain("Do X");
  });
});
