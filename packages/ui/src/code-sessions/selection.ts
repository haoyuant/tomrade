import type { Terminal } from "@xterm/xterm";

/** Only the public xterm surface used by the selection follower. */
type SelectionTerminal = Pick<Terminal, "rows" | "cols" | "buffer" | "onSelectionChange" | "onWriteParsed" | "getSelectionPosition" | "select" | "clearSelection">;
type Point = [col: number, line: number];
type Range = { start: Point; end: Point };

/**
 * Where a double-click's word ends: xterm's own marks, and the full-width ones. Chinese has no spaces, so without
 * these a word runs through the whole sentence.
 */
export const wordSeparator = " ()[]{}',\"`\u3000，。、；：！？（）［］｛｝【】《》〈〉「」『』〔〕“”‘’…—·～";
/** Asks the pane to scroll, as the wheel does. */
type Scroll = (direction: "up" | "down", lines: number) => void;
/** A dictionary's word breaks for Chinese, which has no spaces between words: null until it has loaded. */
export type Words = { cut(text: string): string[] | null; load(): Promise<unknown> };
const HAN = /\p{Script=Han}/u;
const WORD_RUN = /^[\p{L}\p{N}\p{M}]+$/u;

/*
 * A program that lays its own text out (Claude Code) breaks a long file path at the right edge and indents the rest
 * on the next row. The copy puts such a path back on one line; fileLinks.ts reads the same break for a click.
 * Nothing says a path at the edge is not simply over, so one that already has its extension is left alone.
 */
const OPEN_PATH = /(?:^|[\s(["'：，。；、（【「『《“‘])(?:file:\/\/|\/|~\/|[A-Za-z]:[\\/])[^\s<>"'`\])}]*$/;
const REST = /^\s*[^\s<>"'`\])}]+/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,4}$/;
/** How near the right edge a row must end to count as broken there. */
const EDGE = 4;
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
/** A row's text in cells, near enough to tell whether it reaches the edge. */
const width = (text: string) => [...text].reduce((cells, ch) => cells + (ch.length > 1 || WIDE.test(ch) ? 2 : 1), 0);

/**
 * How far up the rows moved between two paints of the screen, and the rows that take part: all of them through
 * the scrollback, or a TUI's body between its fixed header and footer. Null when nothing moved or it cannot be told.
 */
function moved(before: string[], after: string[]): { by: number; first: number; last: number } | null {
  let best: { by: number; first: number; last: number } | null = null;
  let score = 0;
  let tied = false;
  for (let by = 1 - after.length; by < after.length; by++) {
    if (by === 0) continue;
    let count = 0;
    let first = -1;
    let last = -1;
    for (let y = 0; y < after.length; y++) {
      // A row that reads the same where it was says nothing, and a blank one matches anywhere.
      if (after[y] !== before[y + by] || after[y] === before[y] || !after[y].trim()) continue;
      count++;
      if (first < 0) first = y;
      last = y;
    }
    if (!count || count < score) continue;
    if (count === score) tied = true;
    else { best = { by, first, last }; score = count; tied = false; }
  }
  if (!best || tied) return null;
  let { first, last } = best;
  const { by } = best;
  while (first > 0 && after[first - 1] === before[first - 1 + by]) first--;
  while (last < after.length - 1 && after[last + 1] === before[last + 1 + by]) last++;
  // The rows that came into view moved too.
  return { by, first: Math.max(0, Math.min(first, first + by)), last: Math.min(after.length - 1, Math.max(last, last + by)) };
}

/**
 * Frames contain repainted cells, not the application's scroll operations. In particular a TUI can
 * scroll its body while herdr's scrollback offset stays at zero. Anchor to the selected cells after
 * xterm parses each frame, rather than to that offset or the rows on the screen.
 *
 * While the button is down xterm keeps the screen rows the drag started on. Once the content moves under it
 * (the wheel, output, or `scroll` asked for here with the pointer past the top or bottom edge) the drag is
 * carried on here instead: from the text it began on to the cell under the pointer.
 */
export function followSelection(terminal: SelectionTerminal, el: HTMLElement, scroll?: Scroll, words?: Words) {
  let top = 0;
  let picked: { start: Point; end: Point } | null = null;
  let shown: { start: Point; end: Point; cutStart: boolean; cutEnd: boolean } | null = null;
  let lines = new Map<number, string>();
  let context = new Map<number, string>();
  let quiet = false;
  let held = false;
  // Of the drag in progress: the rows as last painted, the pointer, and what the press selected, which stays in it.
  let screen: string[] = [];
  let pointer: { x: number; y: number } | null = null;
  let origin: (Range & { tail: string; head: string; whole: boolean }) | null = null;
  // Set once the drag is carried on here: the rows that scroll, and every row seen in them, by line.
  let drag: { lo: number; hi: number; seen: Map<number, string> } | null = null;
  let edge: ReturnType<typeof setInterval> | undefined;
  let asked = 0;
  const rowText = (y: number, from = 0, to?: number) => terminal.buffer.active.getLine(y)?.translateToString(true, from, to) ?? "";
  const before = (a: Point, b: Point) => a[1] < b[1] || (a[1] === b[1] && a[0] < b[0]);
  const same = (a: Point, x: number, y: number) => a[0] === x && a[1] === y;
  const hide = () => {
    quiet = true;
    terminal.clearSelection();
    quiet = false;
    shown = null;
  };
  const show = (firstLine: number, lastLine: number) => {
    if (!picked) return;
    const cutStart = firstLine !== picked.start[1];
    const cutEnd = lastLine !== picked.end[1];
    const start: Point = [cutStart ? 0 : picked.start[0], firstLine - top];
    const end: Point = [cutEnd ? terminal.cols : picked.end[0], lastLine - top];
    quiet = true;
    terminal.select(start[0], start[1], (end[1] - start[1]) * terminal.cols + end[0] - start[0]);
    quiet = false;
    shown = { start, end, cutStart, cutEnd };
  };
  /** xterm's selection by line: an end still where a cut highlight put it stands for the hidden end. */
  const lifted = (at: NonNullable<ReturnType<SelectionTerminal["getSelectionPosition"]>>): Range => ({
    start: picked && shown?.cutStart && same(shown.start, at.start.x, at.start.y) ? picked.start : [at.start.x, at.start.y + top],
    end: picked && shown?.cutEnd && same(shown.end, at.end.x, at.end.y) ? picked.end : [at.end.x, at.end.y + top],
  });
  const box = () => (el.querySelector(".xterm-screen") ?? el).getBoundingClientRect();
  /** The cell boundary under the pointer as xterm takes it for a selection, kept within rows `lo` to `hi`. */
  const under = (lo: number, hi: number): Point | null => {
    const rect = box();
    if (!pointer || !rect.width || !rect.height) return null;
    const y = Math.floor(((pointer.y - rect.top) / rect.height) * terminal.rows);
    if (y < lo) return [0, lo];
    if (y > hi) return [terminal.cols, hi];
    let x = Math.max(0, Math.min(terminal.cols, Math.round(((pointer.x - rect.left) / rect.width) * terminal.cols)));
    // Inside a wide character: all of it.
    if (x < terminal.cols && terminal.buffer.active.getLine(y)?.getCell(x)?.getWidth() === 0) x++;
    return [x, y];
  };
  /** The drag carried on here: what the press selected, out to the pointer. */
  const extend = () => {
    const at = drag && under(drag.lo, drag.hi);
    if (!drag || !origin || !at) return;
    const focus: Point = [at[0], at[1] + top];
    let { start, end } = origin;
    if (before(focus, start)) start = origin.whole ? [0, focus[1]] : focus;
    else if (before(end, focus)) end = origin.whole ? [terminal.cols, focus[1]] : focus;
    if (same(start, end[0], end[1])) {
      picked = null;
      lines.clear();
      context.clear();
      hide();
      return;
    }
    const kept = new Map<number, string>();
    const rows = new Map<number, string>();
    for (let line = start[1]; line <= end[1]; line++) {
      const y = line - top;
      const row = drag.seen.get(line) ?? "";
      rows.set(line, row);
      // Only what the press selected can end the selection out of view: its text was taken then.
      if (y >= drag.lo && y <= drag.hi) kept.set(line, rowText(y, line === start[1] ? start[0] : 0, line === end[1] ? end[0] : undefined));
      else kept.set(line, line === start[1] ? origin.tail : line === end[1] ? origin.head : row);
    }
    picked = { start, end };
    lines = kept;
    context = rows;
    show(Math.max(start[1], top + drag.lo), Math.min(end[1], top + drag.hi));
  };
  const changed = terminal.onSelectionChange(() => {
    if (quiet) return;
    const at = terminal.getSelectionPosition();
    if (!at) {
      picked = null;
      shown = null;
      lines.clear();
      context.clear();
      return;
    }
    const { start, end } = lifted(at);
    picked = { start, end };
    shown = null;
    const kept = new Map([...lines].filter(([line]) => line >= start[1] && line <= end[1]));
    context = new Map([...context].filter(([line]) => line >= start[1] && line <= end[1]));
    for (let y = Math.max(0, start[1] - top); y <= Math.min(terminal.rows - 1, end[1] - top); y++) {
      const line = top + y;
      context.set(line, terminal.buffer.active.getLine(y)?.translateToString(true) ?? "");
      kept.set(line, terminal.buffer.active.getLine(y)?.translateToString(true, line === start[1] ? start[0] : 0, line === end[1] ? end[0] : undefined) ?? "");
    }
    lines = kept;
  });
  const parsed = terminal.onWriteParsed(() => {
    if (held) {
      const was = screen;
      screen = Array.from({ length: terminal.rows }, (_, y) => rowText(y));
      asked = 0;
      if (!origin) return;
      const went = moved(was, screen);
      // Rows moving elsewhere on the screen (a footer growing, say) leave the drag where it is. Once carried on, the
      // region's ends wobble by a blank row that matches on one paint and not the next: most of it moving is the body.
      const from = Math.max(0, Math.min(terminal.rows - 1, origin.start[1] - top));
      const ours = went && (drag ? 2 * (Math.min(went.last, drag.hi) - Math.max(went.first, drag.lo) + 1) > drag.hi - drag.lo + 1 : from >= went.first && from <= went.last);
      if (went && ours) {
        if (!drag) {
          drag = { lo: 0, hi: 0, seen: new Map(context) };
          was.forEach((text, y) => drag?.seen.set(top + y, text));
        }
        top += went.by;
        drag.lo = went.first;
        drag.hi = went.last;
      }
      if (!drag) return;
      for (let y = drag.lo; y <= drag.hi; y++) drag.seen.set(top + y, screen[y]);
      extend();
      return;
    }
    if (!picked) return;
    // A candidate is a translation of the whole selection, clipped to the viewport. Blank rows
    // cannot identify text. Prefer the largest matching part; an ambiguous match hides the highlight
    // rather than selecting unrelated text. Keep the snapshot so scrolling back can find it again.
    let best: { top: number; first: number; last: number } | null = null;
    let score = 0;
    let contextScore = 0;
    let tied = false;
    for (let candidate = picked.start[1] - terminal.rows + 1; candidate <= picked.end[1]; candidate++) {
      let matched = 0;
      let contextMatched = 0;
      let first = 0;
      for (const [line, text] of lines) {
        const y = line - candidate;
        if (y < 0 || y >= terminal.rows) continue;
        const actual = terminal.buffer.active.getLine(y)?.translateToString(true, line === picked.start[1] ? picked.start[0] : 0, line === picked.end[1] ? picked.end[0] : undefined) ?? "";
        // Fixed TUI headers and footers can occlude either end inside the viewport. Only draw
        // the contiguous matching run, never over those controls or newly inserted text.
        if (actual !== text) { matched = 0; contextMatched = 0; first = line + 1; continue; }
        if (!matched) first = line;
        if (!text.trim()) continue;
        matched++;
        // A short selection (a word in shell output, for example) can match many rows.
        // Use the rest of its original row to break ties, without requiring that unselected
        // text stays unchanged or including it in the clipboard snapshot.
        if (terminal.buffer.active.getLine(y)?.translateToString(true) === context.get(line)) contextMatched++;
        if (matched < score || (matched === score && contextMatched < contextScore)) continue;
        if (matched === score && contextMatched === contextScore) tied = true;
        else { best = { top: candidate, first, last: line }; score = matched; contextScore = contextMatched; tied = false; }
      }
    }
    if (best === null || tied) hide();
    else { top = best.top; show(best.first, best.last); }
  });
  // Always copy the snapshot, including between the arrival and parsing of a repaint, and while
  // the selection is outside the viewport. Never copy whatever replaced it at the old screen rows.
  const text = (): string | null => {
    if (!picked) return null;
    let out = "";
    // Whether the row before ended inside a path the program broke at the edge: this row then goes on with it.
    let open = false;
    for (let line = picked.start[1]; line <= picked.end[1]; line++) {
      const row = context.get(line) ?? "";
      const part = (lines.get(line) ?? "").replace(/ /g, " ");
      const rest: RegExpExecArray | null = open ? REST.exec(row) : null;
      if (line > picked.start[1] && !rest) out += "\n";
      out += rest ? part.trimStart() : part;
      const path: boolean = rest ? rest[0].length === row.length : OPEN_PATH.test(row);
      open = path && width(row) >= terminal.cols - EDGE && !EXTENSION.test(row);
    }
    return out;
  };
  const copy = (e: ClipboardEvent) => {
    const snapshot = text();
    if (snapshot === null || !e.clipboardData) return;
    e.clipboardData.setData("text/plain", snapshot);
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const release = () => {
    held = false;
    drag = null;
    origin = null;
    pointer = null;
    screen = [];
    clearInterval(edge);
    window.removeEventListener("mousemove", move, true);
  };
  // Before xterm's own listener, which keeps the event to itself.
  const move = (e: MouseEvent) => {
    // A release that never arrived, outside the window say.
    if (!(e.buttons & 1)) return release();
    pointer = { x: e.clientX, y: e.clientY };
    extend();
  };
  /** With the pointer past the top or bottom edge, the pane scrolls that way: faster the further out. */
  const scrollPast = () => {
    const rect = box();
    const past = !pointer ? 0 : pointer.y < rect.top ? pointer.y - rect.top : pointer.y > rect.bottom ? pointer.y - rect.bottom : 0;
    // One step at a time, the next after the last one's frame: two paints must share rows for the move to be told.
    const now = performance.now();
    if (!past || (asked && now - asked < 250)) return;
    asked = now;
    scroll?.(past < 0 ? "up" : "down", Math.min(Math.max(1, Math.floor(terminal.rows / 6)), 1 + Math.floor(Math.min(Math.abs(past), 80) / 16)));
  };
  const press = (e: MouseEvent) => {
    if (e.button !== 0) return;
    release();
    held = true;
    if (!e.shiftKey) { picked = null; shown = null; lines.clear(); context.clear(); }
    pointer = { x: e.clientX, y: e.clientY };
    screen = Array.from({ length: terminal.rows }, (_, y) => rowText(y));
    window.addEventListener("mousemove", move, true);
    if (scroll) edge = setInterval(scrollPast, 50);
  };
  /**
   * A double-clicked run of Chinese, which xterm takes up to the next space or punctuation: only the dictionary word
   * under the pointer. The first one waits for the dictionary to load, then narrows if the selection is still that run.
   */
  const narrow = (clientX: number): void => {
    const at = terminal.getSelectionPosition();
    const line = at && at.start.y === at.end.y ? terminal.buffer.active.getLine(at.start.y) : undefined;
    if (!at || !line || !words) return;
    const cells: { col: number; width: number }[] = [];
    const cellOf: number[] = [];
    let run = "";
    for (let x = at.start.x; x < at.end.x; x++) {
      const cell = line.getCell(x);
      const width = cell?.getWidth() ?? 0;
      if (!cell || !width) continue;
      const chars = cell.getChars() || " ";
      for (let i = [...chars].length; i > 0; i--) cellOf.push(cells.length);
      run += chars;
      cells.push({ col: x, width });
    }
    if (!HAN.test(run) || !WORD_RUN.test(run)) return;
    const parts = words.cut(run);
    if (!parts) {
      const was = `${at.start.x},${at.start.y},${at.end.x}`;
      void words.load().then(() => {
        const now = terminal.getSelectionPosition();
        if (!now || `${now.start.x},${now.start.y},${now.end.x}` !== was) return;
        narrow(clientX);
        const after = terminal.getSelectionPosition();
        if (held && origin && !origin.whole && after) origin = originOf(lifted(after), false);
      }, () => undefined);
      return;
    }
    const rect = box();
    const col = Math.floor(((clientX - rect.left) / rect.width) * terminal.cols);
    const clicked = cells.findIndex((c) => col >= c.col && col < c.col + c.width);
    if (clicked < 0) return;
    let from = 0;
    for (const part of parts) {
      const length = [...part].length;
      const first = cellOf[from];
      const last = cellOf[from + length - 1];
      from += length;
      if (first === undefined || last === undefined || clicked < first || clicked > last) continue;
      const start = cells[first].col;
      const end = cells[last].col + cells[last].width;
      if (start !== at.start.x || end !== at.end.x) terminal.select(start, at.start.y, end - start);
      return;
    }
  };
  const originOf = (range: Range, whole: boolean) => {
    const text = (p: Point, from: number, to?: number) => (p[1] - top >= 0 && p[1] - top < terminal.rows ? rowText(p[1] - top, from, to) : lines.get(p[1]) ?? "");
    return { ...range, tail: text(range.start, range.start[0]), head: text(range.end, 0, range.end[0]), whole };
  };
  /** After xterm took the press: the cell, word or line it selected, or with Shift the end it kept. */
  const pressed = (e: MouseEvent) => {
    if (e.button !== 0 || !held) return;
    if (e.detail === 2 && !e.shiftKey) narrow(e.clientX);
    const here = under(0, terminal.rows - 1);
    const at = terminal.getSelectionPosition();
    let range: Range | null = here && { start: [here[0], here[1] + top], end: [here[0], here[1] + top] };
    if (at) {
      range = lifted(at);
      const kept = here && range.end[1] - top === here[1] && range.end[0] === here[0] ? range.start : range.end;
      if (e.shiftKey) range = { start: kept, end: kept };
    }
    if (!range) return;
    origin = originOf(range, !e.shiftKey && e.detail === 3);
  };
  el.addEventListener("copy", copy, true);
  el.addEventListener("mousedown", press, true);
  el.addEventListener("mousedown", pressed);
  window.addEventListener("mouseup", release);
  return {
    /** The selection's snapshot as the clipboard takes it, wherever the pane has scrolled since; null with none. */
    text,
    dispose() {
      changed.dispose();
      parsed.dispose();
      el.removeEventListener("copy", copy, true);
      release();
      el.removeEventListener("mousedown", press, true);
      el.removeEventListener("mousedown", pressed);
      window.removeEventListener("mouseup", release);
    },
  };
}
