/** Backlog horizontal-scroll affordance. Run after pnpm build:backend and pnpm dev:ui:
 * pnpm --filter @tomrade/desktop exec electron scripts/backlog-scroll-check.mjs
 * Set TOMRADE_LANG=zh to verify the Chinese copy.
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-backlog-scroll-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const zh = process.env.TOMRADE_LANG === "zh";
const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  ctx.settings.set({ ...ctx.settings.get(), language: process.env.TOMRADE_LANG ?? "en", onboarding: { seen: ["*"] } });
  const { project } = seedDesignProject({ dbFor: (id) => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos });
  await ctx.storage.ready;
  const views = ctx.views.listForProject(project.id);

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const text = (sel) => $(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  await sleep(3000);

  const scroller = `document.querySelector('.board-scroll-area > .col-track, .board-scroll-area > .lanes')`;
  const hasHint = () => $(`!!document.querySelector('.board-scroll-hint')`);
  const switchView = async (view) => {
    await press(`document.querySelector('.side-row.is-view[data-view="${view.id}"]')`);
    await sleep(500);
  };
  check("overflow shows a translated hint", (await text('.board-scroll-hint'))?.includes(zh ? "向右滚动" : "Scroll right"));
  check("fade does not intercept pointer events", await $(`getComputedStyle(document.querySelector('.board-scroll-fade')).pointerEvents === 'none'`));
  await press(`document.querySelector('.board-scroll-hint')`);
  await sleep(700);
  check("click advances the board", await $(`${scroller}.scrollLeft > 0`));
  await $(`${scroller}.scrollLeft = ${scroller}.scrollWidth`);
  await sleep(200);
  check("hint disappears at the right edge", !(await hasHint()));
  check("done and cancelled columns can be reached", await $(`(() => { const sc = ${scroller}; return ['done', 'cancelled'].every(key => { const col = sc.querySelector('[data-column="'+key+'"]'); return col && col.getBoundingClientRect().right <= sc.getBoundingClientRect().right + 1; }); })()`));
  await $(`${scroller}.scrollLeft = 0`);
  await sleep(200);
  check("scrolling back restores the hint", await hasHint());
  check("hint sits below cards", await $(`document.querySelector('.board-scroll-hint').getBoundingClientRect().top >= ${scroller}.getBoundingClientRect().bottom`));
  await shot("backlog-scroll-hint");

  win.setSize(2400, 900);
  await sleep(300);
  await switchView(views.find(v => v.name === "Triage"));
  check("a board that fits has no hint", !(await hasHint()));
  win.setSize(700, 900);
  await sleep(300);
  check("narrowing the window reveals the hint", await hasHint());
  win.setSize(2400, 900);
  await sleep(300);
  check("widening the window hides the hint", !(await hasHint()));

  win.setSize(1500, 900);
  await sleep(300);
  await switchView(views.find(v => v.name === "Sprint 12"));
  check("swimlanes show the hint too", await hasHint());
  await press(`document.querySelector('.board-scroll-hint')`);
  await sleep(700);
  check("hint scrolls swimlanes", await $(`${scroller}.scrollLeft > 0`));
  await $(`${scroller}.scrollLeft = ${scroller}.scrollWidth`);
  await sleep(200);
  check("swimlane hint disappears at the end", !(await hasHint()));
  await switchView(views.find(v => v.layout === "table"));
  check("table view has no board hint", !(await hasHint()));
};

app.whenReady().then(async () => {
  try { await run(); }
  catch (err) { console.error(err); check("harness ran to completion", false); }
  const failed = results.filter(r => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
});
