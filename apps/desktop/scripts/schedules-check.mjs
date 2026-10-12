/**
 * Templates regression: a suggestion is added from the sidebar and run, a
 * template of the person's own (two tickets) is written, scheduled every three
 * days and run, the palette offers it, a schedule fires on its own, and a
 * deleted template takes its schedules with it.
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

  // ── from the sidebar, the suggestions first ───────────────────────────
  await press(`document.querySelector('[data-testid="open-templates"]')`);
  await sleep(700);
  check("the sidebar opens Templates on its suggestions", (await $(`!!document.querySelector('[data-suggestion="daily-todo"]')`)) === true);
  check("everyday ones come first, not only coding", ((await $(`document.querySelector('.dlg-body .eyebrow')?.textContent`)) ?? "").trim() === "Everyday");
  await shot("templates-01-suggestions");
  await press(`document.querySelector('[data-testid="suggestion-add-daily-todo"]')`);
  await sleep(900);
  const [daily] = ctx.schedules.templates(project.id);
  check("Add makes it the project's own template, with its schedule", daily?.name === "Daily to-do" && ctx.schedules.schedules(project.id, daily.id)[0]?.cadence.kind === "daily", { daily, schedules: ctx.schedules.schedules(project.id) });
  check("and opens it, saying when it runs", /every day at 08:00/.test(await editor()) && /next /.test(await editor()), await editor());
  await press(`document.querySelector('[data-testid="template-run"]')`);
  await sleep(1000);
  check("Run now makes today's to-do, its date filled in, on To Do", ctx.items.list({ projectId: project.id }).some((i) => i.title === `To-do · ${weekday} ${ymd}` && i.status === "todo" && i.workType === "general"), titles());
  check("and the run is listed", /by hand/.test(await editor()), await editor());

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

  // ── from the palette ──────────────────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(400);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));true`);
  await sleep(500);
  check("the palette can run a template", (await $(`[...document.querySelectorAll('.palette-row')].some((r) => r.textContent?.includes('Run template · Sunday reset'))`)) === true);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);

  // ── on its schedule, then gone ────────────────────────────────────────
  const dailySchedule = ctx.schedules.schedules(project.id, daily.id)[0];
  await ctx.schedules.tick(dailySchedule.nextRunAt);
  await sleep(300);
  check("when it comes due it runs on its own", ctx.schedules.runs(project.id, daily.id)[0]?.trigger === "schedule");
  await press(`document.querySelector('[data-testid="open-templates"]')`);
  await sleep(600);
  await press(`document.querySelector('[data-template="${own.id}"]')`);
  await sleep(500);
  await press(`[...document.querySelectorAll('[data-testid="template-editor"] button')].find((b) => b.textContent === 'Delete template')`);
  await sleep(200);
  await press(`[...document.querySelectorAll('[data-testid="template-editor"] button')].find((b) => b.textContent === 'Delete it and its schedules?')`);
  await sleep(700);
  check("deleting asks twice, then takes its schedules with it", !ctx.schedules.template(project.id, own.id) && ctx.schedules.schedules(project.id, own.id).length === 0);
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
