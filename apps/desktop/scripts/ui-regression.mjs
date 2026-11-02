/**
 * UI regression: drives the REAL UI against the REAL plugins, booted from the
 * app's own tomrade.yml over a throwaway SQLite file seeded with the design's
 * sample project. Checks the interactions the design specifies, then captures
 * a screenshot per screen and per theme into scripts/shots/.
 *
 *   pnpm --filter @tomrade/desktop test:ui        (needs the dev server up)
 */
import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { seedDesignProject } from "./seed.mjs";
import { agentLinks, changedLinks } from "./agent-links.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/";
const SHOTS = path.join(__dirname, "shots");
// Two checkouts can run this side by side when each names its own folder.
const WORK = process.env.TOMRADE_UI_WORK ?? "/tmp/tomrade-ui-regression";

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
app.setPath("userData", WORK);

const results = [];
// What the person's agents name as Tomrade before this run, to find unchanged at its end.
const linksBefore = agentLinks();
const check = (name, cond) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  // The same composition the app boots, patched by id: MCP on a free port so a
  // running Tomrade never collides with the harness.
  const { ctx } = await boot({
    configFile: path.join(__dirname, "../tomrade.yml"),
    vars: { userData: WORK },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]]
  });
  // A fresh userData has no Hub folder; the app would open on the setup screen.
  // Choosing one here is what a first run does, so every project gets a folder.
  ctx.hub.configure(path.join(WORK, "hub"));
  // The projects plugin seeds a default project on boot; the design's sample data is the whole fixture.
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  // Hints and setup cards are taught once, in their own check; these checks are about everything else.
  ctx.settings.set({ ...ctx.settings.get(), onboarding: { seen: ["*"] } });
  const repos = { dbFor: (id) => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos };
  const { project, repo: sampleRepo } = seedDesignProject(repos);

  const win = new BrowserWindow({
    width: 1560,
    height: 940,
    show: !!process.env.TOMRADE_SHOW,
    webPreferences: { preload: path.join(__dirname, "../preload.cjs"), contextIsolation: true }
  });
  // The renderer's console is the only place a blank page explains itself.
  win.webContents.on("console-message", (event) => {
    const { level, message, lineNumber, sourceId } = event;
    if (level === "error" || level === "warning" || String(level) === "2" || String(level) === "3") console.log(`[renderer ${level}] ${message} (${sourceId}:${lineNumber})`);
  });
  await win.loadURL(DEV_URL);
  await sleep(3500);

  const $ = (js) => win.webContents.executeJavaScript(js, true);
  /* React tracks the last value it wrote, so a controlled input needs the native setter. */
  const typeInto = (selector, text) =>
    $(`(() => {
      const i = document.querySelector('${selector}');
      if (!i) return false;
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  /* The editable fields are native <select>s, and React tracks the last value
     it wrote there too — so the option has to be set through the setter. */
  const pick = (nodeExpr, value) =>
    $(`(() => {
      const s = ${nodeExpr};
      if (!s) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)});
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  /* Radix opens menus on pointerdown, so a bare .click() never reaches them. */
  const press = (selector) =>
    $(`(() => {
      const n = ${selector};
      if (!n) return false;
      for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      }
      return true;
    })()`);
  const shot = async (name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG());
  };
  /* Every overlay centres on the workspace row — the window less the titlebar
     and the status bar — not on the window. Measured, because a dialog that
     forgets `.modal` silently inherits the palette's 96px top anchor and still
     looks plausible in isolation. */
  const checkCentred = async (name, selector = ".palette.modal") =>
    check(
      `${name} is centred on the workspace row`,
      await $(`(() => {
        const n = document.querySelector('${selector}');
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const px = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v));
        const top = px('--titlebar-h'), bottom = px('--statusbar-h');
        const wantY = top + (innerHeight - top - bottom) / 2;
        return Math.abs(r.top + r.height / 2 - wantY) <= 1 && Math.abs(r.left + r.width / 2 - innerWidth / 2) <= 1;
      })()`)
    );
  /* The ThemeProvider owns the class, so a theme must be set through a real
     control: the settings sheet's own switch on the projects home, the palette
     inside a project. */
  const SEGMENT = { sunrise: 0, daybreak: 1, glass: 2, sakura: 3, dawn: 4, light: 5, dark: 6, matcha: 7 };
  const settingsNav = (label) => `[...document.querySelectorAll('.dlg-nav .side-row')].find(r => r.textContent.trim() === '${label}')`;
  const themeViaSettings = async (theme) => {
    await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}));true`);
    await sleep(800);
    await press(`document.querySelectorAll('.dlg-body .theme-seg')[${SEGMENT[theme]}]`);
    await sleep(600);
    await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
    await sleep(700);
  };
  const THEME_LABEL = { light: "Paper", dark: "Ink", matcha: "Matcha" };
  const themeViaPalette = async (theme) => {
    await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
    await sleep(500);
    await typeInto(".palette-input", `Theme · ${THEME_LABEL[theme]}`);
    await sleep(400);
    await press(`document.querySelector('.palette-row')`);
    await sleep(900);
  };

  // ── projects home ───────────────────────────────────────────────────
  // the stored preference is 'system', so pin a theme before the first shot
  await themeViaSettings("light");
  const projectCards = await $(`document.querySelectorAll('.proj').length`);
  check("projects home renders a card per project", projectCards === 2);
  check("project card shows board and issue counts", (await $(`document.querySelectorAll('.proj .stat-v').length`)) >= 6);
  await shot("01-projects-paper");
  await themeViaSettings("dark");
  await shot("02-projects-ink");
  await themeViaSettings("matcha");
  await shot("03-projects-matcha");
  await themeViaSettings("light");
  check("the projects home leaves the theme to settings", (await $(`!!document.querySelector('.statusbar .theme-seg')`)) === false);
  check("connecting an outside agent starts folded, in plain words", (await $(`(() => { const d = document.querySelector('.agents-connect'); return !!d && !d.open && !/baseVersion|optimistic|update_item/.test(document.body.innerText); })()`)) === true);

  // ── enter the project ───────────────────────────────────────────────
  await $(`document.querySelectorAll('.proj')[0].click();true`);
  await sleep(1800);
  check("project route resolves to a view", /\/p\/.+\/v\/.+/.test(await $(`location.hash`)));
  const allViews = repos.views.listForProject(project.id);
  check("sidebar lists every saved view", (await $(`document.querySelectorAll('.side-row.is-view').length`)) === allViews.length);
  check("the project opens on its first view", (await $(`location.hash`)).includes(allViews[0].id));
  check("one sidebar row is current", (await $(`document.querySelectorAll('.side-row[aria-current="true"]').length`)) === 1);
  check("query bar offers a filter and the three axes", (await $(`!!document.querySelector('.qb-add') && !!document.querySelector('.qb-column-by') && !!document.querySelector('.qb-group-by') && !!document.querySelector('.qb-sort')`)) === true);
  check("the view head switches between three layouts", (await $(`document.querySelectorAll('.layout-seg button[data-layout]').length`)) === 3);
  check("a saved view is not marked unsaved", (await $(`!!document.querySelector('.view-dirty')`)) === false);
  const columns = await $(`document.querySelectorAll('.col').length`);
  check("board renders the view's columns", columns >= 4);
  check("cards render with a mono issue key", (await $(`!!document.querySelector('.card .card-id')?.textContent.match(/^TOM-\\d+$/)`)) === true);
  check("column numbers are zero-padded", (await $(`document.querySelector('.col-num')?.textContent`)) === "01");
  check("provenance ticks appear in the card gutter", (await $(`document.querySelectorAll('.card .prov-tick').length`)) > 0);
  check("cards name their workstream when the view does not pin one", (await $(`document.querySelectorAll('.card-board').length`)) > 0);
  check("the sidebar lists the workstreams", (await $(`document.querySelectorAll('.side-row.is-workstream').length`)) === repos.boards.list(project.id).length);
  await shot("04-board-paper");

  // ── a workstream row is a place of its own ──────────────────────────
  await press(`document.querySelector('.side-row.is-workstream')`);
  await sleep(900);
  check("a workstream row opens the workstream's page", /\/p\/.+\/w\/.+/.test(await $(`location.hash`)) && (await $(`!!document.querySelector('.qb-chip[data-field="board"]')`)) === true);
  check("the workstream reads as current and no view does", (await $(`document.querySelectorAll('.side-row.is-workstream[aria-current="true"]').length`)) === 1 && (await $(`document.querySelectorAll('.side-row.is-view[aria-current="true"]').length`)) === 0);
  check("a workstream page offers Save as new, not Save view", (await $(`!!document.querySelector('.qb-save-as') && !document.querySelector('.qb-save') && !document.querySelector('.view-menu-btn')`)) === true);
  await press(`document.querySelector('.side-row.is-view[data-view="${allViews[0].id}"]')`);
  await sleep(900);
  check("opening a view leaves the workstream", /\/p\/.+\/v\/.+/.test(await $(`location.hash`)) && (await $(`document.querySelectorAll('.side-row.is-workstream[aria-current="true"]').length`)) === 0);
  const workstreamsBefore = repos.boards.list(project.id).length;
  await press(`document.querySelector('.side-new-workstream')`);
  await sleep(400);
  await typeInto('input[aria-label="New workstream name"]', "Docs");
  await $(`document.querySelector('input[aria-label="New workstream name"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true`);
  await sleep(1200);
  check("creating a workstream from the sidebar writes it", repos.boards.list(project.id).length === workstreamsBefore + 1);
  await $(`document.querySelector('.toast .btn-ghost').click();true`);
  await sleep(1000);
  check("its toast undoes the create", repos.boards.list(project.id).length === workstreamsBefore);
  check("the view head offers fields", (await $(`!!document.querySelector('.view-head .view-fields-btn')`)) === true);
  check("project settings appear once, pinned below the scrolling body", (await $(`document.querySelectorAll('.side-project-settings').length === 1 && !document.querySelector('.side-scroll .side-project-settings') && document.querySelector('.sidebar').lastElementChild.contains(document.querySelector('.side-project-settings'))`)) === true);
  check("…bolder and larger than a nav row, with an accessible name", (await $(`(() => { const b = document.querySelector('.side-project-settings'); const row = document.querySelector('.side-row.is-view'); const cs = getComputedStyle(b); return Number(cs.fontWeight) >= 600 && parseFloat(cs.fontSize) > parseFloat(getComputedStyle(row).fontSize) && b.getAttribute('aria-label') === 'Project settings'; })()`)) === true);

  // ── the roster is sortable: a drop writes the view's rank ────────────
  const rosterBefore = repos.views.listForProject(project.id).map((v) => v.id);
  {
    const box = await $(`(() => {
      const rows = [...document.querySelectorAll('.side-row.is-view')];
      const a = rows[1].getBoundingClientRect(), b = rows[0].getBoundingClientRect();
      return { x0: Math.round(a.left + a.width / 2), y0: Math.round(a.top + a.height / 2), x1: Math.round(b.left + b.width / 2), y1: Math.round(b.top + 4) };
    })()`);
    const send = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1 });
    send("mouseDown", box.x0, box.y0);
    for (let i = 1; i <= 12; i++) {
      send("mouseMove", box.x0, Math.round(box.y0 + ((box.y1 - box.y0) * i) / 12));
      await sleep(35);
    }
    await sleep(200);
    send("mouseUp", box.x1, box.y1);
    await sleep(1400);
  }
  const rosterAfter = repos.views.listForProject(project.id).map((v) => v.id);
  check("dragging a view row above another reorders the roster", rosterAfter[0] === rosterBefore[1] && rosterAfter[1] === rosterBefore[0]);
  check("the sidebar draws the saved order", (await $(`document.querySelectorAll('.side-row.is-view')[0].dataset.view`)) === rosterBefore[1]);
  // put the roster back for the sections that follow; a direct write, so the sidebar redraws on its next refetch
  repos.views.update(project.id, rosterBefore[1], { rank: repos.views.get(project.id, rosterBefore[0]).rank + 0.5 });
  await sleep(600);

  // ── keyboard move: ⌥← ⌥→ is the same write path as a drag ───────────
  const keysOnBoard = await $(`[...document.querySelectorAll('.card .card-id')].map(n => n.textContent).join(',')`);
  const before = repos.items
    .list({ projectId: project.id })
    .find((i) => i.status === "doing" && i.kind === "ticket" && keysOnBoard.split(",").includes(i.key));
  if (!before) throw new Error(`no draggable card on screen; keys=${keysOnBoard}`);
  await $(`(() => { const c=[...document.querySelectorAll('.card')].find(n=>n.textContent.includes('${before.key}')); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true})); return true; })()`);
  await sleep(900);
  const after = repos.items.get(project.id, before.id);
  check("⌥→ moves the focused card one column", after.status !== before.status);
  check("the move bumped the version", after.version === before.version + 1);
  check("a toast offers the undo", (await $(`document.querySelectorAll('.toast').length`)) > 0);
  check("focus follows the card into its new column", (await $(`document.activeElement?.dataset?.id`)) === before.id);
  await shot("05-board-toast");
  // plain arrows only move focus: down the column, then across to the next one
  {
    const focusedId = () => $(`document.activeElement?.dataset?.id ?? null`);
    const press = (key) => $(`(() => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',bubbles:true})); return true; })()`);
    const versions = () => JSON.stringify(repos.items.list({ projectId: project.id }).map((i) => i.version));
    const written = versions();
    const start = await focusedId();
    await press("ArrowDown");
    await sleep(150);
    const below = await focusedId();
    await press("ArrowLeft");
    await sleep(150);
    const beside = await focusedId();
    check("arrow keys move focus between cards and write nothing", !!below && below !== start && !!beside && beside !== below && versions() === written, { start, below, beside });
    // Enter hands focus to the opened ticket; Escape gives it back to the card
    await press("Enter");
    await sleep(500);
    check("opening a card from the keyboard puts focus in its pane", (await $(`document.activeElement?.matches('aside.detail') ?? false`)) === true);
    await $(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
    await sleep(400);
    check("closing it with Escape returns focus to the card", (await focusedId()) === beside && (await $(`!document.querySelector('aside.detail')`)) === true);
  }

  await $(`document.querySelector('.toast .btn-ghost').click();true`);
  await sleep(900);
  check("the toast's Undo reverts the move", repos.items.get(project.id, before.id).status === before.status);
  check("and says what it took back", (await $(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Reverted ${before.key}'))`)) === true);
  // a toast's Undo takes back its own write only: once something newer stands, it says so and leaves it
  await $(`(() => { const c=[...document.querySelectorAll('.card')].find(n=>n.textContent.includes('${before.key}')); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true})); return true; })()`);
  await sleep(900);
  const moved = repos.items.get(project.id, before.id);
  repos.items.update(project.id, before.id, { priority: moved.priority === 3 ? 2 : 3 }, "human");
  const newer = repos.items.get(project.id, before.id);
  await sleep(300);
  await $(`[...document.querySelectorAll('.toast')].reverse().find((t) => t.querySelector('.btn-ghost')?.textContent?.trim() === 'Undo')?.querySelector('.btn-ghost')?.click();true`);
  await sleep(900);
  const now = repos.items.get(project.id, before.id);
  check("an older toast's Undo leaves a newer change alone", now.status === moved.status && now.priority === newer.priority);
  check("…and says it changed since", (await $(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('changed again after that'))`)) === true);
  repos.items.update(project.id, before.id, { status: before.status, priority: before.priority }, "human");
  await sleep(600);

  // ── pointer drag: dnd-kit's own path, not the keyboard twin ─────────
  // dnd-kit ignores synthetic events, so this uses trusted OS-level input.
  const dragged = repos.items.list({ projectId: project.id }).find((i) => i.status === "verifying" && keysOnBoard.split(",").includes(i.key));
  if (dragged) {
    const box = await $(`(() => {
      const card = [...document.querySelectorAll('.card')].find(n => n.textContent.includes('${dragged.key}'));
      const target = [...document.querySelectorAll('.col')].find(c => c.textContent.includes('Doing'));
      if (!card || !target) return null;
      const a = card.getBoundingClientRect(), b = target.querySelector('.col-body').getBoundingClientRect();
      return { x0: Math.round(a.left + a.width / 2), y0: Math.round(a.top + 18), x1: Math.round(b.left + b.width / 2), y1: Math.round(b.top + 40) };
    })()`);
    if (box) {
      const send = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1 });
      send("mouseDown", box.x0, box.y0);
      for (let i = 1; i <= 16; i++) {
        send("mouseMove", Math.round(box.x0 + ((box.x1 - box.x0) * i) / 16), Math.round(box.y0 + ((box.y1 - box.y0) * i) / 16));
        await sleep(35);
      }
      await sleep(200);
      send("mouseUp", box.x1, box.y1);
      await sleep(1600);
    }
    const landed = repos.items.get(project.id, dragged.id);
    check("a pointer drag writes the column's field", landed.status === "doing");
    check("a status drop leaves the workstream alone", landed.boardId === dragged.boardId);
    if (landed.status === "doing") await shot("21-after-drag");
    repos.items.update(project.id, dragged.id, { status: "verifying" }, "human");
    await $(`location.reload();true`);
    await sleep(3200);
  }

  // ── order survives the round trip ───────────────────────────────────
  // A rank computed in the wrong domain lands the card elsewhere after the
  // refetch, and a tie writes a rank that changes nothing — both only show up on
  // the SECOND drag, once a neighbour already carries a view_item_rank row.
  const columnOrder = () =>
    $(`(() => {
      const col = [...document.querySelectorAll('.col')].find(c => c.textContent.includes('Doing'));
      return [...col.querySelectorAll('.card .card-id')].map(n => n.textContent).join(',');
    })()`);
  const dragInto = async (key, columnName, slot) => {
    const box = await $(`(() => {
      const card = [...document.querySelectorAll('.card')].find(n => n.textContent.includes('${key}'));
      const col = [...document.querySelectorAll('.col')].find(c => c.textContent.includes('${columnName}'));
      if (!card || !col) return null;
      const a = card.getBoundingClientRect(), b = col.querySelector('.col-body').getBoundingClientRect();
      return { x0: Math.round(a.left + a.width / 2), y0: Math.round(a.top + 18), x1: Math.round(b.left + b.width / 2), y1: Math.round(b.top + ${slot}) };
    })()`);
    if (!box) return false;
    const send = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1 });
    send("mouseDown", box.x0, box.y0);
    for (let i = 1; i <= 16; i++) {
      send("mouseMove", Math.round(box.x0 + ((box.x1 - box.x0) * i) / 16), Math.round(box.y0 + ((box.y1 - box.y0) * i) / 16));
      await sleep(35);
    }
    await sleep(200);
    send("mouseUp", box.x1, box.y1);
    await sleep(1500);
    return true;
  };
  const first = repos.items.list({ projectId: project.id }).find((i) => i.status === "verifying" && keysOnBoard.split(",").includes(i.key));
  if (first && (await dragInto(first.key, "Doing", 40))) {
    const second = repos.items.list({ projectId: project.id }).find((i) => i.status === "verifying" && keysOnBoard.split(",").includes(i.key));
    if (second) await dragInto(second.key, "Doing", 200);
    const shown = await columnOrder();
    await $(`location.reload();true`);
    await sleep(3200);
    check("the dropped order survives a refetch", (await columnOrder()) === shown);
    check(
      "neither drag changed the workstream",
      [first.key, second?.key].filter(Boolean).every((k) => repos.items.getByKey(project.id, k)?.boardId === first.boardId)
    );
    await shot("22-drag-order");
    for (const key of [first.key, second?.key].filter(Boolean)) {
      const item = repos.items.getByKey(project.id, key);
      if (item) repos.items.update(project.id, item.id, { status: "verifying" }, "human");
    }
    await $(`location.reload();true`);
    await sleep(3200);
  }

  // ── the first sort of a tied column: one write, one ⌘Z ──────────────
  // With every card at the same rank there is no midpoint, so the drop renumbers
  // the column — as one history entry, not one per card.
  {
    const viewId = (await $(`location.hash`)).match(/\/v\/([^/?]+)/)?.[1];
    const db = repos.dbFor(project.id);
    const inDoing = repos.items.list({ projectId: project.id }).filter((i) => i.status === "doing" && keysOnBoard.split(",").includes(i.key));
    if (viewId && inDoing.length >= 3) {
      db.prepare("DELETE FROM view_item_rank WHERE view_id = ?").run(viewId);
      for (const item of inDoing) repos.items.update(project.id, item.id, { rank: 0 }, "human");
      await $(`location.reload();true`);
      await sleep(3200);
      const rankOps = () => db.prepare("SELECT COUNT(*) AS n FROM oplog WHERE op = 'rank'").get().n;
      const rowsBefore = rankOps();
      // the top card, dropped between the second and third: both neighbours sit at the same rank
      const box = await $(`(() => {
        const col = [...document.querySelectorAll('.col')].find(c => c.textContent.includes('Doing'));
        // at this width the column can sit behind the assistant panel
        col.scrollIntoView({ block: 'nearest', inline: 'start' });
        const cards = [...col.querySelectorAll('.card')];
        const a = cards[0].getBoundingClientRect(), b = cards[1].getBoundingClientRect();
        return { x0: Math.round(a.left + a.width / 2), y0: Math.round(a.top + 18), x1: Math.round(b.left + b.width / 2), y1: Math.round(b.bottom - 6) };
      })()`);
      const send = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1 });
      send("mouseDown", box.x0, box.y0);
      for (let i = 1; i <= 16; i++) {
        send("mouseMove", Math.round(box.x0 + ((box.x1 - box.x0) * i) / 16), Math.round(box.y0 + ((box.y1 - box.y0) * i) / 16));
        await sleep(35);
      }
      await sleep(200);
      send("mouseUp", box.x1, box.y1);
      await sleep(1500);
      const placed = Object.keys(repos.views.ranks(project.id, viewId)).length;
      check("the first sort of a tied column is one history entry", rankOps() === rowsBefore + 1 && placed >= 2, { entries: rankOps() - rowsBefore, placed });
      await $(`document.body.focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,bubbles:true}));true`);
      await sleep(1200);
      check("and one ⌘Z puts the whole column back", Object.keys(repos.views.ranks(project.id, viewId)).length === 0, repos.views.ranks(project.id, viewId));
      for (const item of inDoing) repos.items.update(project.id, item.id, { rank: item.rank }, "human");
      await $(`location.reload();true`);
      await sleep(3200);
    }
  }

  // ── conflict: an agent write the board has not seen ─────────────────
  const raced = repos.items.list({ projectId: project.id }).find((i) => i.status === "todo" && i.kind === "ticket" && keysOnBoard.split(",").includes(i.key));
  repos.items.update(project.id, raced.id, { priority: 4 }, "ai:mcp");
  await $(`(() => { const c=[...document.querySelectorAll('.card')].find(n=>n.textContent.includes('${raced.key}')); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true})); return true; })()`);
  await sleep(1200);
  check("a stale move raises the conflict banner", (await $(`!!document.querySelector('.banner[role="alert"]')`)) === true);
  check("the conflict left the issue alone", repos.items.get(project.id, raced.id).status === "todo");
  await shot("22-conflict-banner");
  await press(`document.querySelector('.banner .btn-ghost')`);
  await sleep(500);
  check("the banner dismisses", (await $(`!!document.querySelector('.banner')`)) === false);

  // ── filters ─────────────────────────────────────────────────────────
  // The filter menu lists every filterable field; a choice field stays in the
  // menu as a counted check list, so one filter is two presses.
  const menuRow = (text) => `[...document.querySelectorAll('.menu-row')].find(r => r.textContent.trim().startsWith('${text}'))`;
  await press(`document.querySelector('.qb-add')`);
  await sleep(500);
  check("the filter menu lists the fields", (await $(`document.querySelectorAll('.menu-row').length`)) >= 8);
  await press(menuRow("Labels"));
  await sleep(500);
  check("a choice field opens as a counted check list", (await $(`document.querySelectorAll('.menu-row[aria-checked]').length`)) > 0);
  await shot("06-filter-menu");
  const shown = await $(`document.querySelectorAll('.card').length`);
  await press(`document.querySelectorAll('.menu-row[aria-checked]')[0]`);
  await sleep(700);
  check("selecting a label narrows the board", (await $(`document.querySelectorAll('.card').length`)) < shown);
  check("the menu stays open for multi-select", (await $(`document.querySelectorAll('.menu-row[aria-checked]').length`)) > 0);
  await press(`document.querySelector('.view-title')`);
  await sleep(400);
  check("a pointer outside dismisses the menu", (await $(`document.querySelectorAll('.menu-row').length`)) === 0);
  check("an armed filter reads as a chip", (await $(`!!document.querySelector('.qb-chip[data-field="labels"]')`)) === true);
  check("drift from the saved view offers Save view", (await $(`!!document.querySelector('.qb-dirty .qb-save')`)) === true);
  check("and marks the head unsaved", (await $(`!!document.querySelector('.view-dirty')`)) === true);
  await shot("07-board-filtered");
  await press(`document.querySelector('.qb-discard')`);
  await sleep(600);
  check("Discard returns to the saved view", (await $(`!!document.querySelector('.qb-chip')`)) === false && (await $(`!!document.querySelector('.qb-dirty')`)) === false);
  // re-picking the view you are already on must not throw the live query away
  await press(`document.querySelector('.qb-add')`);
  await sleep(400);
  await press(menuRow("Labels"));
  await sleep(400);
  await press(`document.querySelectorAll('.menu-row[aria-checked]')[0]`);
  await sleep(500);
  await press(`document.querySelector('.view-title')`);
  await sleep(400);
  await press(`document.querySelector('.side-row[aria-current="true"]')`);
  await sleep(700);
  check("re-picking the current view keeps the live query", (await $(`!!document.querySelector('.qb-chip[data-field="labels"]')`)) === true);
  await press(`document.querySelector('.qb-discard')`);
  await sleep(600);

  // ── column by ───────────────────────────────────────────────────────
  await press(`document.querySelector('.qb-column-by')`);
  await sleep(500);
  await press(menuRow("Priority"));
  await sleep(700);
  check("column by priority relabels the columns", (await $(`document.querySelector('.col-name')?.textContent`)) === "Urgent");
  await shot("08-board-by-priority");
  await press(`document.querySelector('.qb-column-by')`);
  await sleep(400);
  await press(menuRow("Workstream"));
  await sleep(700);
  check("column by workstream makes one column per workstream", (await $(`document.querySelectorAll('.col').length`)) === repos.boards.list(project.id).length);
  await shot("08a-board-by-workstream");
  await press(`document.querySelector('.qb-discard')`);
  await sleep(600);

  // ── dependency graph ────────────────────────────────────────────────
  // The Graph layout draws the graph @tomradex/deps-graph contributes: same
  // filtered set, arranged as blocker → blocked. Expectations are computed
  // from the repository, so the section holds whatever the seed contains.
  await press(`document.querySelector('.layout-seg button[data-layout="graph"]')`);
  await sleep(1400);
  check("the graph layout renders the canvas", (await $(`!!document.querySelector('.graph-region .react-flow')`)) === true);
  check("switching layout is a draft, not a write", (await $(`!!document.querySelector('.qb-dirty')`)) === true && repos.views.get(project.id, allViews[0].id).layout === "board");
  const ownedNow = () => repos.items.list({ projectId: project.id }).filter((i) => i.kind !== "epic");
  const edgesAmong = (owned) => {
    const ids = new Set(owned.map((i) => i.id));
    return owned.flatMap((i) => i.blocks.filter((t) => ids.has(t))).length;
  };
  const graphOwned = ownedNow();
  check("the graph draws a card node per owned issue", (await $(`document.querySelectorAll('.react-flow__node .card').length`)) === graphOwned.length);
  check("the dependencies draw as arrows", (await $(`document.querySelectorAll('.react-flow__edge').length`)) === edgesAmong(graphOwned));
  check("fitting the graph keeps cards readable", (await $(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`)) >= 0.649);
  check("every edge is drawn in a colour the theme defines", (await $(`[...document.querySelectorAll('.react-flow__edge-path')].every((p) => { const c = getComputedStyle(p).stroke; return c && c !== 'none' && !c.startsWith('rgba(0, 0, 0, 0)'); })`)) === true);

  await press(`document.querySelector('.react-flow__node .card')`);
  await sleep(900);
  check("a graph node opens the detail pane", (await $(`!!document.querySelector('.detail')`)) === true);

  // Edit the dependency from the pane while the graph is on screen: the write
  // goes through Item.blocks, and the canvas refetches the arrows.
  const depKey = await $(`document.querySelector('.detail .card-id')?.textContent`);
  const depOpen = () => repos.items.list({ projectId: project.id }).find((i) => i.key === depKey);
  const reaches = (fromId, toId) => {
    const byId = new Map(repos.items.list({ projectId: project.id }).map((i) => [i.id, i]));
    const queue = [fromId];
    const seen = new Set();
    while (queue.length) {
      for (const next of byId.get(queue.pop())?.blocks ?? []) {
        if (next === toId) return true;
        if (!seen.has(next)) seen.add(next), queue.push(next);
      }
    }
    return false;
  };
  const depSel = depOpen();
  const depTarget = graphOwned.find((c) => c.id !== depSel.id && !depSel.blocks.includes(c.id) && !reaches(c.id, depSel.id));
  const depEdgesBefore = await $(`document.querySelectorAll('.react-flow__edge').length`);
  await press(`document.querySelectorAll('.detail .field-row')[5].querySelector('.lab-add')`);
  await sleep(300);
  await typeInto(".detail .dep-in", `${depTarget.key} ${depTarget.title}`);
  await $(`(() => { const i = document.querySelector('.detail .dep-in'); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
  await sleep(1100);
  check("the Blocks field writes the dependency", depOpen().blocks.includes(depTarget.id));
  check("the canvas picks the new arrow up", (await $(`document.querySelectorAll('.react-flow__edge').length`)) === depEdgesBefore + 1);
  await shot("08b-graph-dependencies");

  await press(`[...document.querySelectorAll('.detail .field-row')[5].querySelectorAll('.lab.dep')].find(c => c.textContent.includes('${depTarget.key}'))?.querySelector('.lab-x')`);
  await sleep(1100);
  check("the chip's × cuts the link again", !depOpen().blocks.includes(depTarget.id));

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(400);
  await press(`document.querySelector('.qb-discard')`);
  await sleep(700);
  check("discarding the layout change returns to the board", (await $(`document.querySelectorAll('.col').length`)) >= 4);

  // ── table layout ────────────────────────────────────────────────────
  await press(`document.querySelector('.layout-seg button[data-layout="table"]')`);
  await sleep(1000);
  check("the table layout lists every visible issue as a row", (await $(`document.querySelectorAll('tr.tbl-row').length`)) === ownedNow().length);
  check("the table shows the layout's default fields", (await $(`[...document.querySelectorAll('th.tbl-cell[data-field]')].map(h => h.dataset.field).join()`)) === "title,status,priority,epic,labels,board,updated");
  await press(`document.querySelector('th.tbl-cell[data-field="priority"] .tbl-th-btn')`);
  await sleep(700);
  check("a header click sorts the table by that field", (await $(`document.querySelector('th.tbl-cell[data-field="priority"] [data-sort]')?.dataset.sort`)) === "asc");
  check("and the sort menu says so", (await $(`document.querySelector('.qb-sort .qb-val')?.textContent`)).includes("Priority"));
  const firstRowKey = await $(`document.querySelector('tr.tbl-row .card-id')?.textContent`);
  check("the top row is the most urgent", repos.items.getByKey(project.id, firstRowKey)?.priority === Math.max(...ownedNow().map((i) => i.priority)));
  await press(`document.querySelector('.qb-group-by')`);
  await sleep(400);
  await press(menuRow("Status"));
  await sleep(700);
  check("group by status sections the table", (await $(`document.querySelectorAll('tr.tbl-group').length`)) >= 3);
  await shot("08c-table-grouped");
  const rowStatus = await $(`document.querySelector('tr.tbl-row td.tbl-cell[data-field="status"] select')?.value`);
  const rowKey = await $(`document.querySelector('tr.tbl-row .card-id')?.textContent`);
  await pick(`document.querySelector('tr.tbl-row td.tbl-cell[data-field="status"] select')`, rowStatus === "doing" ? "verifying" : "doing");
  await sleep(900);
  check("a table cell writes through the same path", repos.items.getByKey(project.id, rowKey)?.status === (rowStatus === "doing" ? "verifying" : "doing"));
  await $(`document.querySelector('.toast .btn-ghost').click();true`);
  await sleep(900);
  await press(`document.querySelector('.qb-discard')`);
  await sleep(700);

  // ── detail pane ─────────────────────────────────────────────────────
  await $(`document.querySelector('.card').click();true`);
  await sleep(900);
  check("a card opens the detail pane", (await $(`!!document.querySelector('.detail')`)) === true);
  // sidebar, board, detail and assistant side by side: nothing runs off the window or under a neighbour
  await $(`localStorage.setItem("tomrade.ai.width", "924"); true`);
  if (await $(`!!document.querySelector('.ai-rail button')`)) await press(`document.querySelector('.ai-rail button')`);
  await sleep(500);
  check("with the detail open, a wide assistant gives way so all four panes fit", (await $(`(() => {
    const board = document.querySelector('section.board-region')?.getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth && !!board && board.width >= 361 && !!document.querySelector('aside.ai:not(.rail)') && document.querySelector('aside.ai').getBoundingClientRect().right <= innerWidth + 1;
  })()`)) === true);
  check("and the board's own chrome stays inside the board", (await $(`(() => {
    const right = document.querySelector('section.board-region').getBoundingClientRect().right;
    return ![...document.querySelectorAll('.board-region .board-head *, .board-region .query-bar *')].some((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && getComputedStyle(e).display !== 'none' && b.right > right + 1; });
  })()`)) === true);
  await $(`localStorage.removeItem("tomrade.ai.width"); true`);
  const customCount = repos.fields.custom(project.id).length;
  check("the detail prints the field strip, custom fields included", (await $(`document.querySelectorAll('.detail .field-row').length`)) === 9 + customCount);
  check("custom fields follow the built-ins", (await $(`document.querySelectorAll('.detail .field-row[data-field]').length`)) === customCount);
  check("the activity ledger reads the oplog", (await $(`document.querySelectorAll('.detail .ledger-row').length`)) > 0);
  check("the detail says History, not oplog, and keeps the version number out of the fields", (await $(`(() => { const d = document.querySelector('.detail'); return !/oplog/i.test(d.innerText) && ![...d.querySelectorAll('.field-row dt')].some(n => n.textContent === 'Version'); })()`)) === true);
  check("writers are named in words, not author ids", (await $(`!/\\b(human|ai:[a-z-]+)\\b/.test(document.querySelector('.detail .ledger').innerText + ' ' + document.querySelector('.statusbar').innerText)`)) === true);
  check("the writable fields render as controls", (await $(`document.querySelectorAll('.detail .fsel').length`)) === 5);
  await shot("09-detail-docked");

  // ── editing an issue in place ────────────────────────────────────────
  // Every field goes through the same optimistic-lock write as an agent's,
  // so the assertions are made against the repository, not the DOM.
  const openKey = await $(`document.querySelector('.detail .card-id')?.textContent`);
  const open = () => repos.items.list({ projectId: project.id }).find((i) => i.key === openKey);
  const opened = open();

  const wantStatus = opened.status === "verifying" ? "doing" : "verifying";
  await pick(`document.querySelectorAll('.detail .fsel')[0]`, wantStatus);
  await sleep(900);
  check("the status field writes to the issue", open().status === wantStatus);
  check("the edit bumped the version", open().version === opened.version + 1);
  check("the edit is one reversible oplog row", ctx.oplog.historyFor(project.id, "item", opened.id, 1)[0]?.op === "update");

  const wantPriority = opened.priority === 4 ? "1" : "4";
  await pick(`document.querySelectorAll('.detail .fsel')[1]`, wantPriority);
  await sleep(900);
  check("the priority field writes to the issue", String(open().priority) === wantPriority);

  await press(`document.querySelector('.detail .lab-add')`);
  await sleep(400);
  check("the label field offers an input", (await $(`!!document.querySelector('.detail .lab-in')`)) === true);
  await typeInto(".detail .lab-in", "regression");
  await $(`document.querySelector('.detail .lab-in').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true`);
  await sleep(900);
  check("a label typed into the field lands on the issue", open().labels.includes("regression"));

  await press(`document.querySelector('.detail .lab .lab-x')`);
  await sleep(900);
  check("a label chip can be taken back off", open().labels.length === opened.labels.length);

  await press(`document.querySelector('.detail-title .inline-edit')`);
  await sleep(400);
  check("the title becomes a textarea in place", (await $(`!!document.querySelector('textarea.detail-title')`)) === true);
  await $(`(() => {
    const t = document.querySelector('textarea.detail-title');
    t.value = 'Edited by the regression harness';
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  check("Enter commits the retitle", open().title === "Edited by the regression harness");

  await press(`document.querySelector('.detail-title .inline-edit')`);
  await sleep(400);
  await $(`(() => {
    const t = document.querySelector('textarea.detail-title');
    t.value = 'Discarded';
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  check("Escape discards the edit instead of committing it", open().title === "Edited by the regression harness");

  // ── writes made elsewhere arrive without a reload ─────────────────────
  repos.items.update(project.id, opened.id, { title: "Renamed over MCP" }, "ai:mcp");
  await sleep(900);
  check("a write an agent makes shows in the open pane without a reload", (await $(`document.querySelector('.detail-title')?.textContent ?? ''`)).includes("Renamed over MCP"));
  // An edit that loses the race to such a write keeps what was typed, ready to send again.
  await press(`document.querySelector('.detail-title .inline-edit')`);
  await sleep(400);
  repos.items.update(project.id, opened.id, { priority: open().priority === 3 ? 2 : 3 }, "ai:mcp");
  await $(`(() => {
    const t = document.querySelector('textarea.detail-title');
    t.value = 'Typed while an agent wrote';
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(1200);
  check("a refused title edit reopens with what was typed", (await $(`document.querySelector('textarea.detail-title')?.value`)) === "Typed while an agent wrote" && open().title === "Renamed over MCP");
  await $(`document.querySelector('textarea.detail-title').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));true`);
  await sleep(900);
  check("and Enter again saves it over the fresh version", open().title === "Typed while an agent wrote");
  repos.items.update(project.id, opened.id, { title: "Edited by the regression harness" }, "human");
  await sleep(700);

  // ── the description is Markdown ──────────────────────────────────────
  const BODY = ".detail [data-testid='issue-body']";
  const EDITOR = ".detail .body-editor";
  const bodyKey = (k, opts = {}) =>
    $(`(() => { const n = document.querySelector("${EDITOR} .cm-content"); if (!n) return false; n.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true, ...${JSON.stringify(opts)} })); return true; })()`);
  const seedBody = open().body ?? "";
  await press(`document.querySelector("${BODY} p") ?? document.querySelector("${BODY}")`);
  await sleep(600);
  check("clicking the description opens the Markdown editor", (await $(`!!document.querySelector("${EDITOR} .cm-content")`)) === true);
  check("the editor holds the source", (await $(`[...document.querySelectorAll("${EDITOR} .cm-line")].map(l => l.textContent).join('\\n')`)) === seedBody);
  await bodyKey("a", { metaKey: true });
  await win.webContents.insertText("## Scope\n\n- [x] parse the feed\n- [ ] retry on 429\n\nfirst line\nsecond line [the doc](notes/plan.md)");
  await press(`[...document.querySelectorAll("${EDITOR} .seg button")].find(b => b.getAttribute('aria-pressed') === 'false')`);
  await sleep(500);
  check("Preview renders the draft as it stands", (await $(`!!document.querySelector("${EDITOR} .body-editor-preview h2")`)) === true);
  await press(`[...document.querySelectorAll("${EDITOR} .seg button")].find(b => b.getAttribute('aria-pressed') === 'false')`);
  await sleep(300);
  await bodyKey("Enter", { metaKey: true });
  await sleep(1000);
  check("⌘↵ saves the description", open().body?.startsWith("## Scope\n\n- [x] parse the feed") === true);
  check("saving closes the editor", (await $(`!!document.querySelector("${EDITOR}")`)) === false);
  check("the description renders its Markdown", (await $(`!!document.querySelector("${BODY} h2") && document.querySelectorAll("${BODY} li").length === 2`)) === true);
  check("task items draw their boxes, ticked and not", (await $(`[...document.querySelectorAll("${BODY} .md-task")].map(b => b.getAttribute('aria-checked')).join()`)) === "true,false");
  check("a single newline is a line break, as on GitHub", (await $(`!!document.querySelector("${BODY} p br")`)) === true);
  await press(`document.querySelector("${BODY} a")`);
  await sleep(400);
  check("a link in the description is not a way into its editor", (await $(`!!document.querySelector("${EDITOR}")`)) === false);

  const savedBody = open().body;
  await press(`document.querySelector("${BODY} p")`);
  await sleep(600);
  await win.webContents.insertText(" Not kept.");
  await bodyKey("Escape");
  await sleep(400);
  check("Escape on an edited description asks before discarding", (await $(`!!document.querySelector("${EDITOR} .body-editor-changed[role=alert]")`)) === true && open().body === savedBody);
  await bodyKey("Escape");
  await sleep(600);
  check("a second Escape discards the edit", open().body === savedBody && (await $(`!!document.querySelector("${EDITOR}")`)) === false);
  check("…without closing the pane around it", (await $(`!!document.querySelector('.detail')`)) === true);

  // an edit in progress is on disk as it is typed, so a quit or a crash leaves it to pick up
  const draftKey = `tomrade.bodyDraft.${project.id}:${opened.id}`;
  await press(`document.querySelector("${BODY} p")`);
  await sleep(600);
  await win.webContents.insertText(" Kept on disk.");
  await sleep(800);
  check("an edit in progress is kept on disk as it is typed", (await $(`JSON.parse(localStorage.getItem(${JSON.stringify(draftKey)}) ?? "{}").text ?? ""`)).endsWith(" Kept on disk."));
  await bodyKey("Escape");
  await sleep(300);
  await bodyKey("Escape");
  await sleep(600);
  check("discarding the edit drops that copy too", (await $(`localStorage.getItem(${JSON.stringify(draftKey)})`)) === null);
  // what a crash leaves behind: the draft on disk and nothing written
  await $(`localStorage.setItem(${JSON.stringify(draftKey)}, ${JSON.stringify(JSON.stringify({ text: `${savedBody} Left by a crash.`, base: savedBody, drafts: [], uploaded: [] }))});true`);
  await $(`location.reload();true`);
  await sleep(3200);
  if (!(await $(`!!document.querySelector('.detail')`))) {
    await $(`[...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-id')?.textContent === ${JSON.stringify(openKey)})?.click();true`);
    await sleep(900);
  }
  check("reopening the ticket picks the draft up in the editor", (await $(`[...document.querySelectorAll("${EDITOR} .cm-line")].map(l => l.textContent).join(' ').includes("Left by a crash.")`)) === true);
  check("…says it is an edit not yet saved", (await $(`!!document.querySelector("${EDITOR} .body-editor-changed.is-restored")`)) === true);
  check("…and wrote nothing meanwhile", open().body === savedBody);
  await press(`document.querySelector("${EDITOR} .is-restored .btn")`);
  await sleep(600);
  check("Discard it drops the draft for good", open().body === savedBody && (await $(`!document.querySelector("${EDITOR}") && localStorage.getItem(${JSON.stringify(draftKey)}) === null`)) === true);

  // an agent writes the body while it is open: the save is refused, the pane
  // re-reads, and the editor asks instead of writing over the agent's text
  await press(`document.querySelector("${BODY} p")`);
  await sleep(600);
  await win.webContents.insertText(" Mine.");
  repos.items.update(project.id, opened.id, { body: `${savedBody}\n\nTheirs.` }, "human");
  await bodyKey("Enter", { metaKey: true });
  await sleep(1200);
  check("a save over a body changed mid-edit is refused", open().body === `${savedBody}\n\nTheirs.`);
  check("…the editor keeps the draft and says what happened", (await $(`!!document.querySelector("${EDITOR} .body-editor-changed")`)) === true);
  await bodyKey("Enter", { metaKey: true });
  await sleep(800);
  check("…and ⌘↵ alone still does not write over it", open().body === `${savedBody}\n\nTheirs.`);
  await press(`document.querySelector("${EDITOR} .body-editor-changed .btn")`);
  await sleep(1000);
  check("Keep mine writes the draft over theirs", open().body === `${savedBody} Mine.`);

  const lockedBefore = open().humanLocked;
  await press(`document.querySelector('.detail-head .btn-ghost')`);
  await sleep(900);
  check("the head toggles the human lock", open().humanLocked === !lockedBefore);

  /* By role, not by position: the head gained a delete button, and the first
     .btn-icon in the pane is no longer the expand toggle. */
  await $(`document.querySelector('.detail [aria-label="Expand detail"]').click();true`);
  await sleep(700);
  check("the detail expands to an overlay", (await $(`!!document.querySelector('.detail.expanded')`)) === true);
  check("the expanded overlay is a real dialog", (await $(`document.querySelector('.detail.expanded')?.getAttribute('role')`)) === "dialog");
  // the trap is the property that matters: Tab off the last control comes back
  // inside rather than walking the board behind the overlay
  const trapped = await $(`(() => {
    const dlg = document.querySelector('.detail.expanded');
    const f = [...dlg.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])')];
    f[f.length - 1].focus();
    return dlg.contains(document.activeElement);
  })()`);
  check("the overlay holds focus inside itself", trapped === true);
  check("focus moves into the overlay", (await $(`!!document.querySelector('.detail.expanded')?.contains(document.activeElement)`)) === true);
  await press(`document.querySelector(".detail.expanded [data-testid='issue-body'] p")`);
  await sleep(600);
  await $(`document.querySelector(".detail.expanded .body-editor .cm-content").dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));true`);
  await sleep(500);
  check("Escape in the overlay's description editor discards the edit, not the overlay",
    (await $(`!!document.querySelector('.detail.expanded') && !document.querySelector('.detail.expanded .body-editor')`)) === true);
  await checkCentred("the expanded issue overlay", ".detail.expanded");
  await shot("10-detail-expanded");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);
  check("Escape collapses the overlay before closing", (await $(`!!document.querySelector('.detail.expanded')`)) === false);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);
  check("a second Escape closes the pane", (await $(`!!document.querySelector('.detail')`)) === false);

  // "?" lists every shortcut, written for this platform
  await $(`document.body.focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}));true`);
  await sleep(500);
  const sheet = await $(`[...document.querySelectorAll('.shortcut-row')].map(r => r.textContent).join(' | ')`);
  check("? opens the keyboard shortcuts", sheet.includes(process.platform === "darwin" ? "⌘K" : "Ctrl+K") && sheet.includes("Move the card a column"), sheet.slice(0, 120));
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(400);
  // a field's edge reads against the page: 3:1
  const edge = await $(`(() => {
    // a 1×1 canvas turns any CSS colour — hex, rgb, oklch — into sRGB bytes
    const g = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
    const bytes = (css) => { g.clearRect(0, 0, 1, 1); g.fillStyle = css; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = (css) => { const [r, gg, b] = bytes(css).map((x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * gg + 0.0722 * b; };
    const i = document.createElement('input'); i.className = 'input'; document.body.append(i);
    const border = getComputedStyle(i).borderTopColor; const surface = getComputedStyle(i).backgroundColor; i.remove();
    const a = lum(border), b = lum(surface);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  })()`);
  check("an input's border has 3:1 contrast against the surface", edge >= 3, edge);

  // ── command palette ─────────────────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(700);
  check("⌘K opens the palette", (await $(`!!document.querySelector('.palette-input')`)) === true);
  check("the palette indexes views, issues and actions", (await $(`document.querySelectorAll('.palette-row').length`)) > 10);
  await shot("11-palette");
  await typeInto(".palette-input", "Theme · Matcha");
  await sleep(600);
  check("typing filters the palette", (await $(`document.querySelectorAll('.palette-row').length`)) === 1);
  await typeInto(".palette-input", "zzzznothing");
  await sleep(400);
  check("the palette's empty state names the term", (await $(`document.querySelector('.palette-empty')?.textContent`)) === "Nothing matches “zzzznothing”.");
  await typeInto(".palette-input", "Theme · Matcha");
  await sleep(400);
  await press(`document.querySelector('.palette-row')`);
  await sleep(900);
  check("a palette action applies the matcha theme", (await $(`document.documentElement.classList.contains('matcha')`)) === true);
  await shot("12-board-matcha");
  await themeViaPalette("dark");
  check("a palette action applies the ink theme", (await $(`document.documentElement.classList.contains('dark')`)) === true);
  await shot("13-board-ink");
  await themeViaPalette("light");
  check("a palette action returns to paper", (await $(`document.documentElement.className`)) === "");

  // ── new view is a real, undoable write ──────────────────────────────
  const viewsBefore = repos.views.listForProject(project.id).length;
  await press(`document.querySelector('.side-new-view')`);
  await sleep(400);
  await typeInto('input[aria-label="New view name"]', "Docs");
  await $(`document.querySelector('input[aria-label="New view name"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true`);
  await sleep(1400);
  check("creating a view writes it", repos.views.listForProject(project.id).length === viewsBefore + 1);
  const docs = repos.views.listForProject(project.id).find((v) => v.name === "Docs");
  check("a new view opens as a board", !!docs && docs.layout === "board" && (await $(`location.hash`)).includes(docs.id));
  check("the ledger records the view create", ctx.oplog.historyFor(project.id, "view", docs.id, 1)[0]?.op === "create");
  await press(`document.querySelector('.view-menu-btn')`);
  await sleep(400);
  await press(`[...document.querySelectorAll('.menu [role="menuitem"]')].find(r => /Delete view/.test(r.textContent))`);
  await sleep(1200);
  check("deleting the view from its menu removes it", repos.views.listForProject(project.id).length === viewsBefore);
  check("and lands on a surviving view", /\/p\/.+\/v\/.+/.test(await $(`location.hash`)) && !(await $(`location.hash`)).includes(docs.id));
  await $(`[...document.querySelectorAll('.toast')].reverse().find((t) => t.textContent.includes('Docs'))?.querySelector('.btn-ghost')?.click();true`);
  await sleep(1200);
  check("the deleted view's toast brings it back", repos.views.listForProject(project.id).some((v) => v.id === docs.id));
  repos.views.remove(project.id, docs.id);
  await sleep(600);
  await press(`document.querySelector('.side-row.is-view[data-view="${allViews[0].id}"]')`);
  await sleep(1000);

  // ── inline composer ─────────────────────────────────────────────────
  const itemsBefore = repos.items.list({ projectId: project.id }).length;
  await $(`[...document.querySelectorAll('.col-body > .btn-ghost')][1].click();true`);
  await sleep(400);
  await $(`(() => { const i=document.querySelector('.col-body .card input'); i.value='Typed straight into the column'; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
  await sleep(1400);
  const nowItems = repos.items.list({ projectId: project.id });
  check("the column composer creates an issue", nowItems.length === itemsBefore + 1);
  const created = nowItems.find((i) => i.title === "Typed straight into the column");
  check("the composer writes the column's own field", created && created.status === "todo");
  check("the new issue continues the key sequence", created && /^TOM-\d+$/.test(created.key));

  // ── dialogs ─────────────────────────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:true,bubbles:true}));true`);
  await sleep(700);
  check("⌘N opens the new-issue sheet", (await $(`!!document.querySelector('#niTitle')`)) === true);
  await checkCentred("the new-issue sheet");
  await shot("14-new-issue");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  // ── fields: workstreams are the Workstream field's options ──────────
  await press(`document.querySelector('.view-fields-btn')`);
  await sleep(900);
  check("the Fields sheet lists the built-ins and the project's own", (await $(`document.querySelectorAll('.fld-row.is-builtin').length`)) === 9 && (await $(`document.querySelectorAll('.fld-row:not(.is-builtin)').length`)) === repos.fields.custom(project.id).length);
  check("a field that opens has its chevron left of its row, and the others keep its place", (await $(`(() => {
    const row = document.querySelector('button.fld-row[data-field="board"]');
    const fold = row?.parentElement.querySelector('.fold-chev');
    const fixed = document.querySelector('div.fld-row.is-builtin');
    return !!fold && !!fixed && fold.getBoundingClientRect().right <= row.getBoundingClientRect().left && Math.abs(fixed.getBoundingClientRect().left - row.getBoundingClientRect().left) < 1;
  })()`)) === true);
  await press(`document.querySelector('button.fld-row[data-field="board"]')`);
  await sleep(600);
  check("the Workstream row opens the workstream editor", (await $(`document.querySelectorAll('.fld-editor[data-editor="workstream"] .fld-ws').length`)) === repos.boards.list(project.id).length);
  const ui = repos.boards.list(project.id).find((b) => b.name === "UI");
  check(
    "a workstream row offers the project's repositories",
    (await $(`[...document.querySelectorAll('.fld-ws[data-board="${ui.id}"] select[aria-label^="Repository of"] option')].map(o => o.textContent).join('|')`)) === `No repository|${sampleRepo.name}|Choose a folder…`
  );
  check("and the path inside the one it stands for", (await $(`document.querySelector('.fld-ws[data-board="${ui.id}"] .fld-ws-path')?.value`)) === "packages/ui");
  check("and says where its agents start", (await $(`document.querySelector('.fld-ws[data-board="${ui.id}"] .fld-ws-where')?.textContent ?? ''`)).includes(`${sampleRepo.name}`) && (await $(`document.querySelector('.fld-ws[data-board="${ui.id}"] .fld-ws-where .num')?.textContent`)) === "packages/ui/");
  check("a workstream without a repository has no path to give", (await $(`document.querySelectorAll('.fld-ws:not([data-board="${ui.id}"]) .fld-ws-path').length`)) === 0);
  // blur is what commits, and blur only fires on an element that had focus
  await $(`(() => { const i = document.querySelector('.fld-ws[data-board="${ui.id}"] input'); i.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Interface'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await sleep(900);
  check("renaming a workstream writes it", repos.boards.get(project.id, ui.id).name === "Interface");
  repos.boards.update(project.id, ui.id, { name: "UI" });
  // A direct repository write never reaches the renderer's cache; the broadcast a sync would send does.
  ctx.get("ipc").send("storage.changed", project.id);
  await sleep(600);
  // by row, not by name: the cache may still be catching up
  await press(`document.querySelector('.fld-ws[data-board="${ui.id}"] button[aria-label^="Remove workstream"]')`);
  await sleep(500);
  check("removing a workstream that holds issues asks where they go", (await $(`!!document.querySelector('select[aria-label="Destination workstream"]')`)) === true);
  check("nothing moved yet", repos.items.list({ boardId: ui.id }).length > 0);
  // ── a select option issues still hold goes only after saying where they go ──
  const area = repos.fields.custom(project.id).find((f) => f.name === "Area");
  const areaOpt = (name) => area.options.find((o) => o.name === name).id;
  const areaOf = (id) => repos.items.get(project.id, id)?.fields[area.id];
  const webHolders = repos.items.list({ projectId: project.id }).filter((i) => i.fields[area.id] === areaOpt("Web")).map((i) => i.id);
  await press(`document.querySelector('button.fld-row[data-field="${area.id}"]')`);
  await sleep(500);
  await press(`document.querySelector('.fld-opt button[aria-label="Remove option Web"]')`);
  await sleep(400);
  check("removing an option issues hold asks first", (await $(`!!document.querySelector('.fld-opt-confirm select[aria-label="What happens to the tickets holding Web"]')`)) === true);
  await shot("15-fields-option-confirm");
  check("and says how many hold it", (await $(`document.querySelector('.fld-opt-confirm p')?.textContent ?? ''`)).startsWith("2 tickets hold Web"));
  check("nothing is cleared before the confirm", webHolders.length === 2 && webHolders.every((id) => areaOf(id) === areaOpt("Web")));
  await pick(`document.querySelector('.fld-opt-confirm select')`, areaOpt("Agent"));
  await press(`document.querySelector('.fld-opt-confirm .btn-danger')`);
  await sleep(700);
  check("confirming with a target moves its issues there", webHolders.every((id) => areaOf(id) === areaOpt("Agent")));
  check("and the option is gone", (await $(`!!document.querySelector('.fld-opt button[aria-label="Remove option Web"]')`)) === false && !repos.fields.custom(project.id).find((f) => f.id === area.id).options.some((o) => o.name === "Web"));
  await typeInto('.fld-editor input[aria-label="New option name"]', "Unused");
  await $(`document.querySelector('.fld-editor input[aria-label="New option name"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true`);
  await sleep(600);
  const added = repos.fields.custom(project.id).find((f) => f.id === area.id).options.some((o) => o.name === "Unused");
  await press(`document.querySelector('.fld-opt button[aria-label="Remove option Unused"]')`);
  await sleep(600);
  check("an option nobody holds goes in one click", added && !repos.fields.custom(project.id).find((f) => f.id === area.id).options.some((o) => o.name === "Unused") && (await $(`!!document.querySelector('.fld-opt-confirm')`)) === false);
  await checkCentred("the fields sheet");
  await shot("15-fields-workstreams");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  // ── the status bar's code item opens the Code inbox ─────────────────
  // a scan gives the code item something to say
  await ctx.codeLink.scan(project.id);
  await sleep(900);
  check("the code status item is a way into the Code inbox", await press(`[...document.querySelectorAll('.statusbar .status-link')].find((n) => /^code/.test(n.textContent ?? ''))`));
  await sleep(700);
  check("…which it opens", (await $(`[...document.querySelectorAll('[role=dialog]')].some((d) => (d.textContent ?? '').includes('Code inbox'))`)) === true);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  // ── project settings: the repositories its workstreams stand for ───
  await press(`document.querySelector('.side-project-settings')`);
  await sleep(900);
  // Settings open on Overview; Repositories is a pane of its own.
  await press(`[...document.querySelectorAll('.project-settings-split .dlg-nav .side-row')].find((b) => (b.textContent ?? '').includes('Repositories'))`);
  await sleep(600);
  check("project settings list the project's repositories", (await $(`document.querySelectorAll('#psRepos .repo-row').length`)) === 1);
  check("a repository is named by its remote", (await $(`document.querySelector('#psRepos .repo-remote')?.textContent`)) === sampleRepo.remote);
  check("and by the workstreams that stand for it", (await $(`[...document.querySelectorAll('#psRepos .repo-workstreams .chip-opt.sel')].map((c) => c.textContent).join()`)).includes("UI"));
  check("with no checkout on this machine, it says so", (await $(`document.querySelector('#psRepos .repo-checkout')?.textContent ?? ''`)).includes("Not set on this machine"));
  check("and waits for an explicit folder before offering clone", (await $(`!!document.querySelector('#psRepos .repo-clone')`)) === false);
  await shot("15-project-repositories");
  // A checkout is believed only when the folder's own origin is that repository.
  const checkoutDir = path.join(WORK, "checkouts", "tomrade");
  fs.mkdirSync(checkoutDir, { recursive: true });
  execSync(`git init -q && git remote add origin ${sampleRepo.remote}`, { cwd: checkoutDir, stdio: "ignore" });
  let refused = null;
  await ctx.repos.setCheckout(sampleRepo.remote, WORK).catch((err) => (refused = err));
  check("a folder that is not that repository is refused", refused !== null);
  await ctx.repos.setCheckout(sampleRepo.remote, checkoutDir);
  await sleep(900);
  check("the checkout set on this machine shows its path", (await $(`document.querySelector('#psRepos .repo-checkout .cfg-name')?.textContent`)) === checkoutDir);
  check("with the run-in-checkout switch off beside it", (await $(`document.querySelector('#psRepos .repo-run-in')?.getAttribute('aria-checked')`)) === "false");
  ctx.repos.clearCheckout(sampleRepo.remote);
  await sleep(700);
  check("clearing it returns the row to unset", (await $(`document.querySelector('#psRepos .repo-checkout')?.textContent ?? ''`)).includes("Not set on this machine"));
  // A folder with no remote is a repository too: chosen as is, it stays on this machine.
  const localDir = path.join(WORK, "checkouts", "local-notes");
  fs.mkdirSync(localDir, { recursive: true });
  execSync(`git init -q -b main && git -c user.email=dev@localhost -c user.name=Dev commit -q --allow-empty -m start`, { cwd: localDir, stdio: "ignore" });
  const showOpenDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [localDir] });
  check("a folder can be chosen as a repository", await press(`document.querySelector('#psRepos .repos-add-folder')`));
  await sleep(1200);
  dialog.showOpenDialog = showOpenDialog;
  const localRepo = ctx.repos.list(project.id).find((r) => r.remote === localDir);
  check("a folder with no remote is added by its path, its checkout already set", !!localRepo && ctx.repos.checkout(localDir).checkout === localDir);
  // Its scan follows any pass already running, so wait for the state rather than call one.
  for (let i = 0; i < 60 && !ctx.codeLink.repoStates(project.id).some((s) => s.repoId === localRepo?.id && s.remote === "none"); i++) await sleep(250);
  await sleep(700);
  check("and reads as a local repository", (await $(`[...document.querySelectorAll('#psRepos .repo-row')].find((r) => r.querySelector('.repo-remote')?.textContent === ${JSON.stringify(localDir)})?.querySelector('.repo-remote-state')?.textContent ?? ''`)).includes("Local repository — no remote"));
  if (localRepo) ctx.repos.remove(project.id, localRepo.id);
  ctx.repos.clearCheckout(localDir);
  await sleep(500);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  await press(`document.querySelector('.view-settings-btn')`);
  await sleep(800);
  check("view settings edits name, layout and the fields shown", (await $(`!!document.querySelector('#vsName') && document.querySelectorAll('.vs-layout button[data-layout]').length === 3 && document.querySelectorAll('.vs-fields .cfg-row[data-field]').length > 6`)) === true);
  check("a board view lists its column space with WIP inputs", (await $(`document.querySelectorAll('.vs-columns .wip-in').length`)) === 6);
  await checkCentred("view settings");
  await shot("16-view-settings");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}));true`);
  await sleep(900);
  check("⌘, opens settings", (await $(`!!document.querySelector('.mode-grid')`)) === true);
  check("an overlay demotes the chrome's primary button", (await $(`document.documentElement.classList.contains('overlay-open')`)) === true);
  check("all three themes preview at once", (await $(`document.querySelectorAll('.mode').length`)) === 3);
  check("a built-in theme is read-only, so no token table is drawn for it", (await $(`!!document.querySelector('.tok-table')`)) === false);
  check("the theme switch reports the preference, not the resolved theme", (await $(`document.querySelectorAll('.dlg-body .theme-seg[aria-pressed="true"]').length`)) === 1);
  // one pane at a time: the menu is what makes the sheet short enough to read
  check("settings opens on a side menu", (await $(`document.querySelectorAll('.dlg-nav .side-row').length`)) >= 4);
  check("exactly one menu row is current", (await $(`document.querySelectorAll('.dlg-nav .side-row[aria-current="true"]').length`)) === 1);
  check("it lands on Appearance", (await $(`document.querySelector('.dlg-body .sec-title')?.textContent`)) === "Appearance");
  check("the card says the theme follows the Hub", (await $(`document.querySelector('.dlg-body .scope-tag')?.textContent`)) === "Follows the Hub");
  await checkCentred("settings");
  await shot("17-settings");
  // ── a custom theme's bin can be undone from the toast ──
  const wait = async (cond, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(150);
    }
    return false;
  };
  const customThemes = () => ctx.settings.get().customThemes?.length ?? 0;
  // the toast stack lies outside the sheet, where a pointer would dismiss it: its buttons are clicked, not pressed
  const clickToast = (selector) => $(`(() => { const b = ${selector}; if (!b) return false; b.click(); return true; })()`);
  await press(`document.querySelector('.mode-grid button[aria-label="Create custom theme"]')`);
  check("creating a custom theme opens its editor", await wait(() => $(`!!document.querySelector('.theme-custom-controls')`)) && customThemes() === 1);
  check("and brings the token table, which only a custom theme can use", (await $(`document.querySelectorAll('.tok-table .token-picker').length`)) === 21);
  await press(`document.querySelector('.theme-custom-controls .icon-btn.danger')`);
  check("its bin deletes it and the toast offers Undo", await wait(() => $(`[...document.querySelectorAll('.toast')].some((n) => (n.textContent ?? '').includes('Deleted the theme') && (n.textContent ?? '').includes('Undo'))`)) && customThemes() === 0);
  await clickToast(`[...document.querySelectorAll('.toast button')].find((b) => (b.textContent ?? '').includes('Undo'))`);
  // The settings change first in the main process; the switch shows it once the window has rendered again.
  const selectedTheme = () => $(`document.querySelector('.dlg-body .theme-switch .theme-seg[aria-pressed="true"]')?.getAttribute('aria-label')`);
  check("Undo brings the theme back, selected again", await wait(async () => customThemes() === 1 && (await selectedTheme()) === "Custom 1") && String(ctx.settings.get().theme).startsWith("custom:"));
  // leave Appearance as it was: the theme gone, its toast dismissed, the pinned built-in theme back
  await press(`document.querySelector('.theme-selection-actions button[aria-label="Edit theme"]')`);
  await wait(() => $(`!!document.querySelector('.theme-custom-controls')`));
  await press(`document.querySelector('.theme-custom-controls .icon-btn.danger')`);
  await wait(() => customThemes() === 0);
  await clickToast(`document.querySelector('.toast .btn-icon[aria-label]')`);
  await press(`document.querySelectorAll('.dlg-body .theme-seg')[${SEGMENT.light}]`);
  await sleep(600);
  const sheetBox = `(() => { const r = document.querySelector('.palette.modal').getBoundingClientRect(); return r.width + 'x' + r.height; })()`;
  const boxOnAppearance = await $(sheetBox);
  await press(settingsNav("MCP servers"));
  await sleep(400);
  check("and the MCP endpoint stays on this machine", (await $(`document.querySelector('.dlg-body .scope-tag')?.textContent`)) === "This machine");
  await sleep(600);
  check("choosing a menu row swaps the pane, agent access heading the MCP one", (await $(`document.querySelector('.dlg-body .sec-title')?.textContent`)) === "Agent access");
  check("and takes the pane it replaced out of the body", (await $(`!!document.querySelector('.mode-grid')`)) === false);
  // the tallest pane and the shortest one leave the sheet exactly the same size
  check("the sheet keeps its frame across panes", (await $(sheetBox)) === boxOnAppearance);
  await checkCentred("settings on its shortest pane");

  // ── language ─────────────────────────────────────────────────────────
  // The stored preference is 'system', and this harness's OS/Electron locale
  // is English, so the sheet — and the html lang attribute — start in English.
  await press(settingsNav("Language"));
  await sleep(600);
  check("the Language pane is reachable from the side menu", (await $(`document.querySelector('.dlg-body .sec-title')?.textContent`)) === "Language");
  check("language defaults to System", (await $(`document.querySelector('.dlg-body .theme-seg[aria-pressed="true"]')?.textContent`)) === "System");
  check("the html lang attribute starts as en", (await $(`document.documentElement.lang`)) === "en");
  await shot("17-settings-language");
  await press(`document.querySelectorAll('.dlg-body .theme-seg')[2]`); // System, English, 中文
  await sleep(700);
  check("choosing 中文 relabels the dialog itself", (await $(`document.querySelector('.dlg-head .dlg-title')?.textContent`)) === "设置");
  check(
    "the side menu re-renders in the chosen language",
    (await $(`[...document.querySelectorAll('.dlg-nav .side-row')].map(r => r.textContent.trim()).join(' | ')`)).includes("外观")
  );
  check("shared vocabulary outside the dialog follows the language too", (await $(`document.querySelector('.dlg-foot .btn-secondary')?.textContent`)) === "完成");
  check("the html lang attribute follows the chosen language", (await $(`document.documentElement.lang`)) === "zh");
  await shot("17-settings-language-zh");
  await press(`document.querySelectorAll('.dlg-body .theme-seg')[1]`); // back to English, so every later check keeps asserting English text
  await sleep(700);
  check("choosing English reverts the dialog", (await $(`document.querySelector('.dlg-head .dlg-title')?.textContent`)) === "Settings");
  check("the html lang attribute reverts to en", (await $(`document.documentElement.lang`)) === "en");

  // ── about ────────────────────────────────────────────────────────────
  // The facts come from this very process, so they are checked against it.
  await press(settingsNav("About"));
  await sleep(700);
  const fact = (name) => `document.querySelector('.about-facts [data-fact="${name}"] dd')?.textContent`;
  check("the About pane is reachable from the side menu", (await $(`document.querySelector('.dlg-body .sec-title')?.textContent`)) === "About Tomrade");
  check("it names the version the app reports", (await $(fact("version"))) === app.getVersion());
  check("and the Electron and Chromium it runs on", (await $(fact("electron"))) === process.versions.electron && (await $(fact("chromium"))) === process.versions.chrome);
  check("and where this machine keeps the app's data", (await $(`document.querySelector('.about-facts .about-path')?.textContent`)) === app.getPath("userData"));
  check("a checkout says so instead of offering a release update", (await $(`!!document.querySelector('.about-version .tag') && !document.querySelector('.about-update button')`)) === true);
  check("the About pane fits the frame the other panes set", (await $(sheetBox)) === boxOnAppearance);
  await shot("17-settings-about");

  await press(`[...document.querySelectorAll('.dlg-foot .btn-secondary')].pop()`);
  await sleep(700);
  check("the demotion lifts with the overlay", (await $(`document.documentElement.classList.contains('overlay-open')`)) === false);

  // opened from the gear, closing has an opener to hand focus back to.
  // A synthetic press does not focus the button the way a real click does.
  await $(`[...document.querySelectorAll('.titlebar .btn-icon')].pop().focus();true`);
  await press(`[...document.querySelectorAll('.titlebar .btn-icon')].pop()`);
  await sleep(800);
  await press(`[...document.querySelectorAll('.dlg-foot .btn-secondary')].pop()`);
  await sleep(800);
  check("closing a dialog hands focus back to whatever opened it", (await $(`document.activeElement?.getAttribute('aria-label')`)) === "Settings");

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(500);
  await typeInto(".palette-input", "About");
  await sleep(400);
  await press(`[...document.querySelectorAll('.palette-row')].find(r => r.textContent.trim() === 'About Tomrade')`);
  await sleep(900);
  check("the palette's About command opens settings on that pane", (await $(`document.querySelector('.dlg-nav .side-row[aria-current="true"]')?.textContent.trim()`)) === "About");
  await press(`[...document.querySelectorAll('.dlg-foot .btn-secondary')].pop()`);
  await sleep(700);

  // ── plugin manager ─────────────────────────────────────────────────
  // A pane of settings, not a sheet of its own. The counts come from the main
  // process, so this checks it against the composition that actually booted
  // rather than against a number typed here.
  const SHEET = `[aria-label="Settings"]`;
  const rowFor = (id) => `document.querySelector('${SHEET} .cfg-row[data-id="${id}"]')`;
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(500);
  await typeInto(".palette-input", "Plugins");
  await sleep(400);
  await press(`[...document.querySelectorAll('.palette-row')].find(r => r.textContent.trim() === 'Plugins')`);
  await sleep(900);
  check("the palette's Plugins command opens settings on that pane", (await $(`document.querySelector('.dlg-nav .side-row[aria-current="true"]')?.textContent.trim()`)) === "Manage plugins");
  check("and stacks no second sheet over settings", (await $(`document.querySelectorAll('.palette.modal').length`)) === 1);
  check(
    "every module is listed with what provides it",
    (await $(`document.querySelectorAll('${SHEET} .tok-table tbody tr').length`)) === ctx.plugins.modules().length
  );
  check("a row is drawn per plugin", (await $(`document.querySelectorAll('${SHEET} .cfg-row').length`)) === ctx.plugins.list().length);
  check("the row credits one plugin with both keys it provides", (await $(`${rowFor("boards")}.textContent.includes('boards, views')`)) === true);
  check("the switch is locked on the only plugin providing a required module", (await $(`!!${rowFor("db")}.querySelector('.switch[disabled]')`)) === true);
  check("and the row names the module it holds", (await $(`${rowFor("db")}.textContent.includes('holds db')`)) === true);
  check("with the reason on the control itself", (await $(`${rowFor("db")}.querySelector('.switch').title.includes('only plugin providing db')`)) === true);
  check("an optional plugin's switch is free", (await $(`!${rowFor("archify")}.querySelector('.switch[disabled]')`)) === true);
  check("the pet is an optional plugin row", (await $(`!${rowFor("pet")}.querySelector('.switch[disabled]')`)) === true);
  check("the manager fits the frame the other panes set", (await $(sheetBox)) === boxOnAppearance);
  await shot("18-plugins");
  await $(`${rowFor("write-policy")}.scrollIntoView({ block: 'center' });true`);
  await sleep(400);
  await shot("18-plugins-installed");

  await press(`${rowFor("archify")}.querySelector('.switch')`);
  await sleep(1200);
  check("the switch unloads the plugin in the main process", ctx.plugins.list().find((p) => p.id === "archify")?.state === "disabled");
  check("its tool leaves the registry", !ctx.tools.list().some((t) => t.name === "diagram_render"));
  check("and the sheet redraws from what loaded", (await $(`${rowFor("archify")}.querySelector('.tag').textContent`)) === "off");
  await press(`${rowFor("archify")}.querySelector('.switch')`);
  await sleep(1200);
  check("switching it back on restores the plugin and its tool", ctx.tools.list().some((t) => t.name === "diagram_render"));

  // ── external MCP servers ─────────────────────────────────────────────
  // Pasted the way a server's README prints it; Electron runs the stdio fixture as plain Node.
  const mcpRow = (id) => `document.querySelector('${SHEET} [data-mcp-server="${id}"]')`;
  const fillArea = (selector, text) =>
    $(`(() => {
      const a = document.querySelector('${selector}');
      if (!a) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(a, ${JSON.stringify(text)});
      a.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  const fixture = path.join(__dirname, "../../../packages/mcp-client/tests/fixtures/stdio-server.mjs");
  await press(settingsNav("MCP servers"));
  await sleep(600);
  // Agent access heads the pane; the servers Tomrade reaches follow it.
  check("MCP servers is a settings pane", (await $(`[...document.querySelectorAll('.dlg-body .sec-title')].map((n) => n.textContent).join('|')`)) === "Agent access|MCP servers");
  check("with nothing connected it says how to start", (await $(`!!document.querySelector('[data-testid="mcp-add"]') && !!document.querySelector('[data-testid="mcp-import-open"]')`)) === true);
  await press(`document.querySelector('[data-testid="mcp-import-open"]')`);
  await sleep(300);
  await fillArea("#mcp-import-text", JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [fixture], env: { ELECTRON_RUN_AS_NODE: "1" } } } }));
  await press(`document.querySelector('[data-testid="mcp-import"] .btn-secondary')`);
  await sleep(900);
  await ctx.mcpClient.settled();
  await sleep(500);
  check("pasting another client's mcpServers JSON saves the server", ctx.settings.get().mcpServers?.servers?.[0]?.id === "fx");
  check("it connects and its tools join the registry", ctx.tools.has("fx__echo") && ctx.tools.has("fx__files_read"));
  check("the row turns connected without a reload", (await $(`${mcpRow("fx")}?.dataset.state`)) === "connected");
  check("its Tools chevron sits outside the server's card, on the left", (await $(`(() => {
    const row = ${mcpRow("fx")};
    const fold = row?.querySelector('[aria-label="Tools"]');
    const card = row?.querySelector('.cfg-row');
    return !!fold && !!card && !card.contains(fold) && fold.getBoundingClientRect().right <= card.getBoundingClientRect().left;
  })()`)) === true);
  await press(`${mcpRow("fx")}.querySelector('[aria-label="Tools"]')`);
  await sleep(400);
  check("the row opens onto the tools it registered", (await $(`document.querySelectorAll('${SHEET} [data-testid="mcp-tools"] tbody tr').length`)) === 9);
  check("the MCP pane keeps the sheet's frame", (await $(sheetBox)) === boxOnAppearance);
  await shot("18-mcp-servers");

  await press(`${mcpRow("fx")}.querySelector('.switch')`);
  await sleep(900);
  check("switching a server off takes its tools away", !ctx.tools.has("fx__echo") && (await $(`${mcpRow("fx")}?.dataset.state`)) === "off");
  await press(`${mcpRow("fx")}.querySelector('.switch')`);
  await sleep(600);
  await ctx.mcpClient.settled();
  await sleep(300);
  check("and back on reconnects it", ctx.tools.has("fx__echo") && (await $(`${mcpRow("fx")}?.dataset.state`)) === "connected");

  await press(`${mcpRow("fx")}.querySelector('[aria-label="Edit"]')`);
  await sleep(400);
  check("editing fills the form from the saved server", (await $(`document.querySelector('#mcp-id')?.value + ' ' + document.querySelector('#mcp-command')?.value`)) === `fx ${process.execPath}`);
  await press(`[...document.querySelectorAll('[data-testid="mcp-form"] .btn-ghost')].find(b => b.textContent === 'Test connection')`);
  await sleep(2500);
  check("testing a configuration lists what the server offers", (await $(`document.querySelector('[data-testid="mcp-test-ok"]')?.textContent ?? ''`)).includes("fixture 1.2.3"));
  await shot("18-mcp-servers-form");
  await typeInto("#mcp-id", "Not Valid");
  await sleep(200);
  check("a name that cannot prefix a tool is refused before saving", (await $(`document.querySelector('#mcp-id').getAttribute('aria-invalid') === 'true' && document.querySelector('[data-testid="mcp-form"] .btn-secondary').disabled`)) === true);
  await press(`[...document.querySelectorAll('[data-testid="mcp-form"] .btn-ghost')].find(b => b.textContent === 'Cancel')`);
  await sleep(300);

  await press(`${mcpRow("fx")}.querySelector('[aria-label="Remove"]')`);
  await sleep(200);
  await press(`${mcpRow("fx")}.querySelector('.btn-danger')`);
  await sleep(900);
  check("removing a server forgets it and its tools", (ctx.settings.get().mcpServers?.servers?.length ?? 0) === 0 && !ctx.tools.list().some((t) => t.name.startsWith("fx__")));
  ctx.settings.set({ ...ctx.settings.get(), mcpServers: { servers: [{ id: "broken", transport: { type: "stdio", command: process.execPath, args: [fixture], env: { ELECTRON_RUN_AS_NODE: "1", FIXTURE_CRASH: "1" } } }] } });
  await ctx.mcpClient.settled();
  // The shipped composition retries after a second; look before it does.
  await sleep(300);
  check("a server that fails says why on its row, and that it will retry", (await $(`${mcpRow("broken")}?.dataset.state === 'failed' && ${mcpRow("broken")}.textContent.includes('missing API key') && ${mcpRow("broken")}.textContent.includes('retrying 1/3')`)) === true);
  await shot("18-mcp-servers-failed");
  ctx.settings.set({ ...ctx.settings.get(), mcpServers: { servers: [] } });
  await sleep(400);
  await press(settingsNav("Manage plugins"));
  await sleep(600);

  await press(`${rowFor("pet")}.querySelector('.switch')`);
  await sleep(900);
  check("switching the pet off unloads its service and accessory", !ctx.get("pet") && ctx.contributions.assistantAccessories().length === 0);
  await press(`${rowFor("pet")}.querySelector('.switch')`);
  await sleep(1200);
  check("switching the pet back on restores its accessory", !!ctx.get("pet") && ctx.contributions.assistantAccessories().some((a) => a.id === "tomrade.pet"));
  const appSettings = ctx.settings.get();
  ctx.settings.set({ ...appSettings, pet: { ...appSettings.pet, displayMode: "desktop" } });
  await sleep(900);
  const petWindow = BrowserWindow.getAllWindows().find((candidate) => candidate !== win && candidate.getTitle() === "Tomrade pet");
  check("desktop mode owns a separate always-on-top window", !!petWindow?.isAlwaysOnTop());
  check("desktop mode removes the embedded contribution", ctx.contributions.assistantAccessories().length === 0);
  check("the desktop surface loads the pet canvas", petWindow ? await petWindow.webContents.executeJavaScript(`!!document.querySelector('#pet')`, true) : false);
  ctx.settings.set({ ...ctx.settings.get(), pet: { ...ctx.settings.get().pet, displayMode: "embedded" } });
  await sleep(700);
  check("returning to embedded mode closes the pet window", !BrowserWindow.getAllWindows().some((candidate) => candidate !== win && candidate.getTitle() === "Tomrade pet"));
  await press(`[...document.querySelectorAll('.dlg-foot .btn-secondary')].pop()`);
  await sleep(700);

  // ── assistant panel ────────────────────────────────────────────────
  check("the assistant panel is docked", (await $(`!!document.querySelector('.ai')`)) === true);
  check("the engine chip names the conductor", (await $(`(document.querySelector('.ai-knobs .chip-btn:not(.ai-ws)')?.textContent ?? '').trim().length > 0`)) === true);
  check("an empty thread introduces the agent", (await $(`!!document.querySelector('.ai-scroll .turn-ai, .ai-scroll .agent-empty')`)) === true);
  // The seeded project has a backlog, so starting one from a product idea is not offered.
  check(
    "an empty thread suggests what to try, without the idea starter once a backlog exists",
    (await $(`[...document.querySelectorAll('.starters .starter')].map(b => b.textContent).join('|')`)) === "What should I work on next?|Tidy up the backlog|Add a ticket…|Write a document…"
  );
  check("the embedded pet stage sits immediately above the composer", (await $(`document.querySelector('.ai-foot > .pet-stage + .ai-composer') !== null`)) === true);
  check("the embedded pet exposes its task state", (await $(`document.querySelector('.pet-stage')?.dataset.petState`)) === "idle");
  // The workstream is a chip beside the engine's, opening a menu — not a form field.
  await press(`document.querySelector('.ai-knobs .ai-ws')`);
  await sleep(500);
  check(
    "the assistant offers the whole project or one workstream",
    (await $(`[...document.querySelectorAll('.menu-row.is-radio .m-name')].map(n => n.textContent).join('|')`)) === ["Whole project", ...repos.boards.list(project.id).map((b) => b.name)].join("|")
  );
  await press(`[...document.querySelectorAll('.menu-row.is-radio')].find(r => r.querySelector('.m-name')?.textContent === 'UI')`);
  await sleep(1400);
  check("picking a workstream starts a thread on it", ctx.agent.store.threads(project.id).some((th) => th.boardId === ui.id));
  check("with no checkout here, the panel says the agent cannot run", (await $(`document.querySelector('.ai-workdir.is-problem')?.textContent ?? ''`)).includes("No local checkout"));
  await typeInto(".ai-input", "hello");
  await sleep(200);
  check("the suggestions step aside once something is typed", (await $(`document.querySelector('.starters') === null`)) === true);
  check("and holds the message until one is set", (await $(`document.querySelector('.ai-send')?.disabled`)) === true);
  check("saying why on the control itself", (await $(`document.querySelector('.ai-send')?.title ?? ''`)).startsWith("No local checkout for"));
  await shot("18-assistant-workstream");
  await press(`document.querySelector('.ai-repos-link')`);
  await sleep(900);
  check("the way out opens project settings on Repositories", (await $(`!!document.querySelector('#psRepos')`)) === true);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(600);
  await press(`document.querySelector('.ai-knobs .ai-ws')`);
  await sleep(500);
  await press(`[...document.querySelectorAll('.menu-row.is-radio')].find(r => r.querySelector('.m-name')?.textContent === 'Whole project')`);
  await sleep(900);
  check("back on the whole project the message may go", (await $(`!document.querySelector('.ai-workdir') && document.querySelector('.ai-send')?.disabled === false`)) === true);
  await typeInto(".ai-input", "");
  // A new thread opens on the engine and knobs the panel is showing, not the settings
  // default. The default is pointed at another engine first, so "kept the thread's
  // engine" and "fell back to the default" are told apart.
  const showing = ctx.agent.store.threads(project.id)[0];
  const elsewhere = (await ctx.agent.engineViews()).find((e) => e.id !== showing.engine)?.id;
  const settingsBefore = ctx.settings.get();
  ctx.settings.set({ ...settingsBefore, agent: { ...settingsBefore.agent, defaultEngine: elsewhere } });
  await press(`[...document.querySelectorAll('.ai-knobs .chip-btn')].find(b => b.title === 'Effort')`);
  await sleep(500);
  await press(`[...document.querySelectorAll('.menu-row.is-radio')].find(r => r.querySelector('.m-name')?.textContent === 'high')`);
  await sleep(1000);
  check("the effort pick lands on the chip", (await $(`[...document.querySelectorAll('.ai-knobs .chip-btn')].find(b => b.title === 'Effort')?.textContent ?? ''`)).includes("high"));
  // the bar's + opens ⌘K on its ways to start: ↵ with nothing typed is a new conversation with the built-in assistant
  await press(`document.querySelector('.ai .sbar button[aria-label="New thread"]')`);
  for (let i = 0; i < 30 && !(await $(`!!document.querySelector('[data-testid="palette-start"]')`)); i++) await sleep(100);
  await $(`document.querySelector('.palette-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));true`);
  await sleep(1400);
  const nextThread = ctx.agent.store.threads(project.id)[0];
  check("a new thread opens on the engine and effort the panel was showing", nextThread.id !== showing.id && nextThread.engine === showing.engine && nextThread.options?.effort === "high");
  check("and the panel is showing it, on the same chips", (await $(`[...document.querySelectorAll('.ai-knobs .chip-btn')].find(b => b.title === 'Effort')?.textContent ?? ''`)).includes("high"));
  ctx.settings.set(settingsBefore);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'j',metaKey:true,bubbles:true}));true`);
  await sleep(600);
  check("⌘J collapses the assistant to its rail", (await $(`!!document.querySelector('.ai-rail')`)) === true);
  await shot("18-assistant-railed");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'j',metaKey:true,bubbles:true}));true`);
  await sleep(600);

  // ── sidebar ─────────────────────────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'b',metaKey:true,bubbles:true}));true`);
  await sleep(600);
  check("⌘B collapses the sidebar to its rail", (await $(`!!document.querySelector('.side-rail') && !document.querySelector('.sidebar')`)) === true);
  check("a railed sidebar hands view switching to the view head", (await $(`getComputedStyle(document.querySelector('.board-nav')).display`)) !== "none");
  check("the collapsed sidebar is remembered", (await $(`localStorage.getItem('tomrade.sidebar.open')`)) === "0");
  check("the rail keeps project settings as a labelled gear", (await $(`document.querySelector('.side-rail .rail-project-settings')?.getAttribute('aria-label')`)) === "Project settings");
  await shot("18-sidebar-railed");
  await press(`document.querySelector('.side-rail .btn-icon')`);
  await sleep(600);
  check("the rail's button brings the sidebar back", (await $(`!!document.querySelector('.sidebar')`)) === true);
  check("the view head's switcher retreats with it", (await $(`getComputedStyle(document.querySelector('.board-nav')).display`)) === "none");

  // ── saved views slice one backlog ───────────────────────────────────
  const bugsView = allViews.find((v) => v.name === "Bugs");
  await press(`document.querySelector('.side-row.is-view[data-view="${bugsView.id}"]')`);
  await sleep(1200);
  const bugTickets = repos.items.list({ projectId: project.id }).filter((i) => i.kind !== "epic" && i.labels.includes("bug"));
  check("a filtered view shows exactly the issues its clauses admit", (await $(`document.querySelectorAll('.card').length`)) === bugTickets.length);
  check("epics are structure, never cards", (await $(`[...document.querySelectorAll('.card-title')].every(n => !/^(Multi-board architecture|Theme token refactor|AI panel|MCP surface)$/.test(n.textContent))`)) === true);
  check("the saved filter reads as a chip", (await $(`!!document.querySelector('.qb-chip[data-field="labels"]')`)) === true);
  const sprint = allViews.find((v) => v.name === "Sprint 12");
  await press(`document.querySelector('.side-row.is-view[data-view="${sprint.id}"]')`);
  await sleep(1400);
  check("a view pinned to a workstream drops the workstream chip from its cards", (await $(`document.querySelectorAll('.card-board').length`)) === 0);
  check("swimlanes group the board by epic", (await $(`document.querySelectorAll('.lanes[data-group-by="epic"] section.lane').length`)) >= 2);
  check("an empty lane renders collapsed", (await $(`document.querySelectorAll('section.lane.collapsed').length`)) > 0);
  check("a WIP cap prints as count / cap", (await $(`[...document.querySelectorAll('.col-count')].some(n => n.textContent.includes('/'))`)) === true);
  await shot("19-view-swimlanes");
  await press(`document.querySelector('.side-row.is-view[data-view="${allViews[0].id}"]')`);
  await sleep(1000);

  // ── standalone issue screen ─────────────────────────────────────────
  const locked = repos.items.list({ projectId: project.id }).find((i) => i.humanLocked);
  await $(`location.hash = '#/p/${project.id}/i/${locked.id}';true`);
  await sleep(1600);
  check("the issue route renders the standalone sheet", (await $(`!!document.querySelector('.issue-wrap')`)) === true);
  check("the ledger names the write, not just 'updated'", (await $(`[...document.querySelectorAll('.ledger-txt')].some(n => /locked title and body|set status to/.test(n.textContent))`)) === true);
  check("the field strip lays out horizontally, custom fields included", (await $(`document.querySelectorAll('.issue-wrap .fs-item').length`)) === 10 + repos.fields.custom(project.id).length);
  check("the standalone sheet is editable too", (await $(`document.querySelectorAll('.issue-wrap .fsel').length`)) === 5);
  check("a locked issue explains the lock", (await $(`!!document.querySelector('.lockbar')`)) === true);
  check("dependencies render as chips that open the issue", (await $(`document.querySelectorAll('.issue-wrap .lab.dep').length`)) >= 3);
  await shot("20-issue-detail");

  // ── permanent delete ────────────────────────────────────────────────
  // Last, deliberately. It is the one write nothing can walk back, so it must
  // never shrink the project under a count an earlier section asserted — and
  // both targets are created here, never a seeded issue another check counts.
  const ownBoard = repos.boards.list(project.id).find((b) => !b.across);
  const doomed = repos.items.create({ title: "Purge me from the sheet", boardId: ownBoard.id, projectId: project.id, by: "human" });
  const doomed2 = repos.items.create({ title: "Purge me from the pane", boardId: ownBoard.id, projectId: project.id, status: "doing", by: "human" });

  /* These two were written behind the renderer's back, and queries hold for
     `staleTime` (30s). A hash change — including one made through loadURL, which
     is a same-document navigation when only the fragment differs — leaves the
     SPA and its cache alive, so the sheet would render "not in this project".
     Reload for a genuinely cold client. */
  await $(`location.hash = '#/p/${project.id}/i/${doomed.id}';true`);
  await sleep(400);
  win.webContents.reload();
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await sleep(2600);
  check("the issue sheet offers a permanent delete", (await $(`!!document.querySelector('.titlebar .purge-btn')`)) === true);
  check("the delete control is not one more field", (await $(`document.querySelectorAll('.issue-wrap .fs-item').length`)) === 10 + repos.fields.custom(project.id).length);

  await $(`document.querySelector('.titlebar .purge-btn').focus();true`);
  await press(`document.querySelector('.titlebar .purge-btn')`);
  await sleep(800);
  check("the permanent delete asks before it destroys", (await $(`!!document.querySelector('.dangerbar')`)) === true);
  check("the confirmation names the issue it will destroy", (await $(`document.querySelector('.dlg-head .tag')?.textContent`)) === doomed.key);
  check("the confirmation says the write is not undoable", (await $(`/not undoable/i.test(document.querySelector('.dangerbar')?.textContent ?? '')`)) === true);
  // focus must land in the sheet but never on the button that destroys
  check(
    "focus opens away from the destructive button",
    (await $(`(() => {
      const dlg = document.querySelector('.palette.modal.sheet-md');
      return !!dlg && dlg.contains(document.activeElement) && !document.activeElement.classList.contains('btn-danger');
    })()`)) === true
  );
  await checkCentred("the delete confirmation", ".palette.modal.sheet-md");
  await shot("23-delete-confirm");

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(700);
  check("Escape cancels the confirmation rather than confirming it", repos.items.get(project.id, doomed.id) !== null);
  check("cancelling closes the sheet", (await $(`!!document.querySelector('.dangerbar')`)) === false);
  // a sheet that closes by unmounting never gives the shared Dialog its
  // open -> false transition, and the restore silently never runs
  check(
    "cancelling hands focus back to the control that opened it",
    (await $(`document.activeElement?.classList.contains('purge-btn')`)) === true
  );

  await press(`document.querySelector('.titlebar .purge-btn')`);
  await sleep(700);
  await press(`document.querySelector('.dlg-foot .btn-danger')`);
  await sleep(1400);
  check("confirming destroys the issue for good", repos.items.get(project.id, doomed.id) === null);
  check("the purge left one tombstone and no history", ctx.oplog.historyFor(project.id, "item", doomed.id, 10).map((o) => o.op).join() === "purge");
  check("deleting the open issue leaves for the project, not a dead sheet", /\/p\/.+\/v\/.+/.test(await $(`location.hash`)));

  // the same control on the docked pane, where the board is what has to react
  await sleep(900);
  await $(`(() => { const c=[...document.querySelectorAll('.card')].find(n=>n.textContent.includes('${doomed2.key}')); if(!c) return false; c.click(); return true; })()`);
  await sleep(900);
  check("the detail pane offers the same permanent delete", (await $(`!!document.querySelector('.detail .purge-btn')`)) === true);
  await press(`document.querySelector('.detail .purge-btn')`);
  await sleep(800);
  await press(`document.querySelector('.dlg-foot .btn-danger')`);
  await sleep(1400);
  check("the pane's delete destroys the issue too", repos.items.get(project.id, doomed2.id) === null);
  check("the card leaves the board", (await $(`[...document.querySelectorAll('.card-id')].some(n => n.textContent === '${doomed2.key}')`)) === false);
  check("the detail pane closes with the issue it was showing", (await $(`!!document.querySelector('.detail')`)) === false);
  // the toast must not offer an undo the write path cannot honour
  check(
    "the permanent delete's toast offers no undo",
    (await $(`(() => { const t = [...document.querySelectorAll('.toast')].pop(); return !!t && !t.querySelector('.btn-ghost'); })()`)) === true
  );
  check(
    "the status bar names the purge rather than calling it an update",
    (await $(`[...document.querySelectorAll('.statusbar .status-item')].some(n => /permanently deleted/.test(n.textContent))`)) === true
  );

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,bubbles:true}));true`);
  await sleep(1200);
  check("⌘Z cannot resurrect a permanently deleted issue", repos.items.get(project.id, doomed2.id) === null);
  check("the tombstone survives the undo as the audit trail", ctx.oplog.recent(project.id, 30).some((o) => o.op === "purge" && o.entityId === doomed2.id));
  await shot("24-after-delete");

  // ── project settings, and the delete that takes a whole project ──────
  // After everything that counts the fixture, and on a project the harness makes
  // for itself: this delete is not undoable and takes every board and issue with
  // it, so it must never be pointed at the sample data other checks assert on.
  const throwaway = repos.projects.create({ name: "Throwaway", description: "made by the harness" });
  repos.items.create({ title: "goes with the project", projectId: throwaway.id, boardId: repos.boards.defaultFor(throwaway.id).id, by: "human" });

  /* Written behind the renderer's back, so the projects query is stale for
     `staleTime`; a hash change keeps the SPA and its cache alive. Reload. */
  await $(`location.hash = '#/';true`);
  await sleep(400);
  win.webContents.reload();
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await sleep(2600);
  check("the projects grid renders a card per project", (await $(`document.querySelectorAll('.proj').length`)) === 3);

  const gearFor = (name) =>
    `[...document.querySelectorAll('.proj-cell')].find(c => c.querySelector('.proj-name')?.textContent === '${name}')?.querySelector('.proj-gear')`;
  check("each card carries its own settings control", (await $(`document.querySelectorAll('.proj-cell .proj-gear').length`)) === 3);
  await $(`${gearFor("Throwaway")}.focus();true`);
  await press(gearFor("Throwaway"));
  await sleep(800);
  check("a project card opens its own settings sheet", (await $(`!!document.querySelector('#psName')`)) === true);
  check("the key prefix is stated, not offered", (await $(`document.querySelector('#psPrefix')?.readOnly`)) === true);
  check("the sheet names the id an agent uses over MCP", (await $(`document.querySelector('#psId')?.value`)) === throwaway.id);
  await checkCentred("project settings");
  await shot("25-project-settings");

  // the archive switch is a draft like every other control on a settings sheet
  await press(`document.querySelector('.cfg-row .switch')`);
  await sleep(300);
  check("the archive switch reads back its draft state", (await $(`document.querySelector('.cfg-row .switch')?.getAttribute('aria-checked')`)) === "true");
  await press(`[...document.querySelectorAll('.dlg-foot .btn-ghost')].pop()`);
  await sleep(700);
  check("Cancel discards the project draft", repos.projects.get(throwaway.id).archived === false);

  await press(gearFor("Throwaway"));
  await sleep(700);
  await typeInto("#psName", "Throwaway renamed");
  await press(`[...document.querySelectorAll('.dlg-foot .btn-secondary')].pop()`);
  await sleep(1200);
  check("Save writes the project name", repos.projects.get(throwaway.id).name === "Throwaway renamed");
  check("the grid re-reads the renamed project", (await $(`[...document.querySelectorAll('.proj-name')].some(n => n.textContent === 'Throwaway renamed')`)) === true);

  await press(gearFor("Throwaway renamed"));
  await sleep(700);
  await press(`document.querySelector('.del-proj')`);
  await sleep(800);
  check("deleting a project asks before it destroys", (await $(`!!document.querySelector('.dangerbar')`)) === true);
  check("the confirmation says the write is not undoable", (await $(`/not undoable/i.test(document.querySelector('.dangerbar')?.textContent ?? '')`)) === true);
  check("the confirmation lists what goes with the project", (await $(`document.querySelectorAll('.del-list li').length`)) >= 4);
  check("the button that destroys is disabled until the name is typed", (await $(`document.querySelector('.dlg-foot .btn-danger')?.disabled`)) === true);
  check("focus opens on the confirmation field, not the destructive button", (await $(`document.activeElement?.id`)) === "dpName");
  await checkCentred("the project delete confirmation");
  await shot("26-project-delete-confirm");

  // one sheet, two faces: Escape steps back to the settings rather than out
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(700);
  check("Escape on the confirmation returns to the settings face", (await $(`!!document.querySelector('#psName')`)) === true);
  check("Escape cancelled the delete rather than confirming it", repos.projects.get(throwaway.id) !== null);

  await press(`document.querySelector('.del-proj')`);
  await sleep(700);
  await typeInto("#dpName", "Throwaway");
  await sleep(400);
  check("a name that does not match keeps the delete disabled", (await $(`document.querySelector('.dlg-foot .btn-danger')?.disabled`)) === true);
  await typeInto("#dpName", "Throwaway renamed");
  await sleep(400);
  check("the typed name arms the delete", (await $(`document.querySelector('.dlg-foot .btn-danger')?.disabled`)) === false);
  await press(`document.querySelector('.dlg-foot .btn-danger')`);
  await sleep(1600);
  check("confirming destroys the project for good", repos.projects.get(throwaway.id) === null);
  check("its cache, workstreams, views and issues go with it", !ctx.db.has(throwaway.id) && repos.boards.list(throwaway.id).length === 0 && repos.views.listForProject(throwaway.id).length === 0 && repos.items.list({ projectId: throwaway.id }).length === 0);
  check("the card leaves the grid", (await $(`document.querySelectorAll('.proj').length`)) === 2);
  check("the sheet closes with the project it was configuring", (await $(`!!document.querySelector('#psName')`)) === false);
  check("the fixture project is untouched", repos.items.list({ projectId: project.id }).length > 0);
  await shot("27-after-project-delete");

  // ── where a project is stored ────────────────────────────────────────
  // The folder is the truth: the sheet names it, says who drives git in it,
  // lets plugin data travel or not, and syncs on demand.
  await ctx.storage.ready;
  const projectDir = ctx.hub.catalog.project(project.id)?.dir;
  check("a configured Hub means no setup screen", (await $(`!!document.querySelector('.hub-setup')`)) === false && (await $(`!!document.querySelector('.proj-grid')`)) === true);
  check("every project gets a folder under the Hub", !!projectDir && projectDir.startsWith(path.join(WORK, "hub", "projects")));
  check("the folder holds the project as text", fs.existsSync(path.join(projectDir, ".tomrade", "project.json")));
  check(
    "every issue travels as one line",
    fs.readFileSync(path.join(projectDir, ".tomrade", "state", "items.jsonl"), "utf8").trim().split("\n").length === repos.items.list({ projectId: project.id }).length
  );
  check("the live database is never in the folder", !fs.existsSync(path.join(projectDir, ".tomrade", "project.db")));
  check("the folder keeps a database out on purpose", fs.readFileSync(path.join(projectDir, ".tomrade", ".gitignore"), "utf8").includes("*.db"));
  check("every write reaches the folder's log", fs.readdirSync(path.join(projectDir, ".tomrade", "log")).some((f) => f.endsWith(".jsonl")));

  await press(gearFor("Tomrade"));
  await sleep(900);
  check("the sheet names the project's folder", (await $(`document.querySelector('.stg-dir')?.textContent`)) === projectDir);
  check("a folder of its own says so", (await $(`document.querySelector('.stg-origin')?.textContent`) ?? "").includes("A folder of its own"));
  check("the folder can be changed, not only read", (await $(`!!document.querySelector('.stg-change')`)) === true);
  check("a remote is offered for a folder of its own", (await $(`!!document.querySelector('#stgProvider')`)) === true);
  check(
    "every remote transport is offered, and no folder pretends to be one",
    (await $(`[...document.querySelectorAll('#stgProvider option')].map(o => o.value).join()`)) === ",git,github"
  );
  check(
    "nothing is publishable until a remote is chosen",
    (await $(`document.querySelector('.stg-publish')?.disabled`)) === true
  );
  const exportsBefore = ctx.hub.catalog.project(project.id)?.exports ?? [];
  check("plugin data that can travel is listed", (await $(`document.querySelectorAll('.stg-export').length`)) > 0);
  check("conversation history is one of them", (await $(`[...document.querySelectorAll('.stg-export .cfg-name')].some(n => n.textContent === 'Conversation history')`)) === true);
  check("in a folder of its own it travels by default", exportsBefore.includes("agent") && (await $(`document.querySelector('.stg-export[data-namespace="agent"] input')?.checked`)) === true);
  await shot("28-project-storage");

  await press(`document.querySelector('.stg-export[data-namespace="agent"] input')`);
  await sleep(1500);
  check("unticking stops it travelling", !(ctx.hub.catalog.project(project.id)?.exports ?? []).includes("agent"));
  check("and the folder's manifest says so", !JSON.parse(fs.readFileSync(path.join(projectDir, ".tomrade", "project.json"), "utf8")).exports.includes("agent"));
  check("nothing of it is left in the folder", !fs.existsSync(path.join(projectDir, ".tomrade", "plugins", "agent")));

  check("the sheet reports the folder in step", (await $(`[...document.querySelectorAll('.stg-status .tag')].some(t => t.textContent === 'In step')`)) === true);
  const writtenAt = fs.statSync(path.join(projectDir, ".tomrade", "state", "items.jsonl")).mtimeMs;
  await press(`document.querySelector('.stg-sync')`);
  await sleep(1800);
  check("syncing an unchanged project rewrites nothing", fs.statSync(path.join(projectDir, ".tomrade", "state", "items.jsonl")).mtimeMs === writtenAt);
  check("and still reads as in step", (await $(`[...document.querySelectorAll('.stg-status .tag')].some(t => t.textContent === 'In step')`)) === true);
  check("the cache can be rebuilt from the folder", (await $(`!!document.querySelector('.stg-rebuild')`)) === true);
  await shot("29-project-published");

  // A remote that needs an account asks for it here, where it is used —
  // and stays closed until it has one, so nothing is typed into a dead form.
  await pick(`document.querySelector('#stgProvider')`, "github");
  await sleep(700);
  check("a remote that needs an account asks for it inline", (await $(`!!document.querySelector('#stgSecret')`)) === true);
  check("its own fields stay shut until the account is connected", (await $(`!!document.querySelector('#sf-stg-owner')`)) === false);
  check("publishing is impossible without the account", (await $(`document.querySelector('.stg-publish')?.disabled`)) === true);
  check(
    "it says where to get one",
    (await $(`[...document.querySelectorAll('.dlg-body .btn-ghost')].some(b => /github\.com/.test(b.textContent))`)) === true
  );
  await shot("30-destination-connect");

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(700);

  // The account is stored per machine, but it is not a screen of its own: the
  // provider claims that section, and Settings does not draw it twice. The
  // data pane names the Hub folder and the cache under it.
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}));true`);
  await sleep(900);
  const navLabels = `[...document.querySelectorAll('.dlg-nav .side-row')].map(r => r.textContent.trim()).join(' | ')`;
  check("a plugin's own settings pane is still offered", (await $(navLabels)).includes("Pet"));
  check("but a destination's account is not a settings pane", (await $(navLabels)).includes("GitHub") === false);
  check("theme automation is drawn once, on Appearance, and not again as a plugin pane", (await $(navLabels)).includes("Theme automation") === false);
  const fieldLabels = `[...document.querySelectorAll('.dlg-body .field > label')].map(l => l.textContent)`;
  // A field the plugin marks advanced waits behind one line; the terminal choice is the only thing drawn at first.
  const advancedFold = `document.querySelector('.dlg-body .fold[data-fold$="-advanced"] .fold-head')`;
  await press(settingsNav("Code link"));
  await sleep(500);
  const plainLabels = await $(fieldLabels);
  check("the command templates wait behind Advanced", plainLabels.includes("Terminal app") && !plainLabels.includes("Claude Code command") && (await $(`${advancedFold}?.getAttribute('aria-expanded')`)) === "false", plainLabels);
  await press(advancedFold);
  await sleep(300);
  const codeLabels = await $(fieldLabels);
  check("a plugin field without a title still reads as words, not its key", codeLabels.includes("Claude Code command") && !codeLabels.some((l) => /^[a-z]+[A-Z]/.test(l)), codeLabels);
  check("and no field shows [object Object]", (await $(`[...document.querySelectorAll('.dlg-body input, .dlg-body textarea')].some(i => i.value.includes('[object Object]'))`)) === false);
  // A value the schema refuses stays as typed with the reason under it, instead of springing back.
  await press(settingsNav("Files"));
  await sleep(500);
  check("the token budget waits behind Advanced too", (await $(`!!document.querySelector('#sf-files-agentIndexTokens')`)) === false && (await $(`!!${advancedFold}`)) === true);
  await press(advancedFold);
  await sleep(300);
  const budget = () => ctx.settings.get().files?.agentIndexTokens;
  const budgetBefore = budget();
  const leaveWith = (selector, text) =>
    $(`(() => { const i = document.querySelector('${selector}'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); return true; })()`);
  await leaveWith("#sf-files-agentIndexTokens", "25000");
  await sleep(500);
  check("an out-of-range number says what is allowed", (await $(`document.querySelector('.dlg-body .field-error')?.textContent ?? ''`)) === "Enter a number from 0 to 20000.");
  check("and stays as typed, unsaved", (await $(`document.querySelector('#sf-files-agentIndexTokens').value`)) === "25000" && budget() === budgetBefore, budget());
  await leaveWith("#sf-files-agentIndexTokens", "2500");
  await sleep(700);
  check("a value in range saves once the field is left, and the complaint goes", budget() === 2500 && (await $(`!document.querySelector('.dlg-body .field-error')`)) === true, budget());
  // plugin cards come back in the person's language
  const language = ctx.settings.get().language;
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  await sleep(900);
  // the pane may be drawn afresh in the new language, with Advanced folded again
  await $(`(() => { const h = ${advancedFold}; if (h?.getAttribute('aria-expanded') === 'false') h.click(); return true; })()`);
  await sleep(300);
  check("a plugin pane speaks Chinese when the app does", (await $(navLabels)).includes("宠物") && (await $(fieldLabels)).includes("文件清单的篇幅"), await $(fieldLabels));
  ctx.settings.set({ ...ctx.settings.get(), language, files: { ...ctx.settings.get().files, agentIndexTokens: budgetBefore } });
  await sleep(700);
  await press(settingsNav("Hub"));
  await sleep(700);
  const missing = ctx.storage.restores().entries;
  check("the Hub pane names the folder", (await $(`document.querySelector('#hubDir')?.value`)) === path.join(WORK, "hub"));
  check("with no remote yet it offers the destination kinds", (await $(`!!document.querySelector('#hubProvider') && document.querySelector('.hub-publish')?.disabled === true`)) === true);
  check("and lists the projects not on this computer yet", (await $(`document.querySelectorAll('.hub-other').length`)) === missing.length);
  check("saying so when there is nothing", (await $(`!!document.querySelector('.hub-others-none')`)) === (missing.length === 0));
  check("retrying them all waits for one that is not already under way", (await $(`document.querySelector('.hub-attach-all')?.disabled ?? true`)) === missing.every((e) => e.state === "restoring"));
  // One pane says where everything lives: the folder above, the cache under it, and no Data pane of its own.
  check("and the cache folder beneath it", (await $(`document.querySelector('#hubCache')?.value`)) === path.join(WORK, "cache"));
  check("so there is no separate Data pane", (await $(navLabels)).includes("Data") === false);
  await shot("30-hub-pane");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  // ── opening a project someone else published ────────────────────────
  // The round trip that matters for a team: publish, leave, and come back to it
  // from the destination alone — no clone by hand, no id typed in.
  const handoffDir = path.join(WORK, "handoff");
  const handoff = repos.projects.create({ name: "Handoff", keyPrefix: "HND" }, { dir: handoffDir });
  await sleep(300);
  repos.items.create({ title: "written on the other machine", projectId: handoff.id, boardId: repos.boards.defaultFor(handoff.id).id, by: "human" });
  await ctx.storage.publish(handoff.id);
  repos.projects.remove(handoff.id);
  check("a project can be given a folder of the user's choosing", fs.existsSync(path.join(handoffDir, ".tomrade", "project.json")));
  check("the folder keeps the project after it leaves this machine", fs.existsSync(path.join(handoffDir, ".tomrade", "state", "items.jsonl")));

  await $(`location.hash = '#/';true`);
  await sleep(400);
  win.webContents.reload();
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await sleep(2600);
  check("the project it left is gone from the grid", (await $(`[...document.querySelectorAll('.proj-name')].some(n => n.textContent === 'Handoff')`)) === false);

  check("the home offers to open a folder", (await $(`!!document.querySelector('.titlebar .open-folder')`)) === true);
  await press(`document.querySelector('.titlebar .open-remote')`);
  await sleep(800);
  check("opening a published project asks where it is published", (await $(`!!document.querySelector('#opProvider')`)) === true);
  check(
    "every remote transport can be opened from",
    (await $(`[...document.querySelectorAll('#opProvider option')].map(o => o.value).join()`)) === "git,github"
  );
  await shot("31-open-a-project");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  // "Open folder…" ends in a native picker the harness cannot drive; what the
  // button does once a folder is picked is exactly this call.
  await ctx.storage.attach(handoffDir);
  await sleep(400);
  await $(`location.hash = '#/p/${handoff.id}';true`);
  await sleep(2600);
  check("the project comes back from its folder", repos.projects.get(handoff.id) !== null);
  check("it keeps the id agents already know", (await $(`location.hash`)).includes(handoff.id));
  check("its issues and its key prefix came with it", repos.items.list({ projectId: handoff.id })[0]?.key === "HND-1");

  // ── a failure reads as one ───────────────────────────────────────────
  ctx.contributions.command({ id: "harness.fail", title: "Harness: fail on purpose", run: () => { throw new Error("Boom from a plugin command"); } });
  await $(`location.reload();true`);
  await sleep(3000);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(700);
  await typeInto(".palette-input", "Harness: fail on purpose");
  await sleep(400);
  await press(`[...document.querySelectorAll('.palette-row')].find((r) => r.textContent.includes('Harness: fail on purpose'))`);
  await sleep(900);
  const errorToast = await $(`(() => { const t = document.querySelector('.toast.is-error'); return t ? { text: t.querySelector('.toast-body')?.textContent ?? '', role: t.getAttribute('role'), copy: !!t.querySelector('[aria-label="Copy the message"]') } : null; })()`);
  check("a failed action shows an error toast, marked as one", errorToast?.role === "alert");
  check("in the error's own words, without Electron's wrapper", !!errorToast && errorToast.text.includes("Boom from a plugin command") && !/Error invoking remote method|^Error:/.test(errorToast.text));
  check("which can be copied", errorToast?.copy === true);

  // ── New issue: one press, one issue ─────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:true,bubbles:true}));true`);
  await sleep(700);
  check("Create waits for a title", (await $(`[...document.querySelectorAll('[role=dialog] .btn-primary')].find((b) => /Create/.test(b.textContent))?.disabled`)) === true);
  const issuesBefore = repos.items.list({ projectId: handoff.id }).length;
  await typeInto("#niTitle", "Pressed twice");
  await $(`(() => { const i = document.querySelector('#niTitle'); for (let n = 0; n < 2; n++) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await sleep(1200);
  check("two quick Enters make one issue", repos.items.list({ projectId: handoff.id }).filter((i) => i.title === "Pressed twice").length === 1 && repos.items.list({ projectId: handoff.id }).length === issuesBefore + 1);

  // ── a project's last view cannot be deleted ─────────────────────────
  for (const v of repos.views.listForProject(handoff.id).slice(1)) repos.views.remove(handoff.id, v.id);
  await $(`location.hash = '#/p/${handoff.id}';true`);
  await sleep(1500);
  await press(`document.querySelector('.view-menu-btn')`);
  await sleep(400);
  check("Delete view is off on a project's only view", (await $(`[...document.querySelectorAll('.menu [role="menuitem"]')].find(r => /Delete view/.test(r.textContent))?.hasAttribute('data-disabled')`)) === true);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(300);

  // ── the palette searches every ticket, not the first 60 ─────────────
  const handoffBoard = repos.boards.list(handoff.id)[0];
  for (let i = 0; i < 70; i++) repos.items.create({ projectId: handoff.id, boardId: handoffBoard.id, title: `Filler ticket ${i + 1}`, by: "human" });
  await $(`location.reload();true`);
  await sleep(3000);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(700);
  // a ticket the palette does not list before anything is typed
  const listed = new Set(await $(`[...document.querySelectorAll('.palette-row .card-id')].map((n) => n.textContent)`));
  const last = repos.items.list({ projectId: handoff.id }).find((i) => i.kind === "ticket" && !listed.has(i.key));
  check("seventy-odd tickets are more than the palette lists unasked", !!last);
  await typeInto(".palette-input", last?.key ?? "none");
  await sleep(500);
  check("the palette finds a ticket past the first sixty", (await $(`[...document.querySelectorAll('.palette-row .card-id')].some((n) => n.textContent === ${JSON.stringify(last?.key)})`)) === true);
  check("and shows its title as written, not in capitals", (await $(`(() => { const r = [...document.querySelectorAll('.palette-row')].find((n) => n.querySelector('.card-id')?.textContent === ${JSON.stringify(last?.key)}); return r ? getComputedStyle(r.querySelector('.p-label')).textTransform : null; })()`)) === "none");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);

  // ── ⌘K scrolls, and a ticket typed for is not buried under old conversations ──
  const shipped = repos.items.create({ projectId: handoff.id, boardId: handoffBoard.id, title: "Ship the export", by: "human" });
  repos.items.update(handoff.id, shipped.id, { status: "done" }, "human");
  const digits = shipped.key.split("-")[1];
  const engine = ctx.agent.store.threads(project.id)[0]?.engine ?? "pi";
  const longAgo = Date.now() - 24 * 60 * 60_000;
  // quiet a day, so they are history; what they said fuzzily spells the key, their titles do not
  for (let i = 0; i < 14; i++) {
    const th = ctx.agent.store.createThread(handoff.id, engine, i % 2 ? "Hey" : `New chat ${i}`);
    ctx.agent.store.setSaid(handoff.id, th.id, `Handled it - ${digits[0]} drafts, ${digits.slice(1) || digits} sent`);
  }
  const onTicket = ctx.agent.store.createThread(handoff.id, engine, "Export work", null, shipped.id);
  repos.dbFor(handoff.id).prepare("UPDATE plugin_agent_threads SET updated_at = ? WHERE project_id = ?").run(longAgo, handoff.id);
  await $(`location.reload();true`);
  await sleep(3000);
  if (!(await $(`!!document.querySelector('.ai .sbar')`))) {
    await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'j',metaKey:true,bubbles:true}));true`);
    await sleep(1200);
  }
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(900);
  const box = await $(`(() => { const p = document.querySelector('.palette'), l = document.querySelector('.palette-list'); return { panel: p.getBoundingClientRect().height, vh: innerHeight, scroll: l.scrollHeight, client: l.clientHeight }; })()`);
  check("⌘K stays within 60% of the window", box.panel <= box.vh * 0.6 + 1);
  check("and its list is bounded by it, so it scrolls", box.scroll > box.client && box.client > 0);
  check("the wheel scrolls the list", (await $(`(() => { const l = document.querySelector('.palette-list'); l.scrollTop = 240; return l.scrollTop; })()`)) > 0);
  await $(`document.querySelector('.palette-list').scrollTop = 0;true`);
  // ↑ from the first row wraps to the last: cmdk scrolls it into view
  await $(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));true`);
  await sleep(400);
  // seen: inside the list's box and the palette's, which clips whatever the list does not scroll
  const inView = (selector) => `(() => { const n = ${selector}; if (!n) return false; const l = document.querySelector('.palette-list').getBoundingClientRect(), p = document.querySelector('.palette').getBoundingClientRect(), r = n.getBoundingClientRect(); return r.top >= Math.max(l.top, p.top) - 1 && r.bottom <= Math.min(l.bottom, p.bottom) + 1; })()`;
  check("the arrow keys bring the last row into view", (await $(`(() => { const rows = [...document.querySelectorAll('.palette-list [cmdk-item]')]; const last = rows[rows.length - 1]; return last?.getAttribute('aria-selected') === 'true'; })()`)) && (await $(inView(`[...document.querySelectorAll('.palette-list [cmdk-item]')].pop()`))));
  await typeInto(".palette-input", shipped.key);
  await sleep(1200);
  const ticketRow = `[...document.querySelectorAll('.palette-row')].find((n) => n.querySelector('.card-id')?.textContent === ${JSON.stringify(shipped.key)})`;
  check("a closed ticket typed by its key is in view", await $(inView(ticketRow)));
  check("and is the first row to pick", (await $(`document.querySelector('.palette-list [cmdk-item]') === ${ticketRow}`)) === true);
  check("Tickets come before History when both match", (await $(`(() => { const t = ${ticketRow}?.closest('[cmdk-group]'), h = document.querySelector('[data-testid="palette-history"]'); return !!t && !!h && !!(t.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING); })()`)) === true);
  check("History keeps the conversation on that ticket", (await $(`!!document.querySelector('[data-session="thread:${onTicket.id}"]')`)) === true);
  check("and leaves out the ones whose title and ticket do not hold the key", (await $(`[...document.querySelectorAll('[data-testid="palette-history"] .palette-row')].filter((n) => /Hey|New chat/.test(n.textContent)).length`)) === 0);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);

  return results;
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.log("HARNESS ERROR: " + (err && err.stack ? err.stack : String(err)));
    check("harness ran to completion", false);
  }
  const moved = changedLinks(linksBefore);
  if (moved.length) console.log(`INFO: agent links changed: ${JSON.stringify(moved)}`);
  check("left the Tomrade entry in the person's agent configurations as it was", !moved.length);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${SHOTS}`);
  if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
  app.exit(failed.length ? 1 : 0);
});
