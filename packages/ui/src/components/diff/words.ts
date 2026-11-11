import type { ChangeLine } from "@tomradex/code-link";

/** A changed stretch of one line, as character offsets into its text. */
export type Span = [from: number, to: number];

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
// A run of spaces, one CJK character, a word, or any single other character.
const TOKEN = new RegExp(`\\s+|[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{N}_])+|.`, "gsu");

/** Above this many token pairs the table is not worth building; only the shared ends are matched. */
const TABLE_MAX = 250_000;
/** A pair that shares less than this much of its text is two different lines, not an edit of one. */
const SHARED_MIN = 0.3;

const tokensOf = (text: string): string[] => text.match(TOKEN) ?? [];
const blank = (token: string): boolean => /^\s+$/.test(token);

/** Which tokens of `a` and `b` a longest common subsequence leaves unmatched. */
function unmatched(a: string[], b: string[]): { a: boolean[]; b: boolean[] } {
  const inA = a.map(() => true);
  const inB = b.map(() => true);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  for (let i = 0; i < head; i++) inA[i] = inB[i] = false;
  for (let i = 0; i < tail; i++) inA[a.length - 1 - i] = inB[b.length - 1 - i] = false;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (!n || !m || n * m > TABLE_MAX) return { a: inA, b: inB };
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[head + i] === b[head + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[head + i] === b[head + j]) {
      inA[head + i] = inB[head + j] = false;
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  return { a: inA, b: inB };
}

/** The flagged tokens as character spans, neighbours joined. */
function spansOf(tokens: string[], flagged: boolean[]): Span[] {
  const spans: Span[] = [];
  let at = 0;
  tokens.forEach((token, i) => {
    if (flagged[i]) {
      const last = spans.at(-1);
      if (last && last[1] === at) last[1] = at + token.length;
      else spans.push([at, at + token.length]);
    }
    at += token.length;
  });
  return spans;
}

/** What changed inside a deleted line and the added line that replaced it; null when they are the same or share too little to be one edit. */
export function wordDiff(before: string, after: string): { old: Span[]; new: Span[] } | null {
  if (before === after) return null;
  const a = tokensOf(before);
  const b = tokensOf(after);
  const flags = unmatched(a, b);
  const inked = (tokens: string[], keep: (i: number) => boolean) => tokens.reduce((sum, token, i) => (blank(token) || !keep(i) ? sum : sum + token.length), 0);
  const longest = Math.max(inked(a, () => true), inked(b, () => true));
  if (longest && inked(a, (i) => !flags.a[i]) / longest < SHARED_MIN) return null;
  return { old: spansOf(a, flags.a), new: spansOf(b, flags.b) };
}

/** Word-level spans for a hunk's lines, by line index: each run of deletions is paired, in order, with the additions right after it. */
export function pairedSpans(lines: readonly ChangeLine[]): Map<number, Span[]> {
  const spans = new Map<number, Span[]>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== "del") {
      i++;
      continue;
    }
    let adds = i;
    while (adds < lines.length && lines[adds].kind === "del") adds++;
    let end = adds;
    while (end < lines.length && lines[end].kind === "add") end++;
    for (let k = 0; k < Math.min(adds - i, end - adds); k++) {
      const diff = wordDiff(lines[i + k].text, lines[adds + k].text);
      if (!diff) continue;
      if (diff.old.length) spans.set(i + k, diff.old);
      if (diff.new.length) spans.set(adds + k, diff.new);
    }
    i = end;
  }
  return spans;
}
