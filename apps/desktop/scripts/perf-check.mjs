/**
 * Performance regression: a project of 500 tickets stays responsive. Opening a
 * card is timed from the click to the second frame after it, and a reply
 * streamed into a long conversation by how long it keeps the main thread busy.
 * The bounds are for the dev UI (React's development build, about three times
 * slower than a release); PERF_BOARD_MS and PERF_STREAM_MS override them.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:perf
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-perf-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (detail !== undefined) console.log(`  ${JSON.stringify(detail)}`);
};
const STATUSES = ["backlog", "todo", "doing", "verifying", "done"];

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Perf", keyPrefix: "PF" });
  // A long conversation, then a reply streamed in 300 pieces: the stand-in an engine is for timing
  let turns = 0;
  ctx.agent.engine({
    id: "chatty", title: "Chatty", author: "ai:chatty",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      turns += 1;
      if (turns === 1) {
        for (let i = 0; i < 60; i++) {
          io.emit({ type: "trace", tool: "list_items", ok: true, summary: `looked at page ${i}`, ms: 12, args: { projectId: input.projectId, page: i, filter: { status: ["todo", "doing"], labels: ["ui", "core"] } } });
          io.emit({ type: "text", text: `Step ${i}: PF-${i + 1} and PF-${i + 2} still need a look.\n\nNothing else changed.` });
        }
        return { stop: "end" };
      }
      for (let i = 0; i < 300; i++) {
        io.delta(`word${i} `);
        await new Promise((r) => setTimeout(r, 8));
      }
      io.emit({ type: "text", text: "done streaming" });
      return { stop: "end" };
    }
  });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "chatty" } });
  const boardId = ctx.boards.list(project.id)[0].id;
  const started = Date.now();
  for (let i = 0; i < 500; i++) {
    ctx.items.create({ projectId: project.id, boardId, title: `Ticket number ${i} with a title long enough to wrap onto a second line`, status: STATUSES[i % 5], priority: i % 4, labels: i % 3 ? ["ui"] : ["core", "sync"], by: i % 2 ? "human" : "ai:mcp" });
  }
  console.log(`seeded 500 tickets in ${Date.now() - started} ms`);

  const win = new BrowserWindow({ width: 1600, height: 1000, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  await sleep(4000);
  // Done tickets past the closed window (TOM-624, 50 by default) wait behind the done column's "Load more".
  const cards = () => $(`document.querySelectorAll('.card').length`);
  const more = `document.querySelector('[data-column="done"] [data-testid="closed-more"]')`;
  const opened = { cards: await cards(), more: await $(`${more}?.textContent ?? null`) };
  check("the board holds every open ticket and the newest 50 done, and says 50 more are not shown", opened.cards === 450 && opened.more?.startsWith("50 more not shown"), opened);
  await $(`${more}?.querySelector('button')?.click(); true`);
  for (let i = 0; i < 50 && (await cards()) < 500; i++) await sleep(100);
  await sleep(500);
  check("loading the rest puts all 500 tickets on the board", (await cards()) === 500 && !(await $(`!!${more}`)), await cards());

  // click → two frames: React's render, layout and the paint it leads to
  const timeClick = (selector, index) =>
    $(`new Promise((resolve) => {
      const n = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      const t0 = performance.now();
      n.click();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
    })`);
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const measure = async (selector) => {
    const times = [];
    for (let i = 0; i < 12; i++) {
      times.push(await timeClick(selector, (i * 37) % 500));
      await sleep(250);
    }
    return { median: Math.round(median(times)), max: Math.round(Math.max(...times)) };
  };
  const board = await measure(".card");
  check("selecting a card on a 500-ticket board", board.median < Number(process.env.PERF_BOARD_MS ?? 80), board);

  // ── streaming into a long conversation ───────────────────────────────
  const send = async (text) => {
    await $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(100);
    await $(`document.querySelector('.ai-send').click();true`);
  };
  await send("fill the conversation");
  await sleep(3000);
  check("the conversation holds 120 rows", (await $(`document.querySelectorAll('.ai-scroll .turn-ai, .ai-scroll .trace-row').length`)) >= 120, await $(`document.querySelectorAll('.ai-scroll .turn-ai, .ai-scroll .trace-row').length`));
  // How long the main thread was busy while the reply streamed in: a ping that
  // cannot be answered is time spent rendering.
  await $(`(() => { window.__blocked = 0; window.__sampling = true; const ch = new MessageChannel(); let sent = performance.now(); ch.port1.onmessage = () => { const d = performance.now() - sent; if (d > 4) window.__blocked += d; if (window.__sampling) { sent = performance.now(); ch.port2.postMessage(0); } }; ch.port2.postMessage(0); return true; })()`);
  await send("now stream");
  await sleep(4500);
  const streamed = await $(`(() => { window.__sampling = false; return { blocked: Math.round(window.__blocked), done: document.querySelector('.ai-scroll').textContent.includes('done streaming') }; })()`);
  check("streaming 300 pieces into a long conversation leaves the main thread free", streamed.done && streamed.blocked < Number(process.env.PERF_STREAM_MS ?? 1200), streamed);
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
