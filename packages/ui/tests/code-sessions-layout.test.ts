import { expect, it } from "vitest";
import type { Layout } from "@tomradex/code-sessions";
import { close, leaves, prune, resize, show, split } from "../src/code-sessions/layout";

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
