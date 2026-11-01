/**
 * Night shift regression: the title bar and the palette open the dialog, To Do tickets are chosen
 * and a dependency is explained, terminal panes or sessions are picked, the shift
 * starts where it was told, progress shows in the dialog, the title bar and the status bar,
 * and Stop ends it. Start itself is a stand-in: real starts are covered by
 * packages/night-shift/tests/real-start.test.ts.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:night-shift
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = process.env.TOMRADE_SHOTS ?? path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-night-shift-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work, linkAgents: "false" }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  const board = ctx.boards.list(project.id)[0];
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });

  ctx.agent.engine({ id: "standin", title: "Stand-in coder", author: "ai:standin", capabilities: ["backlog", "code", "general"], available: async () => ({ ok: true }), async turn() { return { stop: "end" }; } });
  const make = (title, status = "todo") => ctx.items.create({ projectId: project.id, boardId: board.id, title, status, workType: "coding", by: "human" });
  const first = make("Add the export button");
  const second = make("Write the export docs");
  const later = make("A long one for a later night, whose title runs on well past the width of the dialog so that it has to wrap", "backlog");
  ctx.items.update(project.id, first.id, { blocks: [second.id] }, "human");
  const starts = [];
  ctx.codeLink.start = async (_projectId, itemId, opts) => {
    starts.push({ itemId, mode: opts.mode, engine: opts.engine });
    return { ok: true, threadId: null, branch: `work/${itemId}` };
  };

  ctx.codeLink.prChecks = async () => "pending";

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) => $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true })); return true; })()`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const waitFor = async (expr, ms = 8000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await $(expr)) return true;
      await sleep(80);
    }
    return false;
  };
  const test = (id) => `document.querySelector('[data-testid="${id}"]')`;
  const text = (id) => `(${test(id)}?.textContent ?? '')`;
  const candidate = (title) => `[...document.querySelectorAll('[data-testid="night-shift-candidate"]')].find((r) => r.textContent.includes(${JSON.stringify(title)}))`;
  const status = () => `[...document.querySelectorAll('.statusbar .status-item')].map((n) => n.textContent).join(' | ')`;
  const closeDialog = `[...document.querySelectorAll('.dlg-foot .btn-secondary')].find((b) => /^(Cancel|Close)$/.test(b.textContent.trim()))`;
  await waitFor(`!!document.querySelector('.statusbar')`, 20000);

  // ── from the title bar ────────────────────────────────────────────────
  await sleep(600);
  check("a project with no repository has no door to a shift it could not run", !(await $(`!!${test("titlebar-night-shift")}`)));
  ctx.repos.create({ projectId: project.id, name: "alpha", remote: "https://example.com/alpha.git" });
  const reloaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await reloaded;
  await waitFor(`!!document.querySelector('.statusbar')`, 20000);
  check("with a repository, the title bar offers a night shift", await waitFor(`!!${test("titlebar-night-shift")}`));
  await shot("night-shift-entry");
  await press(test("titlebar-night-shift"));
  check("the title bar opens the dialog", await waitFor(`!!${test("night-shift-pick")}`));
  await press(closeDialog);
  await waitFor(`!${test("night-shift-pick")}`);

  // ── from the palette ──────────────────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));true`);
  check("the palette offers a night shift", await waitFor(`[...document.querySelectorAll('.palette-row')].some((r) => r.textContent.includes('Start a night shift'))`));
  await press(`[...document.querySelectorAll('.palette-row')].find((r) => r.textContent.includes('Start a night shift'))`);
  check("which opens the dialog", await waitFor(`!!${test("night-shift-pick")}`));
  await waitFor(`!!${candidate("Add the export button")}`);

  // ── choosing ──────────────────────────────────────────────────────────
  check("To Do is chosen, Backlog is not", await $(`${candidate("Add the export button")}.querySelector('input').checked && ${candidate("Write the export docs")}.querySelector('input').checked && !${candidate("A long one")}.querySelector('input').checked`));
  check("a dependant says it needs automatic merging", (await $(`${candidate("Write the export docs")}.textContent`)).includes("starts only with automatic merging"));
  await press(test("night-shift-auto-merge"));
  check("with it on, it says what it waits for", await waitFor(`${candidate("Write the export docs")}.textContent.includes('After AL-')  && !${candidate("Write the export docs")}.textContent.includes('only with')`));

  // ── where it runs ─────────────────────────────────────────────────────
  const pressed = () => $(`${test("night-shift-mode")}.querySelector('[aria-pressed="true"]').dataset.mode`);
  await press(`${test("night-shift-mode")}.querySelector('[data-mode="run"]')`);
  check("sessions can be picked", await waitFor(`${test("night-shift-mode")}.querySelector('[data-mode="run"]').getAttribute('aria-pressed') === 'true'`));
  await press(`${test("night-shift-mode")}.querySelector('[data-mode="terminal"]')`);
  check("and terminal panes", await waitFor(`${test("night-shift-mode")}.querySelector('[data-mode="terminal"]').getAttribute('aria-pressed') === 'true'`), await pressed());
  check("in a terminal it says the agent's own permissions apply", await waitFor(`!!${test("night-shift-terminal-permissions")}`));
  await shot("night-shift-setup");

  // ── a narrow window, Glass ────────────────────────────────────────────
  const fits = () => $(`(() => { const s = document.querySelector('.palette'); return !!s && s.scrollWidth <= s.clientWidth + 1 && s.getBoundingClientRect().right <= innerWidth; })()`);
  win.setSize(760, 620);
  await sleep(400);
  check("nothing spills out of a narrow window", await fits());
  await shot("night-shift-narrow");
  await $(`document.documentElement.classList.add('glass');true`);
  await sleep(300);
  check("nor under Glass", await fits());
  await shot("night-shift-glass");
  await $(`document.documentElement.classList.remove('glass');true`);
  win.setSize(1500, 900);
  await sleep(300);

  // ── going ─────────────────────────────────────────────────────────────
  // finding the agents on this machine takes a moment, and the button waits for them
  check("the start button waits for an agent", await waitFor(`${test("night-shift-start")}?.disabled === false`, 30000));
  await press(test("night-shift-start"));
  check("it starts in the place chosen, upstream first", await waitFor(`!!${test("night-shift-going")}`) && (await (async () => { for (let i = 0; i < 50 && !starts.length; i++) await sleep(100); return starts[0]?.itemId === first.id && starts[0]?.mode === "terminal"; })()), starts);
  check("its dependant waits", starts.length === 1, starts);
  check("the setting is kept on the shift", ctx.nightShift.current(project.id)?.settings.mode === "terminal" && ctx.nightShift.current(project.id)?.settings.autoMerge === true);
  check("the dialog says where it runs", await waitFor(`${text("night-shift-going")}.includes('In terminal panes')`));
  check("the status bar shows it", await waitFor(`(${status()}).includes('Night shift 0/2')`), await $(status()));
  check("the title bar says how far along it is", await waitFor(`${text("titlebar-night-shift")}.includes('0/2')`), await $(text("titlebar-night-shift")));

  ctx.items.update(project.id, first.id, { status: "verifying" }, "human");
  await ctx.nightShift.tick();
  check("a delivery moves the count, in the dialog and on the status bar", (await waitFor(`${text("night-shift-going")}.includes('1 of 2 delivered')`)) && (await waitFor(`(${status()}).includes('Night shift 1/2')`)), await $(text("night-shift-going")));
  await shot("night-shift-going");
  const current = ctx.nightShift.current.bind(ctx.nightShift);
  ctx.nightShift.current = (id) => { const shift = current(id); return shift && { ...shift, counts: { ...shift.counts, "needs-you": 1 } }; };
  ctx.ipc.send("nightShift.changed", project.id);
  check("the title bar shows a ticket waiting for you", await waitFor(`${test("titlebar-night-shift")}.title.includes('1 need you') && !!${test("titlebar-night-shift")}.querySelector('.titlebar-night-shift-waiting')`), await $(`${test("titlebar-night-shift")}.title`));
  await press(closeDialog);
  check("the dialog closes", await waitFor(`!${test("night-shift-going")}`));
  await sleep(300);
  await shot("night-shift-entry-waiting");
  const barFits = () => $(`(() => { const bar = document.querySelector('.titlebar').getBoundingClientRect(); const last = document.querySelector('.titlebar > :last-child').getBoundingClientRect(); return last.right <= bar.right; })()`);
  for (const width of [1500, 1280, 1100]) {
    win.setSize(width, 900);
    await sleep(300);
    check(`at ${width} wide, with a shift going, settings stay on the bar`, await barFits(), await $(`document.querySelector('.titlebar').clientWidth`));
    check(`and the waiting count shows`, await $(`${test("titlebar-night-shift")}.querySelector('.titlebar-night-shift-waiting').getBoundingClientRect().width > 0`));
  }
  await shot("night-shift-entry-tight");
  win.setSize(1500, 900);
  await sleep(300);
  await press(test("titlebar-night-shift"));
  await waitFor(`!!${test("night-shift-going")}`);
  ctx.nightShift.current = current;
  ctx.ipc.send("nightShift.changed", project.id);

  // ── stopping ──────────────────────────────────────────────────────────
  await press(test("night-shift-stop"));
  check("Stop halts it", await waitFor(`${text("night-shift-going")}.includes('Stopping') || !!${test("night-shift-pick")}`));
  await ctx.nightShift.tick();
  await sleep(200);
  check("no new ticket started", starts.length === 1, starts);
  check("the status bar lets go once it ends", await waitFor(`!(${status()}).includes('Night shift')`), await $(status()));
  check("the title bar goes back to offering one", await waitFor(`${test("titlebar-night-shift")}.title === 'Start the night shift'`), await $(`${test("titlebar-night-shift")}.title`));
  check("the dialog says how the last one went", await waitFor(`${text("night-shift-last")}.includes('Stopped: 1 of 2 delivered')`), await $(text("night-shift-last")));
  check("the morning report lands in Files, with a way to it from the dialog", await waitFor(`!!${test("night-shift-brief")}`), ctx.nightShift.list(project.id, 1)[0]?.briefPath);
  const brief = ctx.nightShift.list(project.id, 1)[0]?.briefPath;
  const written = brief ? (await ctx.files.read(project.id, brief)) : null;
  check("and it says what happened", !!written && String(written.body ?? written).includes("It was stopped before it finished."), written);
  await shot("night-shift-stopped");
  await press(test("night-shift-brief"));
  check("the link opens the report", await waitFor(`location.hash.includes('/f/')`), await $(`location.hash`));
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
