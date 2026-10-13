/**
 * Usage regression: what runs spend is seen where a person looks for it — a
 * ticket's Cost as a column a table view sorts on and a row in the detail
 * pane, and Settings → Usage per engine. A stand-in engine that reports its
 * spend makes it deterministic.
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
  await shot("usage-02-settings-usage");
  const usage = await $(`[...document.querySelectorAll('[data-testid="usage-pane"] tr[data-engine="spender"]')].map((r) => [...r.querySelectorAll('td')].map((d) => d.textContent))`);
  check("Usage lists the engine for today and the week", usage.length === 2, usage);
  check("with its runs, tokens and spend", JSON.stringify(usage[0]) === JSON.stringify(["Spender", "3", "6,000", "6,000", "0", "0", "900", "$1.75"]), usage[0]);
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
