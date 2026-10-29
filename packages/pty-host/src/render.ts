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

/** Paints a whole screen over whatever the window showed. */
export function fullFrame(screen: Screen): string {
  let out = `${RESET}\x1b[?25l\x1b[H\x1b[2J${screen.modes}`;
  screen.rows.forEach((row, y) => {
    if (row) out += `\x1b[${y + 1};1H${row}`;
  });
  return out + cursorOf(screen);
}

/** Paints only what changed from `before`; empty when nothing did. A screen of another size is painted whole. */
export function diffFrame(before: Screen, after: Screen): string {
  if (before.width !== after.width || before.height !== after.height) return fullFrame(after);
  let rows = "";
  after.rows.forEach((row, y) => {
    if (row === before.rows[y] && after.widths[y] === before.widths[y]) return;
    // A row that fills its width is left as it is: clearing from its last column would take that column too.
    rows += `\x1b[${y + 1};1H${row}${after.widths[y]! < after.width ? "\x1b[K" : ""}`;
  });
  const modes = after.modes !== before.modes ? after.modes : "";
  const moved = after.cursor?.x !== before.cursor?.x || after.cursor?.y !== before.cursor?.y;
  if (!rows && !modes && !moved) return "";
  return `\x1b[?25l${modes}${rows}${cursorOf(after)}`;
}

const cursorOf = (screen: Screen) => (screen.cursor ? `\x1b[${screen.cursor.y + 1};${screen.cursor.x + 1}H\x1b[?25h` : "");
