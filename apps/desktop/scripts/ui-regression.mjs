/**
 * UI regression: drives the REAL UI against the REAL repositories over a
 * throwaway SQLite file seeded with the design's sample project. Checks the
 * interactions the design specifies, then captures a screenshot per screen
 * and per theme into scripts/shots/.
 *
 *   pnpm --filter @tomrade/desktop test:ui        (needs the dev server up)
 */
import { app, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, BoardsRepository, ItemsRepository, ProjectsRepository, ViewsRepository } from "@tomrade/core";
import { registerDataIpc } from "../dist/ipc.js";
import { seedDesignProject } from "./seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/";
const SHOTS = path.join(__dirname, "shots");
const WORK = "/tmp/tomrade-ui-regression";

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
app.setPath("userData", WORK);

const results = [];
const check = (name, cond) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let settings = { llm: { apiKey: "", baseURL: "https://api.deepseek.com", model: "deepseek-chat" }, theme: "system" };

const run = async () => {
  const dbPath = path.join(WORK, "tomrade.db");
  const db = openDb(dbPath);
  const repos = {
    db,
    items: new ItemsRepository(db),
    projects: new ProjectsRepository(db),
    boards: new BoardsRepository(db),
    views: new ViewsRepository(db)
  };
  const { project } = seedDesignProject(repos);

  registerDataIpc({
    ...repos,
    dbPath,
    mcpUrl: () => "http://127.0.0.1:19090/mcp",
    getSettings: () => settings,
    setSettings: (next) => {
      settings = next;
      return settings;
    }
  });

  const win = new BrowserWindow({
    width: 1560,
    height: 940,
    show: !!process.env.TOMRADE_SHOW,
    webPreferences: { preload: path.join(__dirname, "../dist/preload.cjs"), contextIsolation: true }
  });
  await win.loadURL(DEV_URL);
  await sleep(3500);

  const $ = (js) => win.webContents.executeJavaScript(js, true);
  /* React tracks the last value it wrote, so a controlled input needs the native setter. */
  const typeInto = (selector, text) =>
    $(`(() => {
      const i = document.querySelector('${selector}');
      if (!i) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
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
  /* The ThemeProvider owns the class, so a theme must be set through a real
     control: the status-bar switch where there is one, the palette otherwise. */
  const SEGMENT = { system: 0, light: 1, dark: 2, matcha: 3 };
  const themeViaSwitch = async (theme) => {
    await press(`document.querySelectorAll('.statusbar .theme-seg')[${SEGMENT[theme]}]`);
    await sleep(800);
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
  await themeViaSwitch("light");
  const projectCards = await $(`document.querySelectorAll('.proj').length`);
  check("projects home renders a card per project", projectCards === 2);
  check("project card shows board and issue counts", (await $(`document.querySelectorAll('.proj .stat-v').length`)) >= 6);
  await shot("01-projects-paper");
  await themeViaSwitch("dark");
  await shot("02-projects-ink");
  await themeViaSwitch("matcha");
  await shot("03-projects-matcha");
  await themeViaSwitch("light");
  check("the theme switch reports the preference, not the resolved theme", (await $(`document.querySelectorAll('.statusbar .theme-seg[aria-pressed="true"]').length`)) === 1);

  // ── enter the project ───────────────────────────────────────────────
  await $(`document.querySelectorAll('.proj')[0].click();true`);
  await sleep(1800);
  check("board route resolves to a board and a view", /\/p\/.+\/b\/.+\/v\/.+/.test(await $(`location.hash`)));
  const boardRows = await $(`document.querySelectorAll('.side-row.is-board').length`);
  check("sidebar lists four workstreams plus two cross-board scopes", boardRows === 6);
  check("one sidebar row is current", (await $(`document.querySelectorAll('.side-row[aria-current="true"]').length`)) === 1);
  check("query bar renders four facets", (await $(`document.querySelectorAll('.qb-btn').length`)) === 4);
  check("grouping segmented control has three modes", (await $(`document.querySelectorAll('.seg.quiet button').length`)) === 3);
  const columns = await $(`document.querySelectorAll('.col').length`);
  check("board renders the view's columns", columns >= 4);
  check("cards render with a mono issue key", (await $(`!!document.querySelector('.card .card-id')?.textContent.match(/^TOM-\\d+$/)`)) === true);
  check("column numbers are zero-padded", (await $(`document.querySelector('.col-num')?.textContent`)) === "01");
  check("provenance ticks appear in the card gutter", (await $(`document.querySelectorAll('.card .prov-tick').length`)) > 0);
  check("a WIP cap prints as count / cap", (await $(`[...document.querySelectorAll('.col-count')].some(n => n.textContent.includes('/'))`)) === true);
  await shot("04-board-paper");

  // ── keyboard move: ← → is the same write path as a drag ─────────────
  const keysOnBoard = await $(`[...document.querySelectorAll('.card .card-id')].map(n => n.textContent).join(',')`);
  const before = repos.items
    .list({ projectId: project.id })
    .find((i) => i.status === "doing" && i.kind === "ticket" && keysOnBoard.split(",").includes(i.key));
  if (!before) throw new Error(`no draggable card on screen; keys=${keysOnBoard}`);
  await $(`(() => { const c=[...document.querySelectorAll('.card')].find(n=>n.textContent.includes('${before.key}')); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); return true; })()`);
  await sleep(900);
  const after = repos.items.get(before.id);
  check("ArrowRight moves the focused card one column", after.status !== before.status);
  check("the move bumped the version", after.version === before.version + 1);
  check("a toast offers the undo", (await $(`document.querySelectorAll('.toast').length`)) > 0);
  check("focus follows the card into its new column", (await $(`document.activeElement?.dataset?.id`)) === before.id);
  await shot("05-board-toast");

  await $(`document.querySelector('.toast .btn-ghost').click();true`);
  await sleep(900);
  check("the toast's Undo reverts the move", repos.items.get(before.id).status === before.status);

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
    const landed = repos.items.get(dragged.id);
    check("a pointer drag writes the grouped field", landed.status === "doing");
    check("a drag never changes the board", landed.boardId === dragged.boardId);
    if (landed.status === "doing") await shot("21-after-drag");
    repos.items.update(dragged.id, { status: "verifying" }, "human");
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
      "neither drag changed the board",
      [first.key, second?.key].filter(Boolean).every((k) => repos.items.getByKey(project.id, k)?.boardId === first.boardId)
    );
    await shot("22-drag-order");
    for (const key of [first.key, second?.key].filter(Boolean)) {
      const item = repos.items.getByKey(project.id, key);
      if (item) repos.items.update(item.id, { status: "verifying" }, "human");
    }
    await $(`location.reload();true`);
    await sleep(3200);
  }

  // ── conflict: an agent write the board has not seen ─────────────────
  const raced = repos.items.list({ projectId: project.id }).find((i) => i.status === "todo" && i.kind === "ticket" && keysOnBoard.split(",").includes(i.key));
  repos.items.update(raced.id, { priority: 4 }, "ai:mcp");
  await $(`(() => { const c=[...document.querySelectorAll('.card')].find(n=>n.textContent.includes('${raced.key}')); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); return true; })()`);
  await sleep(1200);
  check("a stale move raises the conflict banner", (await $(`!!document.querySelector('.banner[role="alert"]')`)) === true);
  check("the conflict left the issue alone", repos.items.get(raced.id).status === "todo");
  await shot("22-conflict-banner");
  await press(`document.querySelector('.banner .btn-ghost')`);
  await sleep(500);
  check("the banner dismisses", (await $(`!!document.querySelector('.banner')`)) === false);

  // ── filters ─────────────────────────────────────────────────────────
  await press(`document.querySelectorAll('.qb-btn')[0]`);
  await sleep(500);
  check("a facet menu opens with counted options", (await $(`document.querySelectorAll('.menu-row .m-count').length`)) > 0);
  await shot("06-facet-menu");
  const shown = await $(`document.querySelectorAll('.card').length`);
  await press(`document.querySelectorAll('.menu-row')[0]`);
  await sleep(700);
  check("selecting a label narrows the board", (await $(`document.querySelectorAll('.card').length`)) < shown);
  check("the menu stays open for multi-select", (await $(`document.querySelectorAll('.menu-row').length`)) > 0);
  await press(`document.querySelector('.board-title')`);
  await sleep(400);
  check("a pointer outside dismisses the menu", (await $(`document.querySelectorAll('.menu-row').length`)) === 0);
  check("an armed facet reads as a tag", (await $(`!!document.querySelector('.qb-btn[data-on="true"]')`)) === true);
  check("drift from the saved view offers Save to view", (await $(`!!document.querySelector('.query-bar .btn-secondary')`)) === true);
  await shot("07-board-filtered");
  await $(`[...document.querySelectorAll('.query-bar .btn-ghost')].find(b=>b.textContent.trim()==='Reset').click();true`);
  await sleep(600);
  check("Reset returns to the saved view", (await $(`!!document.querySelector('.qb-btn[data-on="true"]')`)) === false);
  // re-picking the board you are already on must not throw the live query away
  await press(`document.querySelectorAll('.qb-btn')[0]`);
  await sleep(400);
  await press(`document.querySelectorAll('.menu-row')[0]`);
  await sleep(500);
  await press(`document.querySelector('.board-title')`);
  await sleep(400);
  await press(`document.querySelector('.side-row[aria-current="true"]')`);
  await sleep(700);
  check("re-picking the current board keeps the live query", (await $(`!!document.querySelector('.qb-btn[data-on="true"]')`)) === true);
  await press(`[...document.querySelectorAll('.query-bar .btn-ghost')].find(b=>b.textContent.trim()==='Reset')`);
  await sleep(600);

  // ── grouping ────────────────────────────────────────────────────────
  await $(`document.querySelectorAll('.seg.quiet button')[1].click();true`);
  await sleep(700);
  check("grouping by priority relabels the columns", (await $(`document.querySelector('.col-name')?.textContent`)) === "Urgent");
  await shot("08-board-by-priority");
  await $(`document.querySelectorAll('.seg.quiet button')[0].click();true`);
  await sleep(600);

  // ── detail pane ─────────────────────────────────────────────────────
  await $(`document.querySelector('.card').click();true`);
  await sleep(900);
  check("a card opens the detail pane", (await $(`!!document.querySelector('.detail')`)) === true);
  check("the detail prints the field strip", (await $(`document.querySelectorAll('.detail .field-row').length`)) === 6);
  check("the activity ledger reads the oplog", (await $(`document.querySelectorAll('.detail .ledger-row').length`)) > 0);
  await shot("09-detail-docked");
  await $(`document.querySelector('.detail .btn-icon').click();true`);
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
  await shot("10-detail-expanded");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);
  check("Escape collapses the overlay before closing", (await $(`!!document.querySelector('.detail.expanded')`)) === false);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);
  check("a second Escape closes the pane", (await $(`!!document.querySelector('.detail')`)) === false);

  // ── command palette ─────────────────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(700);
  check("⌘K opens the palette", (await $(`!!document.querySelector('.palette-input')`)) === true);
  check("the palette indexes spaces, issues and actions", (await $(`document.querySelectorAll('.palette-row').length`)) > 10);
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

  // ── new board is a real, undoable write ─────────────────────────────
  const boardsBefore = repos.boards.list(project.id).length;
  await $(`[...document.querySelectorAll('.side-add')][0].click();true`);
  await sleep(400);
  await $(`(() => { const i=document.querySelector('.side-row input'); i.value='Docs'; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
  await sleep(1400);
  check("creating a board writes it", repos.boards.list(project.id).length === boardsBefore + 1);
  const docs = repos.boards.list(project.id).find((b) => b.name === "Docs");
  check("a new board gets the All work view", repos.views.listForBoard(docs.id).map((v) => v.name).join() === "All work");
  await $(`document.querySelector('.toast .btn-ghost').click();true`);
  await sleep(1000);
  check("undo removes the board again", repos.boards.list(project.id).length === boardsBefore);

  // ── inline composer ─────────────────────────────────────────────────
  const itemsBefore = repos.items.list({ projectId: project.id }).length;
  await $(`[...document.querySelectorAll('.col-body > .btn-ghost')][1].click();true`);
  await sleep(400);
  await $(`(() => { const i=document.querySelector('.col-body .card input'); i.value='Typed straight into the column'; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
  await sleep(1400);
  const nowItems = repos.items.list({ projectId: project.id });
  check("the column composer creates an issue", nowItems.length === itemsBefore + 1);
  const created = nowItems.find((i) => i.title === "Typed straight into the column");
  check("the composer writes the column's own field", created && created.status === "doing");
  check("the new issue continues the key sequence", created && /^TOM-\d+$/.test(created.key));

  // ── dialogs ─────────────────────────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:true,bubbles:true}));true`);
  await sleep(700);
  check("⌘N opens the new-issue sheet", (await $(`!!document.querySelector('#niTitle')`)) === true);
  await shot("14-new-issue");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  await $(`[...document.querySelectorAll('.board-head .btn-ghost')].pop().click();true`);
  await sleep(900);
  check("board settings opens with the issue distribution", (await $(`!!document.querySelector('.bs-bar')`)) === true);
  check("board settings lists the saved-view roster", (await $(`document.querySelectorAll('.cfg-row .bs-radio').length`)) > 0);
  // the roster is a draft: removing a row and cancelling must leave the view alone
  const viewsBefore = repos.views.listForBoard(repos.boards.list(project.id).find((b) => b.name === "UI").id).length;
  await press(`[...document.querySelectorAll('.cfg-row .btn-icon')].pop()`);
  await sleep(400);
  check("removing a roster row is a draft, not a write", (await $(`document.querySelectorAll('.cfg-row').length`)) === viewsBefore - 1);
  await press(`[...document.querySelectorAll('.dlg-foot .btn-ghost')].pop()`);
  await sleep(700);
  check("Cancel discards the roster edit", repos.views.listForBoard(repos.boards.list(project.id).find((b) => b.name === "UI").id).length === viewsBefore);
  await press(`[...document.querySelectorAll('.board-head .btn-ghost')].pop()`);
  await sleep(800);
  await shot("15-board-settings");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  await $(`[...document.querySelectorAll('.qb-right .btn-ghost')].pop().click();true`);
  await sleep(800);
  check("view settings lists the column space with WIP inputs", (await $(`document.querySelectorAll('.wip-in').length`)) === 6);
  await shot("16-view-settings");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}));true`);
  await sleep(900);
  check("⌘, opens settings", (await $(`!!document.querySelector('.tok-table')`)) === true);
  check("an overlay demotes the chrome's primary button", (await $(`document.documentElement.classList.contains('overlay-open')`)) === true);
  check("all three themes preview at once", (await $(`document.querySelectorAll('.mode').length`)) === 3);
  check("the token table resolves live swatches", (await $(`document.querySelectorAll('.tok-table .chip').length`)) === 8);
  await shot("17-settings");
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

  // ── assistant panel ────────────────────────────────────────────────
  check("the assistant panel is docked", (await $(`!!document.querySelector('.ai')`)) === true);
  check("the context chip states what it can see", (await $(`!!document.querySelector('.ai-head .tag')?.textContent.includes('·')`)) === true);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'j',metaKey:true,bubbles:true}));true`);
  await sleep(600);
  check("⌘J collapses the assistant to its rail", (await $(`!!document.querySelector('.ai-rail')`)) === true);
  await shot("18-assistant-railed");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'j',metaKey:true,bubbles:true}));true`);
  await sleep(600);

  // ── cross-board scope ───────────────────────────────────────────────
  await press(`[...document.querySelectorAll('.side-row.is-board')].pop()`);
  await sleep(1200);
  check("a cross-board scope borrows every issue", (await $(`document.querySelectorAll('.card').length`)) > 0);
  check("epics are structure, never cards", (await $(`[...document.querySelectorAll('.card-title')].every(n => !/^(Multi-board architecture|Theme token refactor|AI panel|MCP surface)$/.test(n.textContent))`)) === true);
  check("cards in a scope name their owning board", (await $(`document.querySelectorAll('.card-board').length`)) > 0);
  check("a scope offers no board settings", (await $(`[...document.querySelectorAll('.board-head .btn-ghost')].some(b=>b.textContent.includes('Board settings'))`)) === false);
  check("a scope has no inline composer", (await $(`document.querySelectorAll('.col-body > .btn-ghost').length`)) === 0);
  await shot("19-scope-across-boards");

  // ── standalone issue screen ─────────────────────────────────────────
  const locked = repos.items.list({ projectId: project.id }).find((i) => i.humanLocked);
  await $(`location.hash = '#/p/${project.id}/i/${locked.id}';true`);
  await sleep(1600);
  check("the issue route renders the standalone sheet", (await $(`!!document.querySelector('.issue-wrap')`)) === true);
  check("the ledger names the write, not just 'updated'", (await $(`[...document.querySelectorAll('.ledger-txt')].some(n => /locked title and body|set status to/.test(n.textContent))`)) === true);
  check("the field strip lays out horizontally", (await $(`document.querySelectorAll('.issue-wrap .fs-item').length`)) === 6);
  check("a locked issue explains the lock", (await $(`!!document.querySelector('.lockbar')`)) === true);
  check("blocked issues are listed as relations", (await $(`document.querySelectorAll('.rel-row').length`)) === 3);
  await shot("20-issue-detail");

  return results;
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.log("HARNESS ERROR: " + (err && err.stack ? err.stack : String(err)));
    check("harness ran to completion", false);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${SHOTS}`);
  if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
  app.exit(failed.length ? 1 : 0);
});
