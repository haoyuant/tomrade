import { expect, it } from "vitest";
import type { Layout } from "@tomradex/code-sessions";
import { applyPreset, close, leaves, place, prune, resize, reveal, shape, show, split } from "../src/code-sessions/layout";

const one: Layout = { type: "leaf", id: "c1", sessionId: "s1" };

it("splits a cell, keeping its session first and the new half empty, and closes back to the sibling", () => {
  const { layout, created } = split(one, "c1", "row", "c2");
  expect(created).toBe("c2");
  expect(layout).toEqual({ type: "split", id: "c2s", direction: "row", ratio: 0.5, a: one, b: { type: "leaf", id: "c2", sessionId: null } });
  const deeper = split(layout, "c2", "column", "c3").layout;
  expect(leaves(deeper).map((l) => l.id)).toEqual(["c1", "c2", "c3"]);
  expect(close(deeper, "c3")).toEqual(layout);
  expect(close(layout, "c1")).toEqual({ type: "leaf", id: "c2", sessionId: null });
  // The last cell is emptied, never removed.
  expect(close(one, "c1")).toEqual({ type: "leaf", id: "c1", sessionId: null });
});

it("shows a session in one cell only, keeps ratios in bounds, and empties cells whose session went", () => {
  const two = split(one, "c1", "row", "c2").layout;
  const moved = show(two, "c2", "s1");
  expect(leaves(moved).map((l) => l.sessionId)).toEqual([null, "s1"]);
  expect(leaves(show(moved, "c1", "s2")).map((l) => l.sessionId)).toEqual(["s2", "s1"]);
  expect((resize(two, "c2s", 0.99) as Extract<Layout, { type: "split" }>).ratio).toBe(0.85);
  expect((resize(two, "c2s", 0.3) as Extract<Layout, { type: "split" }>).ratio).toBe(0.3);
  expect(leaves(prune(show(two, "c2", "s9"), new Set(["s1"]))).map((l) => l.sessionId)).toEqual(["s1", null]);
});

it("keeps a preset's shape, refills it in reading order, places new ids in the first empty cell", () => {
  const grid = split(split(one, "c1", "row", "c2").layout, "c1", "column", "c3").layout;
  const full = show(show(grid, "c2", "s2"), "c3", "s3");
  expect(leaves(shape(full)).map((l) => l.sessionId)).toEqual([null, null, null]);
  let n = 0;
  const fresh = () => `n${++n}`;
  // Two cells in the preset, three sessions shown: the first two come along, the third is let go.
  const applied = applyPreset(full, split({ type: "leaf", id: "p1", sessionId: "gone" }, "p1", "row", "p2").layout, fresh);
  expect(leaves(applied).map((l) => l.sessionId)).toEqual(["s1", "s3"]);
  expect(leaves(applied).every((l) => l.id.startsWith("n"))).toBe(true);
  expect(leaves(place(grid, "s9")).map((l) => l.sessionId)).toEqual(["s1", "s9", null]);
  expect(place(full, "s9")).toEqual(full);
});

it("brings a session into view without moving anything out: its cell, an empty one, or a new one beside", () => {
  const two = split(one, "c1", "row", "c2").layout;
  expect(reveal(two, "s1", null)).toEqual({ layout: two, cell: "c1" });
  // A terminal's cell that became the session counts as showing it.
  expect(reveal(show(two, "c2", "t1"), "s2", null, (id) => (id === "t1" ? "s2" : id)).cell).toBe("c2");
  const filled = reveal(two, "s2", null);
  expect(filled.cell).toBe("c2");
  expect(leaves(filled.layout).map((l) => l.sessionId)).toEqual(["s1", "s2"]);
  const beside = reveal(filled.layout, "s3", "c2", undefined, "c3");
  expect(beside.cell).toBe("c3");
  expect(leaves(beside.layout).map((l) => [l.id, l.sessionId])).toEqual([["c1", "s1"], ["c2", "s2"], ["c3", "s3"]]);
});
