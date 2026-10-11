/**
 * Agent panel regression: a run keeps going in the main process while the
 * panel looks elsewhere — another project, another thread — and the panel
 * has to show where it got to when it comes back, not the cached moment it
 * left. A slow stand-in engine makes the timing deterministic.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:agent-panel
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-agent-panel-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};
const LINES = ["step one", "step two", "all done"];

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const alpha = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  const beta = ctx.projects.create({ name: "Beta", keyPrefix: "BE" });
  await ctx.storage.ready;
  ctx.agent.engine({
    id: "slow",
    title: "Slow",
    author: "ai:slow",
    available: async () => ({ ok: true }),
    async turn(_input, io) {
      await sleep(600);
      io.emit({ type: "text", text: LINES[0] });
      await sleep(1200);
      io.emit({ type: "text", text: LINES[1] });
      await sleep(1200);
      io.emit({ type: "text", text: LINES[2] });
      return { stop: "end" };
    }
  });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", agent: { ...settings.agent, defaultEngine: "slow" } });

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${alpha.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const go = (projectId) => $(`location.hash = '#/p/${projectId}';true`);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const send = async (text) => {
    await $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(100);
    await $(`document.querySelector('.ai-send').click();true`);
  };
  const panel = () =>
    $(`({ working: !!document.querySelector('.ai-scroll .working'), locked: document.querySelector('.ai-composer')?.hasAttribute('data-busy') ?? null,
          lines: [...document.querySelectorAll('.ai-scroll .turn-ai .turn-body p')].map((p) => p.textContent).filter((t) => ${JSON.stringify(LINES)}.includes(t)) })`);
  const threads = async () => {
    if (!(await $(`!!document.querySelector('.menu-row.is-radio')`))) await press(`document.querySelector('.ai-head .btn-icon[aria-label="Threads"]')`);
    await sleep(400);
  };
  const newThread = async () => {
    await threads();
    await press(`document.querySelector('button[aria-label="New thread"]')`);
    await sleep(800);
  };
  await sleep(2000);

  // ── the run ends while another project is on screen ──────────────────
  await send("first");
  await sleep(300);
  check("the panel says the run is working", (await panel()).working);
  await go(beta.id);
  await sleep(3500);
  await go(alpha.id);
  await sleep(1000);
  let seen = await panel();
  check("back on the project, the finished run no longer reads as working", !seen.working, seen);
  check("and the composer takes a message again", seen.locked === false, seen);
  check("and everything the run wrote while away is there", LINES.every((line) => seen.lines.includes(line)), seen.lines);

  // ── the panel comes back while the run is still going ────────────────
  await newThread();
  await send("second");
  await sleep(300);
  await go(beta.id);
  await sleep(900); // the first line lands while away
  await go(alpha.id);
  await sleep(500); // back before the second line
  seen = await panel();
  check("back mid-run, the line written while away is there", seen.working && seen.lines[0] === LINES[0], seen);
  await sleep(3000);
  seen = await panel();
  check("and the rest streams in until the run ends", !seen.working && seen.lines.join("|") === LINES.join("|"), seen);

  // ── the run ends while another thread of the project is on screen ────
  await newThread();
  await send("third");
  await sleep(300);
  const busyId = ctx.agent.store.threads(alpha.id)[0].id;
  await newThread();
  check("the panel moved to a fresh thread", (await panel()).lines.length === 0);
  await sleep(3500);
  await threads();
  // Titled from its first message once the run has had a moment, so looked up now.
  const busyTitle = ctx.agent.store.threads(alpha.id).find((th) => th.id === busyId)?.title;
  check("the busy thread is in the threads menu", await press(`[...document.querySelectorAll('.menu-row.is-radio')].find((r) => r.querySelector('.m-name')?.textContent === ${JSON.stringify(busyTitle)})`), busyTitle);
  await sleep(1000);
  seen = await panel();
  check("picking the busy thread again shows its run finished", !seen.working && seen.lines.join("|") === LINES.join("|"), seen);

  // ── the composer: several lines, typed ahead, and the keyboard left where it was ──
  const draftNow = () => $(`document.querySelector('.ai-input')?.value ?? null`);
  const key = (opts) => $(`document.querySelector('.ai-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...${JSON.stringify(opts)} }));true`);
  const setDraft = (text) => $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await newThread();
  await send("fourth");
  await sleep(300);
  check("the composer is a multi-line box that stays open while a run works", await $(`(() => { const i = document.querySelector('.ai-input'); return i.tagName === 'TEXTAREA' && !i.disabled; })()`));
  await setDraft("the next message\nwith a second line");
  await key({ shiftKey: true });
  await sleep(150);
  check("Shift+Enter does not send", (await draftNow()) === "the next message\nwith a second line");
  await key({});
  await sleep(300);
  check("Enter while the run works keeps the draft for later", (await draftNow()) === "the next message\nwith a second line" && (await panel()).working);
  await $(`(() => { const b = document.createElement('input'); b.id = 'elsewhere'; document.body.appendChild(b); b.focus(); return true; })()`);
  await sleep(4200);
  check("a run that ends leaves the keyboard where the person put it", (await $(`document.activeElement?.id`)) === "elsewhere" && !(await panel()).working);
  await key({});
  await sleep(400);
  check("once it has ended, Enter sends the waiting draft", (await draftNow()) === "" && (await panel()).working);
  await sleep(4000);
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
