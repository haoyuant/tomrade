// Real TerminalCell on a clear terminal: dim and italic cells stay see-through, inverse text stays light (patches/@xterm__addon-webgl).
// Run: pnpm --filter @tomrade/desktop exec electron scripts/terminal-clear-check.mjs
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../packages/ui/package.json", import.meta.url));
const { build } = createRequire(require.resolve("vite"))("esbuild");
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {TerminalCell} from './src/code-sessions/TerminalCell';
      window.root = createRoot(document.getElementById('term'));
      root.render(React.createElement(TerminalCell, {cell:'c1', sessionId:'s1', pane:'p1', tokens:{}, font:'', labels:{}, autoFocus:false, clear:true}));`,
    resolveDir: fileURLToPath(new URL("../../../packages/ui/", import.meta.url)), loader: "tsx"
  },
  bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' }
});

const PAGE = "#f6dcd0";
const ROWS = [["plain", "0"], ["dim", "2"], ["italic", "3"], ["inverse", "7"]];
const GAP_COLUMN = 5;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 400, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await win.loadURL(`data:text/html,<html><body style='margin:0;background:${encodeURIComponent(PAGE)};--surface: %23ffffff; --fg: %23201a18'><div id='term' style='width:700px;height:300px'></div></body></html>`);
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    await js(`window.sent = []; window.tomradeSurface = {send: m => sent.push(m), onMessage: fn => {window.receive = fn; return () => {}}}; void 0;`);
    await js(bundle.outputFiles[0].text + "\nvoid 0;");
    await wait();
    assert.ok(await js("!!document.querySelector('.xterm-screen > canvas')"), "TerminalCell draws with WebGL");
    const bytes = "\x1b[?25l\x1b[2J\x1b[H" + ROWS.map(([, sgr]) => `\x1b[${sgr}mab        cd\x1b[0m`).join("\r\n");
    await js(`receive({type:'frame',cell:'c1',bytes:${JSON.stringify(bytes)}})`);
    await wait();
    const box = await js(`(() => {const r = document.querySelector('.xterm-screen').getBoundingClientRect(); const a = sent.find(m => m.type === 'attach'); return {x:r.x, y:r.y, w:r.width/a.cols, h:r.height/a.rows};})()`);
    const image = await win.webContents.capturePage();
    const { width } = image.getSize();
    const bitmap = image.toBitmap();
    const scale = width / win.getContentSize()[0];
    const pixel = (x, y) => {
      const at = (Math.round(y * scale) * width + Math.round(x * scale)) * 4;
      return [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
    };
    const hex = (rgb) => `#${rgb.map(v => v.toString(16).padStart(2, "0")).join("")}`;
    const gap = (row) => hex(pixel(box.x + box.w * (GAP_COLUMN + .5), box.y + box.h * (row + .5)));
    for (const row of [0, 1, 2]) {
      assert.equal(gap(row), PAGE, `${ROWS[row][0]} cells leave the page showing`);
      console.log("PASS", ROWS[row][0], "cells leave the page showing");
    }
    assert.equal(gap(3), "#201a18", "inverse cells are filled with the text colour");
    console.log("PASS inverse cells are filled with the text colour");
    let brightest = 0;
    for (let y = box.y + box.h * 3; y < box.y + box.h * 4; y += .5) for (let x = box.x; x < box.x + box.w * 2; x += .5) brightest = Math.max(brightest, pixel(x, y)[1]);
    assert.ok(brightest > 200, `inverse text is drawn in the surface colour, brightest ${brightest}`);
    console.log("PASS inverse text is drawn in the surface colour");
    await js("root.unmount()");
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    win.destroy(); app.exit(process.exitCode ?? 0);
  }
});
