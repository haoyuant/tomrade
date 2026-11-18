/**
 * Usage statistics reach the queue from the real app (TOM-1117): a person's search, quick add and chat message each
 * leave one event, with the closed-set dim where the registry has one; the same message sent by automation leaves
 * none; and with statistics off nothing is queued at all.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:analytics
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Nowhere to send to: every event stays in the queue for the check to read.
process.env.TOMRADE_ANALYTICS_URL = "http://127.0.0.1:9";
const { boot } = await import("../dist/boot.js");

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-analytics-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};
const queueFile = path.join(work, "analytics", "queue.jsonl");
const queued = () =>
  fs.existsSync(queueFile)
    ? fs.readFileSync(queueFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.event === "feature.activate")
    : [];
const actions = (feature, action) => queued().filter((e) => e.feature_id === feature && e.action === action);

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    // A checkout calls itself "dev", which no event may carry: the check stands in as a prerelease.
    vars: { userData: work, appVersion: "0.0.0-check" },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, { id: "engine-scripted", disabled: false }]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  ctx.agent.store.setBrief(project.id, "App: a small web app.");
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const type = (selector, text) =>
    $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.focus(); Object.getOwnPropertyDescriptor(n.constructor.prototype, 'value').set.call(n, ${JSON.stringify(text)}); n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const wait = async (cond, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(150);
    }
    return false;
  };
  await wait(() => $(`!!document.querySelector('.qb-search-input')`));
  await sleep(1500);

  // Typed in bursts: one event once the person pauses, and never the words.
  for (const text of ["l", "lo", "log", "login"]) await type(".qb-search-input", text);
  await sleep(1600);
  const searches = actions("backlog.search", "search_query");
  check("a burst of typing in the ticket search is one search_query, a second after it stops", searches.length === 1, searches);
  check("the event carries no text: only the envelope's fields", searches.every((e) => !JSON.stringify(e).includes("login")), searches);
  await type(".qb-search-input", "");
  await sleep(300);

  // Quick add on the board: backlog.create with dim quick.
  await press(`[...document.querySelectorAll('button.btn-ghost')].find((b) => b.textContent?.trim() === 'New ticket')`);
  await wait(() => $(`!!document.querySelector('.card input.input')`));
  await type(".card input.input", "Sign-in page");
  await $(`document.querySelector('.card input.input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true`);
  const created = await wait(() => actions("backlog.create", "create").length > 0);
  check("a ticket made with the board's quick add is backlog.create, dim quick", created && actions("backlog.create", "create").every((e) => e.dim === "quick"), actions("backlog.create", "create"));

  // The person's message goes through the window's channel; automation calls send() itself.
  const thread = ctx.agent.newThread(project.id, "scripted", null, {});
  await $(`window.tomrade.invoke('agent.send', ${JSON.stringify(project.id)}, ${JSON.stringify(thread.id)}, 'hello')`);
  const sent = await wait(() => actions("agent.chat", "message_sent").length === 1);
  check("a message the person sends is agent.chat message_sent, with the engine that ran it", sent && actions("agent.chat", "message_sent")[0].dim === "scripted", actions("agent.chat", "message_sent"));
  await sleep(1500);
  ctx.agent.send(project.id, thread.id, { kind: "text", text: "from a routine" });
  await sleep(800);
  check("the same message sent by automation is not counted", actions("agent.chat", "message_sent").length === 1, actions("agent.chat", "message_sent"));

  // Off: the queue is emptied and nothing new arrives.
  await $(`window.tomrade.invoke('analytics.setEnabled', false)`);
  await wait(async () => queued().length === 0);
  for (const text of ["x", "xy"]) await type(".qb-search-input", text);
  await $(`window.tomrade.invoke('agent.send', ${JSON.stringify(project.id)}, ${JSON.stringify(thread.id)}, 'again')`);
  await sleep(1600);
  check("with statistics off, nothing is queued", queued().length === 0, queued());

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
