// Real xterm + browser mouse selection, with TUI repaints and no herdr scroll notification.
// Run: pnpm --filter @tomrade/desktop exec electron scripts/terminal-selection-check.mjs
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(new URL("../../../packages/ui/package.json", import.meta.url));
const xterm = fs.readFileSync(require.resolve("@xterm/xterm"), "utf8");
const source = fs.readFileSync(new URL("../../../packages/ui/src/code-sessions/selection.ts", import.meta.url), "utf8");
const follower = ts.transpile(source.replace(/export (function|const)/g, "$1"), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }).replace(/export \{\};?/, "");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadURL("data:text/html,<html><body><div id='term'></div></body></html>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    await win.webContents.executeJavaScript(xterm);
    await win.webContents.executeJavaScript(`(async () => { ${follower}
      window.term = new Terminal({cols: 60, rows: 12, scrollback: 0, wordSeparator});
      term.open(document.getElementById('term'));
      window.offset = 0;
      window.follower = followSelection(term, document.getElementById('term'), (direction, lines) => paint(offset + (direction === 'up' ? -lines : lines)));
      window.paintRows = async (rows) => {
        await new Promise(resolve => term.write(rows.map((text, y) => '\\x1b[' + (y + 1) + ';1H\\x1b[2K' + text).join(''), resolve));
        await new Promise(resolve => setTimeout(resolve, 60));
      };
      window.paint = (offset) => (window.offset = offset, paintRows)(['Fixed header', ...Array.from({length: 9}, (_, i) => 'Body line ' + (offset + i)), 'Fixed input', 'Fixed status']);
      window.copy = () => {
        const data = new DataTransfer();
        document.getElementById('term').dispatchEvent(new ClipboardEvent('copy', {clipboardData: data, bubbles: true, cancelable: true}));
        return data.getData('text/plain');
      };
      await paint(0);
    })()`);
    const js = (code) => win.webContents.executeJavaScript(code);
    const box = await js(`(() => { const r = document.querySelector('.xterm-screen').getBoundingClientRect(); return {x:r.x, y:r.y, w:r.width/60, h:r.height/12}; })()`);
    const mouse = (type, col, row, clickCount = 1) => win.webContents.sendInputEvent({ type, x: Math.round(box.x + box.w * col), y: Math.round(box.y + box.h * (row + .5)), button: "left", clickCount, modifiers: type === "mouseUp" ? [] : ["leftButtonDown"] });
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
    await js("paintRows(Array.from({length: 12}, (_, i) => 'shell line ' + (40 + i)))");
    const shellPicked = await select(0, 4, 5, 4);
    await js("paintRows(Array.from({length: 12}, (_, i) => 'shell line ' + (38 + i)))");
    await check("shell scroll keeps a common word anchored to its original row", `term.getSelectionPosition()?.start.y === 6 && copy() === ${JSON.stringify(shellPicked)}`);
    await js("paintRows(Array.from({length: 12}, (_, i) => 'shell line ' + (60 + i)))");
    await check("repeated words alone remain ambiguous offscreen", `!term.hasSelection() && copy() === ${JSON.stringify(shellPicked)}`);
    await js("paintRows(Array.from({length: 12}, (_, i) => 'shell line ' + (40 + i)))");
    await check("scroll back restores the short shell selection", `term.getSelectionPosition()?.start.y === 4 && term.getSelection() === ${JSON.stringify(shellPicked)}`);
    await js("paintRows(['', '', 'shell changed outside the selection', '', '', '', '', '', '', '', '', ''])");
    await check("unique selected text still follows when unselected context changes", `term.getSelectionPosition()?.start.y === 2 && copy() === ${JSON.stringify(shellPicked)}`);
    const body = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => "Body line " + (from + i)).join("\n");
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    await js("paint(0)");
    mouse("mouseDown", 0, 4);
    mouse("mouseMove", 12, 6);
    await js("paint(2)");
    await check("held: the start stays on its text, the end under the pointer", `term.getSelectionPosition()?.start.y === 2 && term.getSelection() === ${JSON.stringify(body(3, 7))}`);
    await js("paint(6)");
    await check("held: the start scrolls out of view, and stays in the copy", `term.getSelection() === ${JSON.stringify(body(6, 11))} && copy() === ${JSON.stringify(body(3, 11))}`);
    mouse("mouseMove", 5, 8);
    mouse("mouseUp", 5, 8);
    await wait(100);
    await check("held: the pointer moves the end after a scroll", `copy() === ${JSON.stringify(body(3, 12) + "\nBody ")}`);
    await js("paint(0)");
    await check("released: the dragged selection follows like any other", `term.getSelectionPosition()?.start.y === 4 && term.getSelection() === ${JSON.stringify(body(3, 8))} && copy() === ${JSON.stringify(body(3, 12) + "\nBody ")}`);
    mouse("mouseDown", 0, 4);
    mouse("mouseMove", 3, 13);
    await wait(500);
    mouse("mouseUp", 3, 13);
    await wait(150);
    const reached = await js("offset");
    if (reached < 2) throw new Error(`Pointer below the terminal did not scroll: ${reached}`);
    // A release between a scroll and its frame leaves the end one step short of the last body row.
    const down = await js("copy()");
    const last = Number(down.split("\n").at(-1).slice(10));
    if (down !== body(3, last) || last < reached + 6 || last > reached + 8) throw new Error(`Pointer below the terminal selected ${JSON.stringify(down)} at offset ${reached}`);
    console.log("PASS", "pointer below the terminal scrolls and selects down to the last body row");
    await wait(300);
    await check("released: the scrolling stops", `offset === ${reached}`);
    mouse("mouseDown", 6, 5);
    mouse("mouseMove", 3, -2);
    await wait(500);
    mouse("mouseUp", 3, -2);
    await wait(150);
    const back = await js("offset");
    if (back >= reached) throw new Error(`Pointer above the terminal did not scroll: ${back}`);
    const up = await js("copy()");
    const first = Number(up.split("\n")[0].slice(10));
    if (up !== body(first, reached + 3) + "\nBody l" || first < back || first > back + 2) throw new Error(`Pointer above the terminal selected ${JSON.stringify(up)} at offset ${back}`);
    console.log("PASS", "pointer above the terminal scrolls and selects up to the first body row");
    const word = async (col, row) => {
      for (const clicks of [1, 2]) {
        mouse("mouseDown", col, row, clicks);
        mouse("mouseUp", col, row, clicks);
      }
      await wait(100);
      return js("term.getSelection()");
    };
    await js("paintRows(['- 编辑和保存：可以直接改文件、多光标（Cmd-D）。离开', 'Monaco 之外，还加了 Solidity、Typst、Nim 等。', 'see packages/ui/src/a.ts:12 and https://tomrade.com/a?b=1 now', '', '', '', '', '', '', '', '', ''])");
    for (const [col, row, expected] of [[5.5, 0, "编辑和保存"], [20.5, 0, "可以直接改文件"], [40.5, 0, "Cmd-D"], [32.5, 1, "Typst"], [10, 2, "packages/ui/src/a.ts:12"], [40, 2, "https://tomrade.com/a?b=1"]]) {
      const got = await word(col, row);
      if (got !== expected) throw new Error(`Double-click selected ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`);
      console.log("PASS", "double-click selects", expected);
    }
    await js("follower.dispose()");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
