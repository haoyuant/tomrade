/**
 * Update flow regression, against a feed served from this process: a newer
 * release is announced in a centred sheet and nothing more, Later means not
 * again, Download opens Settings on About where the progress is, the two
 * settings change what is asked and when, and no channel ever offers an older
 * build. A checkout cannot install, so the restart itself is left to a real
 * release (docs/ops/releasing.md, local only).
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
/** Every request's headers: a check must carry nothing that tells one install from another. */
const heard = [];
const server = http.createServer((req, res) => {
  const at = new URL(req.url, "http://feed").pathname;
  asked.push(at);
  heard.push(req.headers);
  const body = feed.get(at);
  if (body) res.writeHead(200, { "content-type": "text/yaml" }).end(body);
  else res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.TOMRADE_UPDATE_URL = `http://127.0.0.1:${server.address().port}/`;
if (process.platform === "linux") process.env.APPIMAGE ??= path.join(work, "Tomrade.AppImage");

// An ID an earlier version of Tomrade left behind, which this one removes.
const installId = path.join(work, ".updaterId");
fs.writeFileSync(installId, "d4ad8e5b-6f0a-5b3c-9a1e-2f7c3b8d1e40");

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
  const notice = () => $(`document.querySelector('.update-notice')?.textContent ?? null`);
  const noticeAction = (label) => `[...document.querySelectorAll('.update-notice .dlg-foot .btn')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  const settingsSheets = () => $(`document.querySelectorAll('.palette.sheet-settings').length`);
  const settingsPane = () => $(`document.querySelector('.palette.sheet-settings .side-row[aria-current="true"]')?.textContent.trim() ?? null`);
  const switchOn = () => $(`document.querySelector('.about-update-pref[data-pref="autoCheck"] .switch')?.getAttribute('aria-checked')`);
  const channelShown = () => $(`document.querySelector('.about-update-pref[data-pref="channel"] button[aria-pressed="true"]')?.textContent.trim() ?? null`);

  // ── at launch: a newer release is announced, not fetched ────────────
  let s = await status();
  check("a build pointed at a feed can update itself", s.blocked === null, s);
  check("checks are on and Stable is the channel by default", prefs()?.autoCheck === true && prefs()?.channel === "stable", prefs());
  check("the Stable feed is asked at launch and the newer release found", s.phase.kind === "available" && s.phase.version === newer && asked.includes(stable), { s, asked });
  await shot("updates-notice");
  check("a sheet says so, with Download and Later", ((await notice()) ?? "").includes(`Tomrade ${newer}`) && !!(await $(`!!(${noticeAction("Download")}) && !!(${noticeAction("Later")})`)), await notice());
  const placed = await $(`(() => { const r = document.querySelector('.update-notice').getBoundingClientRect(); return { dx: Math.abs(r.left + r.width / 2 - innerWidth / 2), dy: Math.abs(r.top + r.height / 2 - innerHeight / 2) }; })()`);
  check("in the middle of the window, over a scrim", placed.dx < 2 && placed.dy < 40 && !!(await $(`!!document.querySelector('.scrim')`)), placed);
  check("with Download holding the focus", (await $(`document.activeElement?.textContent.trim()`)) === "Download");
  check("nothing was downloaded", !asked.some((p) => p.endsWith(".zip")), asked);
  await press(noticeAction("Later"));
  await sleep(500);
  check("Later puts the notice away", (await notice()) === null, await notice());
  await $(`window.tomrade.invoke('updates.check')`);
  await sleep(800);
  check("and a later check of the same version doesn't bring it back", (await notice()) === null, await notice());
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
  const sourceRow = () => $(`(() => { const row = document.querySelector('.about-update-pref[data-pref="source"]'); return row && { pressed: row.querySelector('button[aria-pressed="true"]')?.textContent.trim(), locked: [...row.querySelectorAll('button')].every((b) => b.disabled), note: row.querySelector('.meta-txt')?.textContent }; })()`);
  const source = await sourceRow();
  check("the update source is Automatic by default, and TOMRADE_UPDATE_URL holds it", prefs()?.source === "auto" && source?.pressed === "Automatic" && source.locked && s.feed?.name === "custom", { prefs: prefs(), source, feed: s.feed });
  check("and the source row names the feed in use", (source?.note ?? "").includes(new URL(process.env.TOMRADE_UPDATE_URL).host), source);
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
  check("and no notice is stacked on top of it", (await notice()) === null, await notice());

  // ── Download from the notice opens Settings on About ────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(600);
  check("(Settings closed again)", (await settingsSheets()) === 0);
  const third = `${Number(newest.split(".")[0]) + 1}.0.0`;
  feed.set(stable, manifest(third));
  await $(`window.tomrade.invoke('updates.check')`);
  await sleep(1000);
  check("with Settings shut, the next release is announced", ((await notice()) ?? "").includes(`Tomrade ${third}`), await notice());
  await press(noticeAction("Download"));
  await sleep(1500);
  s = await status();
  await shot("updates-download");
  check("Download closes the notice", (await notice()) === null);
  // A checkout has no app-update.yml, so its download fails before asking for the zip.
  check("starts the download", s.phase.kind === "downloading" || s.phase.kind === "failed", s.phase);
  check("and opens Settings on About, where the progress shows", (await settingsSheets()) === 1 && (await settingsPane()) === "About" && (await line()) !== null, { sheets: await settingsSheets(), pane: await settingsPane(), line: await line() });
  check("with the focus inside Settings", !!(await $(`!!document.activeElement?.closest('.sheet-settings')`)));

  // ── Settings open on another pane: switched, not stacked ────────────
  await press(`[...document.querySelectorAll('.palette.sheet-settings .side-row')].find((b) => b.textContent.trim() === 'Appearance')`);
  await sleep(500);
  check("(Settings moved to Appearance)", (await settingsPane()) === "Appearance", await settingsPane());
  const fourth = `${Number(third.split(".")[0]) + 1}.0.0`;
  feed.set(stable, manifest(fourth));
  await $(`window.tomrade.invoke('updates.check')`);
  await sleep(1000);
  check("away from About, the notice comes up over Settings", ((await notice()) ?? "").includes(`Tomrade ${fourth}`), await notice());
  await press(noticeAction("Download"));
  await sleep(1500);
  check("and Download turns that same sheet to About instead of opening a second", (await settingsSheets()) === 1 && (await settingsPane()) === "About", { sheets: await settingsSheets(), pane: await settingsPane() });
  // ── no install ID ───────────────────────────────────────────────────
  check("no check carried an install ID", heard.length > 0 && heard.every((h) => !("x-user-staging-id" in h)), heard.map((h) => Object.keys(h)));
  check("and the ID file an earlier version left is gone", !fs.existsSync(installId));
  console.log(`  a check's headers: ${[...new Set(heard.flatMap((h) => Object.entries(h).map(([k, v]) => `${k}: ${k === "host" ? "<feed>" : v}`)))].join(" | ")}`);
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
