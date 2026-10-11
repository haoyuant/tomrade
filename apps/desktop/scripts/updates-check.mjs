/**
 * Update flow regression, against a feed served from this process: a newer
 * release is announced and nothing more, Later means not again, the two
 * settings change what is asked and when, and no channel ever offers an older
 * build. A checkout cannot install, so the restart itself is left to a real
 * release (docs/releasing.md).
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:updates
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-updates-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

// The feed electron-updater reads on this system, named as electron-builder writes it.
const suffix = { darwin: "-mac", linux: "-linux" }[process.platform] ?? "";
const stable = `/latest${suffix}.yml`;
const beta = `/beta${suffix}.yml`;
const running = app.getVersion();
const newer = `${Number(running.split(".")[0]) + 1}.0.0`;
const manifest = (version) => `version: ${version}\nfiles:\n  - url: ${version}/Tomrade-${version}.zip\n    sha512: AAAA\n    size: 1\npath: ${version}/Tomrade-${version}.zip\nsha512: AAAA\nreleaseDate: '2026-11-01T08:00:00.000Z'\n`;
const feed = new Map([[stable, manifest(newer)]]);
const asked = [];
const server = http.createServer((req, res) => {
  const at = new URL(req.url, "http://feed").pathname;
  asked.push(at);
  const body = feed.get(at);
  if (body) res.writeHead(200, { "content-type": "text/yaml" }).end(body);
  else res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.TOMRADE_UPDATE_URL = `http://127.0.0.1:${server.address().port}/`;
if (process.platform === "linux") process.env.APPIMAGE ??= path.join(work, "Tomrade.AppImage");

const run = async () => {
  const { boot } = await import("../dist/boot.js");
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  // Hints and setup cards are taught once, in their own check; these checks are about everything else.
  ctx.settings.set({ ...ctx.settings.get(), onboarding: { seen: ["*"] } });
  const project = ctx.projects.create({ name: "Updates", keyPrefix: "UP" });
  await ctx.storage.ready;
  ctx.settings.set({ ...ctx.settings.get(), language: "en" });
  const prefs = () => ctx.settings.get().updates;

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  await sleep(3500);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const typeInto = (selector, text) =>
    $(`(() => { const i = document.querySelector('${selector}'); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const status = () => $(`window.tomrade.invoke('updates.status')`);
  // TOMRADE_SHOTS=<dir> keeps a picture of each state, for a look by eye.
  const shot = async (name) => {
    if (!process.env.TOMRADE_SHOTS) return;
    fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const line = () => $(`document.querySelector('.about-update .about-update-state')?.textContent ?? null`);
  const button = (label) => `[...document.querySelectorAll('.about-update-head .btn')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  const toasts = () => $(`[...document.querySelectorAll('.toast')].map((t) => t.querySelector('.toast-body')?.textContent ?? '')`);
  const toastAction = (label) => `[...document.querySelectorAll('.toast .btn')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  const switchOn = () => $(`document.querySelector('.about-update-pref[data-pref="autoCheck"] .switch')?.getAttribute('aria-checked')`);
  const channelShown = () => $(`document.querySelector('.about-update-pref[data-pref="channel"] button[aria-pressed="true"]')?.textContent.trim() ?? null`);

  // ── at rest ─────────────────────────────────────────────────────────
  let s = await status();
  check("a build pointed at a feed can update itself", s.blocked === null, s);
  check("and asks nothing before the first check is due", s.phase.kind === "idle" && asked.length === 0, { s, asked });
  check("checks are on and Stable is the channel by default", prefs()?.autoCheck === true && prefs()?.channel === "stable", prefs());

  // ── a newer release is announced, not fetched ───────────────────────
  await $(`window.tomrade.invoke('updates.check')`);
  await sleep(1500);
  s = await status();
  check("a check finds the newer release on the Stable feed", s.phase.kind === "available" && s.phase.version === newer && asked.includes(stable), { s, asked });
  const notice = (await toasts()).find((t) => t.includes(`Tomrade ${newer} is available`));
  await shot("updates-notice");
  check("a notice says so, with Download and Later", !!notice && !!(await $(`!!(${toastAction("Download")}) && !!(${toastAction("Later")})`)), await toasts());
  check("nothing was downloaded", !asked.some((p) => p.endsWith(".zip")), asked);
  await press(toastAction("Later"));
  await sleep(500);
  check("Later puts the notice away", !(await toasts()).some((t) => t.includes("is available")), await toasts());
  await $(`window.tomrade.invoke('updates.check')`);
  await sleep(800);
  check("and a later check of the same version doesn't bring it back", !(await toasts()).some((t) => t.includes("is available")), await toasts());
  check("installing is refused before anything is downloaded", (await $(`window.tomrade.invoke('updates.install')`)) === false);

  // ── the About pane: the same news, and the settings ─────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(500);
  await typeInto(".palette-input", "About");
  await sleep(400);
  await press(`[...document.querySelectorAll('.palette-row')].find(r => r.textContent.trim() === 'About Tomrade')`);
  await sleep(1000);
  check("the About pane says which version is out", ((await line()) ?? "").includes(`Tomrade ${newer} is available`), await line());
  check("and offers Download instead of another check", !!(await $(`!!(${button("Download")})`)) && !(await $(`!!(${button("Check for updates")})`)));
  check("and shows both settings as they are", (await switchOn()) === "true" && (await channelShown()) === "Stable", { on: await switchOn(), channel: await channelShown() });
  await shot("updates-available");

  // ── automatic checks off ────────────────────────────────────────────
  await press(`document.querySelector('.about-update-pref[data-pref="autoCheck"] .switch')`);
  await sleep(800);
  check("the switch turns automatic checks off", prefs()?.autoCheck === false && (await switchOn()) === "false", prefs());

  // ── Beta: another feed, and the old answer forgotten ────────────────
  const before = asked.length;
  await press(`[...document.querySelectorAll('.about-update-pref[data-pref="channel"] button')].find((b) => b.textContent.trim() === 'Beta')`);
  await sleep(1000);
  s = await status();
  check("choosing Beta saves it", prefs()?.channel === "beta" && (await channelShown()) === "Beta", prefs());
  check("and forgets what Stable said", s.phase.kind === "idle", s.phase);
  check("with checks off, nothing is asked on its own", asked.length === before, asked.slice(before));
  await press(button("Check for updates"));
  await sleep(1500);
  s = await status();
  check("Check now asks the Beta feed", asked.slice(before).includes(beta), asked.slice(before));
  check("a missing feed is reported, not hidden", s.phase.kind === "failed" && ((await line()) ?? "").includes("didn't go through"), { phase: s.phase, line: await line() });
  await shot("updates-failed");
  check("with the reason underneath", ((await $(`document.querySelector('.about-update-error')?.textContent ?? ''`)) ?? "").length > 0);

  feed.set(beta, manifest("0.0.1"));
  await press(button("Check for updates"));
  await sleep(1500);
  s = await status();
  check("an older build on the feed is never offered", s.phase.kind === "current" && s.phase.latest === "0.0.1", s.phase);
  await shot("updates-current");
  check("so the pane says this build is newer than the feed's", ((await line()) ?? "").includes("this build is newer than 0.0.1"), await line());

  // ── back to Stable with checks on: asked right away ─────────────────
  const settled = asked.length;
  await press(`[...document.querySelectorAll('.about-update-pref[data-pref="channel"] button')].find((b) => b.textContent.trim() === 'Stable')`);
  await sleep(600);
  await press(`document.querySelector('.about-update-pref[data-pref="autoCheck"] .switch')`);
  await sleep(1500);
  s = await status();
  check("turning checks back on asks the feed at once", asked.slice(settled).includes(stable), asked.slice(settled));
  check("and finds the newer release again", s.phase.kind === "available" && s.phase.version === newer, s.phase);
  const newest = `${Number(newer.split(".")[0]) + 1}.0.0`;
  feed.set(stable, manifest(newest));
  await $(`window.tomrade.invoke('updates.check')`);
  await sleep(1000);
  check("with the About pane open, a newer release shows there", ((await line()) ?? "").includes(`Tomrade ${newest} is available`), await line());
  check("and no notice is stacked on top, whose click would close the dialog", !(await toasts()).some((t) => t.includes(newest)), await toasts());
  check("harness reached the end", true);
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.log("HARNESS ERROR: " + (err && err.stack ? err.stack : String(err)));
    check("harness ran to completion", false);
  }
  server.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
  app.exit(failed.length ? 1 : 0);
});
