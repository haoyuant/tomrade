/**
 * UI regression: drives the REAL UI against the REAL plugins, booted from the
 * app's own tomrade.yml over a throwaway SQLite file seeded with the design's
 * sample project. Checks the interactions the design specifies, then captures
 * a screenshot per screen and per theme into scripts/shots/.
 *
 *   pnpm --filter @tomrade/desktop test:ui        (needs the dev server up)
 */
import { app, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
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

const run = async () => {
  // The same composition the app boots, patched by id: MCP on a free port so a
  // running Tomrade never collides with the harness.
  const { ctx } = await boot({
    configFile: path.join(__dirname, "../tomrade.yml"),
    vars: { userData: WORK },
    patches: [[{ id: "mcp", config: { port: 0 } }]]
  });
  // The projects plugin seeds a default project on boot; the design's sample data is the whole fixture.
  ctx.projects.remove("default");
  const repos = { db: ctx.db, items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views };
  const { project } = seedDesignProject(repos);

  const win = new BrowserWindow({
    width: 1560,
    height: 940,
    show: !!process.env.TOMRADE_SHOW,
    webPreferences: { preload: path.join(__dirname, "../preload.cjs"), contextIsolation: true }
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
  const SEGMENT = { system: 0, light: 1, dark: 2, matcha: 3 };
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

  // ── enter the project ───────────────────────────────────────────────
  await $(`document.querySelectorAll('.proj')[0].click();true`);
  await sleep(1800);
  check("board route resolves to a board and a view", /\/p\/.+\/b\/.+\/v\/.+/.test(await $(`location.hash`)));
  const boardRows = await $(`document.querySelectorAll('.side-row.is-board').length`);
  check("sidebar lists four workstreams plus two cross-board scopes", boardRows === 6);
  check("one sidebar row is current", (await $(`document.querySelectorAll('.side-row[aria-current="true"]').length`)) === 1);
  check("query bar renders four facets", (await $(`document.querySelectorAll('.qb-btn').length`)) === 4);
  check("grouping segmented control has three modes and the contributed graph", (await $(`document.querySelectorAll('.seg.quiet button').length`)) === 4);
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

  // ── dependency graph ────────────────────────────────────────────────
  // The fourth segment is contributed by @tomrade/deps-graph: same slice,
  // arranged as blocker → blocked. Expectations are computed from the
  // repository, so the section holds whatever the seed happens to contain.
  await $(`document.querySelectorAll('.seg.quiet button')[3].click();true`);
  await sleep(1400);
  check("the graph segment renders the canvas", (await $(`!!document.querySelector('.graph-region .react-flow')`)) === true);
  const graphBoardId = (await $(`location.hash`)).match(/\/b\/([^/]+)\//)[1];
  const graphBoard = repos.boards.get(graphBoardId);
  const ownedNow = () =>
    repos.items.list({ projectId: project.id }).filter((i) => i.kind !== "epic" && (graphBoard.across || i.boardId === graphBoardId));
  const edgesAmong = (owned) => {
    const ids = new Set(owned.map((i) => i.id));
    return owned.flatMap((i) => i.blocks.filter((t) => ids.has(t))).length;
  };
  const graphOwned = ownedNow();
  check("the graph draws a card node per owned issue", (await $(`document.querySelectorAll('.react-flow__node .card').length`)) === graphOwned.length);
  check("the dependencies draw as arrows", (await $(`document.querySelectorAll('.react-flow__edge').length`)) === edgesAmong(graphOwned));

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
  await $(`document.querySelectorAll('.seg.quiet button')[0].click();true`);
  await sleep(700);

  // ── detail pane ─────────────────────────────────────────────────────
  await $(`document.querySelector('.card').click();true`);
  await sleep(900);
  check("a card opens the detail pane", (await $(`!!document.querySelector('.detail')`)) === true);
  check("the detail prints the field strip", (await $(`document.querySelectorAll('.detail .field-row').length`)) === 9);
  check("the activity ledger reads the oplog", (await $(`document.querySelectorAll('.detail .ledger-row').length`)) > 0);
  check("the writable fields render as controls", (await $(`document.querySelectorAll('.detail .fsel').length`)) === 4);
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
  check("the edit is one reversible oplog row", ctx.oplog.historyFor("item", opened.id, 1)[0]?.op === "update");

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
  await checkCentred("the expanded issue overlay", ".detail.expanded");
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
  await checkCentred("the new-issue sheet");
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
  await checkCentred("board settings");
  await shot("15-board-settings");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  await $(`[...document.querySelectorAll('.qb-right .btn-ghost')].pop().click();true`);
  await sleep(800);
  check("view settings lists the column space with WIP inputs", (await $(`document.querySelectorAll('.wip-in').length`)) === 6);
  await checkCentred("view settings");
  await shot("16-view-settings");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}));true`);
  await sleep(900);
  check("⌘, opens settings", (await $(`!!document.querySelector('.tok-table')`)) === true);
  check("an overlay demotes the chrome's primary button", (await $(`document.documentElement.classList.contains('overlay-open')`)) === true);
  check("all three themes preview at once", (await $(`document.querySelectorAll('.mode').length`)) === 3);
  check("the token table resolves live swatches", (await $(`document.querySelectorAll('.tok-table .chip').length`)) === 8);
  check("the theme switch reports the preference, not the resolved theme", (await $(`document.querySelectorAll('.dlg-body .theme-seg[aria-pressed="true"]').length`)) === 1);
  // one pane at a time: the menu is what makes the sheet short enough to read
  check("settings opens on a side menu", (await $(`document.querySelectorAll('.dlg-nav .side-row').length`)) >= 4);
  check("exactly one menu row is current", (await $(`document.querySelectorAll('.dlg-nav .side-row[aria-current="true"]').length`)) === 1);
  check("it lands on Appearance", (await $(`document.querySelector('.dlg-body .sec-title')?.textContent`)) === "Appearance");
  await checkCentred("settings");
  await shot("17-settings");
  const sheetBox = `(() => { const r = document.querySelector('.palette.modal').getBoundingClientRect(); return r.width + 'x' + r.height; })()`;
  const boxOnAppearance = await $(sheetBox);
  await press(settingsNav("Agent access"));
  await sleep(600);
  check("choosing a menu row swaps the pane", (await $(`document.querySelector('.dlg-body .sec-title')?.textContent`)) === "Agent access");
  check("and takes the pane it replaced out of the body", (await $(`!!document.querySelector('.tok-table')`)) === false);
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
  check("a third-party plugin's switch is free", (await $(`!${rowFor("stale")}.querySelector('.switch[disabled]')`)) === true);
  check("the manager fits the frame the other panes set", (await $(sheetBox)) === boxOnAppearance);
  await shot("18-plugins");
  await $(`${rowFor("write-policy")}.scrollIntoView({ block: 'center' });true`);
  await sleep(400);
  await shot("18-plugins-installed");

  await press(`${rowFor("stale")}.querySelector('.switch')`);
  await sleep(1200);
  check("the switch unloads the plugin in the main process", ctx.plugins.list().find((p) => p.id === "stale")?.state === "disabled");
  check("its tool leaves the registry", !ctx.tools.list().some((t) => t.name === "list_stale_items"));
  check("and the sheet redraws from what loaded", (await $(`${rowFor("stale")}.querySelector('.tag').textContent`)) === "off");
  await press(`${rowFor("stale")}.querySelector('.switch')`);
  await sleep(1200);
  check("switching it back on restores the plugin and its tool", ctx.tools.list().some((t) => t.name === "list_stale_items"));
  await press(`[...document.querySelectorAll('.dlg-foot .btn-secondary')].pop()`);
  await sleep(700);

  // ── assistant panel ────────────────────────────────────────────────
  check("the assistant panel is docked", (await $(`!!document.querySelector('.ai')`)) === true);
  check("the engine chip names the conductor", (await $(`(document.querySelector('.ai-head .chip-btn')?.textContent ?? '').trim().length > 0`)) === true);
  check("an empty thread introduces the agent", (await $(`!!document.querySelector('.ai-scroll .turn-ai, .ai-scroll .agent-empty')`)) === true);
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
  check("a railed sidebar hands board switching to the board head", (await $(`getComputedStyle(document.querySelector('.board-nav')).display`)) !== "none");
  check("the collapsed sidebar is remembered", (await $(`localStorage.getItem('tomrade.sidebar.open')`)) === "0");
  await shot("18-sidebar-railed");
  await press(`document.querySelector('.side-rail .btn-icon')`);
  await sleep(600);
  check("the rail's button brings the sidebar back", (await $(`!!document.querySelector('.sidebar')`)) === true);
  check("the board head's switcher retreats with it", (await $(`getComputedStyle(document.querySelector('.board-nav')).display`)) === "none");

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
  check("the field strip lays out horizontally", (await $(`document.querySelectorAll('.issue-wrap .fs-item').length`)) === 10);
  check("the standalone sheet is editable too", (await $(`document.querySelectorAll('.issue-wrap .fsel').length`)) === 4);
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
  check("the delete control is not an eleventh field", (await $(`document.querySelectorAll('.issue-wrap .fs-item').length`)) === 10);

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
  check("Escape cancels the confirmation rather than confirming it", repos.items.get(doomed.id) !== null);
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
  check("confirming destroys the issue for good", repos.items.get(doomed.id) === null);
  check("the purge left one tombstone and no history", ctx.oplog.historyFor("item", doomed.id, 10).map((o) => o.op).join() === "purge");
  check("deleting the open issue leaves for the board, not a dead sheet", /\/p\/.+\/b\/.+\/v\/.+/.test(await $(`location.hash`)));

  // the same control on the docked pane, where the board is what has to react
  await sleep(900);
  await $(`(() => { const c=[...document.querySelectorAll('.card')].find(n=>n.textContent.includes('${doomed2.key}')); if(!c) return false; c.click(); return true; })()`);
  await sleep(900);
  check("the detail pane offers the same permanent delete", (await $(`!!document.querySelector('.detail .purge-btn')`)) === true);
  await press(`document.querySelector('.detail .purge-btn')`);
  await sleep(800);
  await press(`document.querySelector('.dlg-foot .btn-danger')`);
  await sleep(1400);
  check("the pane's delete destroys the issue too", repos.items.get(doomed2.id) === null);
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
  check("⌘Z cannot resurrect a permanently deleted issue", repos.items.get(doomed2.id) === null);
  check("the tombstone survives the undo as the audit trail", ctx.oplog.recent(30).some((o) => o.op === "purge" && o.entityId === doomed2.id));
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
  check("its boards, views and issues go with it", repos.boards.list(throwaway.id).length === 0 && repos.items.list({ projectId: throwaway.id }).length === 0);
  check("the card leaves the grid", (await $(`document.querySelectorAll('.proj').length`)) === 2);
  check("the sheet closes with the project it was configuring", (await $(`!!document.querySelector('#psName')`)) === false);
  check("the fixture project is untouched", repos.items.list({ projectId: project.id }).length > 0);
  await shot("27-after-project-delete");

  // ── where a project is stored ────────────────────────────────────────
  // The whole feature through the real UI: choose a destination, publish, and
  // find the project on disk as text — then stop using it and find it still there.
  const dest = path.join(WORK, "destination");
  fs.mkdirSync(dest, { recursive: true });

  await press(gearFor("Tomrade Next"));
  await sleep(900);
  check("the sheet says where the project is stored", (await $(`!!document.querySelector('#stgProvider')`)) === true);
  check("an unbound project reads as living on this machine", (await $(`document.querySelector('#stgProvider')?.value`)) === "");
  check(
    "every registered destination is offered",
    (await $(`[...document.querySelectorAll('#stgProvider option')].map(o => o.value).join()`)) === ",folder,git,github"
  );
  check(
    "nothing is publishable until a destination is chosen",
    (await $(`[...document.querySelectorAll('.dlg-body .btn-secondary')].some(b => /Publish here/.test(b.textContent) && !b.disabled)`)) === false
  );

  await pick(`document.querySelector('#stgProvider')`, "folder");
  await sleep(500);
  check("choosing a folder asks which folder", (await $(`!!document.querySelector('#sf-stg-dir')`)) === true);
  check(
    "a path is chosen, not only typed",
    (await $(`[...document.querySelectorAll('.dlg-body .btn-secondary')].some(b => /Choose/.test(b.textContent))`)) === true
  );

  const publishBtn = `[...document.querySelectorAll('.dlg-body .btn-secondary')].find(b => /Publish here/.test(b.textContent))`;
  await typeInto("#sf-stg-dir", dest);
  await sleep(400);
  check("a chosen destination arms the publish", (await $(`${publishBtn}?.disabled`)) === false);
  await shot("28-project-storage");

  await press(publishBtn);
  await sleep(2600);
  check("publishing writes the project to the destination as text", fs.existsSync(path.join(dest, ".tomrade", "project.json")));
  check(
    "every issue travels as one line",
    fs.readFileSync(path.join(dest, ".tomrade", "state", "items.jsonl"), "utf8").trim().split("\n").length === repos.items.list({ projectId: project.id }).length
  );
  check("the live database is never in the destination", !fs.existsSync(path.join(dest, ".tomrade", "project.db")));
  check("the destination keeps a database out on purpose", fs.readFileSync(path.join(dest, ".tomrade", ".gitignore"), "utf8").includes("*.db"));
  check("the sheet reports it as published", (await $(`[...document.querySelectorAll('.cfg-row .tag')].some(t => t.textContent === 'Published')`)) === true);
  check(
    "a published project offers a sync",
    (await $(`[...document.querySelectorAll('.dlg-body .btn-ghost')].some(b => /Sync now/.test(b.textContent))`)) === true
  );
  await shot("29-project-published");

  // An unchanged project publishes nothing: the artifact is byte-identical.
  const publishedAt = fs.statSync(path.join(dest, ".tomrade", "state", "items.jsonl")).mtimeMs;
  await press(`[...document.querySelectorAll('.dlg-body .btn-ghost')].find(b => /Sync now/.test(b.textContent))`);
  await sleep(1800);
  check("syncing an unchanged project rewrites nothing", fs.statSync(path.join(dest, ".tomrade", "state", "items.jsonl")).mtimeMs === publishedAt);

  await pick(`document.querySelector('#stgProvider')`, "");
  await sleep(400);
  await press(`[...document.querySelectorAll('.dlg-body .btn-secondary')].find(b => /Stop using a destination/.test(b.textContent))`);
  await sleep(1600);
  check("a project can stop using a destination", (await $(`document.querySelector('#stgProvider')?.value`)) === "");
  check("nothing at the destination is deleted with the binding", fs.existsSync(path.join(dest, ".tomrade", "project.json")));

  // A destination that needs an account asks for it here, where it is used —
  // and stays closed until it has one, so nothing is typed into a dead form.
  await pick(`document.querySelector('#stgProvider')`, "github");
  await sleep(700);
  check("a destination that needs an account asks for it inline", (await $(`!!document.querySelector('#stgSecret')`)) === true);
  check("its own fields stay shut until the account is connected", (await $(`!!document.querySelector('#sf-stg-owner')`)) === false);
  check(
    "publishing is impossible without the account",
    (await $(`[...document.querySelectorAll('.dlg-body .btn-secondary')].every(b => !/Publish here/.test(b.textContent) || b.disabled)`)) === true
  );
  check(
    "it says where to get one",
    (await $(`[...document.querySelectorAll('.dlg-body .btn-ghost')].some(b => /github\.com/.test(b.textContent))`)) === true
  );
  await shot("30-destination-connect");

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(700);

  // The account is stored per machine, but it is not a screen of its own: the
  // provider claims that section, and Settings does not draw it twice.
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}));true`);
  await sleep(900);
  const navLabels = `[...document.querySelectorAll('.dlg-nav .side-row')].map(r => r.textContent.trim()).join(' | ')`;
  check("a plugin's own settings pane is still offered", (await $(navLabels)).includes("Stale issues"));
  check("but a destination's account is not a settings pane", (await $(navLabels)).includes("GitHub") === false);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  // ── opening a project someone else published ────────────────────────
  // The round trip that matters for a team: publish, leave, and come back to it
  // from the destination alone — no clone by hand, no id typed in.
  const handoffDir = path.join(WORK, "handoff");
  const handoff = repos.projects.create({ name: "Handoff", keyPrefix: "HND" });
  repos.items.create({ title: "written on the other machine", projectId: handoff.id, boardId: repos.boards.defaultFor(handoff.id).id, by: "human" });
  await ctx.storage.bind(handoff.id, "folder", { dir: handoffDir });
  repos.projects.remove(handoff.id);
  check("the destination keeps the project after it leaves this machine", fs.existsSync(path.join(handoffDir, ".tomrade", "project.json")));

  await $(`location.hash = '#/';true`);
  await sleep(400);
  win.webContents.reload();
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await sleep(2600);
  check("the project it left is gone from the grid", (await $(`[...document.querySelectorAll('.proj-name')].some(n => n.textContent === 'Handoff')`)) === false);

  await press(`[...document.querySelectorAll('.titlebar .btn')].find(b => /Open a project/.test(b.textContent))`);
  await sleep(800);
  check("opening a project asks where it is, not only for a folder", (await $(`!!document.querySelector('#opProvider')`)) === true);
  check(
    "every destination can be opened from, not just a folder",
    (await $(`[...document.querySelectorAll('#opProvider option')].map(o => o.value).join()`)) === "folder,git,github"
  );
  await shot("31-open-a-project");

  await typeInto("#sf-op-dir", handoffDir);
  await sleep(400);
  await press(`document.querySelector('.dlg-foot .btn-primary')`);
  await sleep(2600);
  check("the project comes back from its destination", repos.projects.get(handoff.id) !== null);
  check("it keeps the id agents already know", (await $(`location.hash`)).includes(handoff.id));
  check("its issues and its key prefix came with it", repos.items.list({ projectId: handoff.id })[0]?.key === "HND-1");

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
