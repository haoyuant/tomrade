import type { IBufferCell, IBufferLine } from "@xterm/headless";

/*
 * A pane's screen as the window draws it: each visible row as the ANSI that
 * paints it, the cursor, and the modes that change what the window's keys send.
 * The window's xterm keeps no scrollback, so every frame paints the rows the
 * pane's view shows, wherever that is in the scrollback.
 */

export interface Screen {
  width: number;
  height: number;
  /** Each row's text and styling; trailing blanks left out. */
  rows: string[];
  /** How many columns each row paints, so a short one is cleared to its end. */
  widths: number[];
  /** Where the cursor is on screen; null while it is hidden or the view is up in the scrollback. */
  cursor: { x: number; y: number } | null;
  /** The modes the window's xterm needs to send what the program expects: arrow keys, pastes, focus, the cursor's shape. */
  modes: string;
  /** On the alternate screen: a switch between the two is never taken for a scroll. */
  alternate?: boolean;
}

const RESET = "\x1b[0m";

function color(mode: "fg" | "bg", cell: IBufferCell): string | null {
  const fg = mode === "fg";
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) {
    const c = fg ? cell.getFgColor() : cell.getBgColor();
    return `${fg ? 38 : 48};2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`;
  }
  if (fg ? cell.isFgPalette() : cell.isBgPalette()) {
    const c = fg ? cell.getFgColor() : cell.getBgColor();
    if (c < 8) return String((fg ? 30 : 40) + c);
    if (c < 16) return String((fg ? 90 : 100) + c - 8);
    return `${fg ? 38 : 48};5;${c}`;
  }
  return null;
}

/** The SGR that styles a cell, from a reset. */
export function sgrOf(cell: IBufferCell): string {
  const p: string[] = ["0"];
  if (cell.isBold()) p.push("1");
  if (cell.isDim()) p.push("2");
  if (cell.isItalic()) p.push("3");
  if (cell.isUnderline()) p.push("4");
  if (cell.isBlink()) p.push("5");
  if (cell.isInverse()) p.push("7");
  if (cell.isInvisible()) p.push("8");
  if (cell.isStrikethrough()) p.push("9");
  if (cell.isOverline()) p.push("53");
  const fg = color("fg", cell);
  const bg = color("bg", cell);
  if (fg) p.push(fg);
  if (bg) p.push(bg);
  return `\x1b[${p.join(";")}m`;
}

const flagsOf = (cell: IBufferCell) =>
  (cell.isBold() ? 1 : 0) | (cell.isDim() ? 2 : 0) | (cell.isItalic() ? 4 : 0) | (cell.isUnderline() ? 8 : 0) | (cell.isBlink() ? 16 : 0) | (cell.isInverse() ? 32 : 0) | (cell.isInvisible() ? 64 : 0) | (cell.isStrikethrough() ? 128 : 0) | (cell.isOverline() ? 256 : 0);

/** Each cell's SGR along a row, built again only where the styling differs from the cell before: most runs share one. */
function styler(): (cell: IBufferCell) => string {
  let flags = -1;
  let fgMode = -1;
  let fg = -1;
  let bgMode = -1;
  let bg = -1;
  let sgr = RESET;
  return (cell) => {
    const f = flagsOf(cell);
    if (f === flags && cell.getFgColorMode() === fgMode && cell.getFgColor() === fg && cell.getBgColorMode() === bgMode && cell.getBgColor() === bg) return sgr;
    flags = f;
    fgMode = cell.getFgColorMode();
    fg = cell.getFgColor();
    bgMode = cell.getBgColorMode();
    bg = cell.getBgColor();
    return (sgr = sgrOf(cell));
  };
}

/** One row as the ANSI that paints it from its first column, and how many columns that covers. */
export function renderRow(line: IBufferLine | undefined, cols: number, cell: IBufferCell): { text: string; width: number } {
  if (!line) return { text: "", width: 0 };
  let text = "";
  let width = 0;
  let style = RESET;
  let blanks = 0;
  const styleOf = styler();
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x, cell);
    if (!c) break;
    const w = c.getWidth();
    // The second half of a wide character: the first half painted it.
    if (w === 0) continue;
    const chars = c.getChars() || " ";
    const sgr = styleOf(c);
    // Plain blanks wait: trailing ones are never sent, the row is cleared after it instead.
    if (chars === " " && sgr === RESET) {
      blanks++;
      continue;
    }
    if (blanks) {
      if (style !== RESET) text += style = RESET;
      text += " ".repeat(blanks);
      width += blanks;
      blanks = 0;
    }
    if (sgr !== style) text += style = sgr;
    text += chars;
    width += w;
  }
  if (style !== RESET) text += RESET;
  return { text, width };
}

/** xterm's own row behind the public view (internal, so only ever looked for): three words a cell, content, fg and bg. */
interface RawLine {
  _data?: unknown;
  length?: unknown;
}
/** A cell whose text is kept outside its words (a grapheme of several code points). */
const CONTENT_COMBINED = 0x200000;
/** A cell whose styling is partly kept outside its words (an underline's style or color, a link). */
const BG_EXTENDED = 0x10000000;

interface CachedRow {
  words: Uint32Array;
  cols: number;
  row: { text: string; width: number };
}

/**
 * The rows of the last screen painted, by xterm's own line, with the words they were painted from: a row whose words
 * are the same paints the same, so it is not read cell by cell again, and its text is the very string it was (which a
 * diff compares and hashes for nothing). A row with a cell kept outside its words is always read again.
 */
export class RowCache {
  private rows = new Map<object, CachedRow>();
  private next = new Map<object, CachedRow>();

  render(line: IBufferLine | undefined, cols: number, cell: IBufferCell): { text: string; width: number } {
    const raw = (line as { _line?: RawLine } | undefined)?._line;
    const data = raw?._data;
    if (!raw || !(data instanceof Uint32Array) || typeof raw.length !== "number") return renderRow(line, cols, cell);
    const n = Math.min(cols, raw.length) * 3;
    if (data.length < n) return renderRow(line, cols, cell);
    const hit = this.rows.get(raw);
    if (hit && hit.cols === cols && hit.words.length === n && sameWords(hit.words, data, n)) {
      this.next.set(raw, hit);
      return hit.row;
    }
    const row = renderRow(line, cols, cell);
    if (plainWords(data, n)) {
      const words = hit && hit.words.length === n ? hit.words : new Uint32Array(n);
      words.set(data.subarray(0, n));
      this.next.set(raw, { words, cols, row });
    }
    return row;
  }

  /** The screen is read: only its rows are kept for the next one. */
  done(): void {
    this.rows = this.next;
    this.next = new Map();
  }
}

function sameWords(a: Uint32Array, b: Uint32Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function plainWords(data: Uint32Array, n: number): boolean {
  for (let i = 0; i < n; i += 3) if (data[i]! & CONTENT_COMBINED || data[i + 2]! & BG_EXTENDED) return false;
  return true;
}

/** Paints a whole screen over whatever the window showed. */
export function fullFrame(screen: Screen): string {
  let out = `${RESET}\x1b[?25l\x1b[H\x1b[2J${screen.modes}`;
  screen.rows.forEach((row, y) => {
    if (row) out += `\x1b[${y + 1};1H${row}`;
  });
  return out + cursorOf(screen);
}

// A row that fills its width is left as it is: clearing from its last column would take that column too.
const paintRow = (screen: Screen, y: number) => `\x1b[${y + 1};1H${screen.rows[y]}${screen.widths[y]! < screen.width ? "\x1b[K" : ""}`;
const paintCost = (screen: Screen, y: number) => screen.rows[y]!.length + String(y + 1).length + 4 + (screen.widths[y]! < screen.width ? 3 : 0);

/** Rows `top`..`bottom` (inclusive) moved up `by`: what was below comes up, blank rows come in at the bottom. */
export interface Scroll {
  top: number;
  bottom: number;
  by: number;
}

/**
 * Scrolls rows of the window's screen up, within a scroll region when it is not the whole screen, the region put back
 * after. The rows that come in are blank in the default colors (hence the reset first); the window keeps no scrollback,
 * so the rows that go leave nothing behind.
 */
function scrollBytes(s: Scroll, height: number): string {
  if (s.top === 0 && s.bottom === height - 1) return `${RESET}\x1b[${s.by}S`;
  return `${RESET}\x1b[${s.top + 1};${s.bottom + 1}r\x1b[${s.by}S\x1b[r`;
}

/** How many of the moves that most rows agree on are weighed: a log that scrolls agrees on one. */
const CANDIDATES = 4;
/** Where a repeated row is looked for: a screen of the same row over and over says nothing more after a few. */
const PLACES = 16;

/**
 * The scroll that paints `after` over `before` in the fewest bytes, with the rows it leaves to paint; null when none
 * saves any. A scroll is up by some rows, over the whole screen or one run of rows (an agent's input box stays put
 * under its output). Rows are compared as they are painted, so the bytes it spares are counted exactly.
 */
export function scrollOf(before: Screen, after: Screen): Scroll | null {
  const height = after.height;
  if (height < 2 || before.height !== height || before.width !== after.width || !!before.alternate !== !!after.alternate) return null;
  const ids = new Map<string, number>();
  const idOf = (row: string) => {
    let id = ids.get(row);
    if (id === undefined) ids.set(row, (id = ids.size));
    return id;
  };
  const was = before.rows.map(idOf);
  const now = after.rows.map(idOf);
  const blank = idOf("");
  const equal = (y: number, p: number) => now[y] === was[p] && after.widths[y] === before.widths[p];
  const cost: number[] = [];
  // What painting each row costs as things are, without a scroll.
  const stay: number[] = [];
  for (let y = 0; y < height; y++) {
    cost.push(paintCost(after, y));
    stay.push(equal(y, y) ? 0 : cost[y]!);
  }
  // Each row that moved votes for how far.
  const places = new Map<number, number[]>();
  for (let p = 0; p < height; p++) {
    if (was[p] === blank) continue;
    const list = places.get(was[p]!) ?? [];
    if (list.length < PLACES) list.push(p);
    places.set(was[p]!, list);
  }
  const votes = new Map<number, number>();
  for (let y = 0; y < height; y++) {
    if (!stay[y] || now[y] === blank) continue;
    for (const p of places.get(now[y]!) ?? []) if (p > y && equal(y, p)) votes.set(p - y, (votes.get(p - y) ?? 0) + 1);
  }
  const ks = [...votes].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES);
  let best: Scroll | null = null;
  let bestGain = 0;
  for (const [k] of ks) {
    // A row that moved up costs nothing if it is what the row shows now; a row that came in, nothing if it is blank.
    const moved = (y: number) => stay[y]! - (equal(y, y + k) ? 0 : cost[y]!);
    const fresh = (y: number) => stay[y]! - (now[y] === blank && after.widths[y] === 0 ? 0 : cost[y]!);
    // The best run of moved rows ending at each row (its sum and where it starts), and the fresh rows' sums so far.
    let run = -Infinity;
    let runTop = 0;
    const freshSum = [0];
    for (let y = 0; y < height; y++) freshSum.push(freshSum[y]! + fresh(y));
    for (let end = 0; end + k < height; end++) {
      const d = moved(end);
      if (run > 0) run += d;
      else {
        run = d;
        runTop = end;
      }
      const bottom = end + k;
      const s = { top: runTop, bottom, by: k };
      const gain = run + freshSum[bottom + 1]! - freshSum[end + 1]! - scrollBytes(s, height).length;
      if (gain > bestGain) {
        bestGain = gain;
        best = s;
      }
    }
  }
  return best;
}

/** The window's screen once `scroll` moved its rows. */
function scrolled(screen: Screen, s: Scroll): Screen {
  const rows = [...screen.rows];
  const widths = [...screen.widths];
  for (let y = s.top; y <= s.bottom; y++) {
    const from = y + s.by;
    rows[y] = from <= s.bottom ? screen.rows[from]! : "";
    widths[y] = from <= s.bottom ? screen.widths[from]! : 0;
  }
  return { ...screen, rows, widths };
}

/**
 * Paints only what changed from `before`; empty when nothing did. A screen of another size is painted whole. Output that
 * scrolls is sent as the scroll and the rows it brings in, not as every row painted again.
 */
export function diffFrame(before: Screen, after: Screen): string {
  if (before.width !== after.width || before.height !== after.height) return fullFrame(after);
  const scroll = scrollOf(before, after);
  const shown = scroll ? scrolled(before, scroll) : before;
  let rows = scroll ? scrollBytes(scroll, after.height) : "";
  for (let y = 0; y < after.height; y++) {
    if (after.rows[y] === shown.rows[y] && after.widths[y] === shown.widths[y]) continue;
    rows += paintRow(after, y);
  }
  const modes = after.modes !== before.modes ? after.modes : "";
  // A scroll region takes the cursor home.
  const moved = !!scroll || after.cursor?.x !== before.cursor?.x || after.cursor?.y !== before.cursor?.y;
  if (!rows && !modes && !moved) return "";
  return `\x1b[?25l${modes}${rows}${cursorOf(after)}`;
}

const cursorOf = (screen: Screen) => (screen.cursor ? `\x1b[${screen.cursor.y + 1};${screen.cursor.x + 1}H\x1b[?25h` : "");
