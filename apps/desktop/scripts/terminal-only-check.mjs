/**
 * Terminal-only agents (Cursor, Antigravity CLI): signed in, they still never
 * answer a new conversation or appear in a picker for something only an
 * in-app engine can do, and the Assistant pane says why.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:terminal-only
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-terminal-only-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  // Only the stand-ins below: no CLI on this machine is asked anything.
  const engines = ["engine-tomrade", "engine-loop", "engine-pi-builtin", "engine-claude-code", "engine-codex", "engine-pi", "engine-terminal", "engine-hermes", "engine-dsh", "engine-opencode", "engine-cursor", "engine-workbuddy"];
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, ...engines.map((id) => ({ id, disabled: true }))]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });

  const turns = { echo: 0, termy: 0 };
  ctx.agent.engine({ id: "echo", title: "Echo", author: "ai:test", available: async () => ({ ok: true }),
    async turn(_input, io) { turns.echo++; io.emit({ type: "text", text: "echo answered" }); return { stop: "end" }; } });
  // Signed in and ready, but it can only run in a terminal.
  ctx.agent.engine({ id: "termy", title: "Termy", author: "ai:termy", capabilities: ["code", "general"], terminalOnly: true, available: async () => ({ ok: true }),
    async turn() { turns.termy++; return { stop: "error", error: "Termy runs only in a terminal" }; } });
  const settings = ctx.settings.get();
  // A settings file that names it as the default must not hand it a conversation.
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "termy" } });
  const terminalOnly = ctx.agent.allEngines().filter((e) => e.terminalOnly).map((e) => e.id);

  const win = new BrowserWindow({ width: 1400, height: 1000, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const waitFor = async (js, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await $(js)) return true;
      await sleep(100);
    }
    return false;
  };
  const shot = async (name) => fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS ?? work, name), (await win.webContents.capturePage()).toPNG());
  const pane = (name) => press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((r) => r.textContent?.trim() === ${JSON.stringify(name)})`);
  await sleep(2000);

  // ── a new conversation goes to an engine that can answer it ──────────
  await waitFor(`!!document.querySelector('.ai-input')`);
  check("the panel offers an in-app engine in place of the terminal-only default",
    await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Echo')`),
    await $(`[...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter((t) => /echo|termy/i.test(t))`));
  await $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, 'hello'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(100);
  await $(`document.querySelector('.ai-send').click();true`);
  await waitFor(`document.body.textContent.includes('echo answered')`);
  check("a new conversation with a terminal-only default is answered by an in-app engine", turns.echo === 1 && turns.termy === 0, turns);

  // ── Settings → Assistant says why, folded or not ─────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));true`);
  await sleep(800);
  await pane("Assistant");
  await waitFor(`!!document.querySelector('[data-engine="termy"]')`);
  const note = (id) => $(`document.querySelector('[data-engine="${id}"] [data-terminal-only-note]')?.textContent ?? ''`);
  const en = await note("termy");
  check("the terminal-only row says the agent has no ACP or per-session MCP", /no ACP/.test(en) && /single session/.test(en), en);
  check("and what it cannot do in Tomrade", /cannot chat, run a ticket in Tomrade, answer in IM or run a template/.test(en), en);
  check("and what it still does", /runs tickets in a terminal/.test(en) && /worker/.test(en), en);
  check("it still cannot be picked as the default", await $(`document.querySelector('[data-engine="termy"] input[type=radio]')?.disabled === true`));
  check("an in-app engine's row carries no such note", (await note("echo")) === "");
  await press(`document.querySelector('[data-engine="termy"] .eng-head')`);
  await sleep(300);
  check("the note stays when the row is folded", /no ACP/.test(await note("termy")));
  await shot("10-assistant-terminal-only.png");
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  check("in Chinese too", await waitFor(`(document.querySelector('[data-engine="termy"] [data-terminal-only-note]')?.textContent ?? '').includes('不支持 ACP')`), await note("termy"));
  await shot("11-assistant-terminal-only-zh.png");
  ctx.settings.set({ ...ctx.settings.get(), language: "en" });
  await waitFor(`/no ACP/.test(document.querySelector('[data-engine="termy"] [data-terminal-only-note]')?.textContent ?? '')`);

  // ── a new plugin is never built by an engine that cannot run in the app ──
  await pane("Manage plugins");
  await waitFor(`!!document.querySelector('.plug-tabs [data-tab="mine"]')`);
  await press(`document.querySelector('.plug-tabs [data-tab="mine"]')`);
  await waitFor(`!!document.querySelector('[data-testid="new-plugin"]:not([disabled])')`);
  await press(`document.querySelector('[data-testid="new-plugin"]')`);
  await waitFor(`!!document.querySelector('#npEngine')`);
  const offered = await $(`[...document.querySelectorAll('#npEngine option')].map((o) => o.value).filter(Boolean)`);
  check("the new-plugin dialog offers in-app engines", offered.includes("echo"), offered);
  check("and none that runs only in a terminal", !offered.some((id) => terminalOnly.includes(id)), { offered, terminalOnly });
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    console.error(error);
    results.push({ name: "run", pass: false });
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${process.env.TOMRADE_SHOTS ?? work}`);
  app.exit(failed.length ? 1 : 0);
});
