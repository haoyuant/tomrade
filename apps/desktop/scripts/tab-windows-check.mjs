/**
 * Tab windows regression: the real renderer, IPC, plugins and window code
 * over a throwaway userData.
 * - A file tab moves into a window of its own from its menu, and closes here;
 *   Backlog opens in one and stays; Routines moves; a tab dragged out of the
 *   window and let go there moves too.
 * - The new window starts on that tab with a strip of its own, the assistant
 *   folded, and never writes over the main window's remembered tabs.
 * - The next one opens where the last was left, stepped off one still there.
 * - App-wide prompts land in the leading window only; closing it hands the
 *   role to the next oldest.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:tab-windows
 */
import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { TomradeWindows } from "../dist/windows.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-tab-windows-"));
const shots = process.env.TOMRADE_SHOTS || path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
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
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });
  const project = ctx.projects.create({ name: "Tab windows", keyPrefix: "TW" });
  await ctx.storage.ready;
  const board = ctx.boards.defaultFor(project.id);
  ctx.items.create({ projectId: project.id, boardId: board.id, title: "A ticket on the board", by: "human" });
  await ctx.files.write(project.id, "docs/brief.md", "# The brief\n\nA first draft.\n");
  await ctx.files.write(project.id, "readme.md", "# Readme\n");
  await ctx.files.write(project.id, "notes.txt", "plain notes\n");
  const views = ctx.views.listForProject(project.id).sort((a, b) => a.rank - b.rank);

  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  const placesFile = path.join(work, "window-places.json");
  const windows = new TomradeWindows(ctx, { preload: path.join(dir, "../preload.cjs"), uiIndex: "", icon: path.join(dir, "../assets/icon.png"), devServerUrl: `${base}#/p/${project.id}` }, placesFile);
  ctx.ipc.handle("windows.openTab", (tab) => void windows.open(tab));

  const main = windows.open();
  const on = (win) => {
    // The windows are on screen: the person's own mouse passing over one would end a drag the check is making.
    win.setIgnoreMouseEvents(true);
    const $ = (js) => win.webContents.executeJavaScript(js, true);
    const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
    return {
      win,
      $,
      has,
      tabs: () => $(`[...document.querySelectorAll('.tab-strip [role=tab]')].map((n) => (n.getAttribute('aria-selected') === 'true' ? '*' : '') + (n.dataset.tab === 'backlog' ? 'Backlog' : n.dataset.tab))`),
      route: () => $(`decodeURIComponent(location.hash)`),
      rightClick: (selector) =>
        $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 4, clientY: r.y + 4 })); return true; })()`),
      clickMenuItem: (name) =>
        $(`(() => { const row = [...document.querySelectorAll('.menu.is-floating .menu-row')].find((r) => r.querySelector('.m-name')?.textContent === ${JSON.stringify(name)}); if (!row) return false; row.click(); return true; })()`),
      shot: async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG())
    };
  };
  const logErrors = (win) =>
    win.webContents.on("console-message", (event) => {
      if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
  logErrors(main);
  const wait = async (cond, what = "condition") => {
    for (let i = 0; i < 100; i++) {
      if (await cond().catch(() => false)) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /** The window opened since `before`, once its strip is up. */
  const newWindow = async (before) => {
    await wait(async () => windows.all().length > before.length, "a new window");
    const win = windows.all().find((w) => !before.includes(w));
    if (!win) return null;
    logErrors(win);
    const w = on(win);
    await wait(() => w.has(".tab-strip"), "the new window's strip");
    await sleep(400);
    return w;
  };
  const storedTabs = (w) => w.$(`JSON.parse(localStorage.getItem('tomrade.tabs.${project.id}') ?? 'null')?.tabs.map((t) => t.path)`);

  const m = on(main);
  await wait(() => m.has(".tab-strip"), "the main window's strip");
  await m.$(`location.hash = '#/p/${project.id}/f/docs/brief.md'; true`);
  await wait(async () => same(await m.tabs(), ["Backlog", "*docs/brief.md"]), "the brief");
  await m.$(`location.hash = '#/p/${project.id}/f/readme.md'; true`);
  await wait(async () => same(await m.tabs(), ["Backlog", "docs/brief.md", "*readme.md"]), "the readme");
  check("the main window is not a detached one", (await m.$(`window.tomrade.window.detached`)) === false);
  check("its assistant is open, as the machine left it", await m.has("aside.ai"));

  // ── a file tab moves ──────────────────────────────────────────────────
  let before = windows.all();
  await m.rightClick('.tab[data-tab="docs/brief.md"]');
  await sleep(200);
  await m.shot("tab-windows-00-menu");
  check("a file tab's menu offers to move it to a new window", await wait(() => m.clickMenuItem("Move to new window"), "the menu item"));
  const brief = await newWindow(before);
  check("a second Tomrade window opened", !!brief && windows.all().length === 2);
  if (!brief) return;
  check("it starts on the moved tab, with a strip of its own", await wait(async () => same(await brief.tabs(), ["Backlog", "*docs/brief.md"])), await brief.tabs());
  check("and shows the file", await wait(async () => (await brief.route()).endsWith("/f/docs/brief.md")), await brief.route());
  check("the tab left the main window, which stays on what it showed", await wait(async () => same(await m.tabs(), ["Backlog", "*readme.md"])), await m.tabs());
  check("the new window knows it is one a tab moved into", (await brief.$(`window.tomrade.window.detached`)) === true);
  check("it starts with the assistant folded", (await brief.has(".ai-rail")) && !(await brief.has("aside.ai")));
  check("the main window keeps its assistant", await m.has("aside.ai"));
  check("the new window's place is remembered at once", !!JSON.parse(fs.readFileSync(placesFile, "utf8"))["tab-window"]);
  await brief.shot("tab-windows-01-moved");

  await brief.$(`location.hash = '#/p/${project.id}/f/notes.txt'; true`);
  check("a file opened there joins that window's strip", await wait(async () => same(await brief.tabs(), ["Backlog", "docs/brief.md", "*notes.txt"])), await brief.tabs());
  await sleep(300);
  check("the main window's remembered tabs are untouched by it", same(await storedTabs(m), ["readme.md"]), await storedTabs(m));
  check("the new window keeps its tabs to itself", same(await brief.$(`JSON.parse(sessionStorage.getItem('tomrade.tabs.${project.id}')).tabs.map((t) => t.path)`), ["docs/brief.md", "notes.txt"]));

  // ── one window leads ──────────────────────────────────────────────────
  ctx.ipc.send("settings.show", "about");
  check("Settings asked for by the shell opens in the leading window", await wait(() => m.has(".sheet-settings"), "Settings in the main window"));
  await sleep(300);
  check("and not in the other", !(await brief.has(".sheet-settings")));
  await m.$(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await wait(async () => !(await m.has(".sheet-settings")), "Settings closed");
  ctx.ipc.send("app.open", { projectId: project.id, path: "docs/brief.md" });
  check("a followed link opens in the leading window", await wait(async () => (await m.route()).endsWith("/f/docs/brief.md")), await m.route());
  await sleep(300);
  check("and leaves the other where it was", (await brief.route()).endsWith("/f/notes.txt"), await brief.route());

  // ── where the next one goes ───────────────────────────────────────────
  const wa = brief.win;
  wa.unmaximize();
  wa.setBounds({ x: 160, y: 120, width: 1000, height: 700 });
  await sleep(600);
  const placed = wa.getNormalBounds();
  check("moving it is remembered", same(JSON.parse(fs.readFileSync(placesFile, "utf8"))["tab-window"], placed), JSON.parse(fs.readFileSync(placesFile, "utf8")));

  before = windows.all();
  await m.rightClick('.tab[data-tab="backlog"]');
  check("Backlog's menu offers to open it in a new window", await wait(() => m.clickMenuItem("Open in new window"), "the menu item"));
  const board2 = await newWindow(before);
  check("a window opens on the board", !!board2 && (await wait(async () => (await board2.route()).includes(`/v/${views[0].id}`))), board2 && (await board2.route()));
  if (!board2) return;
  check("Backlog stays in the main window", same(await m.tabs(), ["Backlog", "readme.md", "*docs/brief.md"]), await m.tabs());
  const b2 = board2.win.getNormalBounds();
  check("it opens where the last one was left, stepped off the one still standing there", b2.x === placed.x + 28 && b2.y === placed.y + 28 && b2.width === placed.width, { placed, b2 });

  // ── Routines moves ────────────────────────────────────────────────────
  await m.$(`location.hash = '#/p/${project.id}/r'; true`);
  await wait(async () => same(await m.tabs(), ["Backlog", "*routines", "readme.md", "docs/brief.md"]), "Routines");
  before = windows.all();
  await m.rightClick('.tab[data-tab="routines"]');
  check("Routines' menu offers to move it", await wait(() => m.clickMenuItem("Move to new window"), "the menu item"));
  const routines = await newWindow(before);
  check("Routines opens in a window of its own", !!routines && (await wait(async () => (await routines.route()).endsWith("/r"))));
  check("and leaves the main window, which shows the next tab", await wait(async () => same(await m.tabs(), ["Backlog", "*readme.md", "docs/brief.md"])), await m.tabs());

  // ── a tab dragged out ─────────────────────────────────────────────────
  const at = await m.$(`(() => { const r = document.querySelector('.tab[data-tab="docs/brief.md"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  before = windows.all();
  main.focus();
  main.webContents.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
  for (const step of [1, 2, 3, 4]) {
    main.webContents.sendInputEvent({ type: "mouseMove", x: at.x - step * 40, y: at.y - step * 30, button: "left", modifiers: ["leftButtonDown"] });
    await sleep(40);
  }
  const out = { x: -40, y: -60 };
  main.webContents.sendInputEvent({ type: "mouseMove", x: out.x, y: out.y, button: "left", modifiers: ["leftButtonDown"] });
  await sleep(80);
  const leaving = await m.$(`document.querySelector('.tab[data-tab="docs/brief.md"]')?.dataset.drag ?? null`);
  main.webContents.sendInputEvent({ type: "mouseUp", x: out.x, y: out.y, button: "left", clickCount: 1 });
  check("a tab dragged out of the window fades while it is out there", leaving === "out", leaving);
  const dropped = await newWindow(before);
  check("let go out there, it opens in a window of its own", !!dropped && (await wait(async () => (await dropped.route()).endsWith("/f/docs/brief.md"))));
  check("and leaves the main window", await wait(async () => same(await m.tabs(), ["Backlog", "*readme.md"])), await m.tabs());

  // A drag that ends inside the window is no move, and no click either.
  const n = windows.all().length;
  const readme = await m.$(`(() => { const r = document.querySelector('.tab[data-tab="backlog"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  main.webContents.sendInputEvent({ type: "mouseDown", x: readme.x, y: readme.y, button: "left", clickCount: 1 });
  main.webContents.sendInputEvent({ type: "mouseMove", x: readme.x + 60, y: readme.y + 200, button: "left", modifiers: ["leftButtonDown"] });
  await sleep(60);
  main.webContents.sendInputEvent({ type: "mouseUp", x: readme.x + 60, y: readme.y + 200, button: "left", clickCount: 1 });
  await sleep(600);
  check("a drag let go inside the window opens nothing", windows.all().length === n && (await m.route()).endsWith("/f/readme.md"), await m.route());

  // ── the lead passes on ────────────────────────────────────────────────
  main.close();
  await wait(async () => main.isDestroyed(), "the main window closed");
  await sleep(500);
  check("the next oldest window now leads", windows.lead() === brief.win);
  ctx.ipc.send("settings.show", "about");
  check("and Settings asked for by the shell opens there", await wait(() => brief.has(".sheet-settings"), "Settings in the brief window"));
  await sleep(300);
  check("in that one alone", !(await board2.has(".sheet-settings")) && !(await routines.has(".sheet-settings")));
  await brief.shot("tab-windows-02-lead");
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
