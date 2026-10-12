/**
 * Model setup regression: a wrong API key shows when the profile is saved,
 * not in the first conversation, and a model error in the conversation says
 * what to do about it. A local stand-in for an OpenAI-compatible endpoint
 * refuses any key but "good", and answers the message "second" with a 503
 * three times running, so it outlasts the adapter's retries.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:model-setup
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-model-setup-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

// the "second" message fails three times running — the first try and both retries — then answers
let failures = 0;
const endpoint = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.headers.authorization !== "Bearer good") return res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"Authentication Fails, Your api key is invalid"}}');
    if (body.includes("second") && failures < 3 && ++failures) return res.writeHead(503, { "content-type": "application/json" }).end('{"error":{"message":"Service Unavailable"}}');
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
});

const run = async () => {
  await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${endpoint.address().port}/v1`;
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "loop" } });

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const fill = (selector, text) =>
    $(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const button = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === ${JSON.stringify(text)})`;
  const profiles = () => ctx.settings.get().models?.profiles ?? [];
  await sleep(2000);

  // ── a wrong key is caught at save ────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));true`);
  await sleep(800);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((r) => r.textContent?.trim() === 'Assistant')`);
  await sleep(500);
  await press(button("+ Custom"));
  await sleep(400);
  await fill("#pfBase", base);
  await fill("#pfModel", "flaky");
  await fill("#pfKey", "sk-wrong");
  await press(button("Save profile"));
  await sleep(1500);
  check("saving a profile with a refused key says so", (await $(`document.querySelector('.profile-problem')?.textContent ?? ''`)).includes("refused this API key"));
  check("and keeps it out of the settings", profiles().length === 0, profiles());
  await fill("#pfKey", "good");
  await sleep(100);
  check("editing the key clears the complaint", (await $(`!document.querySelector('.profile-problem')`)) === true);
  await press(button("Save profile"));
  await sleep(1500);
  check("a key the endpoint accepts saves the profile", profiles().length === 1 && profiles()[0].apiKey === "good", profiles());

  // ── a model error in the conversation says what to do ────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(500);
  const send = async (text) => {
    await fill(".ai-input", text);
    await sleep(100);
    await $(`document.querySelector('.ai-send').click();true`);
  };
  await send("first");
  await sleep(2000);
  check("a working profile answers", (await $(`document.querySelector('.ai-scroll')?.textContent ?? ''`)).includes("pong"));
  await send("second");
  // the adapter waits 1 s and then 3 s between its tries before the error surfaces
  await sleep(6500);
  check("a 503 reads as the service's own error, not raw JSON", (await $(`document.querySelector('.ai-error p')?.textContent ?? ''`)) === "The model service had an error of its own.");
  check("with the raw message kept under Details", (await $(`document.querySelector('.ai-error details pre')?.textContent ?? ''`)).includes("503"));
  await press(`document.querySelector('.ai-error') && ${button("Try again")}`);
  await sleep(2500);
  check("Try again sends the message again, and it answers", (await $(`[...document.querySelectorAll('.ai-scroll .turn-ai')].pop()?.textContent ?? ''`)).includes("pong"));

  // the key goes bad later: the conversation points at the settings
  ctx.settings.set({ ...ctx.settings.get(), models: { ...ctx.settings.get().models, profiles: profiles().map((p) => ({ ...p, apiKey: "revoked" })) } });
  await sleep(300);
  await send("third");
  await sleep(2500);
  check("a refused key reads as such", (await $(`[...document.querySelectorAll('.ai-error p')].pop()?.textContent ?? ''`)) === "The model service refused the API key.");
  await press(`[...document.querySelectorAll('.ai-error button')].find((b) => b.textContent?.trim() === 'Open model settings')`);
  await sleep(800);
  check("and opens the model settings", (await $(`[...document.querySelectorAll('.dlg-body .sec-title')].some((n) => n.textContent === 'Models')`)) === true);
  await press(`[...document.querySelectorAll('.profile-row button')].find((b) => b.textContent?.trim() === 'Remove')`);
  await sleep(300);
  check("removing a profile asks first, naming what goes with it", (await $(`document.querySelector('.profile-remove')?.textContent ?? ''`)).includes("API key is deleted") && profiles().length === 1);
  await press(`document.querySelector('.profile-remove .btn-danger')`);
  await sleep(600);
  check("and removes it once confirmed", profiles().length === 0);
  check("harness reached the end", true);
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.log("HARNESS ERROR: " + (err && err.stack ? err.stack : String(err)));
    check("harness ran to completion", false);
  }
  endpoint.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
  app.exit(failed.length ? 1 : 0);
});
