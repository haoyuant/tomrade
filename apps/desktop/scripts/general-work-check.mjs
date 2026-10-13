/** Real renderer + IPC + plugins, isolated from the user's projects.
 * Run after build:backend with the UI dev server running:
 * pnpm --filter @tomrade/desktop exec electron scripts/general-work-check.mjs
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-general-ui-"));
app.setPath("userData", work);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (name, value) => { if (!value) throw new Error(name); console.log(`PASS: ${name}`); };
let ctx;
let win;
const run = async () => {
try {
  ({ ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] }));
  // A playbook of the user's own, the kind a non-coding project adds: it must be a method like the built-in ones.
  const journal = path.join(work, "hub", "playbooks", "journal.daily");
  fs.mkdirSync(journal, { recursive: true });
  fs.writeFileSync(path.join(journal, "SKILL.md"), "---\nname: journal.daily\ntitle: Daily journal\ndescription: Write today's journal entry into Files\nworkTypes: [general]\n---\n\nWrite the entry under journal/, named by today's date.\n");
  ctx.hub.configure(path.join(work, "hub"));
  const project = ctx.projects.create({ name: "General work regression", keyPrefix: "GEN" });
  // A coding agent that starts with no approval and no sandbox, the way Codex does by default.
  ctx.agent.engine({
    id: "unboxed", title: "Unboxed", author: "ai:unboxed", capabilities: ["code"],
    permissionModes: { default: "full-access", choices: [{ value: "full-access", label: "Full access" }, { value: "workspace", label: "Workspace" }] },
    available: async () => ({ ok: true }),
    async turn() { return { stop: "end" }; }
  });
  win = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const errors = [];
  win.webContents.on("console-message", event => { if (event.level === "error") { errors.push(event.message); console.error(event.message); } });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(100); } throw new Error("UI condition timed out"); };
  const has = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const press = selector => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const value = (selector, text, kind = "HTMLInputElement", event = "input") => js(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(${kind}.prototype, 'value').set.call(node, ${JSON.stringify(text)}); node.dispatchEvent(new Event('${event}', { bubbles: true })); return true; })()`);
  await wait(() => has(".proj"));
  await js(`[...document.querySelectorAll('.proj')].find(n => n.textContent.includes('General work regression')).click(); true`);
  await wait(() => has(".qb-add"));
  const viewHash = await js("location.hash");
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true })); true`);
  await wait(() => has("#niWorkType"));
  assert("a workstream without a repository proposes General work", await js(`document.querySelector('#niWorkType').value === 'general' && !!document.querySelector('#niTemplate')`));
  assert("the method list carries the user's own playbooks", await js(`[...document.querySelectorAll('#niTemplate option')].some(o => o.value === 'journal.daily' && o.textContent === 'Daily journal')`));
  await value("#niTemplate", "document.write", "HTMLSelectElement", "change");
  await sleep(100);
  assert("document template supplies a brief", await js(`document.querySelector('#niBody').value.length > 20`));
  await value("#niTitle", "Prepare workshop guide");
  await sleep(100);
  fs.writeFileSync(path.join(work, "creation.png"), (await win.webContents.capturePage()).toPNG());
  await click(".palette.modal .btn-primary");
  await wait(() => Promise.resolve(ctx.items.list({ projectId: project.id }).some(i => i.title === "Prepare workshop guide")));
  const item = ctx.items.list({ projectId: project.id }).find(i => i.title === "Prepare workshop guide");
  assert("UI persists General type and document method", item.workType === "general" && item.playbookId === "document.write");
  await js(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
  await wait(() => has('[data-testid="delivery-panel"]'));
  assert("General offers the same Start button as coding", await has('[data-testid="start-ticket"]'));
  const current = () => ctx.items.get(project.id, item.id);
  await value('[data-testid="delivery-report"]', "The draft needs a human check.", "HTMLTextAreaElement");
  await sleep(100);
  await click('[data-testid="delivery-submit"]');
  await wait(() => has('[data-testid="delivery-changes"]'));
  assert("submission awaits review", current().status === "verifying");
  const delivery = ctx.items.deliveries.active(project.id, item.id).id;
  await click('[data-testid="delivery-changes"]');
  await wait(() => Promise.resolve(current().status === "doing"));
  await value('[data-testid="delivery-report"]', "Revised draft ready for acceptance.", "HTMLTextAreaElement");
  await sleep(100);
  await click('[data-testid="delivery-submit"]');
  await wait(() => has('[data-testid="delivery-accept"]'));
  assert("revision uses the same delivery", ctx.items.deliveries.active(project.id, item.id).id === delivery);
  await click('[data-testid="delivery-accept"]');
  await wait(() => Promise.resolve(current().status === "done"));
  await sleep(200);
  assert("human acceptance records immutable review history", current().evidence.reviews.map(r => r.decision).join() === "changes-requested,accepted");
  await click('[data-testid="delivery-panel"] summary');
  await wait(() => has('[data-testid="delivery-panel"] details[open]'));
  await sleep(100);
  fs.writeFileSync(path.join(work, "accepted.png"), (await win.webContents.capturePage()).toPNG());
  assert("history renders both submissions", await js(`document.querySelector('[data-testid="delivery-panel"]').textContent.includes('Revised draft ready')`));
  assert("General copy has no PR-only kind", !(await js(`document.querySelector('.issue-wrap').textContent.includes('one PR')`)));
  ctx.items.update(project.id, item.id, { status: "todo" }, "human");
  await js(`location.hash = ${JSON.stringify(viewHash)}; true`);
  await wait(() => has(".card"));
  await js(`[...document.querySelectorAll('.card')].find(n => n.textContent.includes('Prepare workshop guide')).click(); true`);
  await wait(() => has('.detail [data-testid="delivery-panel"]'));
  assert("reopened detail pane keeps history without accepting the new delivery", current().status === "todo" && ctx.items.deliveries.active(project.id, item.id).sequence === 2 && !(await has('[data-testid="delivery-accept"]')));
  await click('.detail [data-testid="start-ticket"]');
  await wait(() => has('[data-testid="start-dialog"]'));
  assert("Start dialog offers where, agent and method", await js(`document.querySelectorAll('[data-testid="start-mode"] button').length === 2 && !!document.querySelector('#stEngine') && !!document.querySelector('#stMethod')`));
  await wait(() => js(`document.querySelector('[data-testid="start-recommendation"]').textContent.length > 0 && !document.querySelector('[data-testid="start-recommendation"]').textContent.includes('Asking')`));
  assert("the ticket's method is preselected, with the recommendation beside it", await js(`document.querySelector('#stMethod').value === 'document.write' && !document.querySelector('#stMethod').disabled && document.querySelector('[data-testid="start-recommendation"]').dataset.recommended === 'document.write'`));
  assert("the method list holds methods for work, not the assistant's own playbooks", await js(`(() => { const ids = [...document.querySelectorAll('#stMethod option')].map(o => o.value); return ids.includes('journal.daily') && !ids.includes('app.guide') && !ids.some(id => id.startsWith('studio.')); })()`));
  assert("the chosen method says what it does, in words, not its id", await js(`(() => { const o = document.querySelector('#stMethod option:checked'); const when = document.querySelector('[data-testid="start-method-when"]')?.textContent ?? ''; return o.textContent === 'Document' && when.startsWith('Writes or revises a document'); })()`));
  await value("#stMethod", "task.assist", "HTMLSelectElement", "change");
  await wait(() => has('[data-testid="start-use-recommendation"]'));
  assert("a human choice of method wins, and the recommendation is one click away", await js(`document.querySelector('#stMethod').value === 'task.assist'`));
  await click('[data-testid="start-use-recommendation"]');
  await wait(() => js(`document.querySelector('#stMethod').value === 'document.write'`));
  assert("taking the recommendation switches the method back", !(await has('[data-testid="start-use-recommendation"]')));
  fs.writeFileSync(path.join(work, "start-dialog.png"), (await win.webContents.capturePage()).toPNG());
  await click('[data-testid="start-takeover"]');
  await wait(() => js(`document.body.innerText.includes('No agent execution is active')`));
  assert("takeover without an active run explains the manual path", await js(`document.body.innerText.includes('No agent execution is active')`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await wait(() => js(`!document.querySelector('[data-testid="start-dialog"]')`));
  assert("Escape closes the Start dialog without starting", !(await has('[data-testid="start-dialog"]')) && current().status === "todo");
  const feedback = ctx.items.create({ projectId: project.id, boardId: item.boardId, title: "Collect the workshop feedback", workType: "general", status: "todo", by: "human" });
  ctx.items.update(project.id, feedback.id, { blocks: [item.id] }, "human");
  await js(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
  await wait(() => has('[data-testid="start-ticket"]'));
  await click('[data-testid="start-ticket"]');
  await wait(() => has('[data-testid="start-waits-on"]'));
  assert("an open dependency is named before starting, and starting past it is explicit", await js(`document.querySelector('[data-testid="start-waits-on"]').textContent.includes(${JSON.stringify(feedback.key)}) && document.querySelector('[data-testid="start-confirm"]').textContent === 'Start anyway'`));
  fs.writeFileSync(path.join(work, "start-dialog-waits-on.png"), (await win.webContents.capturePage()).toPNG());
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await wait(() => js(`!document.querySelector('[data-testid="start-dialog"]')`));
  const coding = ctx.items.create({ projectId: project.id, boardId: item.boardId, title: "Wire the login form", workType: "coding", status: "todo", by: "human" });
  await js(`location.hash = '#/p/${project.id}/i/${coding.id}'; true`);
  await wait(() => has('.issue-wrap [data-testid="start-ticket"], .titlebar [data-testid="start-ticket"]'));
  await click('[data-testid="start-ticket"]');
  await wait(() => has('[data-testid="start-dialog"]'));
  assert("a coding ticket's Start dialog chooses where and which agent, with no method", await js(`document.querySelectorAll('[data-testid="start-mode"] button').length === 2 && !!document.querySelector('#stEngine') && !document.querySelector('#stMethod')`));
  await value("#stEngine", "unboxed", "HTMLSelectElement", "change");
  await wait(() => has("#stPermission"));
  assert("each permission mode says what it lets the agent do", (await js(`document.querySelector('[data-testid="start-permission-hint"]')?.textContent ?? ''`)).startsWith("Never asks."));
  assert("full access comes with a warning", (await js(`document.querySelector('[data-testid="start-full-access"]')?.textContent ?? ''`)).includes("nothing will be asked"));
  fs.writeFileSync(path.join(work, "start-dialog-full-access.png"), (await win.webContents.capturePage()).toPNG());
  await value("#stPermission", "workspace", "HTMLSelectElement", "change");
  await wait(() => js(`!document.querySelector('[data-testid="start-full-access"]')`));
  assert("a sandboxed mode explains itself and drops the warning", (await js(`document.querySelector('[data-testid="start-permission-hint"]')?.textContent ?? ''`)).includes("inside the ticket's working copy"));
  fs.writeFileSync(path.join(work, "start-dialog-coding.png"), (await win.webContents.capturePage()).toPNG());
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await wait(() => js(`!document.querySelector('[data-testid="start-dialog"]')`));

  // How the machine remembers Start: a file beside the settings file, not a settings section. Written
  // here as a previous session would have left it, then read back by the next dialog -- no restart needed
  // to prove the read, but the file is read from disk every time the dialog opens.
  fs.writeFileSync(path.join(work, "code-link.json"), JSON.stringify({ mode: "run", engine: "unboxed", options: { droid: "on" }, permissionMode: "workspace", updatedAt: Date.now() }));
  await js(`location.hash = '#/p/${project.id}/i/${coding.id}'; true`);
  await wait(() => has('[data-testid="start-ticket"]'));
  await click('[data-testid="start-ticket"]');
  await wait(() => has('[data-testid="start-dialog"]'));
  assert("the dialog opens on the agent and permission the last start here used", await js(`document.querySelector('#stEngine').value === 'unboxed' && document.querySelector('#stPermission')?.value === 'workspace'`));
  assert("the dialog says the choices came from the last start", await has('[data-testid="start-remembered"]'));
  fs.writeFileSync(path.join(work, "start-dialog-remembered.png"), (await win.webContents.capturePage()).toPNG());
  // A file a person has since edited, or an older Tomrade wrote, with nothing usable left: the dialog still opens on defaults.
  fs.writeFileSync(path.join(work, "code-link.json"), JSON.stringify({ mode: "run", updatedAt: Date.now() }));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await wait(() => js(`!document.querySelector('[data-testid="start-dialog"]')`));
  await click('[data-testid="start-ticket"]');
  await wait(() => has('[data-testid="start-dialog"]'));
  assert("nothing usable is remembered, the dialog opens on defaults without a word about it", await js(`document.querySelector('#stEngine').value === 'unboxed' && !document.querySelector('[data-testid="start-remembered"]')`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await wait(() => js(`!document.querySelector('[data-testid="start-dialog"]')`));
  assert("renderer has no errors", errors.length === 0);
  console.log(`Screenshots and isolated fixture: ${work}`);
  win.destroy();
  await ctx.fiber.dispose();
  app.exit(0);
} catch (error) {
  console.error(error);
  if (win) {
    console.error(await win.webContents.executeJavaScript("document.body.innerText"));
    fs.writeFileSync(path.join(work, "failure.png"), (await win.webContents.capturePage()).toPNG());
  }
  console.error(`Fixture retained: ${work}`);
  app.exit(1);
}
};
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
