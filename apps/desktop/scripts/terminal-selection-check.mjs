// Real xterm + browser mouse selection, with TUI repaints and no herdr scroll notification.
// Run: pnpm --filter @tomrade/desktop exec electron scripts/terminal-selection-check.mjs
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(new URL("../../../packages/ui/package.json", import.meta.url));
const xterm = fs.readFileSync(require.resolve("@xterm/xterm"), "utf8");
const source = fs.readFileSync(new URL("../../../packages/ui/src/code-sessions/selection.ts", import.meta.url), "utf8");
const follower = ts.transpile(source.replace("export function", "function"), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }).replace(/export \{\};?/, "");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadURL("data:text/html,<html><body><div id='term'></div></body></html>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    await win.webContents.executeJavaScript(xterm);
    await win.webContents.executeJavaScript(`(async () => { ${follower}
      window.term = new Terminal({cols: 60, rows: 12, scrollback: 0});
      term.open(document.getElementById('term'));
      window.follower = followSelection(term, document.getElementById('term'));
      window.paintRows = async (rows) => {
        await new Promise(resolve => term.write(rows.map((text, y) => '\\x1b[' + (y + 1) + ';1H\\x1b[2K' + text).join(''), resolve));
        await new Promise(resolve => setTimeout(resolve, 60));
      };
      window.paint = (offset) => paintRows(['Fixed header', ...Array.from({length: 9}, (_, i) => 'Body line ' + (offset + i)), 'Fixed input', 'Fixed status']);
      window.copy = () => {
        const data = new DataTransfer();
        document.getElementById('term').dispatchEvent(new ClipboardEvent('copy', {clipboardData: data, bubbles: true, cancelable: true}));
        return data.getData('text/plain');
      };
      await paint(0);
    })()`);
    const js = (code) => win.webContents.executeJavaScript(code);
    const box = await js(`(() => { const r = document.querySelector('.xterm-screen').getBoundingClientRect(); return {x:r.x, y:r.y, w:r.width/60, h:r.height/12}; })()`);
    const mouse = (type, col, row) => win.webContents.sendInputEvent({ type, x: Math.round(box.x + box.w * col), y: Math.round(box.y + box.h * (row + .5)), button: "left", clickCount: 1 });
    const select = async (col, row, endCol, endRow) => {
      mouse("mouseDown", col, row);
      mouse("mouseMove", endCol, endRow);
      mouse("mouseUp", endCol, endRow);
      await new Promise(resolve => setTimeout(resolve, 100));
      return js("term.getSelection()");
    };
    async function check(label, expression) {
      if (!await js(expression)) throw new Error(label + ': ' + JSON.stringify(await js("({selection:term.getSelection(), position:term.getSelectionPosition(), copied:copy()})")));
      console.log("PASS", label);
    }
    const picked = await select(0, 4, 12, 6);
    if (!picked.includes("Body line 3") || !picked.includes("Body line 5")) throw new Error(`Mouse selection failed: ${JSON.stringify(picked)}`);
    await js("paint(2)");
    await check("TUI body moves, fixed header/footer and unchanged scroll offset", `term.getSelectionPosition()?.start.y === 2 && copy() === ${JSON.stringify(picked)}`);
    await js("paint(5)");
    await check("partly hidden behind fixed header", `term.getSelection() === 'Body line 5' && copy() === ${JSON.stringify(picked)}`);
    await js("paint(-5)");
    await check("partly hidden behind fixed input/footer", `term.getSelection().trim() === 'Body line 3' && copy() === ${JSON.stringify(picked)}`);
    await js("paint(20)");
    await check("fully hidden: no highlight, original clipboard", `!term.hasSelection() && copy() === ${JSON.stringify(picked)}`);
    await js("paint(0)");
    await check("scroll back restores highlight", `term.getSelectionPosition()?.start.y === 4 && copy() === ${JSON.stringify(picked)}`);
    await js("paintRows(['Body line 3', 'Body line 4', 'Body line 5', '', 'Body line 3', 'Body line 4', 'Body line 5', '', '', '', '', ''])");
    await check("ambiguous repeated text is not highlighted", `!term.hasSelection() && copy() === ${JSON.stringify(picked)}`);
    mouse("mouseDown", 0, 11);
    mouse("mouseUp", 0, 11);
    await js("paint(0)");
    await check("a fresh click cancels an offscreen selection", "!term.hasSelection() && copy() === ''");
    await js("paintRows(['Header', '中文选区和滚动', '', '', '', '', '', '', '', '', '', 'Footer'])");
    const chinese = await select(2, 1, 8, 1);
    if (chinese !== "文选区") throw new Error(`Wide-character fixture: ${chinese}`);
    await js("paintRows(['Header', '', '', '中文选区和滚动', '', '', '', '', '', '', '', 'Footer'])");
    await check("partial columns use terminal cells, including wide characters", `term.getSelection() === ${JSON.stringify(chinese)} && term.getSelectionPosition()?.start.y === 3 && copy() === ${JSON.stringify(chinese)}`);
    await js("follower.dispose()");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
