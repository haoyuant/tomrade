/**
 * Usage regression: what runs spend is seen where a person looks for it — a
 * ticket's Cost as a column a table view sorts on and a row in the detail
 * pane, and Settings → Usage per engine, with worker calls apart by who
 * answered and what for. A stand-in engine and a stand-in lent model that
 * report their spend make it deterministic.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:usage
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-usage-"));
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
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] } });
  const spend = [1.5, 0.25, 0.004];
  let n = 0;
  ctx.agent.engine({ id: "spender", title: "Spender", author: "ai:spender", available: async () => ({ ok: true }), async turn() {
    return { stop: "end", costUsd: spend[n++] ?? 0, usage: { inputTokens: 2000, outputTokens: 300 } };
  } });

  const board = ctx.boards.list(project.id)[0];
  const [big, small, none] = ["Rewrite the importer", "Fix a typo", "Never started"].map((title) => ctx.items.create({ projectId: project.id, boardId: board.id, title, by: "human" }));
  const spendOn = async (item, times) => {
    const thread = ctx.agent.newThread(project.id, "spender");
    for (let i = 0; i < times; i++) {
      ctx.agent.send(project.id, thread.id, { kind: "text", text: `go ${i}` });
      for (let w = 0; w < 100 && ctx.agent.store.runs(project.id, thread.id).some((r) => r.status === "running"); w++) await sleep(20);
      await sleep(50);
    }
    // the spend follows the ticket a thread stands for; a ticket's own coding thread needs a repository, which this check has none of
    ctx.db.for(project.id).prepare("UPDATE plugin_agent_threads SET item_id = ? WHERE id = ?").run(item.id, thread.id);
  };
  await spendOn(big, 1);
  await spendOn(small, 2);
  // worker calls on a lent model the person chose, as a signed-in CLI would answer them
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [], roles: { worker: "lent:fake-cli" } } });
  ctx.llm.lend({ id: "fake-cli", title: "Fake CLI", ready: async () => true, model: { capabilities: { tools: false, streaming: false, json: false }, async *chat() {
    yield { type: "usage", inputTokens: 15000, cacheReadTokens: 14000, outputTokens: 40 };
    yield { type: "text", delta: '{"ok":true}' };
    yield { type: "stop", reason: "end" };
  } } });
  const anything = { safeParse: (data) => ({ success: true, data }) };
  for (const purpose of ["similar", "similar", "plan"]) await ctx.llm.completeJson(anything, { system: "s", user: "u", purpose });
  const view = ctx.views.create({ projectId: project.id, name: "Spend", icon: "i-bars", layout: "table", query: { filter: [], columnBy: "status", columns: [], groupBy: null, sortBy: [{ field: "cost", dir: "desc" }], fields: ["status", "cost"], wip: {}, graph: null } });

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}/v/${view.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  await sleep(2500);

  const rows = () => $(`[...document.querySelectorAll('.tbl-row')].map((r) => [r.querySelector('.tbl-title-text')?.textContent, r.querySelector('[data-field="cost"]')?.textContent])`);
  check("the table has a Cost column", (await $(`document.querySelector('th[data-field="cost"]')?.textContent ?? ''`)).includes("Cost"));
  check("sorted by spend, the dearest first and the never-run last", JSON.stringify(await rows()) === JSON.stringify([["Rewrite the importer", "$1.50"], ["Fix a typo", "$0.254"], ["Never started", "—"]]), await rows());
  await press(`document.querySelector('.tbl-row[data-id="${small.id}"] .tbl-title')`);
  await sleep(800);
  await shot("usage-01-table-cost");
  check("the ticket's detail shows what it cost", (await $(`document.querySelector('.fieldstrip [data-field="cost"] dd')?.textContent`)) === "$0.254");
  await press(`document.querySelector('.tbl-row[data-id="${none.id}"] .tbl-title')`);
  await sleep(800);
  check("and a ticket nobody ran has no Cost row", (await $(`!!document.querySelector('.fieldstrip [data-field="cost"]')`)) === false);
  // a write cannot set a computed value
  let refused = false;
  try { ctx.items.update(project.id, big.id, { fields: { cost: 0 } }, "human"); } catch { refused = true; }
  check("nobody can write a ticket's Cost", refused);

  // ── Settings → Usage ───────────────────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));true`);
  await sleep(600);
  await press(`[...document.querySelectorAll('.dlg-nav button')].find((b) => b.textContent?.trim() === 'Usage')`);
  await sleep(800);
  await sleep(400);
  await shot("usage-02-settings-usage");
  const usage = await $(`[...document.querySelectorAll('[data-testid="usage-pane"] tr[data-engine="spender"]')].map((r) => [...r.querySelectorAll('td')].map((d) => d.textContent))`);
  check("Usage lists the engine once, over the chosen range", usage.length === 1, usage);
  check("with its runs, tokens and spend", usage[0]?.[0] === "Spender" && usage[0]?.[1] === "3" && usage[0]?.[2].startsWith("6,000") && usage[0]?.[3] === "read 0 · write 0" && usage[0]?.[4] === "900" && usage[0]?.[5] === "0%" && usage[0]?.[7]?.startsWith("$1.75"), usage[0]);

  // The dashboard itself: four KPIs, a bar per local day in both charts, and a share bar.
  const kpis = await $(`[...document.querySelectorAll('[data-testid="usage-pane"] .usage-kpi')].map((k) => [k.querySelector('.eyebrow')?.textContent, k.querySelector('.usage-kpi-value')?.textContent])`);
  check("four headline numbers lead the pane", kpis.length === 4 && kpis[0][1] === "$1.75" && kpis[2][1] === "3", kpis);
  check("a token bar and a spend bar per day of the range", (await $(`document.querySelectorAll('[data-testid="usage-pane"] .usage-plot .usage-col').length`)) === 14, await $(`document.querySelectorAll('[data-testid="usage-pane"] .usage-plot .usage-col').length`));
  check("the engine's share is drawn on both measures", (await $(`document.querySelectorAll('[data-testid="usage-pane"] .usage-share-seg').length`)) === 2, await $(`document.querySelectorAll('[data-testid="usage-pane"] .usage-share-seg').length`));
  const swatches = await $(`[...document.querySelectorAll('[data-testid="usage-pane"] .usage-chart-card .usage-legend .usage-swatch')].map((s) => getComputedStyle(s).backgroundColor)`);
  check("the four token swatches name four different colours", new Set(swatches).size === 4, swatches);
  const shareLefts = await $(`[...document.querySelectorAll('[data-testid="usage-pane"] .usage-share')].map((b) => Math.round(b.getBoundingClientRect().left))`);
  check("both share bars start on the same line", shareLefts.length === 2 && shareLefts[0] === shareLefts[1], shareLefts);
  // 30 days is one click away, and every zero day is still drawn.
  await press(`document.querySelector('[data-days="30"]')`);
  await sleep(900);
  check("the range switch reshapes the charts", (await $(`document.querySelectorAll('[data-testid="usage-pane"] .usage-plot .usage-col').length`)) === 60, await $(`document.querySelectorAll('[data-testid="usage-pane"] .usage-plot .usage-col').length`));
  const monthLabels = await $(`[...document.querySelectorAll('[data-testid="usage-pane"] .usage-chart-card .usage-labels span')].map((s) => s.textContent).filter((s) => s)`);
  check("month labels stay whole dates, not clipped initials", monthLabels.every((l) => l.length >= 4), monthLabels);
  await $(`document.querySelector('[data-testid="usage-pane"]')?.scrollIntoView({ block: 'start' });true`);
  await sleep(400);
  await shot("usage-05-month");
  await press(`document.querySelector('[data-days="7"]')`);
  await sleep(700);
  await $(`document.querySelector('[data-testid="usage-pane"] .usage-shares')?.scrollIntoView({ block: 'center' });true`);
  await sleep(400);
  await shot("usage-04-engine-share");
  const worker = await $(`[...document.querySelectorAll('[data-testid="worker-usage"] tr[data-source="lent:fake-cli"]')].map((r) => [...r.querySelectorAll('td')].map((d) => d.textContent))`);
  check("worker calls are listed apart by who answered and what for", worker.length === 2, worker);
  check("with calls, tokens and cache hit", worker[0]?.slice(0, 6).join("|") === "Fake CLI|Duplicate check|2|30,000|28,000|80" && worker[1]?.slice(0, 6).join("|") === "Fake CLI|Planning|1|15,000|14,000|40", worker);
  check("the purposes are drawn as bars", (await $(`document.querySelectorAll('[data-testid="worker-usage"] .usage-purpose-row').length`)) === 2, await $(`document.querySelectorAll('[data-testid="worker-usage"] .usage-purpose-row').length`));
  await $(`document.querySelector('[data-testid="worker-usage"]')?.scrollIntoView();true`);
  await sleep(300);
  await shot("usage-03-worker-calls");
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
