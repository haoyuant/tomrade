/**
 * Films the real app for Tomrade's demo videos: boots it on a fresh data folder, seeds the "Feedback form"
 * project, then drives the UI the way a person would — a drawn cursor that travels before each click, text typed
 * key by key — while an offscreen window paints every frame into ffmpeg. The agents are the person's own (Claude
 * Code, Codex); nothing they say or do is scripted. Each step's time goes to <out>.markers.json for the edit.
 *
 * pnpm build:backend && pnpm dev:ui, then from apps/desktop:
 *   npx electron scripts/film.mjs <scene> [out-dir]      scenes: tidy
 */
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A 1440×900 layout filmed at 1920×1200: an offscreen window paints at scale 1, so the page is zoomed instead.
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 4 / 3;
const FPS = 30;
app.disableHardwareAcceleration();

const dir = path.dirname(fileURLToPath(import.meta.url));
const scene = process.argv[2] ?? "tidy";
const outDir = path.resolve(process.argv[3] ?? path.join(os.homedir(), "TomradeDemo", "film"));
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-film-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const acceptance = (...lines) => `\n\n## Acceptance\n${lines.map((line) => `- ${line}`).join("\n")}`;
// The same backlog as the demo repository's .demo/seed.mjs, so a take here matches a take in the installed app.
const SEED = [
  { slug: "readme", title: "Add a README with how to run it", status: "done", priority: 1, body: "Say what the app is and how to start it and run the tests." + acceptance("README.md names `npm start` and `npm test`.") },
  { slug: "failed-sends", title: "Handle failed sends in the feedback form", status: "done", priority: 3, body: "When sending fails, the text is kept and the person sees why." + acceptance("A failed send keeps the message and shows an error.", "Tests cover the failure.") },
  { slug: "polish", kind: "epic", title: "Polish the form", status: "todo", priority: 2, body: "Small things that make the form nicer to use." },
  { slug: "send-shortcut", parent: "polish", title: "Send with ⌘/Ctrl+Enter", status: "todo", priority: 2, body: "People who type a lot want to send without reaching for the mouse." + acceptance("⌘+Enter on macOS and Ctrl+Enter elsewhere send the form, exactly like pressing Send.", "Plain Enter still adds a new line.", "The decision (is this key event a send shortcut?) is a pure helper in src/feedback.js with a node --test test.") },
  { slug: "chars-left", parent: "polish", title: "Show how many characters are left near the limit", status: "backlog", priority: 1, body: "The limit is 2000 characters. From 1800 on, show how many are left instead of the count." + acceptance("At 1800+ the label reads “N left”.", "Tested in src/feedback.js.") },
  { slug: "dark-system", parent: "polish", title: "Follow the system's dark mode", status: "backlog", priority: 1, body: "Use prefers-color-scheme so the form is dark when the system is." + acceptance("Dark colours under prefers-color-scheme: dark.", "Text stays readable in both.") },
  { slug: "dark-mode", title: "Support dark mode", status: "backlog", priority: 1, body: "Someone asked for a dark version of the form." + acceptance("The form has a dark look.") },
  { slug: "emoji", title: "Count emoji as one character", status: "backlog", priority: 2, body: "👍 counts as 2 characters today; count what a person sees." + acceptance("countLabel counts user-perceived characters (Intl.Segmenter).", "Tests cover emoji and accented letters.") },
  { slug: "leave-warning", title: "Warn before closing the tab with unsent text", status: "backlog", priority: 1, body: "If the box has text that wasn't sent, ask before the tab closes." + acceptance("beforeunload asks only when there is unsent text.") },
  { slug: "v2", title: "Feedback v2: attachments, categories and follow-up by email", status: "backlog", priority: 1, body: "Let people attach a screenshot, pick a category (bug, idea, question) and leave an email address if they want an answer. Show a summary before sending, and send a confirmation email afterwards." }
];

/** Paints every frame of `win` into an H.264 master at a steady 30 fps, repeating the last frame while nothing changes. */
function film(win, file) {
  const size = { width: Math.round(WIDTH * SCALE), height: Math.round(HEIGHT * SCALE) };
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${size.width}x${size.height}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "inherit", "inherit"] });
  let last = null;
  let told = false;
  win.webContents.on("paint", (_event, _dirty, image) => {
    const s = image.getSize();
    if (!told) { told = true; console.log(`[film] paints ${s.width}×${s.height}`); }
    last = (s.width === size.width && s.height === size.height ? image : image.resize(size)).toBitmap();
  });
  win.webContents.setFrameRate(FPS);
  const started = performance.now();
  let frames = 0;
  const tick = setInterval(() => {
    if (!last) return;
    // Catch up after a busy main thread, so the video's clock is the wall clock.
    const due = Math.floor(((performance.now() - started) / 1000) * FPS);
    while (frames < due) {
      ffmpeg.stdin.write(last);
      frames++;
    }
  }, 1000 / FPS / 2);
  return {
    at: () => (performance.now() - started) / 1000,
    async stop() {
      clearInterval(tick);
      ffmpeg.stdin.end();
      await new Promise((resolve) => ffmpeg.on("close", resolve));
    }
  };
}

/** A drawn cursor, clicks and typing that reach the page as real input events. */
function hands(win) {
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const pos = { x: WIDTH * 0.62, y: HEIGHT * 0.55 };
  // Page coordinates are CSS pixels of the 1440×900 layout; input events take the window's own.
  const px = (v) => Math.round(v * SCALE);
  const cursor = async () =>
    $(`(() => {
      if (document.getElementById('film-cursor')) return true;
      const c = document.createElement('div');
      c.id = 'film-cursor';
      c.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 22 L7.5 17 L11 25.5 L14.6 24 L11.2 15.8 L18.5 15.8 Z" fill="#1f1a17" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(${pos.x}px, ${pos.y}px)', transition: 'transform 520ms cubic-bezier(.3,.1,.2,1)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.25))' });
      const ring = document.createElement('div');
      ring.id = 'film-ring';
      Object.assign(ring.style, { position: 'fixed', left: '-14px', top: '-14px', width: '28px', height: '28px', borderRadius: '50%', border: '2px solid rgba(181,72,44,.75)', zIndex: 2147483646, pointerEvents: 'none', opacity: '0', transform: 'scale(.4)', transition: 'opacity 380ms, transform 380ms' });
      document.body.append(ring, c);
      return true;
    })()`);
  const rectOf = (expr) => $(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const moveTo = async (x, y) => {
    await cursor();
    await $(`document.getElementById('film-cursor').style.transform = 'translate(${x}px, ${y}px)'`);
    win.webContents.sendInputEvent({ type: "mouseMove", x: px(x), y: px(y) });
    pos.x = x;
    pos.y = y;
    await sleep(620);
  };
  return {
    $,
    cursor,
    async waitFor(js, what, seconds = 60) {
      for (let i = 0; i < seconds * 10; i++) {
        if (await $(js)) return true;
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    async click(expr) {
      const at = await rectOf(expr);
      if (!at) throw new Error(`nothing to click: ${expr}`);
      await moveTo(at.x, at.y);
      await sleep(200);
      await $(`(() => { const r = document.getElementById('film-ring'); r.style.transition = 'none'; r.style.opacity = '1'; r.style.transform = 'translate(${at.x}px, ${at.y}px) scale(.4)'; r.offsetWidth; r.style.transition = 'opacity 380ms, transform 380ms'; r.style.opacity = '0'; r.style.transform = 'translate(${at.x}px, ${at.y}px) scale(1.3)'; })()`);
      const x = px(at.x);
      const y = px(at.y);
      win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      await sleep(70);
      win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      await sleep(350);
    },
    async type(text, perKey = 38) {
      for (const ch of text) {
        win.webContents.sendInputEvent({ type: "char", keyCode: ch });
        await sleep(perKey + (/[ ,.:]/.test(ch) ? 40 : 0));
      }
    },
    async key(keyCode, modifiers = []) {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await sleep(150);
    },
    async hover(expr) {
      const at = await rectOf(expr);
      if (at) await moveTo(at.x, at.y);
    }
  };
}

const running = `document.querySelector('.ai-send')?.getAttribute('aria-label') === 'Stop'`;
const idle = `!!document.querySelector('.ai-send') && document.querySelector('.ai-send').getAttribute('aria-label') !== 'Stop'`;

const SCENES = {
  /** Short B: the assistant tidies the backlog, the board changes, one click reverts the whole run. */
  async tidy({ h, mark }) {
    await h.click(`document.querySelector('.ai-input')`);
    mark("type");
    await h.type("Tidy up the backlog: merge duplicates and split anything too big for one PR.");
    await sleep(400);
    await h.key("Enter");
    mark("sent");
    await h.waitFor(running, "the run to start", 30);
    // It may stop to ask before writing; the first choice that says yes answers it. Done is idle for four seconds straight.
    let idleSince = null;
    for (;;) {
      const state = await h.$(`(() => {
        const live = [...document.querySelectorAll('.q-ask:not(.done)')].at(-1);
        if (live) return 'ask';
        return ${idle} ? 'idle' : 'busy';
      })()`);
      if (state !== "idle") idleSince = null;
      else if (idleSince === null) idleSince = Date.now();
      else if (Date.now() - idleSince > 4000) break;
      if (state === "ask") {
        mark("ask");
        await sleep(1500);
        // Pick any: every proposal; pick one: the first that says yes.
        const multiple = await h.$(`/any/i.test([...document.querySelectorAll('.q-ask:not(.done) .q-eyebrow')].at(-1)?.textContent ?? '')`);
        const chips = await h.$(`document.querySelectorAll('.q-ask:not(.done) .chip-opt').length`);
        if (multiple) for (let i = 0; i < chips; i++) await h.click(`document.querySelectorAll('.q-ask:not(.done) .chip-opt')[${i}]`);
        else await h.click(`[...document.querySelectorAll('.q-ask:not(.done) .chip-opt')].find((b) => /^(apply|yes|go|write|merge|do it|allow)/i.test(b.textContent.trim())) ?? document.querySelector('.q-ask:not(.done) .chip-opt')`);
        await h.click(`document.querySelector('.q-ask:not(.done) .q-confirm button')`);
        mark("answered");
      }
      await sleep(500);
    }
    mark("done");
    await sleep(2500);
    await h.hover(`[...document.querySelectorAll('.rf-btn')].at(-1)`);
    await sleep(1200);
    mark("revert");
    await h.click(`[...document.querySelectorAll('.rf-btn')].at(-1)`);
    await h.waitFor(`[...document.querySelectorAll('.rf-note')].some((n) => n.textContent.startsWith('Reverted'))`, "the revert", 30);
    mark("reverted");
    await sleep(3500);
  }
};

async function run() {
  const { boot } = await import("../dist/boot.js");
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Feedback form", keyPrefix: "FB" });
  const keys = new Map();
  for (const item of SEED) {
    const created = await ctx.tools.execute("create_item", { title: item.title, body: item.body, kind: item.kind ?? "ticket", status: item.status, priority: item.priority, ...(item.kind === "epic" ? {} : { workType: "coding" }), ...(item.parent ? { parentId: keys.get(item.parent) } : {}) }, { by: "human", projectId: project.id });
    keys.set(item.slug, created.key);
  }
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", theme: "dawn", pet: { ...settings.pet, enabled: false }, onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "claude-code" } });

  const win = new BrowserWindow({ width: Math.round(WIDTH * SCALE), height: Math.round(HEIGHT * SCALE), show: false, webPreferences: { offscreen: true, preload: path.join(dir, "../preload.cjs"), contextIsolation: true, backgroundThrottling: false } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  win.webContents.on("dom-ready", () => win.webContents.setZoomFactor(SCALE));
  await win.loadURL(`${base}#/p/${project.id}`);
  win.webContents.setZoomFactor(SCALE);
  const h = hands(win);
  await h.waitFor(`!!document.querySelector('.ai-input') && document.querySelectorAll('.card, [data-testid="card"]').length > 0`, "the board and the assistant", 60);
  await h.cursor();
  await sleep(1500);

  const file = path.join(outDir, `${scene}-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`);
  const camera = film(win, file);
  const markers = [];
  const mark = (label) => { markers.push({ t: +camera.at().toFixed(2), label }); console.log(`[${camera.at().toFixed(1)}s] ${label}`); };
  await sleep(1500);
  mark("start");
  try {
    await SCENES[scene]({ h, mark, ctx, project });
  } finally {
    mark("end");
    await camera.stop();
    fs.writeFileSync(file.replace(/\.mp4$/, ".markers.json"), JSON.stringify({ scene, markers }, null, 2));
    console.log(`filmed ${file}`);
  }
}

app.whenReady().then(run).then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); });
