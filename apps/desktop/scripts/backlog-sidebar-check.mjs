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

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  ctx.settings.set({ ...ctx.settings.get(), language: process.env.TOMRADE_LANG ?? "en", onboarding: { seen: ["*"] } });
  const { project, boardIds } = seedDesignProject({ dbFor: (id) => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos });
  await ctx.storage.ready;
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
  const order = await $(`[...document.querySelectorAll('.side-scroll > .side-group')].map((g) => ['side-files', 'side-routines', 'side-backlog'].find((c) => g.classList.contains(c)) ?? g.className)`);
  check("the sidebar is three modules: files, routines, backlog", JSON.stringify(order) === JSON.stringify(["side-files", "side-routines", "side-backlog"]), order);
  check("the backlog module is headed Backlog", (await text(".side-backlog-home .side-label")) === "Backlog");
  check("views, workstreams and fields all sit inside it", (await $(`['.side-views', '.side-workstreams', '.side-fields'].every((s) => document.querySelector(s)?.closest('.side-backlog'))`)) === true);
  check("its head reads as current on a view", (await $(`document.querySelector('.side-backlog-home')?.getAttribute('aria-current')`)) === "true");
  check("every workstream is listed", (await $(`document.querySelectorAll('.side-row.is-workstream').length`)) === boards.length);
  check("the sidebar never scrolls sideways", (await $(`(() => { const sc = document.querySelector('.side-scroll'); return sc.scrollWidth <= sc.clientWidth; })()`)) === true);
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
  check("which opens the Fields sheet on that workstream's card", (await $(`document.querySelector('.fld-ws.is-focus')?.dataset.board`)) === unbound.id);
  await shot("backlog-sidebar-03-connect");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(500);

  // ── the help popover ──────────────────────────────────────────────────
  await press(`document.querySelector('.side-ws-help-btn')`);
  await sleep(300);
  check("the help explains what a workstream is", ((await text(".side-ws-help")) ?? "").includes("one line of work"));
  check("and that each can point at its own repository", ((await text(".side-ws-help")) ?? "").includes("its own repository"));
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
  check("and its toast offers to connect a repository", (await $(`[...document.querySelectorAll('.toast button')].some((b) => b.textContent === 'Connect a repository')`)) === true);
  await shot("backlog-sidebar-05-created");

  // ── the module folds ──────────────────────────────────────────────────
  await press(`document.querySelector('.side-module-toggle')`);
  await sleep(200);
  check("the backlog folds away", (await $(`!document.querySelector('.side-backlog .side-views')`)) === true);
  await press(`document.querySelector('.side-module-toggle')`);
  await sleep(200);
  check("and comes back", (await $(`!!document.querySelector('.side-backlog .side-views')`)) === true);
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
