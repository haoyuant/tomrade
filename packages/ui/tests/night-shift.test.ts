import { describe, expect, it } from "vitest";
import type { Item } from "@tomradex/domain";
import { factsChosen, shiftCandidates, shiftNote, shiftOrder, withTaken } from "../src/lib/nightShift";

const item = (key: string, over: Partial<Item> = {}): Item => ({ id: key, key, title: key, kind: "ticket", status: "todo", priority: 0, rank: 0, blockedBy: [], blocks: [], ...over }) as Item;

describe("what a shift is offered", () => {
  it("takes tickets not begun, To Do first, then by priority; never epics or work under way", () => {
    const all = [item("B", { status: "backlog", priority: 4 }), item("T1"), item("T2", { priority: 3 }), item("E", { kind: "epic" }), item("D", { status: "doing" }), item("V", { status: "verifying" })];
    expect(shiftCandidates(all).map((i) => i.key)).toEqual(["T2", "T1", "B"]);
  });
});

describe("what a plan starts with", () => {
  it("chooses To Do's coding work and nothing else", () => {
    expect([...factsChosen([item("T", { workType: "coding" }), item("G", { workType: "general" }), item("B", { status: "backlog", workType: "coding" })])]).toEqual(["T"]);
  });
});

describe("a dependency the person took", () => {
  it("counts as if it were written, for what it joins and nothing else", () => {
    const [a, b, c] = withTaken([item("A"), item("B", { blockedBy: ["C"] }), item("C")], [{ from: "A", to: "B" }]);
    expect(a!.blocks).toEqual(["A", "B"].slice(1));
    expect(b!.blockedBy).toEqual(["C", "A"]);
    expect(c!.blocks).toEqual([]);
    expect(shiftOrder([b!, a!]).map((i) => i.key)).toEqual(["A", "B"]);
  });
});

describe("the order a shift tries", () => {
  it("puts each ticket after what it waits on", () => {
    expect(shiftOrder([item("C", { blockedBy: ["B"] }), item("B", { blockedBy: ["A"] }), item("A")]).map((i) => i.key)).toEqual(["A", "B", "C"]);
  });

  it("ignores waits outside the choice, and survives a cycle", () => {
    expect(shiftOrder([item("A", { blockedBy: ["Z"] }), item("B")]).map((i) => i.key)).toEqual(["A", "B"]);
    expect(shiftOrder([item("A", { blockedBy: ["B"] }), item("B", { blockedBy: ["A"] })]).map((i) => i.key).sort()).toEqual(["A", "B"]);
  });
});

describe("what a chosen ticket says", () => {
  const up = item("UP");
  const down = item("DOWN", { blockedBy: ["UP"] });
  const open = new Map([["UP", up], ["DOWN", down]]);

  it("says nothing when it can start at once", () => expect(shiftNote(up, new Set(["UP"]), open, false)).toBeNull());
  it("a finished upstream no longer counts", () => expect(shiftNote(down, new Set(["DOWN"]), new Map([["DOWN", down]]), false)).toBeNull());
  it("a chain needs merging to go on", () => {
    expect(shiftNote(down, new Set(["UP", "DOWN"]), open, false)).toEqual({ kind: "after-merge", keys: ["UP"] });
    expect(shiftNote(down, new Set(["UP", "DOWN"]), open, true)).toEqual({ kind: "after", keys: ["UP"] });
  });
  it("an upstream left out means it will not start", () => expect(shiftNote(down, new Set(["DOWN"]), open, true)).toEqual({ kind: "outside", keys: ["UP"] }));
});
