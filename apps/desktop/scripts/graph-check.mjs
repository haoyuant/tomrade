/**
 * Graph regression: the dependency graph reads cleanly — no card covers
 * another, no arrow runs under a card it does not join, tickets with no
 * dependency line up apart from the chains — and its foot carries the two
 * actions: Update dependencies asks the assistant to recheck them, and
 * Export image saves the whole graph as a PNG.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:graph
 */
import { app, BrowserWindow, dialog } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-graph-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

// [title, labels, blocks (by index)] — chains, a diamond, a skipped rank, a fan-out, long titles, and loners
const TICKETS = [
  ["Design the storage schema", ["core"], [1, 2, 6]],
  ["Write the migration runner that upgrades every existing project database in place", ["core", "storage"], [3]],
  ["Expose items over IPC", [], [3, 4]],
  ["Board view", ["ui"], [5]],
  ["Detail pane with every field the plugins contribute, editable inline", ["ui"], [5]],
  ["Ship the beta", ["release"], []],
  ["Sync to GitHub Issues", ["sync"], [5]],
  ["Fix the flaky clock test", [], []],
  ["Translate the settings sheet", ["i18n"], []],
  ["Write the onboarding guide for a team that has never used a backlog before", ["docs"], []],
  ["Spike: local embeddings", [], []],
  ["Keyboard shortcuts cheat sheet", ["ui"], []]
];

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });

  const board = ctx.boards.list(project.id)[0];
  const made = TICKETS.map(([title, labels]) => ctx.items.create({ projectId: project.id, boardId: board.id, title, labels, by: "human" }));
  TICKETS.forEach(([, , blocks], i) => {
    if (blocks.length) ctx.items.update(project.id, made[i].id, { blocks: blocks.map((j) => made[j].id) }, "human");
  });
  ctx.items.update(project.id, made[0].id, { status: "done" }, "human");
  // two epics: each card wears its epic's tag, in a hue of the epic's own
  const epics = ["Storage rewrite", "Editing in place"].map((title) => ctx.items.create({ projectId: project.id, boardId: board.id, title, kind: "epic", by: "human" }));
  for (const [i, epic] of [[1, 0], [2, 0], [3, 1], [4, 1]]) ctx.items.update(project.id, made[i].id, { parentId: epics[epic].id }, "human");
  // a finished loner and a cancelled one: nothing for the graph to say about either
  ctx.items.update(project.id, made[7].id, { status: "done" }, "human");
  ctx.items.update(project.id, made[10].id, { status: "cancelled" }, "human");
  const HIDDEN = 3;
  const allEdges = TICKETS.reduce((n, [, , blocks]) => n + blocks.length, 0);
  // AL-1 is done, so none of its links is live: it steps out of the picture with them.
  const settledEdges = TICKETS[0][2].length;
  const edgeCount = allEdges - settledEdges;
  const view = ctx.views.create({ projectId: project.id, name: "Dependencies", icon: "i-graph", layout: "graph", query: { filter: [], columnBy: "status", columns: [], groupBy: null, sortBy: [], wip: {}, graph: "deps" } });

  // The save dialog answers itself: the export lands in the work folder.
  const exported = path.join(work, "graph.png");
  let saveAsked = null;
  dialog.showSaveDialog = async (...args) => {
    saveAsked = args.at(-1);
    return { canceled: false, filePath: exported };
  };

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}/v/${view.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  for (let i = 0; i < 50 && (await $(`document.querySelectorAll('.react-flow__edge').length`)) < edgeCount; i++) await sleep(200);
  await sleep(800);

  check("open tickets are cards; done, cancelled and settled ones are not", (await $(`document.querySelectorAll('.react-flow__node .card').length`)) === TICKETS.length - HIDDEN);
  check("every live dependency is an arrow", (await $(`document.querySelectorAll('.react-flow__edge').length`)) === edgeCount);

  // Geometry in flow coordinates, so it holds at any zoom and off screen.
  const geometry = () =>
    $(`(() => {
      const scale = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a;
      const origin = document.querySelector('.react-flow__viewport').getBoundingClientRect();
      const nodes = [...document.querySelectorAll('.react-flow__node')].map((n) => {
        const r = n.getBoundingClientRect();
        return { id: n.dataset.id, x: (r.left - origin.left) / scale, y: (r.top - origin.top) / scale, w: r.width / scale, h: r.height / scale };
      });
      const edges = [...document.querySelectorAll('.react-flow__edge')].map((g) => {
        const p = g.querySelector('.react-flow__edge-path');
        const [source, target] = g.dataset.id.split('>');
        const m = p.getScreenCTM();
        const len = p.getTotalLength();
        const points = [];
        for (let s = 0; s <= len; s += 4) {
          const pt = p.getPointAtLength(s).matrixTransform(m);
          points.push({ x: (pt.x - origin.left) / scale, y: (pt.y - origin.top) / scale });
        }
        return { source, target, points };
      });
      return { nodes, edges };
    })()`);

  const audit = async (when) => {
    const { nodes, edges } = await geometry();
    const overlaps = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (w > 0 && h > 0) overlaps.push([a.id, b.id, Math.round(w), Math.round(h)]);
      }
    check(`${when}: no card covers another`, overlaps.length === 0, overlaps);
    // An arrow may touch its own two cards at its ends, never another card.
    const crossings = [];
    for (const e of edges)
      for (const n of nodes) {
        if (n.id === e.source || n.id === e.target) continue;
        if (e.points.some((p) => p.x > n.x + 2 && p.x < n.x + n.w - 2 && p.y > n.y + 2 && p.y < n.y + n.h - 2)) crossings.push([e.source, e.target, n.id]);
      }
    check(`${when}: no arrow runs under a card it does not join`, crossings.length === 0, crossings);
    // Gaps between neighbours: tight enough to read as one graph, loose enough to tell cards apart.
    const tight = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
        const dy = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
        if (Math.max(dx, dy) < 12) tight.push([a.id, b.id]);
      }
    check(`${when}: cards keep a gap between them`, tight.length === 0, tight);
    return { nodes, edges };
  };

  const first = await audit("as laid out");
  await shot("graph-01-laid-out");

  // Loners sit apart from the chains, in rows, not as one long column.
  const linked = new Set(first.edges.flatMap((e) => [e.source, e.target]));
  const loners = first.nodes.filter((n) => !linked.has(n.id));
  const chains = first.nodes.filter((n) => linked.has(n.id));
  const chainBottom = Math.max(...chains.map((n) => n.y + n.h));
  check("tickets without a dependency gather below the chains", loners.every((n) => n.y >= chainBottom), { loners: loners.map((n) => n.y), chainBottom });
  check("tickets without a dependency share rows", new Set(loners.map((n) => Math.round(n.y))).size < loners.length);

  // A selected card stays put and the layout holds once a card is opened.
  await press(`document.querySelector('.react-flow__node .card')`);
  await sleep(900);
  await audit("with the detail open");
  // The selected card lights what it waits on and what waits on it; the rest steps back.
  const focusId = await $(`document.querySelector('.react-flow__node.is-focus')?.dataset.id`);
  const neighbours = new Set(first.edges.flatMap((e) => (e.source === focusId ? [e.target] : e.target === focusId ? [e.source] : [])));
  check("the selected card is marked as the focus", !!focusId);
  const upstream = first.edges.filter((e) => e.target === focusId).map((e) => e.source);
  const downstream = first.edges.filter((e) => e.source === focusId).map((e) => e.target);
  check("what it waits on is lit as upstream", (await $(`[...document.querySelectorAll('.react-flow__node.is-up')].map((n) => n.dataset.id).sort().join()`)) === upstream.sort().join());
  check("what waits on it is lit as downstream", (await $(`[...document.querySelectorAll('.react-flow__node.is-down')].map((n) => n.dataset.id).sort().join()`)) === downstream.sort().join());
  check("every other card steps back", (await $(`document.querySelectorAll('.react-flow__node.is-dim').length`)) === TICKETS.length - HIDDEN - 1 - neighbours.size);
  check("its incoming arrows are lit as upstream, outgoing as downstream", (await $(`[document.querySelectorAll('.react-flow__edge.is-up').length, document.querySelectorAll('.react-flow__edge.is-down').length].join()`)) === `${upstream.length},${downstream.length}`);
  check("upstream and downstream wear different colours", (await $(`(() => { const u = document.querySelector('.react-flow__node.is-up'); const d = document.querySelector('.react-flow__node.is-down'); return !u || !d || u.style.getPropertyValue('--ring') !== d.style.getPropertyValue('--ring'); })()`)) === true);
  await shot("graph-02-detail-open");
  await press(`document.querySelector('.react-flow__pane')`);
  await sleep(500);
  check("a click on the canvas lets every card back", (await $(`document.querySelectorAll('.react-flow__node.is-dim, .react-flow__node.is-focus').length`)) === 0);
  // The pointer alone lights a card the same way, and takes it with it when it leaves.
  const hovered = first.edges[0].target;
  const latency = await $(`new Promise((resolve) => {
    const start = performance.now();
    document.querySelector('.react-flow__node[data-id="${hovered}"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const tick = () => document.querySelector('.react-flow__node.is-focus') ? resolve(Math.round(performance.now() - start)) : performance.now() - start > 1000 ? resolve(-1) : requestAnimationFrame(tick);
    requestAnimationFrame(tick);
  })`);
  check("the highlight answers the pointer within 100 ms", latency >= 0 && latency <= 100, latency);
  await sleep(300);
  check("hovering a card puts it in focus", (await $(`document.querySelector('.react-flow__node.is-focus')?.dataset.id`)) === hovered);
  const fadeIn = await $(`(() => {
    const ms = (el, prop) => { const cs = getComputedStyle(el); const i = cs.transitionProperty.split(', ').indexOf(prop); return i < 0 ? 0 : parseFloat(cs.transitionDuration.split(', ')[i]) * 1000; };
    const lit = document.querySelector('.react-flow__node.is-up, .react-flow__node.is-down') ?? document.querySelector('.react-flow__node.is-focus');
    return { ring: ms(lit.querySelector('.card'), 'box-shadow'), dim: ms(document.querySelector('.react-flow__node.is-dim'), 'opacity'), line: ms(document.querySelector('.react-flow__edge.is-up .react-flow__edge-path, .react-flow__edge.is-down .react-flow__edge-path'), 'stroke') };
  })()`);
  check("and fades into it quickly", Object.values(fadeIn).every((v) => v > 0 && v <= 150), fadeIn);
  check("and lights its blockers", (await $(`document.querySelectorAll('.react-flow__node.is-up').length`)) === first.edges.filter((e) => e.target === hovered).length);
  await $(`document.querySelector('.react-flow__node[data-id="${hovered}"]').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))`);
  await sleep(300);
  check("leaving it lets every card back", (await $(`document.querySelectorAll('.react-flow__node.is-dim, .react-flow__node.is-focus').length`)) === 0);
  // A real pointer resting on a card: the focus holds still (no card hides for a frame, which would
  // end the hover and start it again), and a real click lands.
  const centre = await $(`(() => { const r = document.querySelector('.react-flow__node[data-id="${hovered}"] .card').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: centre.x - 40, y: centre.y });
  win.webContents.sendInputEvent({ type: "mouseMove", x: centre.x, y: centre.y });
  const steady = await $(`new Promise((resolve) => {
    // once the focus lands on the card, every frame it is elsewhere is a flicker
    let hidden = 0, lost = 0, landed = false;
    const start = performance.now();
    const tick = () => {
      hidden += [...document.querySelectorAll('.react-flow__node')].filter((n) => getComputedStyle(n).visibility === 'hidden').length;
      const now = document.querySelector('.react-flow__node.is-focus')?.dataset.id ?? null;
      if (now === '${hovered}') landed = true;
      else if (landed) lost++;
      if (performance.now() - start < 1000) requestAnimationFrame(tick); else resolve({ hidden, lost, focus: now });
    };
    requestAnimationFrame(tick);
  })`);
  check("a resting pointer keeps every card shown", steady.hidden === 0, steady);
  check("and keeps the focus still on that card", steady.lost === 0 && steady.focus === hovered, steady);
  win.webContents.sendInputEvent({ type: "mouseDown", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
  await sleep(900);
  // Sweeping across cards is not a hover on each: the focus stays put until the pointer rests.
  const centres = await $(`[...document.querySelectorAll('.react-flow__node:not(.is-focus) .card')].slice(0, 3).map((c) => { const r = c.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: c.closest('.react-flow__node').dataset.id }; })`);
  const before = await $(`document.querySelector('.react-flow__node.is-focus')?.dataset.id ?? null`);
  const seen = new Set();
  for (const c of centres) {
    win.webContents.sendInputEvent({ type: "mouseMove", x: c.x, y: c.y });
    await sleep(30);
    seen.add(await $(`document.querySelector('.react-flow__node.is-focus')?.dataset.id ?? null`));
  }
  check("a pointer sweeping across cards does not strobe the focus", seen.size === 1 && seen.has(before), [...seen]);
  await sleep(400);
  check("and the focus settles where it rests", (await $(`document.querySelector('.react-flow__node.is-focus')?.dataset.id`)) === centres.at(-1).id);
  win.webContents.sendInputEvent({ type: "mouseMove", x: centre.x, y: centre.y });
  await sleep(400);
  check("a real click on the hovered card opens it", (await $(`document.querySelector('.detail .card-id')?.textContent`)) === (await $(`document.querySelector('.react-flow__node[data-id="${hovered}"] .card-id')?.textContent`)));
  win.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
  await press(`document.querySelector('.react-flow__pane')`);
  await sleep(500);
  // The highlight fades rather than snaps: rings, lines and arrowheads all ease between states.
  const fades = await $(`(() => {
    const ms = (el, prop) => { const cs = getComputedStyle(el); const props = cs.transitionProperty.split(', '); const i = props.indexOf(prop); return i < 0 ? 0 : parseFloat(cs.transitionDuration.split(', ')[i]) * 1000; };
    return {
      ring: ms(document.querySelector('.react-flow__node .card'), 'box-shadow'),
      dim: ms(document.querySelector('.react-flow__node'), 'opacity'),
      line: ms(document.querySelector('.react-flow__edge-path'), 'stroke'),
      arrow: ms(document.querySelector('.edge-arrow'), 'fill')
    };
  })()`);
  check("the ring, the dimming, the lines and the arrowheads fade slowly out of a focus", Object.values(fades).every((v) => v >= 250), fades);
  check("every arrow has its own arrowhead in its line's colour", (await $(`[...document.querySelectorAll('.react-flow__edge')].every((g) => g.querySelector('.edge-arrow')?.style.fill === g.querySelector('.react-flow__edge-path').style.stroke)`)) === true);
  check("every live dependency carries a flowing dot", (await $(`document.querySelectorAll('.edge-flow').length`)) === edgeCount, await $(`document.querySelectorAll('.edge-flow').length`));

  // The settled ticket comes back on request, its arrows dashed and still, and goes again.
  check("the foot counts the settled tickets", (await $(`document.querySelector('[data-testid="graph-settled"]')?.textContent`))?.includes(String(HIDDEN)) === true);
  await press(`document.querySelector('[data-testid="graph-settled"]')`);
  await sleep(1200);
  check("showing them draws every ticket", (await $(`document.querySelectorAll('.react-flow__node .card').length`)) === TICKETS.length);
  check("and every dependency", (await $(`document.querySelectorAll('.react-flow__edge').length`)) === allEdges);
  check("a finished blocker's arrows are dashed", (await $(`[...document.querySelectorAll('.react-flow__edge')].filter((g) => g.querySelector('.react-flow__edge-path').style.strokeDasharray).length`)) === settledEdges);
  check("an open blocker's arrows are not", (await $(`[...document.querySelectorAll('.react-flow__edge')].filter((g) => !g.querySelector('.react-flow__edge-path').style.strokeDasharray).length`)) === edgeCount);
  check("a finished blocker's arrows carry no dot", (await $(`document.querySelectorAll('.edge-flow').length`)) === edgeCount);
  await audit("with the settled shown");
  await shot("graph-02b-settled-shown");
  await press(`document.querySelector('[data-testid="graph-settled"]')`);
  await sleep(1200);
  check("hiding them again takes the settled tickets out", (await $(`document.querySelectorAll('.react-flow__node .card').length`)) === TICKETS.length - HIDDEN);
  await $(`document.querySelector('.detail-close, [data-testid="detail-close"]')?.click()`);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(600);

  // ── epic tags ──
  const epicTags = await $(`[...document.querySelectorAll('.react-flow__node .card-epic')].map((t) => ({ name: t.textContent, hue: Number(t.style.getPropertyValue('--epic-hue')) }))`);
  check("each card in an epic wears the epic's tag", epicTags.length === 4 && epicTags.filter((t) => t.name === "Storage rewrite").length === 2 && epicTags.filter((t) => t.name === "Editing in place").length === 2, epicTags);
  const hueOf = (name) => epicTags.find((t) => t.name === name)?.hue;
  const apart = Math.abs(hueOf("Storage rewrite") - hueOf("Editing in place")) % 360;
  check("two epics wear hues well apart", Math.min(apart, 360 - apart) >= 60, epicTags);
  check("no epic wears the reds, oranges or ambers a blocked or upstream mark speaks in", epicTags.every((t) => t.hue >= 120 && t.hue <= 340), epicTags);
  const contrast = await $(`(() => {
    const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgb = (c) => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = '#000'; paint.fillStyle = c; paint.fillRect(0, 0, 1, 1); return [...paint.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const root = document.documentElement;
    const before = root.className;
    const out = {};
    for (const theme of ['', 'dark', 'matcha', 'dawn', 'sunrise', 'daybreak', 'sakura']) {
      root.classList.remove('dark', 'matcha', 'dawn', 'sunrise', 'daybreak', 'glass', 'sakura', 'backdrop');
      if (theme) root.classList.add(theme);
      out[theme || 'light'] = Math.min(...[...document.querySelectorAll('.react-flow__node .card-epic')].map((t) => { const cs = getComputedStyle(t); return ratio(cs.color, cs.backgroundColor); })).toFixed(2);
    }
    root.className = before;
    return out;
  })()`);
  check("every epic tag reads at 4.5:1 or better in every theme", Object.values(contrast).every((r) => Number(r) >= 4.5), contrast);
  console.log("epic tag contrast by theme:", JSON.stringify(contrast));

  // ── export ──
  check("the foot offers Export image", (await $(`!!document.querySelector('[data-testid="graph-export"]')`)) === true);
  await press(`document.querySelector('[data-testid="graph-export"]')`);
  for (let i = 0; i < 50 && !(saveAsked && fs.existsSync(exported)); i++) await sleep(200);
  await sleep(300);
  check("Export image asks where to save a .png", saveAsked?.defaultPath?.endsWith(".png"), saveAsked);
  const png = fs.existsSync(exported) ? fs.readFileSync(exported) : Buffer.alloc(0);
  const pngW = png.length > 24 ? png.readUInt32BE(16) : 0;
  const pngH = png.length > 24 ? png.readUInt32BE(20) : 0;
  check("the export is a PNG", png.subarray(1, 4).toString() === "PNG");
  const spanW = Math.max(...first.nodes.map((n) => n.x + n.w)) - Math.min(...first.nodes.map((n) => n.x));
  const spanH = Math.max(...first.nodes.map((n) => n.y + n.h)) - Math.min(...first.nodes.map((n) => n.y));
  check("the export holds the whole graph at full size", pngW >= spanW && pngH >= spanH, { pngW, pngH, spanW, spanH });
  if (png.length) fs.copyFileSync(exported, path.join(shots, "graph-03-export.png"));

  // ── update dependencies ──
  check("the foot offers Update dependencies", (await $(`!!document.querySelector('[data-testid="graph-update-deps"]')`)) === true);
  const threadsBefore = ctx.agent.store.threads?.(project.id)?.length ?? 0;
  await press(`document.querySelector('[data-testid="graph-update-deps"]')`);
  await sleep(1500);
  const sent = await $(`[...document.querySelectorAll('.msg, .turn, [data-role="user"]')].map((n) => n.textContent).join(' ')`);
  check("Update dependencies sends the ask to the assistant", /dependenc/i.test(sent ?? ""), { sent: (sent ?? "").slice(0, 200), threadsBefore });
  await shot("graph-04-update-deps");

  // Narrow window: the foot's actions still fit beside the hint.
  win.setSize(900, 800);
  await sleep(800);
  check("the foot fits a narrow window", (await $(`(() => { const f = document.querySelector('.graph-foot'); return f && f.scrollWidth <= f.clientWidth + 1; })()`)) === true);
  await shot("graph-05-narrow");

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(() => run().catch((err) => {
  console.error(err);
  app.exit(1);
}));
