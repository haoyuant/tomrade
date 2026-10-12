/**
 * Ticket search regression: one field in the query bar narrows whichever view
 * is open — board, table or graph, a saved view or a workstream page — by key,
 * title or body. It is never saved with the view, it stays put while views
 * change, and it says how many more match outside the view.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:search
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { oneFocusRing } from "./focus-ring.mjs";
import { seedDesignProject } from "./seed.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-search-"));
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
  const { project, boardIds } = seedDesignProject({ dbFor: (id) => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos });
  await ctx.storage.ready;

  const tickets = ctx.items.list({ projectId: project.id }).filter((i) => i.kind !== "epic");
  const matching = (word) => tickets.filter((i) => `${i.key} ${i.title} ${i.body ?? ""}`.toLowerCase().includes(word.toLowerCase()));
  const views = ctx.views.listForProject(project.id);
  const bugs = views.find((v) => v.name === "Bugs");

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const search = (text) => $(`(() => { const i = document.querySelector('.qb-search-input'); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const key = (target, init) => $(`(() => { const t = ${target}; t.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...${JSON.stringify(init)} })); return true; })()`);
  const cardKeys = async () => (await $(`[...document.querySelectorAll('.board-region .card .card-id')].map((n) => n.textContent).sort().join(',')`)) ?? "";
  const field = () => $(`document.querySelector('.qb-search-input')?.value ?? null`);
  const focused = () => $(`document.activeElement?.classList.contains('qb-search-input') ?? false`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  await sleep(3000);

  // ── the field, on the board ───────────────────────────────────────────
  check("the query bar opens with an empty ticket search", (await field()) === "");
  check("its placeholder names what it finds", (await $(`document.querySelector('.qb-search-input')?.placeholder`)) === "Search tickets");
  // the assistant's composer opens with the caret, and a slash typed there is its own
  await $(`document.querySelector('.ai-input')?.focus(); true`);
  await key("document.activeElement", { key: "/" });
  check("/ typed into another field stays there", !(await focused()));
  await $(`document.activeElement?.blur(); true`);
  await key("window", { key: "/" });
  check("/ elsewhere puts the caret in it", await focused());
  check("one focus ring, on the field — none on the input inside it", await oneFocusRing(win, ".qb-search-input", ".qb-search"));
  const word = "matcha";
  const hits = matching(word);
  const hitKeys = hits.map((i) => i.key).sort().join(",");
  await search(word);
  await sleep(500);
  check("typing narrows the board to the tickets holding the word", hits.length === 2 && (await cardKeys()) === hitKeys, { want: hitKeys, saw: await cardKeys() });
  check("a word only in the body counts", hits.some((i) => !i.title.toLowerCase().includes(word)));
  check("the view head counts what is shown", ((await $(`document.querySelector('.board-facts .meta-txt')?.textContent`)) ?? "").startsWith(`${hits.length} shown of ${tickets.length}`));
  check("the field reads as armed", (await $(`document.querySelector('.qb-search')?.dataset.on`)) === "true");
  check("searching is not an edit to the view", (await $(`!document.querySelector('.qb-dirty') && !document.querySelector('.view-dirty')`)) === true);
  check("an emptied column blames the search", ((await $(`[...document.querySelectorAll('.col-empty')].map((n) => n.textContent).join('|')`)) ?? "").includes(`matches “${word}”`));
  check("with the sidebar and the assistant open, the bar stays one row", (await $(`(() => { const tops = new Set([...document.querySelectorAll('.query-bar > *, .qb-right > *')].filter((n) => n.getBoundingClientRect().width > 0).map((n) => Math.round(n.getBoundingClientRect().top))); return tops.size; })()`)) === 1);
  await shot("search-01-board");
  await key("document.querySelector('.qb-search-input')", { key: "Escape" });
  await sleep(200);

  // ── the same words in every layout ────────────────────────────────────
  await search(word);
  await sleep(300);
  await press(`document.querySelector('.layout-seg button[data-layout="table"]')`);
  await sleep(600);
  check("the table keeps the search", (await $(`[...document.querySelectorAll('tr.tbl-row .card-id')].map((n) => n.textContent).sort().join(',')`)) === hitKeys);
  await press(`document.querySelector('.layout-seg button[data-layout="graph"]')`);
  await sleep(1200);
  check("so does the graph", (await $(`[...document.querySelectorAll('.react-flow__node .card .card-id')].map((n) => n.textContent).sort().join(',')`)) === hitKeys);
  await press(`document.querySelector('.layout-seg button[data-layout="table"]')`);
  await sleep(400);
  await search("zzqx");
  await sleep(400);
  check("a table with no match says what was searched", ((await $(`document.querySelector('.tbl-empty')?.textContent`)) ?? "").includes("“zzqx”"));
  await press(`document.querySelector('.qb-discard')`);
  await sleep(400);
  check("and discarding the layout leaves the search alone", (await field()) === "zzqx");

  // ── across views and workstreams ──────────────────────────────────────
  await search(word);
  await press(`document.querySelector('.side-row.is-view[data-view="${bugs.id}"]')`);
  await sleep(900);
  check("opening another view keeps the search", (await field()) === word);
  const bugHits = hits.filter((i) => i.labels.includes("bug"));
  check("which narrows that view too", (await cardKeys()) === bugHits.map((i) => i.key).sort().join(","), await cardKeys());
  check("and says how many more match outside it", ((await $(`document.querySelector('.qb-search-note')?.textContent`)) ?? "") === `${hits.length - bugHits.length} more outside this view`);
  await shot("search-02-elsewhere");
  await press(`document.querySelector('.side-row.is-workstream[data-board="${boardIds.get("bd-ui")}"]')`);
  await sleep(900);
  check("a workstream page keeps it as well", (await field()) === word && (await cardKeys()) === hitKeys, await cardKeys());
  check("with nothing hidden, there is no note", (await $(`!!document.querySelector('.qb-search-note')`)) === false);
  await press(`document.querySelector('.side-row.is-view[data-view="${views[0].id}"]')`);
  await sleep(900);

  // ── keys ──────────────────────────────────────────────────────────────
  const target = hits[0];
  await search(target.key.toLowerCase());
  await sleep(400);
  check("a ticket's key finds it", (await cardKeys()) === target.key, await cardKeys());
  await key("document.querySelector('.qb-search-input')", { key: "Enter" });
  await sleep(600);
  check("Enter opens the first match", (await $(`document.querySelector('aside.detail .card-id')?.textContent`)) === target.key);
  await $(`document.querySelector('.qb-search-input').focus(); true`);
  await key("document.querySelector('.qb-search-input')", { key: "Escape" });
  await sleep(400);
  check("Escape empties the field first", (await field()) === "" && (await cardKeys()).split(",").length > hits.length);
  check("and leaves the open ticket open", (await $(`!!document.querySelector('aside.detail')`)) === true);
  await key("document.querySelector('.qb-search-input')", { key: "Escape" });
  await sleep(200);
  check("a second Escape leaves the field", !(await focused()) && (await $(`!!document.querySelector('aside.detail')`)) === true);
  await key("window", { key: "f", metaKey: true });
  check("⌘F puts the caret back", await focused());
  await key("window", { key: "Escape" });

  // ── per project ───────────────────────────────────────────────────────
  await search(word);
  const other = ctx.projects.create({ name: "Beta", keyPrefix: "BE" });
  await ctx.storage.ready;
  await $(`location.hash = '#/p/${other.id}'; true`);
  await sleep(1500);
  check("another project has its own, empty search", (await field()) === "");
  await $(`location.hash = '#/p/${project.id}'; true`);
  await sleep(1500);
  check("coming back finds this one's where it was left", (await field()) === word);
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
