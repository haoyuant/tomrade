/**
 * Routines (templates) regression: the sidebar opens the Routines screen in a tab
 * of its own, a suggestion is added from it and run, a template of the person's
 * own (two tickets) is written, scheduled every three days and run, its card's
 * switch pauses and resumes the schedule, the palette offers it, a schedule
 * fires on its own, and a deleted template takes its schedules with it.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:schedules
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-schedules-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, { id: "schedules", config: { tickMs: 3600000 } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] } });

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const type = (selector, text) => $(`(() => { const i = document.querySelector('${selector}'); const proto = i.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const pick = (selector, value) => $(`(() => { const s = document.querySelector('${selector}'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const titles = () => ctx.items.list({ projectId: project.id }).map((i) => i.title);
  await sleep(2500);

  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const weekday = today.toLocaleDateString("en", { weekday: "long" });
  const editor = () => $(`document.querySelector('[data-testid="template-editor"]')?.textContent ?? ''`);
  const escape = async () => {
    await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
    await sleep(400);
  };
  const openCard = (id) => press(`document.querySelector('[data-template="${id}"] .routine-card-open')`);

  // ── from the sidebar, the suggestions first ───────────────────────────
  check(
    "Routines is its own entry beside Files, not in the backlog's foot",
    (await $(`(() => { const b = document.querySelector('[data-testid="open-templates"]'); return !!b?.closest('.side-routines') && !b.closest('.side-foot') && b.closest('.side-group')?.previousElementSibling?.classList.contains('side-files') && b.getAttribute('aria-label') === 'Open routines'; })()`)) === true
  );
  await press(`document.querySelector('[data-testid="open-templates"]')`);
  await sleep(700);
  check("the sidebar opens Routines as a screen, not a dialog", (await $(`!!document.querySelector('[data-testid="routines-region"]') && !document.querySelector('[role="dialog"]') && location.hash.endsWith('/r')`)) === true, await $(`location.hash`));
  check("in a tab of its own beside Backlog", (await $(`(() => { const tab = document.querySelector('.tab-strip [data-tab="routines"]'); return tab?.getAttribute('aria-selected') === 'true' && tab.previousElementSibling?.dataset.tab === 'backlog' && document.querySelector('[data-tab="backlog"]').getAttribute('aria-selected') === 'false'; })()`)) === true);
  check("its entry reads as current while Routines is", (await $(`document.querySelector('[data-testid="open-templates"]')?.getAttribute('aria-current')`)) === "true");
  check("no view reads as current there", (await $(`!document.querySelector('.side-row.is-view[aria-current="true"]')`)) === true);
  check("with no routines yet, it says so above the suggestions", /None yet/.test(await $(`document.querySelector('[data-testid="routines-region"]').textContent`)) && (await $(`!!document.querySelector('.routines-suggestions [data-suggestion="daily-todo"]')`)) === true);
  check("everyday ones come first, not only coding", ((await $(`document.querySelector('.routines-suggestions .eyebrow')?.textContent`)) ?? "").trim() === "Everyday");
  await shot("templates-01-suggestions");
  await press(`document.querySelector('[data-testid="suggestion-add-daily-todo"]')`);
  await sleep(900);
  const [daily] = ctx.schedules.templates(project.id);
  check("Add makes it the project's own template, with its schedule", daily?.name === "Daily to-do" && ctx.schedules.schedules(project.id, daily.id)[0]?.cadence.kind === "daily", { daily, schedules: ctx.schedules.schedules(project.id) });
  check("and opens it in a dialog, saying when it runs", /every day at 08:00/.test(await editor()) && /next /.test(await editor()) && (await $(`!!document.querySelector('[role="dialog"] [data-testid="template-editor"]')`)) === true, await editor());
  await press(`document.querySelector('[data-testid="template-run"]')`);
  await sleep(1000);
  check("Run now makes today's to-do, its date filled in, on To Do", ctx.items.list({ projectId: project.id }).some((i) => i.title === `To-do · ${weekday} ${ymd}` && i.status === "todo" && i.workType === "general"), titles());
  check("and the run is listed", /by hand/.test(await editor()), await editor());
  await escape();
  check("its card shows its schedule, its switch on, and the run", (await $(`(() => { const c = document.querySelector('[data-template="${daily.id}"]'); return !!c && /every day at 08:00/.test(c.textContent) && /last run/.test(c.textContent) && c.querySelector('.switch')?.getAttribute('aria-checked') === 'true'; })()`)) === true, await $(`document.querySelector('[data-template="${daily.id}"]')?.textContent`));
  check("its suggestion now reads as added", /Added/.test(await $(`document.querySelector('[data-suggestion="daily-todo"]').textContent`)));

  // ── your own: two tickets, then a schedule ────────────────────────────
  await press(`document.querySelector('[data-testid="template-new"]')`);
  await sleep(400);
  check("a new template waits for a name and a title", (await $(`document.querySelector('[data-testid="template-save"]').disabled`)) === true);
  await type("#tplName", "Sunday reset");
  await type("#tplT0", "Plan meals for {weekday}");
  await type("#tplB0", "- [ ] Breakfast\n- [ ] Dinner");
  await press(`document.querySelector('[data-testid="template-add-ticket"]')`);
  await sleep(200);
  await type("#tplT1", "Tidy the desk");
  await type("#tplL1", "home,");
  await sleep(150);
  check("a comma typed into labels stays while typing", (await $(`document.querySelector('#tplL1').value`)) === "home,");
  await type("#tplL1", "home, weekly");
  await sleep(200);
  await shot("templates-02-editor");
  await press(`document.querySelector('[data-testid="template-save"]')`);
  await sleep(900);
  const own = ctx.schedules.templates(project.id).find((x) => x.name === "Sunday reset");
  check("it is saved as written", own && own.action.kind === "tickets" && own.action.items.length === 2 && own.action.items[1].labels.join() === "home,weekly", own);

  // ── two columns, and a sheet that resizes from its corner within its limits ──
  await sleep(300);
  const box = (sel) => $(`(() => { const r = document.querySelector('${sel}')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })()`);
  const main = await box(".template-main");
  const side = await box(".template-side");
  check("a saved template reads in two columns", main && side && side.x > main.x + main.w - 1 && Math.abs(side.y - main.y) < 2, { main, side });
  await shot("templates-03-columns");
  const sheet0 = await box(".sheet-templates");
  const drag = async (dx, dy) => {
    const g = await box(".dlg-grip");
    const [x, y] = [Math.round(g.x + g.w / 2), Math.round(g.y + g.h / 2)];
    win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      win.webContents.sendInputEvent({ type: "mouseMove", x: x + Math.round((dx * i) / 8), y: y + Math.round((dy * i) / 8), modifiers: ["leftButtonDown"] });
      await sleep(16);
    }
    win.webContents.sendInputEvent({ type: "mouseUp", x: x + dx, y: y + dy, button: "left", clickCount: 1 });
    await sleep(150);
    return box(".sheet-templates");
  };
  // a short window already holds the sheet at the workspace row's height
  const capH = await $(`parseFloat(getComputedStyle(document.querySelector('.sheet-templates')).maxHeight)`);
  const grown = await drag(60, 40);
  check("dragging the corner grows the sheet under the pointer", Math.abs(grown.w - sheet0.w - 120) <= 4 && Math.abs(grown.h - Math.min(sheet0.h + 80, capH)) <= 4, { sheet0, grown, capH });
  const huge = await drag(900, 900);
  check("it stops at Tomrade's widest sheet and the workspace row", huge.w <= 1280 && huge.h <= 920 && huge.y >= 42, huge);
  const tiny = await drag(-2000, -2000);
  check("and never shrinks past its minimum", tiny.w >= 719 && tiny.h >= 479, tiny);
  await drag(300, 200);
  const kept = await $(`localStorage.getItem('tomrade.dialogSize.templates')`);
  check("the size is remembered", !!kept && JSON.parse(kept).w > tiny.w, kept);
  await shot("templates-04-resized");
  // a new routine has no schedules yet, so its tickets get the whole width
  await escape();
  await press(`document.querySelector('[data-testid="template-new"]')`);
  await sleep(300);
  await press(`document.querySelector('[data-testid="template-add-ticket"]')`);
  await sleep(200);
  const cards = await $(`[...document.querySelectorAll('.template-ticket')].map((n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })`);
  check("a new routine on a wide sheet lays its tickets side by side", cards.length === 2 && cards[1].x > cards[0].x && cards[1].y === cards[0].y, cards);
  await shot("templates-05-new-wide");
  await escape();
  check("a card without a schedule has no switch and runs by hand", (await $(`(() => { const c = document.querySelector('[data-template="${own.id}"]'); return !!c && !c.querySelector('.switch') && /run when you need it/.test(c.textContent); })()`)) === true);
  await openCard(own.id);
  await sleep(300);
  await $(`document.querySelector('.dlg-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(100);
  const reset = await box(".sheet-templates");
  check("double-clicking the grip goes back to the default size", Math.abs(reset.w - sheet0.w) <= 1 && Math.abs(reset.h - sheet0.h) <= 1 && (await $(`localStorage.getItem('tomrade.dialogSize.templates')`)) === null, reset);
  await press(`document.querySelector('[data-testid="schedule-add"]')`);
  await sleep(300);
  await pick("#cdKind", "days");
  await sleep(150);
  await type("#cdEvery", "3");
  await type("#cdAt", "09:30");
  await sleep(150);
  await press(`document.querySelector('[data-testid="schedule-save"]')`);
  await sleep(800);
  const [every3] = ctx.schedules.schedules(project.id, own.id);
  check("a schedule every three days is set", every3?.cadence.kind === "days" && every3.cadence.every === 3 && every3.cadence.at === "09:30", every3);
  await press(`document.querySelector('[data-testid="template-run"]')`);
  await sleep(1000);
  check("running it makes both tickets", titles().includes(`Plan meals for ${weekday}`) && titles().includes("Tidy the desk"), titles());
  await escape();
  await shot("templates-06-cards");

  // ── the card's switch pauses its schedules, and turns them back on ────
  const ownSwitch = `document.querySelector('[data-template="${own.id}"] .switch')`;
  await press(ownSwitch);
  await sleep(700);
  const paused = ctx.schedules.schedules(project.id, own.id)[0];
  check("switching a card off pauses its schedule: it will not run on its own", paused?.enabled === false && paused.nextRunAt === null && (await $(`${ownSwitch}.getAttribute('aria-checked')`)) === "false", paused);
  check("the switch does not open the card", (await $(`!document.querySelector('[role="dialog"]')`)) === true);
  check("the card says it is off", /· off/.test(await $(`document.querySelector('[data-template="${own.id}"]').textContent`)));
  await press(ownSwitch);
  await sleep(700);
  const resumed = ctx.schedules.schedules(project.id, own.id)[0];
  check("and switching it on schedules the next run again", resumed?.enabled === true && typeof resumed.nextRunAt === "number" && (await $(`${ownSwitch}.getAttribute('aria-checked')`)) === "true", resumed);

  // ── from the palette ──────────────────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));true`);
  await sleep(500);
  check("the palette can run a template", (await $(`[...document.querySelectorAll('.palette-row')].some((r) => r.textContent?.includes('Run routine · Sunday reset'))`)) === true);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);

  // ── on its schedule, then gone ────────────────────────────────────────
  const dailySchedule = ctx.schedules.schedules(project.id, daily.id)[0];
  await ctx.schedules.tick(dailySchedule.nextRunAt);
  await sleep(300);
  check("when it comes due it runs on its own", ctx.schedules.runs(project.id, daily.id)[0]?.trigger === "schedule");
  await press(`document.querySelector('[data-testid="open-templates"]')`);
  await sleep(600);
  await openCard(own.id);
  await sleep(500);
  await press(`[...document.querySelectorAll('[data-testid="template-editor"] button')].find((b) => b.textContent === 'Delete routine')`);
  await sleep(200);
  await press(`[...document.querySelectorAll('[data-testid="template-editor"] button')].find((b) => b.textContent === 'Delete it and its schedules?')`);
  await sleep(700);
  check("deleting asks twice, then takes its schedules with it", !ctx.schedules.template(project.id, own.id) && ctx.schedules.schedules(project.id, own.id).length === 0);
  check("and the dialog and the card go with it", (await $(`!document.querySelector('[role="dialog"]') && !document.querySelector('[data-template="${own.id}"]')`)) === true);

  // ── the tab closes like a file's ──────────────────────────────────────
  await press(`document.querySelector('[data-tab="routines"] .tab-close')`);
  await sleep(600);
  check("closing the Routines tab goes back to Backlog", (await $(`!document.querySelector('[data-tab="routines"]') && document.querySelector('[data-tab="backlog"]').getAttribute('aria-selected') === 'true' && !document.querySelector('[data-testid="routines-region"]')`)) === true);
  check("harness reached the end", true);
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.log("HARNESS ERROR: " + (err && err.stack ? err.stack : String(err)));
    check("harness ran to completion", false);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
  app.exit(failed.length ? 1 : 0);
});
