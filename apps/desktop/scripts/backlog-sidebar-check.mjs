/**
 * Backlog module regression: the sidebar is a set of module doors, and the
 * backlog's — views, workstreams, fields — sit under one "Backlog" head.
 * Workstreams are easy to find: each row says where its code lives, switching
 * is one click, creating offers to connect a repository, a help popover says
 * what a workstream is, and the workstream page head carries the binding.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:backlog-sidebar
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { seedDesignProject } from "./seed.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-backlog-sidebar-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const zh = process.env.TOMRADE_LANG === "zh";
const say = zh
  ? { what: "一条工作线", repo: "自己的代码仓库", connect: "连接仓库", backlog: "工单", workstreams: "工作流" }
  : { what: "one line of work", repo: "its own repository", connect: "Connect a repository", backlog: "Backlog", workstreams: "Workstreams" };

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  ctx.settings.set({ ...ctx.settings.get(), language: process.env.TOMRADE_LANG ?? "en", onboarding: { seen: ["*"] } });
  const { project, boardIds } = seedDesignProject({ dbFor: (id) => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos });
  await ctx.storage.ready;
  const ran = [];
  ctx.contributions.command({ id: "demo.links.open", title: "Open link", run: () => (ran.push("open"), { toast: "demo link opened" }) });
  ctx.contributions.sidebarModule({ id: "demo.links", title: "Links", icon: "i-link", rows: () => [{ id: "docs", label: "Docs", icon: "i-file", detail: "docs.example.com", count: 3, command: "demo.links.open" }] });
  const boards = ctx.boards.list(project.id);
  const views = ctx.views.listForProject(project.id);
  const bound = boardIds.get("bd-ui");
  const unbound = boards.find((b) => !b.repoId);

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const text = (sel) => $(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  await sleep(3000);

  // ── one Backlog module ────────────────────────────────────────────────
  const modules = () => $(`[...document.querySelectorAll('.side-scroll > .side-module')].map((g) => g.dataset.module)`);
  const order = await modules();
  check("the sidebar is modules: files, routines, backlog, then a plugin's", JSON.stringify(order) === JSON.stringify(["files", "routines", "backlog", "plugin:demo.links"]), order);
  check("a module with something under it folds from a button on the left", (await $(`['files', 'backlog', 'plugin:demo.links'].every((id) => document.querySelector(\`[data-module="\${id}"] .side-module-head\`)?.firstElementChild?.classList.contains('side-module-fold'))`)) === true);
  check("one without keeps that room, so every title starts at the same x", (await $(`(() => { if (document.querySelector('[data-module="routines"] .side-module-fold')) return false; return new Set([...document.querySelectorAll('.side-module-title')].map((n) => Math.round(n.getBoundingClientRect().left))).size === 1; })()`)) === true);
  check("the gap between any two modules is the same", (await $(`(() => { const ms = [...document.querySelectorAll('.side-scroll > .side-module')]; const gaps = ms.slice(1).map((m, i) => Math.round(m.getBoundingClientRect().top - ms[i].getBoundingClientRect().bottom)); return new Set(gaps).size === 1 ? gaps[0] : gaps; })()`)) === 20);
  check("a hairline sits between modules, inset like the head row", (await $(`(() => { const ms = [...document.querySelectorAll('.side-scroll > .side-module')]; const first = getComputedStyle(ms[0], '::before').content; const rest = ms.slice(1).map((m) => { const c = getComputedStyle(m, '::before'); const head = m.querySelector('.side-module-head').getBoundingClientRect(); return c.content !== 'none' && parseFloat(c.borderTopWidth) <= 1 && Math.abs(m.getBoundingClientRect().left + parseFloat(c.left) - head.left) < 1 && Math.abs(m.getBoundingClientRect().right - parseFloat(c.right) - (head.right - parseFloat(getComputedStyle(m.querySelector('.side-module-head')).paddingRight))) < 1; }); return first === 'none' && rest.every(Boolean); })()`)) === true);
  check("a plugin's module draws its rows", ((await text('[data-module="plugin:demo.links"] .side-row[data-row="docs"]')) ?? "").includes("docs.example.com"));
  await press(`document.querySelector('[data-module="plugin:demo.links"] .side-row[data-row="docs"]')`);
  await sleep(600);
  check("and a row runs the command it names", ran.length === 1);
  check("the backlog module is headed Backlog", (await text(".side-backlog-home .side-label")) === say.backlog);
  check("views and workstreams sit inside it", (await $(`['.side-views', '.side-workstreams'].every((s) => document.querySelector(s)?.closest('.side-backlog'))`)) === true);
  // Present and sized is not drawn: an open fold once took its space and painted nothing.
  check("and an open fold actually draws them", (await $(`['.side-views', '.side-workstreams'].every((s) => document.querySelector(s)?.checkVisibility({ visibilityProperty: true }))`)) === true);
  check("fields left the sidebar for the view head, right of View", (await $(`!document.querySelector('.sidebar .side-fields') && document.querySelector('.view-settings-btn')?.nextElementSibling?.classList.contains('view-fields-btn')`)) === true);
  check("its head reads as current on a view", (await $(`document.querySelector('.side-backlog-home')?.getAttribute('aria-current')`)) === "true");
  check("every workstream is listed", (await $(`document.querySelectorAll('.side-row.is-workstream').length`)) === boards.length);
  check("the sidebar never scrolls sideways", (await $(`(() => { const sc = document.querySelector('.side-scroll'); return sc.scrollWidth <= sc.clientWidth; })()`)) === true);
  check("the views and the workstreams start the same distance under their labels", (await $(`(() => { const gap = (sel) => { const g = document.querySelector(sel); return Math.round(g.querySelector('.side-row .ico').getBoundingClientRect().top - g.querySelector('.side-sub-label').getBoundingClientRect().bottom); }; return gap('.side-views') === gap('.side-workstreams'); })()`)) === true);
  check("files, routines and backlog share one module head style", (await $(`new Set([...document.querySelectorAll('.side-module-title')].map((n) => { const c = getComputedStyle(n); return c.fontSize + c.fontWeight; })).size === 1 && document.querySelectorAll('.side-module-title').length === 4`)) === true);
  check("a workstream row is two short lines, not a tall block", (await $(`document.querySelector('.side-ws-container')?.getBoundingClientRect().height`)) < 56);
  await shot("backlog-sidebar-01");

  // ── where each workstream's code lives ────────────────────────────────
  check("a bound workstream names its repository and folder", ((await text(`.side-row.is-workstream[data-board="${bound}"] .side-ws-repo`)) ?? "").endsWith("/packages/ui"), await text(`.side-row.is-workstream[data-board="${bound}"] .side-ws-repo`));
  check("an unbound one says it has none", (await $(`document.querySelector('.side-row.is-workstream[data-board="${unbound.id}"] .side-ws-repo')?.classList.contains('is-none')`)) === true);

  // ── switching ─────────────────────────────────────────────────────────
  await press(`document.querySelector('.side-row.is-workstream[data-board="${bound}"]')`);
  await sleep(900);
  check("one click switches to the workstream's page", (await $(`document.querySelector('.side-row.is-workstream[data-board="${bound}"]')?.getAttribute('aria-current')`)) === "true");
  check("the page head carries its repository", ((await text(".ws-repo-chip")) ?? "").endsWith("/packages/ui"), await text(".ws-repo-chip"));
  await shot("backlog-sidebar-02-workstream");
  await press(`document.querySelector('.side-row.is-workstream[data-board="${unbound.id}"]')`);
  await sleep(900);
  check("an unbound page offers to connect one", (await $(`document.querySelector('.ws-repo-chip')?.classList.contains('is-none')`)) === true);
  await press(`document.querySelector('.ws-repo-chip')`);
  await sleep(900);
  check("which opens the Workstreams sheet on that workstream's card", (await $(`document.querySelector('.fld-ws.is-focus')?.dataset.board`)) === unbound.id);
  check("titled for workstreams, not fields", (await text(".dlg-head .dlg-title")) === say.workstreams, await text(".dlg-head .dlg-title"));
  await shot("backlog-sidebar-03-connect");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(500);

  // ── the help popover ──────────────────────────────────────────────────
  await press(`document.querySelector('.side-ws-help-btn')`);
  await sleep(300);
  check("the help explains what a workstream is", ((await text(".side-ws-help")) ?? "").includes(say.what));
  check("and that each can point at its own repository", ((await text(".side-ws-help")) ?? "").includes(say.repo));
  await shot("backlog-sidebar-04-help");
  check("the help opens in place, never clipped sideways", (await $(`(() => { const sc = document.querySelector('.side-scroll'); return sc.scrollWidth <= sc.clientWidth; })()`)) === true);
  await press(`document.querySelector('.side-ws-help-manage')`);
  await sleep(700);
  check("its button opens the workstream editor", (await $(`!!document.querySelector('[data-editor="workstream"]')`)) === true);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(500);

  // ── creating ──────────────────────────────────────────────────────────
  await press(`document.querySelector('.side-new-workstream')`);
  await sleep(200);
  await $(`(() => { const i = document.querySelector('.side-workstreams input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Docs'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await sleep(900);
  check("a new workstream lands in the list", (await $(`[...document.querySelectorAll('.side-workstreams .side-name')].some((n) => n.textContent === 'Docs')`)) === true);
  check("and its toast offers to connect a repository", (await $(`[...document.querySelectorAll('.toast button')].some((b) => b.textContent === ${JSON.stringify(say.connect)})`)) === true);
  await shot("backlog-sidebar-05-created");

  // ── removing asks first ───────────────────────────────────────────────
  const docs = ctx.boards.list(project.id).find((b) => b.name === "Docs");
  await press(`document.querySelector('.side-row.is-workstream[data-board="${docs.id}"]')?.closest('.side-ws-container')?.querySelector('.side-ws-edit')`);
  await sleep(900);
  await press(`document.querySelector('.fld-ws[data-board="${docs.id}"] .fld-ws-remove')`);
  await sleep(500);
  check("removing a workstream opens a confirmation", (await $(`!!document.querySelector('.ws-remove-confirm')`)) === true);
  check("cancel holds the focus", (await $(`document.activeElement?.classList.contains('btn-secondary') && !!document.activeElement.closest('[role=dialog]')?.querySelector('.ws-remove')`)) === true);
  await shot("backlog-sidebar-06-remove");
  await press(`document.activeElement`);
  await sleep(500);
  check("cancelling keeps it", !!ctx.boards.list(project.id).find((b) => b.id === docs.id) && (await $(`!document.querySelector('.ws-remove-confirm')`)) === true);
  await press(`document.querySelector('.fld-ws[data-board="${docs.id}"] .fld-ws-remove')`);
  await sleep(500);
  await press(`document.querySelector('.ws-remove-confirm')`);
  await sleep(900);
  check("confirming removes it", !ctx.boards.list(project.id).find((b) => b.id === docs.id));
  check("and its toast offers undo", (await $(`!!document.querySelector('.toast .toast-undo, .toast button')`)) === true);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(500);

  // ── real mouse input: dnd-kit drags a handle on press unless told otherwise ──
  const centre = async (sel) => {
    const at = await $(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; n.scrollIntoView({ block: "nearest" }); const r = n.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!at) throw new Error(`nothing matches ${sel}`);
    return at;
  };
  const mouse = (type, { x, y }, held) => win.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1, ...(held ? { modifiers: ["leftButtonDown"] } : {}) });
  const click = async (sel) => {
    const at = await centre(sel);
    mouse("mouseMove", at);
    mouse("mouseDown", at);
    await sleep(60);
    mouse("mouseUp", at);
    await sleep(300);
  };
  await click('[data-module="backlog"] .side-module-fold');
  check("a real click on the fold button folds, it does not start a drag", (await $(`!document.querySelector('.side-backlog .side-views') && !document.querySelector('.side-module.dragging')`)) === true);
  await click('[data-module="backlog"] .side-module-fold');
  check("and a second click unfolds", (await $(`!!document.querySelector('.side-backlog .side-views')`)) === true);
  await click('[data-module="routines"] .side-templates');
  await sleep(500);
  check("a real click on a module title still opens it", (await $(`document.querySelector('.side-templates')?.getAttribute('aria-current')`)) === "true");
  await click('.side-backlog-home');
  await sleep(500);
  await press(`document.querySelector('[data-module="files"] .side-module-fold')`);
  await sleep(200);
  {
    const from = await centre('[data-module="routines"] .side-module-head');
    const to = await centre('[data-module="files"] .side-module-head');
    mouse("mouseMove", from);
    mouse("mouseDown", from);
    for (let i = 1; i <= 12; i++) {
      mouse("mouseMove", { x: from.x, y: Math.round(from.y + ((to.y - 8 - from.y) * i) / 12) }, true);
      await sleep(30);
    }
    await sleep(200);
    mouse("mouseUp", { x: to.x, y: to.y - 8 });
    await sleep(500);
  }
  check("dragging a module head moves it", JSON.stringify((await modules()).slice(0, 2)) === JSON.stringify(["routines", "files"]), await modules());
  await press(`document.querySelector('[data-module="files"] .side-module-fold')`);
  await sleep(200);
  await $(`localStorage.removeItem('tomrade.sidebar.layout'); true`);
  await win.webContents.reload();
  await sleep(3000);

  // ── folding and order, kept on this machine ───────────────────────────
  await press(`document.querySelector('[data-module="backlog"] .side-module-fold')`);
  await sleep(200);
  check("the backlog folds away", (await $(`!document.querySelector('.side-backlog .side-views')`)) === true);
  await press(`document.querySelector('[data-module="files"] .side-module-fold')`);
  await sleep(200);
  check("so do files", (await $(`!document.querySelector('[data-module="files"] .side-module-body')`)) === true);
  const menuPick = async (moduleId, nth) => {
    await $(`(() => { const h = document.querySelector('[data-module="${moduleId}"] .side-module-head'); const r = h.getBoundingClientRect(); h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 8, button: 2 })); return true; })()`);
    await sleep(300);
    await press(`document.querySelectorAll('.menu.is-floating [role=menuitem]')[${nth}]`);
    await sleep(300);
  };
  await menuPick("backlog", 0);
  await menuPick("backlog", 0);
  check("a module moves up from its menu", JSON.stringify(await modules()) === JSON.stringify(["backlog", "files", "routines", "plugin:demo.links"]), await modules());
  await shot("backlog-sidebar-07-moved");
  await win.webContents.reload();
  await sleep(3000);
  check("the order and the folds survive a reload", JSON.stringify(await modules()) === JSON.stringify(["backlog", "files", "routines", "plugin:demo.links"]) && (await $(`!document.querySelector('.side-backlog .side-views') && !document.querySelector('[data-module="files"] .side-module-body')`)) === true, await modules());
  await menuPick("backlog", 2);
  await press(`document.querySelector('[data-module="backlog"] .side-module-fold')`);
  await press(`document.querySelector('[data-module="files"] .side-module-fold')`);
  await sleep(300);
  check("resetting puts the default order back", JSON.stringify(await modules()) === JSON.stringify(["files", "routines", "backlog", "plugin:demo.links"]), await modules());
  check("and unfolding brings the backlog back", (await $(`!!document.querySelector('.side-backlog .side-views')`)) === true);
  await press(`document.querySelector('[data-testid="open-templates"]')`);
  await sleep(700);
  await press(`document.querySelector('.side-backlog-home')`);
  await sleep(700);
  check("its head is a door back to the first view", (await $(`document.querySelector('.side-row.is-view[data-view="${views[0].id}"]')?.getAttribute('aria-current')`)) === "true");
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.log("HARNESS ERROR: " + (err && err.stack ? err.stack : String(err)));
    check("harness ran to completion", false);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${shots}`);
  if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
  app.exit(failed.length ? 1 : 0);
});
