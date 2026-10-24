/**
 * A permission mode picked while a turn runs: an engine that switches live takes it in that turn — the question
 * waiting for the person is settled, nothing more is asked, the chip shows the new mode — and only an engine that
 * cannot still says "Applies to the next turn". Stand-in engines built on engine-kit's OpenAsks, the same
 * bookkeeping the real engines use, make it deterministic; each engine's own switch has its unit tests.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:live-mode
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODE_ALLOWS, OpenAsks } from "@tomradex/engine-kit";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-live-mode-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const MODES = { default: "ask", choices: [{ value: "ask", label: "Ask permissions" }, { value: "full-access", label: "Full access" }] };
const asked = { live: 0, fixed: 0 };

/** Asks before each of three steps unless the mode the turn works under is Full access. */
const standIn = (id, live) => ({
  id,
  title: live ? "Live" : "Fixed",
  author: `ai:${id}`,
  available: async () => ({ ok: true }),
  permissionModes: MODES,
  ...(live ? { liveModes: true } : {}),
  async turn(input, io) {
    let mode = input.permissionMode;
    const asks = new OpenAsks();
    if (live) io.modeTo?.(async (next) => { mode = next; asks.settle(); return true; });
    const said = [];
    for (const step of [1, 2, 3]) {
      if (io.signal.aborted) return { stop: "cancelled" };
      if (mode === "full-access") { said.push("free"); continue; }
      asked[id]++;
      const answer = await asks.ask(io, `Run step ${step}?`, ["Allow once", "Deny"], () => mode === "full-access", io.signal);
      said.push(answer === MODE_ALLOWS ? "by-mode" : String(answer));
    }
    io.emit({ type: "text", text: `steps: ${said.join(" ")}` });
    return { stop: "end" };
  }
});

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  ctx.agent.engine(standIn("live", true));
  ctx.agent.engine(standIn("fixed", false));
  const useEngine = (id) => { const s = ctx.settings.get(); ctx.settings.set({ ...s, language: "en", onboarding: { seen: ["*"] }, agent: { ...s.agent, defaultEngine: id } }); };
  useEngine("live");

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
  const until = async (expr, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 150) { if (await $(expr)) return true; await sleep(150); }
    return false;
  };
  const chip = `document.querySelector('button[aria-label="Permissions / mode"]')`;
  const menuRows = () => $(`[...document.querySelectorAll('[role="menuitemradio"]')].map((r) => r.textContent ?? '')`);
  const pick = async (label) => {
    let rows = [];
    // a re-render as the question lands can close a menu opened at that moment
    for (let tries = 0; tries < 5 && !rows.length; tries++) {
      await press(chip);
      await sleep(400);
      rows = await menuRows();
    }
    await press(`[...document.querySelectorAll('[role="menuitemradio"]')].find((r) => (r.textContent ?? '').startsWith(${JSON.stringify(label)}))`);
    await sleep(300);
    return rows;
  };
  const waiting = (text) => `[...document.querySelectorAll('.ai-scroll')].some((s) => (s.textContent ?? '').includes(${JSON.stringify(text)})) && !!document.querySelector('[data-testid="needs-you"]')`;
  await sleep(2000);

  // ── an engine that switches live ─────────────────────────────────────
  await send("run the three steps");
  check("the turn stops on its first question", await until(waiting("Run step 1?")));
  const threadId = ctx.agent.activeRuns()[0]?.thread.id;
  const liveRows = await pick("Full access");
  check("the menu does not say the change waits for the next turn", liveRows.length === 2 && liveRows.every((row) => !row.includes("Applies to the next turn")), liveRows);
  check("the waiting question is settled by the mode, and the rest runs without asking", await until(`(document.querySelector('.ai-scroll')?.textContent ?? '').includes('steps: by-mode free free')`), await $(`document.querySelector('.ai-scroll')?.textContent?.slice(-200)`));
  check("nothing more was asked in that turn", asked.live === 1, asked);
  check("nothing waits for the person", await until(`!document.querySelector('[data-testid="needs-you"]')`, 3000));
  check("the chip shows Full access", ((await $(`${chip}?.textContent`)) ?? "").includes("Full access"));
  check("no next-turn note is left", (await $(`[...document.querySelectorAll('.meta-txt')].some((m) => (m.textContent ?? '').startsWith('Next turn:'))`)) === false);

  // ── an engine that cannot ─────────────────────────────────────────────
  // switched behind the window's back, so it reloads to read the thread's engine afresh
  ctx.agent.setEngine(project.id, threadId, "fixed");
  win.webContents.reload();
  await until(`!!document.querySelector('.ai-input')`, 15000);
  await sleep(1500);
  await send("run them again");
  check("the other engine stops on its first question", await until(waiting("Run step 1?")));
  const fixedRows = await pick("Full access");
  check("its menu says the change applies to the next turn", fixedRows.length === 2 && fixedRows.every((row) => row.includes("Applies to the next turn")), fixedRows);
  check("the change is shown as queued", await until(`[...document.querySelectorAll('.meta-txt')].some((m) => (m.textContent ?? '') === 'Next turn: Full access')`, 3000));
  check("its question still waits for the person", (await $(`!!document.querySelector('[data-testid="needs-you"]')`)) === true && asked.fixed === 1, asked);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(() => run().catch((error) => { console.error(error); app.exit(1); }));
