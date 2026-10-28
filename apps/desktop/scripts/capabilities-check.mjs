/** "What Tomrade can do": the home's cards, Help › What Tomrade Can Do, and where each Try it lands.
 * pnpm build:backend && pnpm dev:ui, then pnpm --filter @tomrade/desktop test:capabilities
 */
import { app, BrowserWindow, Menu } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { installAppMenu } from "../dist/menu.js";
import { provideMainWindow } from "../dist/main-window.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-capabilities-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, pass) => { results.push({ name, pass: !!pass }); console.log(`${pass ? "PASS" : "FAIL"}: ${name}`); };

async function run() {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  ctx.agent.engine({ id: "echo", title: "Echo", author: "ai:test", available: async () => ({ ok: true }), async turn() { return { stop: "end" }; } });
  const settings = ctx.settings.get();
  // Every hint but the cards is put away, so nothing else stands over them.
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["hint.start", "hint.graph", "hint.revert", "hint.workstreams", "sample-tile", "setup-screen", `setup-screen:${ctx.hub.deviceId}`, "setup-required"] }, agent: { ...settings.agent, defaultEngine: "echo" } });

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const waitFor = async (js, tries = 80) => {
    for (let i = 0; i < tries; i++) { if (await $(js)) return true; await sleep(100); }
    return false;
  };
  const press = (id) => $(`(() => { const b = [...document.querySelectorAll('[data-testid="capability-try-${id}"]')].at(-1); b?.click(); return !!b; })()`);
  const pane = `document.querySelector('[role="dialog"] .side-row[aria-current="true"]')?.textContent.trim()`;
  const escape = async () => { win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await sleep(300); };
  const openPage = async () => {
    ctx.ipc.send("app.capabilities");
    return waitFor(`document.querySelectorAll('.sheet-capabilities .capability').length === 5`);
  };

  check("the home shows five cards while there are few projects", await waitFor(`document.querySelectorAll('[data-testid="capabilities-home"] .capability').length === 5`));
  check("each card has a still and a Try it", await $(`[...document.querySelectorAll('[data-testid="capabilities-home"] .capability')].every((c) => c.querySelector('.capability-media img, .capability-media video') && c.querySelector('.capability-try'))`));
  check("the stills load", await waitFor(`[...document.querySelectorAll('[data-testid="capabilities-home"] .capability-media img')].every((i) => i.complete && i.naturalWidth > 0)`));

  // Help › What Tomrade Can Do, through the menu's own click.
  provideMainWindow({ open: () => win, current: () => win });
  installAppMenu({ restartWithoutPlugins: () => {} });
  const help = Menu.getApplicationMenu()?.items.find((i) => i.role === "help");
  const item = help?.submenu?.items.find((i) => i.label === "What Tomrade Can Do");
  check("the Help menu has What Tomrade Can Do", !!item);
  item?.click();
  check("it opens the page", await waitFor(`document.querySelectorAll('.sheet-capabilities .capability').length === 5`));

  // IM: Settings on its pane, from the home.
  await press("im");
  check("IM's Try it opens Settings on IM", await waitFor(`${pane} === "IM"`));
  await escape();

  // From the home, the idea opens the only project with its words waiting in the assistant.
  await press("idea");
  check("the idea's Try it opens the project", await waitFor(`location.hash.startsWith('#/p/${project.id}')`));
  check("…with the idea's words in the assistant, not sent", await waitFor(`document.querySelector('.ai-input')?.value === "I want to build "`));
  check("…and the keyboard in it", await $(`document.activeElement === document.querySelector('.ai-input')`));
  await $(`(() => { const el = document.querySelector('.ai-input'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);

  check("the command palette lists What Tomrade can do", await (async () => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    if (!(await waitFor(`!!document.querySelector('.palette-input')`))) return false;
    await $(`(() => { const el = document.querySelector('.palette-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'What Tomrade'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(300);
    const row = await $(`(() => { const r = [...document.querySelectorAll('.palette-row')].find((x) => x.textContent.includes('What Tomrade can do')); r?.click(); return !!r; })()`);
    return row && waitFor(`document.querySelectorAll('.sheet-capabilities .capability').length === 5`);
  })());

  await press("groom");
  check("the backlog's Try it fills the tidy-up words", await waitFor(`document.querySelector('.ai-input')?.value.startsWith("Tidy up the backlog")`));

  if (await openPage()) await press("sessions");
  check("the sessions' Try it opens the start dialog", await waitFor(`!!document.querySelector('[data-testid="palette-start"]')`));
  await escape();

  if (await openPage()) await press("terminal");
  check("the terminal's Try it opens the repositories where agents connect", await waitFor(`${pane} === "Repositories"`));
  await escape();

  if (await openPage()) await press("im");
  check("IM's Try it inside a project opens Settings on IM", await waitFor(`${pane} === "IM"`));
  await escape();

  // Asked for less motion, nothing plays by itself.
  win.webContents.debugger.attach();
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await openPage();
  check("with reduced motion no clip plays by itself", await $(`[...document.querySelectorAll('.sheet-capabilities video')].every((v) => v.paused && !v.autoplay)`));
  await escape();

  // Put away from the home, it stays away.
  await win.loadURL(`${base}#/`);
  await waitFor(`!!document.querySelector('[data-testid="capabilities-home"]')`);
  await $(`[...document.querySelectorAll('[data-testid="capabilities-home"] button')].find((b) => b.textContent.trim() === 'Hide')?.click()`);
  check("Hide puts the cards away", await waitFor(`!document.querySelector('[data-testid="capabilities-home"]')`));
  check("…and remembers it", (ctx.settings.get().onboarding?.seen ?? []).includes("capabilities-home"));
  win.destroy();
}

app.whenReady().then(run).then(() => {
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
}).catch((error) => { console.error(error); app.exit(1); });
