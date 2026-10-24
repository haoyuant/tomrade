// Real TerminalCell + xterm: keep the pointer location and page-key identity across the surface boundary.
// Run: pnpm --filter @tomrade/desktop exec electron scripts/terminal-scroll-check.mjs
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
      createRoot(document.getElementById('term')).render(React.createElement(TerminalCell,
        {cell:'c1', sessionId:'s1', pane:'p1', tokens:{}, font:'', labels:{}, autoFocus:true}));`,
    resolveDir: fileURLToPath(new URL("../../../packages/ui/", import.meta.url)), loader: "tsx"
  },
  bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' }
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL("data:text/html,<html><body style='--surface:white;--fg:black'><div id='term' style='width:700px;height:400px'></div></body></html>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    await js(`window.sent = []; window.tomradeSurface = {send: m => sent.push(m), onMessage: fn => {window.receive = fn; return () => {}}}; void 0;`);
    await js(bundle.outputFiles[0].text);
    for (let i = 0; i < 50 && !await js(`sent.some(m => m.type === 'attach')`); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(await js(`sent.some(m => m.type === 'attach')`), "terminal attached");
    await js(`window.dimensions = sent.find(m => m.type === 'attach'); window.screenBox = () => {const r = document.querySelector('.xterm-screen').getBoundingClientRect(); const s = dimensions; return {x:r.x, y:r.y, cw:r.width/s.cols, ch:r.height/s.rows, cols:s.cols, rows:s.rows}};
      window.wheel = (column, row, deltaY) => {const b = screenBox(); document.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel', {clientX:b.x+(column+.5)*b.cw, clientY:b.y+(row+.5)*b.ch, deltaY, bubbles:true, cancelable:true}));}; void 0;`);
    // Codex owns the screen and ignores wheel events outside its transcript, including (0,0).
    for (const modes of ["", "\x1b[?1049h\x1b[?1000h\x1b[?1006h"]) {
      await js(`receive({type:'frame',cell:'c1',bytes:${JSON.stringify(modes)}}); void 0;`);
      await new Promise(resolve => setTimeout(resolve, 40));
      await js(`sent.length = 0; wheel(20, 8, -120); void 0;`);
      const messages = await js(`sent.filter(m => m.type === 'scroll')`);
      assert.equal(messages.length, 1, "one scroll per wheel");
      assert.equal(messages[0].column, 20, "wheel column reaches the application");
      assert.equal(messages[0].row, 8, "wheel row reaches the transcript");
      assert.equal(messages[0].direction, "up");
      assert.equal(messages[0].lines, 6);
      assert(!await js(`sent.some(m => m.type === 'input')`), "xterm does not also send arrow keys");
    }
    console.log("PASS shell and mouse-reporting TUI receive the wheel's cell coordinates");
    await js(`sent.length = 0; document.querySelector('.xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'PageUp',keyCode:33,bubbles:true,cancelable:true})); void 0;`);
    const page = await js(`sent.find(m => m.type === 'scroll')`);
    assert.equal(page?.source, "page_key", "herdr must route PageUp as a key for full-screen apps");
    assert.equal(page.direction, "up");
    await js(`sent.length = 0; document.querySelector('.xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'PageDown',keyCode:34,bubbles:true,cancelable:true})); void 0;`);
    assert.deepEqual(await js(`sent.filter(m => m.type === 'scroll').map(m => [m.source, m.direction])`), [["page_key", "down"]]);
    console.log("PASS PageUp and PageDown keep their identity instead of becoming wheels at (0,0)");
    await js(`sent.length = 0; wheel(20,8,0); void 0;`);
    assert.equal(await js(`sent.filter(m => m.type === 'scroll').length`), 0, "horizontal-only gestures do not scroll down");
    await js(`receive({type:'scrolled',cell:'c1',offset:0,max:200,rows:dimensions.rows}); void 0;`);
    await new Promise(resolve => setTimeout(resolve, 40));
    await js(`document.querySelector('.cs-scrollbar').dispatchEvent(new WheelEvent('wheel', {deltaY:120,bubbles:true,cancelable:true})); void 0;`);
    const barWheel = await js(`sent.find(m => m.type === 'scroll')`);
    assert.equal(barWheel.column, Math.floor((await js(`dimensions.cols`)) / 2));
    assert.equal(barWheel.row, Math.floor((await js(`dimensions.rows`)) / 2));
    console.log("PASS scrollbar wheel targets the terminal body, and zero vertical movement is ignored");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ?? 0);
  }
});
