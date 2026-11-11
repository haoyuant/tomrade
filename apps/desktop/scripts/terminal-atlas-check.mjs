// Real TerminalCells sharing one glyph atlas: coming back to the window redraws every one of them as it was, also when
// atlas pages merge in the middle of a terminal's redraw, and time after time (patches/@xterm__addon-webgl).
// Run: pnpm --filter @tomrade/desktop exec electron scripts/terminal-atlas-check.mjs
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const COLUMNS = 4;
const CELLS = 12;
const WIDTH = 400;
const HEIGHT = 260;
/** Screens of other glyphs each terminal shows first: they fill the atlas until its pages merge. */
const WARM_UPS = 2;
const RETURNS = 4;
/** As on a Retina screen: glyphs four times the size fill a page four times as fast, so a return's redraw alone merges pages. */
const ZOOM = 2;
const COLOURS = ["255;120;120", "120;230;140", "130;170;255", "240;220;120", "230;140;240", "120;230;230"];

const require = createRequire(new URL("../../../packages/ui/package.json", import.meta.url));
const { build } = createRequire(require.resolve("vite"))("esbuild");
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {TerminalCell} from './src/code-sessions/TerminalCell';
      window.roots = [...document.querySelectorAll('.cell')].map((el, i) => {
        const root = createRoot(el);
        root.render(React.createElement(TerminalCell, {cell:'c' + i, sessionId:'s' + i, pane:'p' + i, tokens:{}, font:'', labels:{}, autoFocus:false}));
        return root;
      });`,
    resolveDir: fileURLToPath(new URL("../../../packages/ui/", import.meta.url)), loader: "tsx"
  },
  bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' }
});

/** A screen of wide glyphs no other screen has, each row in its own colour, every other one bold. */
const screen = (cols, rows, first) => {
  let code = first;
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let line = `\x1b[${y % 2 ? "1;" : ""}38;2;${COLOURS[y % COLOURS.length]}m`;
    for (let x = 0; x < Math.floor(cols / 2); x++) line += String.fromCodePoint(code++);
    lines.push(line + "\x1b[0m");
  }
  return { bytes: "\x1b[?25l\x1b[2J\x1b[H" + lines.join("\r\n"), next: code };
};

app.whenReady().then(async () => {
  const rowsOfCells = Math.ceil(CELLS / COLUMNS);
  const win = new BrowserWindow({ show: false, useContentSize: true, enableLargerThanScreen: true, width: COLUMNS * WIDTH * ZOOM, height: rowsOfCells * HEIGHT * ZOOM, webPreferences: { backgroundThrottling: false, zoomFactor: ZOOM } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const cells = Array.from({ length: CELLS }, () => `<div class='cell' style='width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden'></div>`).join("");
    await win.loadURL(`data:text/html,<html><body style='margin:0;background:%23101018;--surface: %23101018; --fg: %23e8e6f0'><div style='display:grid;grid-template-columns:repeat(${COLUMNS},${WIDTH}px)'>${cells}</div></body></html>`);
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    await js(`window.sent = []; window.tomradeSurface = {send: m => sent.push(m), onMessage: fn => {window.receive = fn; return () => {}}}; void 0;`);
    // The atlas keeps its pages on canvases of its own: their sizes say how far it filled, and whether pages merged.
    await js(`window.canvases = []; const make = document.createElement.bind(document); document.createElement = (tag, ...rest) => {const el = make(tag, ...rest); if (tag === 'canvas') canvases.push(el); return el;}; void 0;`);
    await js(bundle.outputFiles[0].text + "\nvoid 0;");
    await wait();
    assert.equal(await js("[...document.querySelectorAll('.xterm-screen')].filter(s => s.querySelector('canvas')).length"), CELLS, "every TerminalCell draws with WebGL");
    const grids = await js(`sent.filter(m => m.type === 'attach').map(m => ({cell: m.cell, cols: m.cols, rows: m.rows}))`);
    assert.equal(grids.length, CELLS);

    let seq = 0;
    const frame = (cell, bytes) => js(`receive({type:'frame',cell:${JSON.stringify(cell)},seq:${++seq},bytes:${JSON.stringify(bytes)}}); void 0;`);
    // A write that changes nothing still draws its terminal again, from the atlas as it is by then.
    const settle = async () => {
      for (const g of grids) await frame(g.cell, "\x1b[H");
      await wait();
    };
    const shot = async () => {
      const image = await win.webContents.capturePage();
      return { bitmap: image.toBitmap(), width: image.getSize().width, scale: image.getSize().width / (COLUMNS * WIDTH) };
    };
    /** Pixels of a cell that differ between two captures. */
    const changed = (a, b, index) => {
      const left = (index % COLUMNS) * WIDTH * a.scale;
      const top = Math.floor(index / COLUMNS) * HEIGHT * a.scale;
      let count = 0;
      for (let y = top; y < top + HEIGHT * a.scale; y++) {
        for (let x = left; x < left + WIDTH * a.scale; x++) {
          const at = (y * a.width + x) * 4;
          if (Math.abs(a.bitmap[at] - b.bitmap[at]) + Math.abs(a.bitmap[at + 1] - b.bitmap[at + 1]) + Math.abs(a.bitmap[at + 2] - b.bitmap[at + 2]) > 96) count++;
        }
      }
      return count;
    };
    const pages = () => js(`(() => {const sizes = {}; for (const c of canvases) if (c.width === c.height && c.width >= 512) sizes[c.width] = (sizes[c.width] ?? 0) + 1; return sizes;})()`);
    // Every comparison is made before any fails the run: which draws went wrong says where the atlas let a terminal down.
    const failures = [];
    const same = (a, b, what) => {
      const off = grids.map((_, i) => changed(a, b, i));
      if (off.every(n => n === 0)) return console.log("PASS", what);
      failures.push(`${what}: pixels that differ, cell by cell: ${off.join(" ")}`);
      console.log("FAIL", failures.at(-1));
    };

    let code = 0x4e00;
    for (let round = 0; round <= WARM_UPS; round++) {
      for (const g of grids) {
        const s = screen(g.cols, g.rows, code);
        code = s.next;
        await frame(g.cell, s.bytes);
      }
      await wait();
    }
    const made = await pages();
    console.log("atlas pages made, by size:", JSON.stringify(made), "at", grids[0].cols + "x" + grids[0].rows, "cells a terminal, device pixel ratio", await js("devicePixelRatio"));
    assert.ok(Object.keys(made).some(size => Number(size) > 512), "the screens filled the atlas until its pages merged");
    if (process.env.TOMRADE_SHOTS) fs.writeFileSync(`${process.env.TOMRADE_SHOTS}/atlas-drawn.png`, (await win.webContents.capturePage()).toPNG());
    const drawn = await shot();
    await settle();
    const truth = await shot();
    same(drawn, truth, "a screen drawn while the atlas fills is drawn right");

    for (let n = 1; n <= RETURNS; n++) {
      await js("window.dispatchEvent(new Event('focus')); void 0;");
      await wait();
      if (process.env.TOMRADE_SHOTS) fs.writeFileSync(`${process.env.TOMRADE_SHOTS}/atlas-return-${n}.png`, (await win.webContents.capturePage()).toPNG());
      same(await shot(), truth, `return ${n} to the window draws every terminal as it was`);
      await settle();
      same(await shot(), truth, `after return ${n}, the next frame of each terminal draws it as it was`);
    }
    await js("roots.forEach(root => root.unmount())");
    assert.deepEqual(failures, [], "every draw matches the terminal's screen");
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    win.destroy(); app.exit(process.exitCode ?? 0);
  }
});
