// Real TerminalCell, xterm hit testing and mouse activation, with the surface boundary recorded.
// Run: pnpm --filter @tomrade/desktop exec electron scripts/terminal-links-check.mjs
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
      root.render(React.createElement(TerminalCell, {cell:'c1', sessionId:'s1', pane:'p1', tokens:{}, font:'', labels:{}, autoFocus:true}));`,
    resolveDir: fileURLToPath(new URL("../../../packages/ui/", import.meta.url)), loader: "tsx"
  },
  bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' }
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  try {
    await win.loadURL("data:text/html,<html><body style='--surface: white; --fg: black'><div id='term' style='width:700px;height:400px'></div></body></html>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    await js(`window.sent = []; window.tomradeSurface = {send: m => sent.push(m), onMessage: fn => {window.receive = fn; return () => {}}}; window.open = () => {throw Error('unexpected browser window')}; window.confirm = () => {throw Error('unexpected confirmation')}; void 0;`);
    await js(bundle.outputFiles[0].text + "\nvoid 0;");
    await wait();
    assert.ok(await js("sent.some(m => m.type === 'attach')"), "TerminalCell attached");
    const box = await js(`(() => {const r = document.querySelector('.xterm-screen').getBoundingClientRect(); const a = sent.find(m => m.type === 'attach'); return {x:r.x, y:r.y, w:r.width/a.cols, h:r.height/a.rows, cols:a.cols};})()`);
    const mouse = (type, col, row) => win.webContents.sendInputEvent({type, x:Math.round(box.x + box.w * (col + .5)), y:Math.round(box.y + box.h * (row + .5)), button:"left", clickCount:1});
    const click = async (col, row) => {
      mouse("mouseMove", col, row); await wait();
      mouse("mouseDown", col, row); mouse("mouseUp", col, row); await wait();
    };
    const paint = async (bytes) => {await js(`receive({type:'frame',cell:'c1',bytes:${JSON.stringify(bytes)}})`); await wait();};
    const fixtures = [
      ["HTTPS", "https://example.com/docs?q=1&lang=zh#start", "https://example.com/docs?q=1&lang=zh#start"],
      ["localhost HTTP", "http://localhost:5173/callback?code=test", "http://localhost:5173/callback?code=test"],
      ["OSC 8", "\x1b]8;;https://example.com/hidden\x1b\\open docs\x1b]8;;\x1b\\", "https://example.com/hidden"],
      ["file URL", "file:///tmp/report%20draft.pdf", "file:///tmp/report%20draft.pdf"],
      ["OSC 8 file", "\x1b]8;;file:///tmp/report%20draft.pdf\x1b\\open file\x1b]8;;\x1b\\", "file:///tmp/report%20draft.pdf"],
      ["absolute path", "/tmp/report.pdf", "/tmp/report.pdf"],
      ["quoted path", '\"/tmp/report draft.pdf\"', "/tmp/report draft.pdf"],
      ["path with line", "/tmp/report.ts:12:3", "/tmp/report.ts:12:3"],
      ["wide prefix", "中文 /tmp/report.pdf", "/tmp/report.pdf"],
      ["wrapped file URL", "file:///tmp/" + "a".repeat(box.cols) + ".pdf", "file:///tmp/" + "a".repeat(box.cols) + ".pdf"],
      ["wrapped URL", "https://example.com/" + "a".repeat(box.cols), "https://example.com/" + "a".repeat(box.cols)]
    ];
    for (const [label, text, url] of fixtures) {
      await paint("\x1b[2J\x1b[H" + text);
      await js("sent.length = 0");
      await click(label === "wide prefix" ? 8 : 3, label.startsWith("wrapped") ? 1 : 0);
      assert.deepEqual(await js("sent.filter(m => m.type === 'openLink')"), [{type:"openLink", url}], label);
      console.log("PASS", label);
    }
    await paint("\x1b[2J\x1b[Hhttps://example.com/select");
    await js("sent.length = 0");
    mouse("mouseMove", 0, 0); await wait(); mouse("mouseDown", 0, 0); mouse("mouseMove", 15, 0); await wait(); mouse("mouseUp", 15, 0); await wait();
    assert.deepEqual(await js("sent.filter(m => m.type === 'openLink')"), [], "drag selection must not open a URL");
    assert.ok(await js(`(() => { const data = new DataTransfer(); document.querySelector('.cs-term-host').dispatchEvent(new ClipboardEvent('copy', {clipboardData:data, bubbles:true, cancelable:true})); return data.getData('text/plain').includes('example'); })()`), "drag selection remains copyable");
    console.log("PASS drag selection remains copyable without opening a link");
    await paint("\x1b[2J\x1b[Hno link here");
    await js("sent.length = 0"); await click(3, 0);
    assert.deepEqual(await js("sent.filter(m => m.type === 'openLink')"), [], "repaint removes old link");
    console.log("PASS repaint removes old link");
    await js("root.unmount()");
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    win.destroy(); app.exit(process.exitCode ?? 0);
  }
});
