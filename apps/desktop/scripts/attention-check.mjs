/**
 * Attention regression: an agent that waits on the person is seen wherever
 * the person is — a count on the Dock, a badge on the collapsed assistant, a
 * word in the thread list, a list in the status bar — and a clicked
 * notification opens its thread. A finished run is told once; what the person
 * switched off in Settings is not told at all. A stand-in engine that asks
 * permission mid-run makes it deterministic.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:attention
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-attention-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false, finishedAfterMs: 0 } }]] });
  const notes = [];
  ctx.on("attention/notified", (note) => notes.push(note));
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  ctx.agent.engine({
    id: "asking",
    title: "Asking",
    author: "ai:asking",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      const said = await io.requestPermission("Run the migration?", ["Allow", "Deny"]);
      io.emit({ type: "text", text: `answer: ${said}` });
      return { stop: "end" };
    }
  });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "asking" } });

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const send = async (text) => {
    await $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(100);
    await $(`document.querySelector('.ai-send').click();true`);
  };
  const list = () => $(`window.tomrade.invoke("attention.list")`);
  const badge = () => (process.platform === "win32" ? null : app.getBadgeCount());
  await sleep(2000);

  // ── a run asks permission: everywhere says so ─────────────────────────
  await send("migrate the database");
  await sleep(1200);
  let entries = await list();
  check("a permission question mid-run is on the attention list", entries.length === 1 && entries[0].kind === "permission" && entries[0].text === "Run the migration?", entries);
  if (badge() !== null) check("the Dock counts it", badge() === 1, badge());
  check("each entry says since when it waits", typeof entries[0]?.since === "number" && entries[0].since <= Date.now(), entries);
  check("a notification says who needs what", notes.some((n) => n.title === "The assistant needs your approval" && n.body === "Run the migration?"), notes);
  check("the status bar says one thing waits", /1 waiting for you/.test((await $(`document.querySelector('[data-testid="needs-you"]')?.textContent`)) ?? ""));
  const firstThread = entries[0]?.threadId;
  await press(`document.querySelector('[aria-label="Collapse assistant panel"]')`);
  await sleep(500);
  check("the collapsed assistant carries a badge", (await $(`document.querySelector('.ai-rail .rail-badge')?.textContent`)) === "1");
  await press(`document.querySelector('.ai-rail .rail-btn')`);
  await sleep(500);
  await press(`document.querySelector('.ai-head .btn-icon[aria-label="Threads"]')`);
  await sleep(400);
  check("the thread list says which conversation waits, and on what", (await $(`[...document.querySelectorAll('.menu-row.is-radio')].some((r) => (r.textContent ?? '').includes('Needs your approval'))`)) === true);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);

  // answering clears it everywhere
  await press(`[...document.querySelectorAll('.ai-scroll button')].find((b) => b.textContent?.trim() === 'Allow')`);
  await sleep(300);
  await press(`[...document.querySelectorAll('.ai-scroll button')].find((b) => /confirm/i.test(b.textContent ?? ''))`);
  await sleep(1200);
  entries = await list();
  check("once answered, nothing waits", entries.length === 0, entries);
  if (badge() !== null) check("and the Dock count is gone", badge() === 0, badge());
  check("the status bar has nothing waiting", (await $(`!!document.querySelector('[data-testid="needs-you"]')`)) === false);
  check("the run that finished is told once, with its last words", notes.filter((n) => n.title === "The assistant finished").length === 1 && notes.some((n) => n.title === "The assistant finished" && n.body === "answer: Allow"), notes);

  // approvals switched off in Settings: the badge still counts, nothing is told
  const told = notes.length;
  ctx.settings.set({ ...ctx.settings.get(), notifications: { ...ctx.settings.get().notifications, approvals: false } });

  // ── a clicked notification opens the thread that waits ─────────────────
  await press(`document.querySelector('.ai-head .btn-icon[aria-label="Threads"]')`);
  await sleep(400);
  await press(`document.querySelector('button[aria-label="New thread"]')`);
  await sleep(800);
  await send("and the second one");
  await sleep(1200);
  entries = await list();
  const second = entries.find((e) => e.threadId !== firstThread);
  check("a second conversation waits", !!second, entries);
  check("with approvals switched off, it is counted but not told", notes.length === told, notes.slice(told));
  // the person moves to the first thread, then clicks the notification for the second
  await press(`document.querySelector('.ai-head .btn-icon[aria-label="Threads"]')`);
  await sleep(400);
  await press(`[...document.querySelectorAll('.menu-row.is-radio')].find((r) => !(r.textContent ?? '').includes('Needs your approval'))`);
  await sleep(800);
  ctx.ipc.send("attention.open", second);
  await sleep(1000);
  check("clicking its notification shows the conversation that waits", (await $(`[...document.querySelectorAll('.ai-scroll button')].some((b) => b.textContent?.trim() === 'Allow')`)) === true);

  // the status bar's list is a way back too
  await press(`document.querySelector('.ai-head .btn-icon[aria-label="Threads"]')`);
  await sleep(400);
  await press(`[...document.querySelectorAll('.menu-row.is-radio')].find((r) => !(r.textContent ?? '').includes('Needs your approval'))`);
  await sleep(800);
  const shown = () => $(`document.querySelector('.ai-scroll')?.textContent ?? ''`);
  check("away from it, the first conversation is on screen", (await shown()).includes("migrate the database") && !(await shown()).includes("and the second one"));
  await press(`document.querySelector('[data-testid="needs-you"]')`);
  await sleep(400);
  const rows = await $(`[...document.querySelectorAll('.menu.is-floating [role="menuitem"]')].map((r) => r.textContent)`);
  check("the status bar lists what waits, and on what", rows.length === 1 && rows[0].includes("Assistant · Needs your approval") && rows[0].includes("Run the migration?"), rows);
  await press(`document.querySelector('.menu.is-floating [role="menuitem"]')`);
  await sleep(1000);
  check("choosing it shows that conversation", (await shown()).includes("and the second one"));
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
