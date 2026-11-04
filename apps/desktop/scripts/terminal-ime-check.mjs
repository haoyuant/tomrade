// Real TerminalCell + xterm in a pane: an IME composing at the right edge must not slide the pane sideways.
// Run: pnpm --filter @tomrade/desktop exec electron scripts/terminal-ime-check.mjs
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
const css = (path) => fs.readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  try {
    // The Terminal window's own pane markup and stylesheet around the cell.
    await win.loadURL("data:text/html,<html><body style='--surface:white;--fg:black'><div class='cs-cell' style='width:700px;height:400px'><div class='cs-cell-bar'><span class='cs-cell-no'>1</span><span class='cs-cell-name'>pane</span></div><div id='term' style='flex:1;min-height:0;display:flex'></div></div></body></html>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    await win.webContents.insertCSS(css("../../../packages/ui/src/code-sessions/code-sessions.css"));
    await js(`window.sent = []; window.tomradeSurface = {send: m => sent.push(m), onMessage: fn => {window.receive = fn; return () => {}}}; void 0;`);
    await js(bundle.outputFiles[0].text);
    for (let i = 0; i < 50 && !await js(`sent.some(m => m.type === 'attach')`); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const { cols } = await js(`sent.find(m => m.type === 'attach')`);
    // The program's cursor near the right edge, as at the end of a long line in an agent's input box.
    await js(`receive({type:'frame',cell:'c1',bytes:${JSON.stringify(`\x1b[5;${cols - 2}H`)}}); void 0;`);
    await new Promise(resolve => setTimeout(resolve, 40));
    win.webContents.focus();
    await js(`document.querySelector('.xterm-helper-textarea').focus(); void 0;`);
    const ime = win.webContents.debugger;
    ime.attach("1.3");
    const text = "zhegewentiyijingjiejuelema";
    await ime.sendCommand("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await new Promise(resolve => setTimeout(resolve, 100));
    // Where the textarea sits in the pane's own layout, wherever the pane may have scrolled.
    const during = await js(`(() => {const pane = document.querySelector('.cs-cell'), box = document.querySelector('.xterm-helper-textarea').getBoundingClientRect(); return {pane: pane.scrollLeft, right: box.right + pane.scrollLeft - pane.getBoundingClientRect().left, width: pane.clientWidth};})()`);
    assert(during.right > during.width, `the composition runs past the pane's right edge (${during.right} > ${during.width})`);
    assert.equal(during.pane, 0, "the pane does not slide while the IME composes past its edge");
    await ime.sendCommand("Input.insertText", { text: "这个问题" });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js(`document.querySelector('.cs-cell').scrollLeft`), 0, "nor once the text is committed");
    await js(`document.querySelector('.cs-cell').scrollLeft = 40; void 0;`);
    assert.equal(await js(`document.querySelector('.cs-cell').scrollLeft`), 0, "a script cannot scroll a pane either");
    console.log("PASS an IME composing past the right edge leaves the pane where it is");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ?? 0);
  }
});
