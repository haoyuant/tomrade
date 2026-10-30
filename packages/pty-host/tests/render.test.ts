import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import { Pane, type Pty } from "../src/pane.js";
import { diffFrame, fullFrame, scrollOf, type Screen } from "../src/render.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

function fakePty() {
  const datas: ((data: string) => void)[] = [];
  return {
    pid: 1,
    onData: (listener: (data: string) => void) => datas.push(listener),
    onExit: () => undefined,
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    print: (data: string) => datas.forEach((listener) => listener(data))
  } satisfies Pty & { print(data: string): void };
}

const settle = (term: HeadlessTerminal) => new Promise<void>((resolve) => term.write("", resolve));
const terms: { dispose(): void }[] = [];
afterEach(() => {
  for (const t of terms.splice(0)) t.dispose();
});

async function pane(cols: number, rows: number) {
  const pty = fakePty();
  const p = new Pane("p", pty, ".", null, cols, rows, { onScroll: () => undefined, onExit: () => undefined });
  terms.push(p);
  return {
    pane: p,
    print: async (data: string) => {
      pty.print(data);
      await settle(p.term);
    }
  };
}

/** A cell as the window shows it: what is in it and how it is styled. A blank never written reads as a space. */
function cellOf(cell: IBufferCell | undefined): string {
  if (!cell) return "?";
  const flags = [cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isInverse(), cell.isStrikethrough()].map(Number).join("");
  return `${cell.getChars() || " "}|${cell.getWidth()}|${cell.getFgColorMode()}:${cell.getFgColor()}|${cell.getBgColorMode()}:${cell.getBgColor()}|${flags}`;
}

function cells(term: HeadlessTerminal, top: number): string[][] {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  return Array.from({ length: term.rows }, (_, y) => {
    const line = buffer.getLine(top + y);
    return Array.from({ length: term.cols }, (_, x) => cellOf(line?.getCell(x, cell)));
  });
}

/** A window that was painted `before`, then sent the diff to `after`: its screen, cell by cell, against the host's. */
async function applied(before: Screen, bytes: string, host: Pane) {
  const window = new Terminal({ cols: before.width, rows: before.height, scrollback: 0, allowProposedApi: true });
  terms.push(window);
  window.write(fullFrame(before));
  if (window.cols !== host.term.cols || window.rows !== host.term.rows) window.resize(host.term.cols, host.term.rows);
  window.write(bytes);
  await settle(window);
  expect(cells(window, 0)).toEqual(cells(host.term, host.term.buffer.active.baseY));
  return window;
}

/** The row-by-row diff, as it was before scrolls were seen: what a scroll is measured against. */
function rowDiff(before: Screen, after: Screen): string {
  let out = "";
  after.rows.forEach((row, y) => {
    if (row !== before.rows[y] || after.widths[y] !== before.widths[y]) out += `\x1b[${y + 1};1H${row}\x1b[K`;
  });
  return out;
}

const colored = (n: number) => `\x1b[3${n % 7}m line ${n} \x1b[1;4${(n + 3) % 7}m${"#".repeat((n * 7) % 23)}\x1b[0m tail ${n}`;
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `${colored(from + i)}\r\n`).join("");
const BOX = 3;
const box = (n: number) => `\x1b[33m* working ${n}\x1b[0m\r\n\x1b[2m${"-".repeat(40)}\x1b[0m\r\n\x1b[1m>\x1b[0m `;
/** Ink's way: the box erased, the new lines, the box again: the output scrolls above a box that stays put. */
const tui = (from: number, to: number, n = 0) => `\x1b[${BOX - 1}A\r\x1b[J${lines(from, to)}${box(n)}`;

describe("a diff that sees scrolls", () => {
  it("moves the whole screen up and paints only the rows that came in", async () => {
    const { pane: p, print } = await pane(40, 10);
    await print(lines(0, 30));
    const before = p.screen();
    await print(lines(30, 33));
    const after = p.screen();
    expect(scrollOf(before, after)).toEqual({ top: 0, bottom: 9, by: 3 });
    const bytes = diffFrame(before, after);
    expect(bytes).toContain("\x1b[3S");
    expect(bytes).not.toMatch(/\x1b\[\d+;\d+r/);
    expect(bytes.length).toBeLessThan(rowDiff(before, after).length / 2);
    await applied(before, bytes, p);
  });

  it("scrolls only the rows above an input box that stays put, and leaves the box alone", async () => {
    const { pane: p, print } = await pane(40, 12);
    await print(`${"\r\n".repeat(12 - BOX)}${box(0)}`);
    await print(tui(0, 20));
    const before = p.screen();
    await print(tui(20, 24));
    const after = p.screen();
    expect(scrollOf(before, after)).toEqual({ top: 0, bottom: 12 - BOX - 1, by: 4 });
    const bytes = diffFrame(before, after);
    // The region set, the scroll, the region put back; the box's rows never painted.
    expect(bytes).toContain(`\x1b[1;${12 - BOX}r\x1b[4S\x1b[r`);
    for (let y = 12 - BOX; y < 12; y++) expect(bytes).not.toContain(`\x1b[${y + 1};1H`);
    await applied(before, bytes, p);
  });

  it("scrolls a run between a header and a footer that both stay put", async () => {
    const { pane: p, print } = await pane(50, 10);
    // A header on row 1, a footer on row 10, output scrolling in rows 2–9 (the program's own scroll region).
    await print(`\x1b[H\x1b[7m header \x1b[0m\x1b[10;1H\x1b[2m footer \x1b[0m\x1b[2;9r\x1b[9;1H`);
    await print(lines(0, 12).replace(/\r\n$/, ""));
    const before = p.screen();
    await print(`\r\n${lines(12, 14).replace(/\r\n$/, "")}`);
    const after = p.screen();
    expect(scrollOf(before, after)).toEqual({ top: 1, bottom: 8, by: 2 });
    await applied(before, diffFrame(before, after), p);
  });

  it("paints the rows that changed after the scroll too", async () => {
    const { pane: p, print } = await pane(40, 12);
    await print(`${"\r\n".repeat(12 - BOX)}${box(0)}`);
    await print(tui(0, 20, 1));
    const before = p.screen();
    // New output, a new spinner line in the box, and a row up in the output rewritten in place.
    await print(tui(20, 22, 2));
    await print(`\x1b7\x1b[3;1H\x1b[2K\x1b[45mrewritten\x1b[0m\x1b8`);
    const after = p.screen();
    const s = scrollOf(before, after);
    expect(s?.by).toBe(2);
    const bytes = diffFrame(before, after);
    expect(bytes).toContain("\x1b[3;1H");
    expect(bytes).toContain(`\x1b[${12 - BOX + 1};1H`);
    await applied(before, bytes, p);
  });

  it("paints a screen of another size whole", async () => {
    const { pane: p, print } = await pane(40, 10);
    await print(lines(0, 30));
    const before = p.screen();
    p.resize(40, 8);
    await print(lines(30, 33));
    const after = p.screen();
    expect(scrollOf(before, after)).toBeNull();
    const bytes = diffFrame(before, after);
    expect(bytes).toContain("\x1b[2J");
    await applied(before, bytes, p);
  });

  it("never takes a switch to the alternate screen for a scroll", async () => {
    const { pane: p, print } = await pane(40, 10);
    await print(lines(0, 30).replace(/\r\n$/, ""));
    const before = p.screen();
    // The alternate screen happens to show the rows the normal one had, three rows up.
    await print(`\x1b[?1049h\x1b[H${lines(23, 30).replace(/\r\n$/, "")}`);
    const after = p.screen();
    expect(after.alternate).toBe(true);
    expect(scrollOf(before, after)).toBeNull();
    expect(scrollOf({ ...before, alternate: true }, after)).not.toBeNull();
    const bytes = diffFrame(before, after);
    expect(bytes).not.toMatch(/\x1b\[\d+S/);
    await applied(before, bytes, p);
  });

  it("does not scroll when nothing moved, or when moving saves nothing", async () => {
    const { pane: p, print } = await pane(40, 6);
    await print(lines(0, 3));
    const before = p.screen();
    await print("x");
    expect(scrollOf(before, p.screen())).toBeNull();
    // Every row new: a scroll brings in nothing worth keeping.
    await print(`\x1b[2J\x1b[H${lines(100, 106).replace(/\r\n$/, "")}`);
    const after = p.screen();
    expect(scrollOf(before, after)).toBeNull();
    await applied(before, diffFrame(before, after), p);
  });

  it("scrolls with blank lines coming in, in the default colors", async () => {
    const { pane: p, print } = await pane(50, 8);
    await print(`\x1b[44m${lines(0, 7)}`);
    const before = p.screen();
    // Lines that end in a reset, then blank ones: the window's new rows must not take the last row's background.
    await print("\x1b[0m\r\n\r\n");
    const after = p.screen();
    await applied(before, diffFrame(before, after), p);
  });
});
