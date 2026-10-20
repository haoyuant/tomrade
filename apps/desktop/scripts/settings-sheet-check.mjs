/**
 * The Settings sheet moves like a window: its header drags it, never under the
 * title bar or off the window, a double-click centres it again, and its corner
 * grip resizes it within limits and remembers the size. It opens centred each time.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:settings-sheet
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-settings-sheet-"));
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
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] } });

  const win = new BrowserWindow({ width: 1400, height: 1000, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const shot = async (name) => fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS ?? work, name), (await win.webContents.capturePage()).toPNG());
  const box = (sel) => $(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })()`);
  const centreOf = (b) => [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)];
  const drag = async ([x, y], dx, dy) => {
    win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      win.webContents.sendInputEvent({ type: "mouseMove", x: x + Math.round((dx * i) / 8), y: y + Math.round((dy * i) / 8), modifiers: ["leftButtonDown"] });
      await sleep(16);
    }
    win.webContents.sendInputEvent({ type: "mouseUp", x: x + dx, y: y + dy, button: "left", clickCount: 1 });
    await sleep(150);
    return box(".sheet-settings");
  };
  const byTitle = async (dx, dy) => drag(centreOf(await box(".sheet-settings .dlg-title")), dx, dy);
  const openSettings = async () => {
    await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));true`);
    await sleep(800);
  };
  const escape = async () => {
    await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
    await sleep(400);
  };
  const near = (a, b) => Math.abs(a - b) <= 2;
  await sleep(2000);

  // ── the header moves it ────────────────────────────────────────────────
  await openSettings();
  const sheet0 = await box(".sheet-settings");
  check("Settings opens", !!sheet0);
  check("its header says it can be moved", (await $(`document.querySelector('.sheet-settings .dlg-title').title`)) === "Drag to move · double-click to centre");
  const moved = await byTitle(-200, 120);
  check("dragging the header moves the sheet with the pointer", near(moved.x, sheet0.x - 200) && near(moved.y, sheet0.y + 120) && near(moved.w, sheet0.w) && near(moved.h, sheet0.h), { sheet0, moved });
  await shot("settings-sheet-01-moved.png");

  const view = await $(`({ w: window.innerWidth, h: window.innerHeight })`);
  const up = await byTitle(0, -2000);
  check("it stops below the title bar", near(up.y, 42), up);
  const right = await byTitle(5000, 0);
  check("it keeps some of itself on the window to the right", right.x <= view.w - 96 && right.x > view.w - 200, { right, view });
  const left = await byTitle(-5000, 0);
  check("and to the left", left.x + left.w >= 96 && left.x + left.w < 200, left);
  // its title is off the window now; take it by what is left of the header
  const rest = await box(".sheet-settings .dlg-head .spacer");
  const back = await drag([Math.round(rest.x + rest.w - 4), Math.round(rest.y + rest.h / 2)], 400, 0);
  check("what is left of the header still takes hold of it", !!back && near(back.x, left.x + 400), { rest, back });
  const centre = async () => {
    await $(`document.querySelector('.sheet-settings .dlg-head').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await sleep(100);
    return box(".sheet-settings");
  };
  await centre();
  const low = await byTitle(0, 5000);
  check("it can be dragged down", !!low && low.y > left.y, low);
  const head = await box(".sheet-settings .dlg-head");
  check("its header never goes below the window", head.y + head.h <= view.h + 1 && head.y > view.h - 120, { head, view });

  const settled = await box(".sheet-settings");
  await drag(centreOf(await box(".sheet-settings .dlg-head button[aria-label^='Close']")), 0, -300);
  check("dragging from the close button does not move it", JSON.stringify(await box(".sheet-settings")) === JSON.stringify(settled) && (await $(`!!document.querySelector('.sheet-settings')`)), settled);

  const centred = await centre();
  check("double-clicking the header centres it again", near(centred.x, sheet0.x) && near(centred.y, sheet0.y), centred);

  // ── the corner resizes it ──────────────────────────────────────────────
  const grow = async (dx, dy) => drag(centreOf(await box(".sheet-settings .dlg-grip")), dx, dy);
  const capH = await $(`parseFloat(getComputedStyle(document.querySelector('.sheet-settings')).maxHeight)`);
  const grown = await grow(60, 40);
  check("dragging the corner grows the sheet under the pointer", near(grown.w, sheet0.w + 120) && near(grown.h, Math.min(sheet0.h + 80, capH)), { sheet0, grown, capH });
  const tiny = await grow(-2000, -2000);
  check("it never shrinks past its minimum", tiny.w >= 639 && tiny.h >= 419, tiny);
  const huge = await grow(2000, 2000);
  check("nor grows past the window", huge.w <= view.w - 64 + 1 && huge.y >= 42, huge);
  await grow(-200, -100);
  const kept = await $(`localStorage.getItem('tomrade.dialogSize.settings')`);
  check("the size is remembered", !!kept && JSON.parse(kept).w < huge.w, kept);
  const sized = await box(".sheet-settings");
  await byTitle(150, 60);
  await shot("settings-sheet-02-resized.png");

  // ── it opens centred, at the size it was left ─────────────────────────
  await escape();
  check("Escape closes it", !(await $(`!!document.querySelector('.sheet-settings')`)));
  await openSettings();
  const again = await box(".sheet-settings");
  check("it opens centred again, at the size it was left", near(again.w, sized.w) && near(again.h, sized.h) && near(again.x, sized.x) && near(again.y, sized.y), { sized, again });

  // ── a smaller window does not strand it ───────────────────────────────
  await byTitle(5000, 0);
  win.setSize(900, 700);
  await sleep(500);
  const small = await $(`({ w: window.innerWidth, h: window.innerHeight })`);
  const after = await box(".sheet-settings");
  check("after the window shrinks it is still within reach", after.x <= small.w - 96 && after.y >= 42, { after, small });
  await shot("settings-sheet-03-small-window.png");

  check("harness reached the end", true);
  win.destroy();
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
