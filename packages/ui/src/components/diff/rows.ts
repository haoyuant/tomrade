import type { ChangedFile, ChangeHunk, ChangeLine } from "@tomradex/code-link";

/** Unchanged lines kept in view on each side of a change. */
export const CONTEXT_KEPT = 3;
/** Folding fewer lines than this hides less than the fold's own row is worth. */
const FOLD_MIN = 4;
/** A file changing more lines than this starts folded. */
export const LARGE_LINES = 1500;

/** A stretch of a hunk: one line, or a run of unchanged lines folded away. */
export type Piece = { kind: "line"; index: number } | { kind: "fold"; from: number; to: number; oldFrom: number; oldTo: number };

/**
 * A hunk's lines with long unchanged runs folded, `CONTEXT_KEPT` lines left beside each change.
 * A fold holding one of `opened` (old line numbers) is unfolded.
 */
export function pieces(hunk: ChangeHunk, opened: readonly number[] = []): Piece[] {
  const { lines } = hunk;
  const out: Piece[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== "context") {
      out.push({ kind: "line", index: i++ });
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].kind === "context") end++;
    const from = i === 0 ? i : i + CONTEXT_KEPT;
    const to = end === lines.length ? end : end - CONTEXT_KEPT;
    const oldFrom = lines[from]?.old ?? 0;
    const oldTo = lines[to - 1]?.old ?? 0;
    const folded = to - from >= FOLD_MIN && !opened.some((line) => line >= oldFrom && line <= oldTo);
    for (let k = i; k < end; k++) {
      if (folded && k === from) {
        out.push({ kind: "fold", from, to, oldFrom, oldTo });
        k = to - 1;
      } else out.push({ kind: "line", index: k });
    }
    i = end;
  }
  return out;
}

/** A row of the split layout: the old side, the new side, or both; a deletion sits beside the addition that replaced it. */
export type SplitRow = { kind: "pair"; left: number | null; right: number | null } | Extract<Piece, { kind: "fold" }>;

export function splitRows(hunk: ChangeHunk, parts: readonly Piece[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < parts.length; ) {
    const part = parts[i];
    if (part.kind === "fold") {
      rows.push(part);
      i++;
      continue;
    }
    const kind = hunk.lines[part.index].kind;
    if (kind === "context") {
      rows.push({ kind: "pair", left: part.index, right: part.index });
      i++;
      continue;
    }
    const run = (want: ChangeLine["kind"]): number[] => {
      const found: number[] = [];
      for (let p = parts[i]; p?.kind === "line" && hunk.lines[p.index].kind === want; p = parts[++i]) found.push(p.index);
      return found;
    };
    const dels = run("del");
    const adds = run("add");
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ kind: "pair", left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

/** How many unchanged lines sit between the hunk before (or the top of the file) and this one. */
export function gapBefore(hunks: readonly ChangeHunk[], index: number): { count: number; oldFrom: number } {
  const prev = hunks[index - 1];
  const oldFrom = prev ? prev.oldStart + prev.oldLines : 1;
  return { count: Math.max(0, hunks[index].oldStart - oldFrom), oldFrom };
}

/** Lines a file's diff draws, for its placeholder's height and the large-file fold. */
export const lineCount = (file: ChangedFile): number => file.hunks?.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? (file.additions ?? 0) + (file.deletions ?? 0);

/** Why a file starts folded; null when it starts open. */
export function quietReason(file: ChangedFile): "generated" | "binary" | "large" | null {
  if (file.binary) return "binary";
  if (file.generated) return "generated";
  return (file.additions ?? 0) + (file.deletions ?? 0) > LARGE_LINES ? "large" : null;
}

/** Digits the widest line number of a file takes. */
export function gutterDigits(file: ChangedFile): number {
  let max = 1;
  for (const hunk of file.hunks ?? []) max = Math.max(max, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);
  return Math.max(2, String(max).length);
}
