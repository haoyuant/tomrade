/**
 * Renders a take from film.mjs into a finished clip, one exact frame at a time, so nothing depends on how fast this
 * machine is: 1920×1080 at 60 fps.
 *
 * - Open and close: the website's own hero (the cat, the red sun, the rays), its animations set to each frame's time,
 *   its headline swapped for the clip's.
 * - The take is one continuous shot. Speed ramps smoothly between 1× and fast-forward; the camera eases from one
 *   framing to the next, drawn on a canvas at sub-pixel precision. Nothing fades.
 * - Captions live on one ticket card that stays on screen: a new line slides in over the old one, and the card glides
 *   when it changes corner. Line changes land on the music's beats.
 * - Between the hero and the take a sheet of paper carrying the app pushes up over the page, and away again at the end.
 * - Sound from film-audio.mjs: music on the same beat, the take's clicks and keys where they land, the edit's cues.
 *
 *   pnpm dev:ui is not needed; the website must be served (pnpm dev in tomrade-site) at FILM_SITE (default
 *   http://127.0.0.1:4321/). From apps/desktop: npx electron scripts/film-render.mjs <edit.json> <take.mp4> <out.mp4>
 *
 * edit.json:
 *   { "music": 0.75,
 *     "intro": { "seconds", "title", "sub" }, "outro": { "seconds", "title", "sub" },
 *     "take": { "from", "to",
 *       "speed": [[at, speed], …],            take times where the speed changes
 *       "cam": [[at, x, y, w], …],            framings to arrive at by those take times (1920×1200 pixels; h follows)
 *       "captions": [{ "at", "kicker", "en", "zh", "note"?, "corner"?: "bl|br|tl|tr" }],
 *       "sfx": [{ "at", "kind" }] } }
 */
import { app, BrowserWindow } from "electron";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mix, BEAT } from "./film-audio.mjs";

const [editFile, master, out] = process.argv.slice(2);
const SITE = process.env.FILM_SITE ?? "http://127.0.0.1:4321/";
const W = 1920;
const H = 1080;
const FPS = 60;
const SRC = { w: 1920, h: 1200 };
const APP = { w: 1600, h: 1000, x: 160, y: 40 };
const PUSH = 0.9;
const PAPER = "#f3ebde";
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
};

/** Output frame → take time: the speed eases to each new value over 0.45 s instead of jumping. */
function timeMap(take) {
  const speeds = [...(take.speed ?? [])].sort((a, b) => a[0] - b[0]);
  const target = (t) => speeds.reduce((s, [at, v]) => (t >= at ? v : s), 1);
  const dt = 1 / FPS / 8;
  const frames = [];
  let t = take.from;
  let v = target(t);
  let step = 0;
  while (t < take.to) {
    if (step % 8 === 0) frames.push({ t, v });
    const want = target(t);
    // Linear ramp in log-speed, so 1×→8× and 8×→1× feel equally gentle.
    const k = Math.log(want) - Math.log(v);
    v = Math.exp(Math.log(v) + Math.sign(k) * Math.min(Math.abs(k), (Math.log(8) / 0.45) * dt));
    t += v * dt;
    step++;
  }
  return frames;
}

/** Take time → the first output frame showing it. */
const frameOf = (frames, at) => {
  const i = frames.findIndex((f) => f.t >= at);
  return i < 0 ? frames.length - 1 : i;
};

/** Each framing is reached by its time, the move taking up to 1.3 s before it. */
function cameraPath(frames, keys) {
  const pts = [[frames[0].t, 0, 0, SRC.w], ...keys].map(([at, x, y, w]) => ({ f: frameOf(frames, at), x, y, w })).sort((a, b) => a.f - b.f);
  return (i) => {
    let prev = pts[0];
    for (const next of pts.slice(1)) {
      if (i >= next.f) { prev = next; continue; }
      const len = Math.min(1.3 * FPS, next.f - prev.f);
      const p = ease((i - (next.f - len)) / len);
      return { x: prev.x + (next.x - prev.x) * p, y: prev.y + (next.y - prev.y) * p, w: prev.w + (next.w - prev.w) * p };
    }
    return prev;
  };
}

const COMPOSITOR = (video) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${PAPER}}
  .bg{position:absolute;inset:0;background:radial-gradient(110% 80% at 50% 120%, #f6dcc3 0%, ${PAPER} 60%)}
  .frame{position:absolute;left:${APP.x}px;top:${APP.y}px;width:${APP.w}px;height:${APP.h}px;border-radius:14px;overflow:hidden;box-shadow:0 26px 70px rgba(70,40,20,.22),0 3px 10px rgba(70,40,20,.10)}
  canvas{display:block;width:${APP.w}px;height:${APP.h}px}
  video{position:absolute;left:-99999px;width:10px}
  .card{position:absolute;left:0;top:0;width:600px;box-sizing:border-box;padding:18px 24px 20px 28px;background:#fffaf3;border-radius:14px;border-left:7px solid #c4492c;box-shadow:0 20px 50px rgba(70,40,20,.24),0 2px 6px rgba(70,40,20,.10);overflow:hidden;will-change:transform}
  .head{display:flex;justify-content:space-between;align-items:center;height:24px;margin-bottom:8px}
  .kicker{font:600 15px "JetBrains Mono","SF Mono",Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#8f7f70}
  .badge{font:600 14px "SF Mono",Menlo,monospace;color:#fff;background:#c4492c;border-radius:999px;padding:3px 10px;transform-origin:right center}
  .lines{position:relative}
  .line{position:absolute;left:0;right:0;top:0}
  .en{font:700 32px/1.18 Charter,Georgia,serif;color:#2a211c}
  .zh{font:500 22px/1.45 "PingFang SC","Hiragino Sans GB",sans-serif;color:#2a211c;opacity:.82;margin-top:8px}
  .note{font:italic 15px/1.35 Charter,Georgia,serif;color:#8f7f70;margin-top:8px}
</style><body><div class="bg"></div><div class="frame"><canvas width="${APP.w}" height="${APP.h}"></canvas></div>
<video src="${video}" muted preload="auto"></video>
<div class="card" style="opacity:0"><div class="head"><span class="kicker"></span><span class="badge" style="opacity:0"></span></div><div class="lines"></div></div>
<script>
  const video = document.querySelector('video');
  const ctx = document.querySelector('canvas').getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const card = document.querySelector('.card');
  const lines = card.querySelector('.lines');
  const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const lineHtml = (c) => '<div class="en">' + esc(c.en) + '</div><div class="zh">' + esc(c.zh) + '</div>' + (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '');
  // Heights of every caption, measured once, so the card can grow and shrink smoothly.
  window.measure = (captions) => captions.map((c) => { const d = document.createElement('div'); d.className = 'line'; d.style.position = 'static'; d.innerHTML = lineHtml(c); lines.append(d); const h = d.getBoundingClientRect().height; d.remove(); return h; });
  window.frame = async (s) => {
    if (Math.abs(video.currentTime - s.time) > 1e-4 || video.readyState < 2) {
      // Every frame of the copy is a keyframe, so once seeked the picture is there; the timeout only guards a lost event.
      await new Promise((r) => { const done = () => { clearTimeout(guard); r(); }; const guard = setTimeout(done, 400); video.addEventListener('seeked', done, { once: true }); video.currentTime = s.time; });
    }
    ctx.drawImage(video, s.cam.x, s.cam.y, s.cam.w, s.cam.w * ${SRC.h / SRC.w}, 0, 0, ${APP.w}, ${APP.h});
    card.style.opacity = s.card.opacity;
    card.style.transform = 'translate(' + s.card.x + 'px,' + s.card.y + 'px)';
    card.querySelector('.kicker').textContent = s.card.kicker;
    const badge = card.querySelector('.badge');
    badge.textContent = s.card.badge;
    badge.style.opacity = s.card.badgeIn;
    badge.style.transform = 'scale(' + (0.7 + 0.3 * s.card.badgeIn) + ')';
    lines.style.height = s.card.height + 'px';
    lines.innerHTML = s.card.layers.map((l) => '<div class="line" style="opacity:' + l.opacity + ';transform:translateY(' + l.y + 'px)">' + lineHtml(l.c) + '</div>').join('');
    document.body.style.transform = 'translateY(' + s.shift + 'px)';
    // Captured only once this state has been painted.
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
  };
</script>`;

/** Corner positions for the 600-wide card of a given height. */
function cornerXY(corner = "bl", h) {
  const cardH = h + 24 + 8 + 38;
  return { x: corner.endsWith("l") ? 70 : W - 70 - 600, y: corner.startsWith("t") ? 90 : H - 64 - cardH };
}

async function heroWindow() {
  const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  // Fast enough that waiting for a painted frame costs a few milliseconds, not a second.
  win.webContents.setFrameRate(240);
  return win;
}

/** The website's hero with this clip's words, every animation held at `ms`; `sheet` is an image pushed over it. */
async function setupHero(win, { title, sub }) {
  await win.loadURL(SITE);
  await sleep(2000);
  await win.webContents.executeJavaScript(`(() => {
    const css = document.createElement('style');
    // Only the hero's poster and words, centred in the frame and set larger than on the page.
    css.textContent = 'header, nav, .actions, .hero-stage, astro-dev-toolbar, .lede ~ *, body > *:not(main):not(header):not(#film-sheet), main > *:not(.hero) { display: none !important } html, body { overflow: hidden !important } .hero { min-height: ${H}px !important; padding-top: 120px !important; box-sizing: border-box } .hero h1 { max-width: 1400px; margin-left: auto; margin-right: auto; font-size: 84px !important; line-height: 1.08 !important } .hero .lede { font-size: 34px !important; max-width: 1400px !important; margin-top: 18px !important } #film-sheet { position: fixed; left: 0; top: 0; width: ${W}px; height: ${H}px; z-index: 2147483647; will-change: transform }';
    document.head.append(css);
    window.scrollTo(0, 0);
    const h1 = document.querySelector('.hero h1');
    h1.textContent = ${JSON.stringify(title)};
    const lede = document.querySelector('.hero .lede');
    lede.textContent = ${JSON.stringify(sub ?? "")};
    lede.lang = 'zh-Hans';
    document.getAnimations().forEach((a) => a.pause());
    return true;
  })()`, true);
}

async function heroFrame(win, ms, sheet) {
  await win.webContents.executeJavaScript(`(() => {
    document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${ms}; });
    let s = document.getElementById('film-sheet');
    if (${sheet ? "true" : "false"}) {
      if (!s) { s = document.createElement('img'); s.id = 'film-sheet'; document.body.append(s); }
      if (s.dataset.key !== ${JSON.stringify(sheet?.key ?? "")}) { s.src = ${JSON.stringify(sheet?.src ?? "")}; s.dataset.key = ${JSON.stringify(sheet?.key ?? "")}; }
      s.style.transform = 'translateY(${sheet?.y ?? 0}px)';
    } else if (s) s.remove();
    return new Promise((r) => requestAnimationFrame(() => r(true)));
  })()`, true);
  if (sheet) await win.webContents.executeJavaScript(`document.getElementById('film-sheet').decode().then(() => true)`, true);
  return win.webContents.capturePage();
}

async function run() {
  const edit = JSON.parse(fs.readFileSync(editFile, "utf8"));
  const take = edit.take;
  const markers = JSON.parse(fs.readFileSync(master.replace(/\.mp4$/, ".markers.json"), "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-render-"));

  // An all-keyframe copy of the stretch we use: every seek lands on an exact frame, at once.
  const proxy = path.join(tmp, "take.mp4");
  ff(["-ss", String(take.from), "-to", String(take.to), "-i", master, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-g", "1", "-pix_fmt", "yuv420p", proxy]);

  const frames = timeMap(take);
  const cam = cameraPath(frames, take.cam ?? []);
  const intro = Math.round((edit.intro?.seconds ?? 4) * FPS);
  const outro = Math.round((edit.outro?.seconds ?? 4) * FPS);
  const push = Math.round(PUSH * FPS);
  // The take's frames start once the sheet has covered the hero; the hero's last frames carry the push.
  const takeStart = intro;
  const total = intro + frames.length + outro;

  // Captions land on beats.
  const caps = (take.captions ?? []).map((c) => ({ ...c, f: Math.round(Math.round(((takeStart + frameOf(frames, c.at)) / FPS) / BEAT) * BEAT * FPS) - takeStart }));

  const comp = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, webPreferences: { offscreen: true, autoplayPolicy: "no-user-gesture-required" } });
  comp.webContents.setFrameRate(240);
  const page = path.join(tmp, "compositor.html");
  fs.writeFileSync(page, COMPOSITOR(pathToFileURL(proxy).href));
  await comp.loadFile(page);
  await comp.webContents.executeJavaScript(`new Promise((r) => { const v = document.querySelector('video'); v.readyState >= 2 ? r(true) : v.addEventListener('loadeddata', () => r(true), { once: true }); })`, true);
  const heights = await comp.webContents.executeJavaScript(`measure(${JSON.stringify(caps)})`, true);

  /** The card at a take frame: which lines show and how, where it sits, the speed badge. */
  const cardAt = (i) => {
    const shown = caps.filter((c) => c.f <= i);
    if (!shown.length) return { opacity: 0, x: 70, y: H, kicker: "", badge: "", badgeIn: 0, height: 0, layers: [] };
    const k = shown.length - 1;
    const cur = shown[k];
    const since = (i - cur.f) / FPS;
    const enter = ease(Math.min(1, ((i - caps[0].f) / FPS) / 0.55));
    // The new line slides up into place; the old one leaves upwards a little ahead of it.
    const pIn = ease(Math.min(1, since / 0.42));
    const layers = [{ c: cur, opacity: Math.min(1, since / 0.25), y: 26 * (1 - pIn) }];
    if (k > 0 && since < 0.3) layers.unshift({ c: shown[k - 1], opacity: 1 - since / 0.3, y: -22 * ease(since / 0.3) });
    const h = heights[k];
    const hPrev = k > 0 ? heights[k - 1] : h;
    const height = hPrev + (h - hPrev) * pIn;
    const posNow = cornerXY(cur.corner, h);
    const posPrev = k > 0 ? cornerXY(shown[k - 1].corner, hPrev) : { x: -640, y: posNow.y };
    const glide = k > 0 ? ease(Math.min(1, since / 0.6)) : enter;
    const x = posPrev.x + (posNow.x - posPrev.x) * glide;
    const y = posPrev.y + (posNow.y - posPrev.y) * glide;
    const v = frames[Math.min(i, frames.length - 1)].v;
    const fast = Math.max(...(take.speed ?? []).map(([, s]) => s), 1);
    return { opacity: 1, x, y, kicker: cur.kicker ?? "", badge: `▶▶ ${fast}×`, badgeIn: Math.max(0, Math.min(1, (v - 1.5) / 2)), height, layers };
  };
  const compFrame = async (i, shift = 0) => {
    const f = frames[Math.max(0, Math.min(i, frames.length - 1))];
    await comp.webContents.executeJavaScript(`frame(${JSON.stringify({ time: Math.max(0, f.t - take.from), cam: cam(i), card: cardAt(i), shift })})`, true);
    return comp.webContents.capturePage();
  };

  const hero = await heroWindow();
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", path.join(tmp, "video.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
  const write = (img) => new Promise((r) => (ffmpeg.stdin.write(img.resize({ width: W, height: H }).toBitmap()) ? r() : ffmpeg.stdin.once("drain", r)));

  // The open: the hero plays; over its last `push` frames the take's first frame pushes up on its sheet.
  await setupHero(hero, edit.intro);
  const first = `data:image/png;base64,${(await compFrame(0)).toPNG().toString("base64")}`;
  const heroStart = Date.now();
  for (let i = 0; i < intro; i++) {
    if (i === 60) console.log(`hero ${((Date.now() - heroStart) / 60).toFixed(0)} ms a frame`);
    const p = (i - (intro - push)) / push;
    await write(await heroFrame(hero, (i / FPS) * 1000, p > 0 ? { key: "first", src: first, y: H * (1 - ease(p)) } : null));
  }
  const started = Date.now();
  const limit = Number(process.env.FILM_LIMIT ?? frames.length);
  for (let i = 0; i < Math.min(limit, frames.length); i++) {
    await write(await compFrame(i));
    if (i % 300 === 0) console.log(`take ${Math.round((i / frames.length) * 100)}% · ${((Date.now() - started) / Math.max(1, i)).toFixed(0)} ms a frame`);
  }
  // The close: the take's last frame leaves upwards on its sheet, uncovering the hero.
  await setupHero(hero, edit.outro);
  const last = `data:image/png;base64,${(await compFrame(frames.length - 1)).toPNG().toString("base64")}`;
  for (let i = 0; i < outro; i++) {
    const p = i / push;
    await write(await heroFrame(hero, (i / FPS) * 1000 + 300, p < 1 ? { key: "last", src: last, y: -H * ease(p) } : null));
  }
  ffmpeg.stdin.end();
  await new Promise((r) => ffmpeg.on("close", r));

  // Sound on the same clock.
  const seconds = total / FPS;
  const effects = [{ t: (intro - push) / FPS, kind: "whoosh" }, { t: (intro + frames.length) / FPS - 0.05, kind: "whoosh" }];
  const at = (t) => {
    const i = frameOf(frames, t);
    return frames[i] && frames[i].v < 1.5 && t >= take.from && t < take.to ? (takeStart + i) / FPS : null;
  };
  for (const e of [...(markers.events ?? []), ...(take.sfx ?? [])]) {
    const t = at(e.at ?? e.t);
    if (t != null) effects.push({ t, kind: e.kind });
  }
  effects.sort((a, b) => a.t - b.t);
  let lastKey = -1;
  const heard = effects.filter((e) => e.kind !== "key" || (e.t - lastKey >= 0.08 && ((lastKey = e.t), true)));
  const sound = path.join(tmp, "sound.wav");
  mix(sound, seconds, heard, { music: edit.music ?? 0.75 });
  ff(["-i", path.join(tmp, "video.mp4"), "-i", sound, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
  console.log(`rendered ${out}: ${seconds.toFixed(1)} s (${intro} + ${frames.length} + ${outro} frames)`);
}

app.whenReady().then(run).then(() => app.exit(0)).catch((e) => { console.error(e); app.exit(1); });
