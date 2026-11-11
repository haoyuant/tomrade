import { describe, expect, it } from "vitest";
import type { ChangedFile, ChangeHunk, ChangeLine } from "@tomradex/code-link";
import { highlightHunk, highlightLines, parserFor, segments } from "../src/components/diff/highlight";
import { gapBefore, pieces, quietReason, splitRows } from "../src/components/diff/rows";
import { fileVersion, isViewed, markViewed } from "../src/components/diff/viewed";
import { pairedSpans, wordDiff } from "../src/components/diff/words";

const ctx = (n: number, text = `line ${n}`): ChangeLine => ({ kind: "context", old: n, new: n, text });
const del = (n: number, text: string): ChangeLine => ({ kind: "del", old: n, new: null, text });
const add = (n: number, text: string): ChangeLine => ({ kind: "add", old: null, new: n, text });
const hunk = (lines: ChangeLine[], oldStart = 1): ChangeHunk => ({ oldStart, oldLines: lines.filter((l) => l.kind !== "add").length, newStart: oldStart, newLines: lines.filter((l) => l.kind !== "del").length, header: "", lines });
const file = (hunks: ChangeHunk[] | null, over: Partial<ChangedFile> = {}): ChangedFile => ({ path: "src/a.ts", oldPath: null, status: "modified", additions: 1, deletions: 1, binary: false, generated: false, truncated: false, hunks, ...over });
const cut = (text: string, spans: [number, number][]) => spans.map(([from, to]) => text.slice(from, to));

describe("word-level diff", () => {
  it("marks only the words that differ between a deleted line and the one that replaced it", () => {
    const before = "const total = price * count;";
    const after = "const total = price * quantity;";
    const diff = wordDiff(before, after)!;
    expect(cut(before, diff.old)).toEqual(["count"]);
    expect(cut(after, diff.new)).toEqual(["quantity"]);
  });

  it("marks an insertion on the new side only, and joins neighbouring changed words", () => {
    const diff = wordDiff("call(a)", "call(a, b + c)")!;
    expect(diff.old).toEqual([]);
    expect(cut("call(a, b + c)", diff.new)).toEqual([", b + c"]);
  });

  it("tells Chinese characters apart one by one", () => {
    const diff = wordDiff("保存这个文件", "保存这个草稿")!;
    expect(cut("保存这个文件", diff.old)).toEqual(["文件"]);
    expect(cut("保存这个草稿", diff.new)).toEqual(["草稿"]);
  });

  it("marks nothing when the lines are the same or share too little to be one edit", () => {
    expect(wordDiff("same", "same")).toBeNull();
    expect(wordDiff("import fs from 'node:fs';", "export const answer = 42;")).toBeNull();
  });

  it("pairs each deletion of a run with the addition in the same place after it", () => {
    const lines = [ctx(1), del(2, "let a = 1;"), del(3, "let b = 2;"), add(2, "let a = 10;"), add(3, "let b = 20;"), add(4, "let c = 30;"), ctx(4)];
    const spans = pairedSpans(lines);
    expect([...spans.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(cut(lines[1].text, spans.get(1)!)).toEqual(["1"]);
    expect(cut(lines[3].text, spans.get(3)!)).toEqual(["10"]);
    expect(cut(lines[4].text, spans.get(4)!)).toEqual(["20"]);
    // The third addition replaced nothing.
    expect(spans.has(5)).toBe(false);
  });
});

describe("rows", () => {
  const long = hunk([...Array.from({ length: 20 }, (_, i) => ctx(i + 1)), del(21, "old"), add(21, "new"), ...Array.from({ length: 20 }, (_, i) => ctx(i + 22))]);

  it("folds long runs of unchanged lines, keeping three beside each change", () => {
    const parts = pieces(long);
    expect(parts[0]).toEqual({ kind: "fold", from: 0, to: 17, oldFrom: 1, oldTo: 17 });
    expect(parts.slice(1, 6).map((p) => (p.kind === "line" ? long.lines[p.index].kind : p.kind))).toEqual(["context", "context", "context", "del", "add"]);
    expect(parts.at(-1)).toEqual({ kind: "fold", from: 25, to: 42, oldFrom: 25, oldTo: 41 });
  });

  it("leaves git's own three lines of context alone, and unfolds a run holding an opened line", () => {
    const short = hunk([ctx(1), ctx(2), ctx(3), del(4, "x"), ctx(5), ctx(6), ctx(7)]);
    expect(pieces(short).every((p) => p.kind === "line")).toBe(true);
    const parts = pieces(long, [9]);
    expect(parts.filter((p) => p.kind === "fold")).toHaveLength(1);
    expect(parts.filter((p) => p.kind === "line")).toHaveLength(42 - 17);
  });

  it("sets a deletion beside the addition that replaced it, and leaves the other side empty for the rest", () => {
    const h = hunk([ctx(1), del(2, "a"), del(3, "b"), add(2, "A"), ctx(4), add(4, "new")]);
    expect(splitRows(h, pieces(h))).toEqual([
      { kind: "pair", left: 0, right: 0 },
      { kind: "pair", left: 1, right: 3 },
      { kind: "pair", left: 2, right: null },
      { kind: "pair", left: 4, right: 4 },
      { kind: "pair", left: null, right: 5 }
    ]);
  });

  it("counts the unchanged lines between hunks", () => {
    const hunks = [hunk([ctx(5), del(6, "x")], 5), hunk([ctx(40), add(40, "y")], 40)];
    expect(gapBefore(hunks, 0)).toEqual({ count: 4, oldFrom: 1 });
    expect(gapBefore(hunks, 1)).toEqual({ count: 33, oldFrom: 7 });
  });

  it("starts generated, binary and very large files folded", () => {
    expect(quietReason(file([]))).toBeNull();
    expect(quietReason(file([], { generated: true }))).toBe("generated");
    expect(quietReason(file(null, { binary: true, additions: null, deletions: null }))).toBe("binary");
    expect(quietReason(file(null, { additions: 1400, deletions: 200 }))).toBe("large");
  });
});

describe("syntax colours", () => {
  it("colours TypeScript by its extension and leaves an unknown language plain", () => {
    const ts = parserFor("src/a.ts")!;
    expect(parserFor("main.rs")).toBeNull();
    const [tokens] = highlightLines(ts, ['const name: string = "x"; // why']);
    const kinds = Object.fromEntries(tokens.map((token) => ['const name: string = "x"; // why'.slice(token.from, token.to), token.kind]));
    expect(kinds).toMatchObject({ const: "keyword", string: "type", '"x"': "string", "// why": "comment" });
  });

  it("gives each line of a token that runs over several its own part", () => {
    const lines = highlightLines(parserFor("a.js")!, ["/* one", "two */ let x"]);
    expect(lines[0]).toEqual([{ from: 0, to: 6, kind: "comment" }]);
    expect(lines[1][0]).toEqual({ from: 0, to: 6, kind: "comment" });
  });

  it("colours a deleted line from the old text and an added line from the new", () => {
    const h = hunk([del(1, "const a = 1;"), add(1, "let a = 'one';")]);
    const tokens = highlightHunk(parserFor("a.ts")!, h);
    expect(tokens.get(0)!.map((t) => t.kind)).toEqual(["keyword", "literal"]);
    expect(tokens.get(1)!.map((t) => t.kind)).toEqual(["keyword", "string"]);
  });

  it("cuts a line wherever a colour or a changed word starts or ends", () => {
    expect(segments("let ab = 1", [{ from: 0, to: 3, kind: "keyword" }], [[4, 6]])).toEqual([
      { text: "let", kind: "keyword", changed: false },
      { text: " ", kind: null, changed: false },
      { text: "ab", kind: null, changed: true },
      { text: " = 1", kind: null, changed: false }
    ]);
    expect(segments("plain")).toEqual([{ text: "plain", kind: null, changed: false }]);
  });
});

describe("viewed marks", () => {
  const before = file([hunk([ctx(1), del(2, "a"), add(2, "b")])]);

  it("forgets a mark once the file's diff changes, and keeps it while it does not", () => {
    const marks = markViewed({}, before, true);
    expect(isViewed(marks, before)).toBe(true);
    expect(isViewed(marks, file([hunk([ctx(1), del(2, "a"), add(2, "b")])]))).toBe(true);
    expect(isViewed(marks, file([hunk([ctx(1), del(2, "a"), add(2, "c")])]))).toBe(false);
    expect(fileVersion(before)).not.toBe(fileVersion({ ...before, status: "renamed", oldPath: "src/old.ts" }));
  });

  it("unmarks one version and leaves no empty entry behind", () => {
    const marks = markViewed({}, before, true);
    expect(markViewed(marks, before, false)).toEqual({});
  });
});
