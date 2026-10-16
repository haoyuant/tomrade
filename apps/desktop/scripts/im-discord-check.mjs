/**
 * The Discord adapter ships with the app: it loads as an extension, the IM
 * wizard shows its Developer Portal steps, and with a token it connects —
 * here to an in-memory Discord standing in for the real one.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:im-discord
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { FakeDiscord } from "../../../packages/im-discord/dist/fake.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-im-discord-"));
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
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });
  for (let i = 0; i < 50 && !ctx.im.adapterViews().some((a) => a.id === "discord"); i++) await sleep(100);
  const adapter = ctx.im.adapterViews().find((a) => a.id === "discord");
  check("the Discord adapter loads with the app", !!adapter, ctx.im.adapterViews().map((a) => a.id));
  check("it asks only for the bot token", adapter?.setup?.fields.map((f) => f.key).join() === "botToken");

  // The main process's network stands in for Discord from here on.
  const discord = new FakeDiscord();
  const net = discord.net();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => (String(input).includes("discord") ? net.fetch(input, init) : realFetch(input, init));
  globalThis.WebSocket = net.WebSocket;

  const win = new BrowserWindow({ width: 1400, height: 1000, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const fill = (selector, text) =>
    $(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const waitFor = async (js, ms = 8000) => { for (let w = 0; w < ms; w += 100) { if (await $(js)) return true; await sleep(100); } return false; };
  await sleep(2000);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));true`);
  await sleep(800);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((r) => r.textContent?.trim() === 'IM')`);
  await waitFor(`!!document.querySelector('[data-testid=im-add]')`);
  await press(`document.querySelector('[data-testid=im-add]')`);
  await waitFor(`!!document.querySelector('#im-adapter')`);
  await $(`(() => { const s = document.querySelector('#im-adapter'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'discord'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  check("the wizard shows the Developer Portal steps", await waitFor(`document.querySelector('[data-testid=im-form]')?.textContent.includes('Reset Token') && document.querySelector('[data-testid=im-form]').textContent.includes('applications.commands')`));
  await fill("#im-id", "discord");
  await fill("#im-cred-botToken", discord.token);
  await sleep(150);
  await $(`document.querySelector('[data-testid=im-plaintext-consent]')?.click();true`);
  await sleep(100);
  await press(`[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save and connect')`);
  check("it connects and names the bot", await waitFor(`document.querySelector('[data-im-connection=discord]')?.textContent.includes('Signed in as tomrade-bot')`));
  fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS ?? work, "im-discord.png"), (await win.webContents.capturePage()).toPNG());
  check("and registers /tomrade", discord.where("PUT", /\/commands$/).length === 1);
  win.destroy();
};

app.whenReady()
  .then(run)
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — failed: ${failed.map((f) => f.name).join("; ")}` : ""}`);
    app.exit(failed.length ? 1 : 0);
  })
  .catch((error) => { console.error(error); app.exit(1); });
