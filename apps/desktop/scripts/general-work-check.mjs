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
  ctx.hub.configure(path.join(work, "hub"));
  const project = ctx.projects.create({ name: "General work regression", keyPrefix: "GEN" });
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
  await value("#niWorkType", "general", "HTMLSelectElement", "change");
  await wait(() => has("#niTemplate"));
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
  assert("no Git startup action for General", !(await has('[data-testid="start-ticket"]')));
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
  await js(`(() => { const n = document.querySelector('[data-testid="general-options"]'); n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ctrlKey: false })); return true; })()`);
  await wait(() => has('.menu select'));
  assert("General options expose method and engine", await js(`document.querySelectorAll('.menu select').length === 2`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await js(`[...document.querySelectorAll('.card')].find(n => n.textContent.includes('Prepare workshop guide')).click(); true`);
  await wait(() => has('[data-testid="general-options"]'));
  await press('[data-testid="general-options"]');
  await wait(() => has('.menu button.btn-secondary'));
  await press('.menu button.btn-secondary');
  await wait(() => js(`document.body.innerText.includes('No agent execution is active')`));
  assert("takeover without an active run explains the manual path", await js(`document.body.innerText.includes('No agent execution is active')`));
  fs.writeFileSync(path.join(work, "detail-options.png"), (await win.webContents.capturePage()).toPNG());
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
