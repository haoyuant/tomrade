// Run: pnpm --filter @tomrade/desktop exec electron scripts/terminal-folder-check.mjs
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../packages/ui/package.json", import.meta.url));
const { build } = createRequire(require.resolve("vite"))("esbuild");
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {NewTerminal} from './src/code-sessions/NewTerminal';
      const root = createRoot(document.getElementById('root'));
      window.opened = [];
      window.render = (props) => root.render(React.createElement(NewTerminal, {key: props.initial ?? 'empty', ready:true, onOpen: cwd => opened.push(cwd), ...props}));`,
    resolveDir: fileURLToPath(new URL("../../../packages/ui/", import.meta.url)), loader: "tsx"
  },
  bundle: true, write: false, format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }
});

app.whenReady().then(async () => {
  let chosen = null;
  const calls = [];
  ipcMain.handle("tomrade:shell.pickDirectory", (_event, ...args) => { calls.push(args); return chosen; });
  const win = new BrowserWindow({ show: false, webPreferences: { preload: fileURLToPath(new URL("../surface-preload.cjs", import.meta.url)), backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async code => {
    const until = Date.now() + 5000;
    while (!(await js(code))) {
      assert.ok(Date.now() < until, `Timed out: ${code}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await win.loadURL("data:text/html,<html><body><div id='root'></div></body></html>");
    await js(bundle.outputFiles[0].text + "\nvoid 0;");
    await js(`render({places:[{label:'tomrade',cwd:'/repos/tomrade'},{label:'plugins',cwd:'/repos/plugins'}]}); void 0;`);
    await waitFor(`document.querySelector('select')?.value === '/repos/tomrade'`);
    chosen = "/tmp/其他 folder";
    await js(`document.querySelector('[data-testid=cs-browse-folder]').click(); void 0;`);
    await waitFor(`document.querySelector('select').value === '/tmp/其他 folder' && !document.querySelector('[data-testid=cs-browse-folder]').disabled`);
    assert.deepEqual(calls[0], ["Choose a terminal folder", "Use this folder"]);
    await js(`document.querySelector('[data-testid=cs-new-terminal]').click(); void 0;`);
    assert.deepEqual(await js("opened"), [chosen]);
    chosen = null;
    await js(`document.querySelector('[data-testid=cs-browse-folder]').click(); void 0;`);
    await waitFor(`!document.querySelector('[data-testid=cs-browse-folder]').disabled`);
    assert.equal(await js("document.querySelector('select').value"), "/tmp/其他 folder");
    await js(`const select = document.querySelector('select'); select.value='/repos/plugins'; select.dispatchEvent(new Event('change',{bubbles:true})); void 0;`);
    await waitFor(`document.querySelector('select').value === '/repos/plugins'`);
    await js(`document.querySelector('[data-testid=cs-new-terminal]').click(); void 0;`);
    assert.equal(await js("opened.at(-1)"), "/repos/plugins");
    await js(`render({initial:'/session/worktree',places:[]}); void 0;`);
    await waitFor(`document.querySelector('select').value === '/session/worktree'`);
    await js(`document.querySelector('[data-testid=cs-new-terminal]').click(); void 0;`);
    assert.equal(await js("opened.at(-1)"), "/session/worktree");
    console.log("PASS: project default, native picker bridge, custom path, cancel, switching repo, session folder");
  } finally {
    win.destroy();
  }
}).then(() => app.quit(), error => { console.error(error); app.exit(1); });
