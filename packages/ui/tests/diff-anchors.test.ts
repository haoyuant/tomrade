import { describe, expect, it } from "vitest";
import type { ChangeHunk, ChangeLine } from "@tomradex/code-link";
import { pickAnchor, placeAnchor, rangeAnchor, sideOf, type Anchor } from "../src/components/diff/anchors";

const ctx = (old: number, text: string, now = old): ChangeLine => ({ kind: "context", old, new: now, text });
const del = (n: number, text: string): ChangeLine => ({ kind: "del", old: n, new: null, text });
const add = (n: number, text: string): ChangeLine => ({ kind: "add", old: null, new: n, text });
const hunk = (lines: ChangeLine[]): ChangeHunk => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, header: "", lines });
const on = (side: Anchor["side"], line: number, quote: string, endLine = line): Anchor => ({ side, line, endLine, quote });

describe("pinning a comment to its lines", () => {
  const before = [hunk([ctx(1, "a"), del(2, "old b"), add(2, "new b"), ctx(3, "c"), add(4, "d"), ctx(4, "}", 5)])];

  it("sits at its recorded line while the text there is still the quote", () => {
    expect(placeAnchor(on("new", 2, "new b"), before)).toEqual({ hunk: 0, first: 2, last: 2, line: 2, endLine: 2 });
    expect(placeAnchor(on("old", 2, "old b"), before)).toEqual({ hunk: 0, first: 1, last: 1, line: 2, endLine: 2 });
  });

  it("follows its lines when lines above push them down, to the nearest place that says the same", () => {
    const after = [hunk([add(1, "}"), add(2, "x"), ctx(1, "a", 3), add(4, "new b"), ctx(3, "c", 5), add(6, "d"), ctx(4, "}", 7)])];
    expect(placeAnchor(on("new", 2, "new b"), after)).toMatchObject({ first: 3, line: 4, endLine: 4 });
    // Two lines say "}": the one nearer to where the comment was wins.
    expect(placeAnchor(on("new", 5, "}"), after)).toMatchObject({ first: 6, line: 7 });
    expect(placeAnchor(on("new", 2, "}"), after)).toMatchObject({ first: 0, line: 1 });
  });

  it("keeps a range only where every quoted line still stands in order, skipping the other side's lines", () => {
    expect(placeAnchor(on("new", 2, "new b\nc\nd", 4), before)).toEqual({ hunk: 0, first: 2, last: 4, line: 2, endLine: 4 });
    expect(placeAnchor(on("old", 1, "a\nold b\nc", 3), before)).toEqual({ hunk: 0, first: 0, last: 3, line: 1, endLine: 3 });
    expect(placeAnchor(on("new", 2, "new b\nd", 3), before)).toBeNull();
  });

  it("is outdated once its lines are gone, and never pieces a quote together across hunks", () => {
    expect(placeAnchor(on("new", 2, "newer b"), before)).toBeNull();
    expect(placeAnchor(on("old", 2, "old b"), [hunk([ctx(1, "a"), add(2, "new b")])])).toBeNull();
    expect(placeAnchor(on("new", 1, "a\nb", 2), [hunk([ctx(1, "a")]), hunk([ctx(2, "b")])])).toBeNull();
    expect(placeAnchor(on("new", 2, "b"), [hunk([ctx(1, "a")]), hunk([ctx(2, "b")])])).toMatchObject({ hunk: 1, first: 0 });
  });
});

describe("choosing what to comment on", () => {
  const lines = hunk([ctx(1, "a"), del(2, "old b"), del(3, "old c"), add(2, "new b"), ctx(4, "d", 3), add(4, "e")]);

  it("comments on a deleted line as it was, and on anything else as it is now", () => {
    expect(sideOf(lines.lines[1])).toBe("old");
    expect(sideOf(lines.lines[0])).toBe("new");
    expect(sideOf(lines.lines[3])).toBe("new");
    expect(pickAnchor([lines], 0, 1, null)).toEqual(on("old", 2, "old b"));
    expect(pickAnchor([lines], 0, 4, null)).toEqual(on("new", 3, "d"));
  });

  it("stretches the range being written to another line of the same side and hunk, in either direction", () => {
    const held = pickAnchor([lines], 0, 3, null)!;
    expect(pickAnchor([lines], 0, 5, held)).toEqual(on("new", 2, "new b\nd\ne", 4));
    expect(pickAnchor([lines], 0, 0, held)).toEqual(on("new", 1, "a\nnew b", 2));
    expect(rangeAnchor(lines, "old", 2, 1)).toEqual(on("old", 2, "old b\nold c", 3));
  });

  it("starts over on the other side, in another hunk, or where there is no such line", () => {
    const held = pickAnchor([lines], 0, 3, null)!;
    expect(pickAnchor([lines], 0, 1, held)).toEqual(on("old", 2, "old b"));
    expect(pickAnchor([lines, hunk([ctx(9, "z")])], 1, 0, held)).toEqual(on("new", 9, "z"));
    expect(pickAnchor([lines], 0, 9, held)).toBeNull();
    expect(rangeAnchor(lines, "new", 1, 3)).toBeNull();
  });
});
