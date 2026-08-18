// UI regression: legacy board interactions must keep working —
// drag ticket across columns (dnd-kit), reorder, open detail,
// create/undo, epic filter. Drives the REAL UI over the dev server
// with mock IPC so behavior is deterministic and offline.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
app.setPath('userData', '/tmp/tomrade-ui-regression');
const preload = path.join(__dirname, '../dist/preload.cjs');
const DEV_URL = process.env.TOMRADE_DEV_URL || 'http://127.0.0.1:5173/';

let seq = 0;
const items = [];
function add(partial) {
  seq += 1;
  const item = { id: 'mock-' + seq, projectId: 'default', title: partial.title, body: null, kind: partial.kind || 'ticket', status: partial.status || 'backlog', parentId: partial.parentId || null, rank: partial.rank ?? 0, updatedAt: Date.now(), updatedBy: 'human', version: 1, humanLocked: false, ...partial };
  items.push(item);
  return item;
}
const epic = add({ title: 'Reporting', kind: 'epic' });
add({ title: 'Export report as PDF', parentId: epic.id, rank: 0 });
add({ title: 'Schedule recurring reports', parentId: epic.id, rank: 1 });

const calls = { update: [], create: [], remove: [], undo: [], projectsCreate: [] };
const projects = [{ id: 'default', name: 'Default Project', description: null, createdAt: Date.now(), updatedAt: Date.now() }];
const results = [];
function check(name, cond) { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS' : 'FAIL') + ': ' + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  ipcMain.handle('tomrade:list', () => items.map((i) => ({ ...i })));
  ipcMain.handle('tomrade:get', (_e, id) => items.find((i) => i.id === id) ?? null);
  ipcMain.handle('tomrade:create', (_e, input) => { calls.create.push(input); return add({ title: input.title, kind: input.kind, parentId: input.parentId }); });
  ipcMain.handle('tomrade:update', (_e, id, patch, baseVersion) => {
    calls.update.push({ id, patch, baseVersion });
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error('not found');
    Object.assign(item, patch, { version: item.version + 1, updatedBy: 'human', updatedAt: Date.now() });
    return { ...item };
  });
  ipcMain.handle('tomrade:delete', (_e, id) => { calls.remove.push(id); const idx = items.findIndex((i) => i.id === id); if (idx >= 0) items.splice(idx, 1); });
  ipcMain.handle('tomrade:undo', () => { calls.undo.push(1); return null; });
  ipcMain.handle('tomrade:recentOplog', () => []);
  ipcMain.handle('tomrade:projects:list', () => projects.map((p) => ({ ...p })));
  ipcMain.handle('tomrade:projects:create', (_e, input) => { calls.projectsCreate.push(input); const p = { id: 'p-' + (projects.length + 1), name: input.name, description: null, createdAt: Date.now(), updatedAt: Date.now() }; projects.push(p); return p; });
  ipcMain.handle('tomrade:projects:remove', (_e, id) => { const i = projects.findIndex((p) => p.id === id); if (i >= 0) projects.splice(i, 1); });
  ipcMain.handle('tomrade:settings:get', () => ({ llm: { apiKey: '', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' }, theme: 'system' }));
  ipcMain.handle('tomrade:mcpUrl', () => 'http://127.0.0.1:19090/mcp');
  ipcMain.handle('tomrade:settings:set', (_e, s) => s);
  ipcMain.handle('tomrade:ai:chat', async () => ({ kind: 'text', reply: 'ok' }));
  ipcMain.handle('tomrade:ai:extract', () => ({ candidates: [], dedup: {} }));
  ipcMain.handle('tomrade:ai:gap', () => []);
  ipcMain.handle('tomrade:ai:createFromCandidate', (_e, c) => add({ title: c.title, kind: c.kind }));

  const win = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { preload, contextIsolation: true, sandbox: true } });
  await win.loadURL(DEV_URL);
  await sleep(4000);

  // 0. home grid renders project cards; click into the project
  await sleep(500);
  const gridCards = await win.webContents.executeJavaScript("[...document.querySelectorAll('main h3')].map((h) => h.textContent)");
  check('home grid shows projects', gridCards.length >= 1 && gridCards.includes('Default Project'));
  await win.webContents.executeJavaScript("[...document.querySelectorAll('main h3')].find((h) => h.textContent === 'Default Project')?.parentElement?.parentElement?.click()");
  await sleep(1200);

  const COL_QUERY = "[...document.querySelectorAll('.board-scroll > div')].map((c) => ({ header: c.querySelector('h2')?.textContent, cards: c.querySelectorAll('.cursor-grab').length }))";
  const colInfo = await win.webContents.executeJavaScript(COL_QUERY);
  check('six columns render', colInfo.length === 6);
  check('columns are Backlog..Cancelled', colInfo.map((c) => c.header).join(',') === 'Backlog,To Do,Doing,Verifying,Done,Cancelled');
  check('backlog has 2 tickets initially', colInfo.find((c) => c.header === 'Backlog')?.cards === 2);

  // drag first backlog card -> To Do column
  const coords = await win.webContents.executeJavaScript("(() => { const cols = [...document.querySelectorAll('.board-scroll > div')]; const card = cols[0].querySelector('.cursor-grab'); const target = cols[1]; if (!card) return null; const r1 = card.getBoundingClientRect(); const r2 = target.getBoundingClientRect(); return { from: { x: r1.x + r1.width / 2, y: r1.y + r1.height / 2 }, to: { x: r2.x + r2.width / 2, y: r2.y + 30 } }; })()");
  if (coords) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: coords.from.x, y: coords.from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i += 1) {
      const t = i / 12;
      win.webContents.sendInputEvent({ type: 'mouseMove', x: coords.from.x + (coords.to.x - coords.from.x) * t, y: coords.from.y + (coords.to.y - coords.from.y) * t, button: 'left', buttons: 1 });
      await sleep(20);
    }
    await sleep(150);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: coords.to.x, y: coords.to.y, button: 'left', clickCount: 1 });
    await sleep(1500);
  }
  const dragUpdate = calls.update.find((c) => c.patch && c.patch.status === 'todo');
  check('drag issued update with status todo', !!dragUpdate);
  check('drag update carried rank', dragUpdate && typeof dragUpdate.patch.rank === 'number');
  const afterDrag = await win.webContents.executeJavaScript(COL_QUERY);
  check('todo column now has 1 card', afterDrag.find((c) => c.header === 'To Do')?.cards === 1);
  check('backlog column now has 1 card', afterDrag.find((c) => c.header === 'Backlog')?.cards === 1);

  // card click opens detail
  await win.webContents.executeJavaScript("document.querySelector('.board-scroll .cursor-grab')?.click()");
  await sleep(600);
  const detailOpen = await win.webContents.executeJavaScript("!!document.querySelector('input[placeholder=\"Title\"]') && document.body.textContent.includes('v1')");
  check('card click opens detail modal', detailOpen);

  // create via + Ticket button
  await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Ticket') && b.textContent.includes('+') === false && b.textContent.trim().startsWith('Ticket'))?.click()");
  await sleep(400);
  await win.webContents.executeJavaScript("(() => { const input = document.querySelector('input[placeholder*=\"Ticket title\"]'); if (input) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(input, 'Dark mode toggle'); input.dispatchEvent(new Event('input', { bubbles: true })); } [...document.querySelectorAll('button')].find((b) => b.textContent === 'Create')?.click() })()");
  await sleep(900);
  check('create button issued create call', calls.create.length === 1 && calls.create[0].title === 'Dark mode toggle');
  const backlogNow = await win.webContents.executeJavaScript("document.querySelectorAll('.board-scroll > div')[0].querySelectorAll('.cursor-grab').length");
  check('new ticket appears in backlog', backlogNow === 2);

  // undo
  await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Undo'))?.click()");
  await sleep(600);
  check('undo button issued undo call', calls.undo.length >= 1);

  // epic filter
  await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Reporting'))?.click()");
  await sleep(600);
  const filteredBacklog = await win.webContents.executeJavaScript("document.querySelectorAll('.board-scroll > div')[0].querySelectorAll('.cursor-grab').length");
  check('epic filter narrows the board', filteredBacklog <= 2);

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log('==== UI REGRESSION ' + (failed.length === 0 ? 'PASSED' : failed.length + ' FAILED') + ' (' + results.length + ' checks) ====');
  const img = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/ui-regression-final.png', img.toPNG());
  app.exit(failed.length === 0 ? 0 : 1);
});