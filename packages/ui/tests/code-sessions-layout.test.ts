import { expect, it } from "vitest";
import type { Layout } from "@tomradex/code-sessions";
import { applyPreset, carryOn, close, cycle, dedupe, heir, holder, landing, leaves, lock, neighbour, place, prune, resize, reveal, shape, show, split } from "../src/code-sessions/layout";

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

// Three cells side by side, showing s1, s2 and s3.
const three = (): Layout => show(show(split(split(one, "c1", "row", "c2").layout, "c2", "row", "c3").layout, "c2", "s2"), "c3", "s3");
const shownIn = (layout: Layout) => leaves(layout).map((l) => [l.id, l.sessionId, !!l.locked]);

it("lands a pick in the selected cell, or where it already shows, and says what it replaced", () => {
  expect(landing(three(), "s9", { selected: "c2" })).toMatchObject({ cell: "c2", replaced: "s2" });
  expect(leaves(landing(three(), "s9", { selected: "c2" }).layout).map((l) => l.sessionId)).toEqual(["s1", "s9", "s3"]);
  // Already shown: that cell, nothing moves; a terminal's cell counts as its session's.
  expect(landing(three(), "s3", { selected: "c1" })).toEqual({ layout: three(), cell: "c3", replaced: null });
  expect(landing(three(), "claimed", { selected: "c1", key: (id) => (id === "s2" ? "claimed" : id) })).toMatchObject({ cell: "c2", replaced: null });
  // An empty selected cell replaces nothing.
  expect(landing(show(three(), "c2", null), "s9", { selected: "c2" })).toMatchObject({ cell: "c2", replaced: null });
});

it("opens a ⌘-click beside the selected cell, and never lands on a locked cell or one that needs you", () => {
  const beside = landing(three(), "s9", { selected: "c1", beside: true, newId: "n1" });
  expect(beside).toMatchObject({ cell: "n1", replaced: null });
  expect(shownIn(beside.layout)).toEqual([["c1", "s1", false], ["n1", "s9", false], ["c2", "s2", false], ["c3", "s3", false]]);
  const locked = lock(three(), "c2", true);
  // The selected cell locked: the least recently selected of the others, a never-selected one first.
  expect(landing(locked, "s9", { selected: "c2", recent: ["c1", "c3", "c2"] })).toMatchObject({ cell: "c1", replaced: "s1" });
  expect(landing(locked, "s9", { selected: "c2", recent: ["c3", "c1", "c2"] })).toMatchObject({ cell: "c3", replaced: "s3" });
  expect(landing(locked, "s9", { selected: "c2", recent: ["c3", "c2"] })).toMatchObject({ cell: "c1", replaced: "s1" });
  // One that needs you is passed over the same way; an empty cell comes before any replacement.
  expect(landing(three(), "s9", { selected: "c1", needsYou: (id) => id === "s1", recent: ["c3", "c1"] })).toMatchObject({ cell: "c2", replaced: "s2" });
  expect(landing(show(locked, "c3", null), "s9", { selected: "c2" })).toMatchObject({ cell: "c3", replaced: null });
  // Every other cell locked or needing you: a new cell beside the selected one.
  const held = landing(lock(lock(three(), "c1", true), "c3", true), "s9", { selected: "c1", needsYou: (id) => id === "s2", newId: "n2" });
  expect(held).toMatchObject({ cell: "n2", replaced: null });
  expect(shownIn(held.layout)).toEqual([["c1", "s1", true], ["n2", "s9", false], ["c2", "s2", false], ["c3", "s3", true]]);
});

it("keeps a cell locked while it shows something: nothing automatic replaces it, emptied it unlocks, presets keep it", () => {
  const locked = lock(three(), "c3", true);
  expect(shownIn(locked)).toEqual([["c1", "s1", false], ["c2", "s2", false], ["c3", "s3", true]]);
  // An empty cell does not lock; an emptied or closed-to-the-last one unlocks.
  expect(lock(show(three(), "c3", null), "c3", true)).toEqual(show(three(), "c3", null));
  expect(shownIn(show(locked, "c3", null))[2]).toEqual(["c3", null, false]);
  expect(close(lock(one, "c1", true), "c1")).toEqual({ type: "leaf", id: "c1", sessionId: null });
  expect(shownIn(lock(locked, "c3", false))[2]).toEqual(["c3", "s3", false]);
  // Its session gone, the cell empties and unlocks.
  expect(shownIn(prune(locked, new Set(["s1", "s2"])))[2]).toEqual(["c3", null, false]);
  // Auto-place and reveal skip it; a preset's shape carries no lock.
  expect(place(lock(show(three(), "c3", null), "c3", true), "s9")).toEqual(show(show(three(), "c3", null), "c3", "s9"));
  expect(leaves(shape(locked)).some((l) => l.locked)).toBe(false);
  let n = 0;
  const fresh = () => `n${++n}`;
  // A one-cell preset over a locked cell: the locked session comes first and stays locked; the rest is let go.
  expect(shownIn(applyPreset(locked, { type: "leaf", id: "p1", sessionId: null }, fresh))).toEqual([["n1", "s3", true]]);
  // Two locked cells into a one-cell preset: the second gets a cell beside, locked too.
  const two = applyPreset(lock(locked, "c1", true), { type: "leaf", id: "p1", sessionId: null }, fresh);
  expect(leaves(two).map((l) => [l.sessionId, !!l.locked])).toEqual([["s1", true], ["s3", true]]);
});

it("finds the pane across each edge, the next and previous in reading order, and what takes a closed pane's place", () => {
  // c1 on the left, full height; on the right c2 above c3, and c3 split again into c3 | c4.
  const right = split(one, "c1", "row", "c2").layout;
  const stacked = split(right, "c2", "column", "c3").layout;
  const grid = split(stacked, "c3", "row", "c4").layout;
  expect(neighbour(grid, "c1", "right")).toBe("c2");
  expect(neighbour(grid, "c1", "left")).toBeNull();
  expect(neighbour(grid, "c2", "left")).toBe("c1");
  expect(neighbour(grid, "c2", "down")).toBe("c3");
  expect(neighbour(grid, "c3", "up")).toBe("c2");
  expect(neighbour(grid, "c3", "right")).toBe("c4");
  expect(neighbour(grid, "c4", "left")).toBe("c3");
  expect(neighbour(grid, "c4", "up")).toBe("c2");
  expect(neighbour(grid, "c3", "left")).toBe("c1");
  expect(neighbour(grid, "c2", "up")).toBeNull();
  // A wider neighbour wins: from c1 rightwards, c2 shares half the edge, c3 a quarter.
  expect(neighbour(resize(grid, "c2s", 0.5), "c1", "right")).toBe("c2");
  expect(neighbour(one, "c1", "right")).toBeNull();

  expect(cycle(grid, "c1", 1)).toBe("c2");
  expect(cycle(grid, "c4", 1)).toBe("c1");
  expect(cycle(grid, "c1", -1)).toBe("c4");
  expect(cycle(grid, "gone", 1)).toBe("c1");

  expect(heir(grid, "c4")).toBe("c3");
  expect(heir(grid, "c3")).toBe("c4");
  expect(heir(grid, "c2")).toBe("c3");
  expect(heir(grid, "c1")).toBe("c2");
  expect(heir(one, "c1")).toBeNull();
});

it("never puts one herdr pane in two cells, whatever id it comes under", () => {
  // s2 is the session the agent in terminal t2 claimed: one pane, two ids.
  const key = (id: string) => (id === "s2" || id === "t2" ? "pane:w1:p2" : id);
  const layout = show(three(), "c2", "t2");
  expect(holder(layout, "s2", key)?.id).toBe("c2");
  // A pick of the session, plain or ⌘: the cell with its terminal, nothing split, nothing replaced.
  expect(landing(layout, "s2", { selected: "c1", key })).toEqual({ layout, cell: "c2", replaced: null });
  expect(landing(layout, "s2", { selected: "c1", beside: true, key })).toEqual({ layout, cell: "c2", replaced: null });
  // Auto-place and reveal leave it where it is.
  const roomy = show(layout, "c3", null);
  expect(place(roomy, "s2", key)).toBe(roomy);
  expect(reveal(roomy, "s2", "c1", key)).toEqual({ layout: roomy, cell: "c2" });
  // Shown elsewhere on purpose, it moves: the old cell empties.
  expect(leaves(show(layout, "c1", "s2", key)).map((l) => l.sessionId)).toEqual(["s2", null, "s3"]);
  // A layout that has it twice keeps the first, or the one asked to keep.
  const twice = show(layout, "c3", "s2");
  expect(leaves(dedupe(twice, key)).map((l) => l.sessionId)).toEqual(["s1", "t2", null]);
  expect(leaves(dedupe(twice, key, "c3")).map((l) => l.sessionId)).toEqual(["s1", null, "s2"]);
  expect(dedupe(layout, key)).toBe(layout);
  // A preset refills each pane once.
  expect(leaves(applyPreset(twice, one, () => "n1", key)).map((l) => l.sessionId)).toEqual(["s1"]);
});

it("hands a cell whose session ended to the row its pane goes on as, locked as it was, unless another cell shows that pane", () => {
  // s2's ticket finished; the agent goes on in the same pane as s9.
  const carried = new Map([["s2", "s9"]]);
  const locked = lock(three(), "c2", true);
  expect(shownIn(carryOn(locked, carried))).toEqual([["c1", "s1", false], ["c2", "s9", true], ["c3", "s3", false]]);
  // Already shown elsewhere, here under the terminal it runs in: the ended session's cell stays as it is.
  const key = (id: string) => (id === "s9" || id === "s3" ? "pane:w1:p3" : id);
  expect(carryOn(three(), carried, key)).toEqual(three());
  expect(carryOn(three(), new Map())).toEqual(three());
});
