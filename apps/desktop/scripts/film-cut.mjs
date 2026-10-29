/**
 * Cuts a take from film.mjs into a finished 16:9 clip at 60 fps. The app fills most of the frame; inside it a camera
 * eases in on what matters and back out. Each caption is a ticket card — the app's own type, a vermilion edge — that
 * slides in at the corner the part names, away from what the camera looks at. The open and the close are Tomrade's
 * sunrise: a sun climbing over a horizon, rays turning slowly behind it. Parts dissolve into each other, never through
 * black. Music and effects come from film-audio.mjs, clicks and keys at the times the take logged them.
 *
 *   npx electron scripts/film-cut.mjs <edit.json> <master.mp4> <out.mp4>
 *
 * edit.json parts, in order:
 *   { "card": { "kicker", "en", "zh", "seconds", "logo": true } }
 *   { "from", "to", "speed"?, "kicker"?, "en", "zh", "note"?, "at"?: "bl|br|tl|tr",
 *     "cam"?: { "from": [x, y, w], "to": [x, y, w], "move"?: [start, end] }, "sfx"?: [{ "at", "kind", "until"? }] }
 * Camera boxes are in the take's 1920×1200 pixels, top-left and width; `move` is the share of the part spent moving.
 */
import { app, BrowserWindow } from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mix } from "./film-audio.mjs";

const [editFile, master, out] = process.argv.slice(2);
const dir = path.dirname(fileURLToPath(import.meta.url));
const W = 1920;
const H = 1080;
const FPS = 60;
const SRC = { w: 1920, h: 1200 };
const APP = { w: 1600, h: 1000, x: 160, y: 40, r: 14 };
const T = 0.5;
const PAPER = "#f3ebde";
const INK = "#2a211c";
const META = "#8f7f70";
const SUN = "#c4492c";
app.disableHardwareAcceleration();

// A "\n" in a line is where it breaks.
const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
const page = (body, bg = "transparent", w = W, h = H) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${bg}}
  .serif{font-family:Charter,Georgia,serif}
  .zh{font-family:"PingFang SC","Hiragino Sans GB",sans-serif}
  .mono{font-family:"JetBrains Mono","SF Mono",Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}
</style><body>${body}</body>`;

/** The paper the app sits on: a warm wash, brighter where the sun would be. */
const backdrop = () => page(`<div style="position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 115%, #f8dcc4 0%, ${PAPER} 55%)"></div>
  <div style="position:absolute;left:${APP.x}px;top:${APP.y}px;width:${APP.w}px;height:${APP.h}px;border-radius:${APP.r}px;box-shadow:0 26px 70px rgba(70,40,20,.22),0 3px 10px rgba(70,40,20,.10)"></div>`, PAPER);

/** White where the app shows: its rounded corners. */
const mask = () => page(`<div style="position:absolute;inset:0;background:#000"></div><div style="position:absolute;inset:0;border-radius:${APP.r}px;background:#fff"></div>`, "#000", APP.w, APP.h);

/** Rays for the sunrise, drawn on a square larger than the frame so they can turn without showing an edge. */
const rays = () => {
  const n = 28;
  const lines = Array.from({ length: n }, (_, i) => `<div style="position:absolute;left:50%;top:50%;width:1400px;height:${i % 2 ? 26 : 48}px;margin-top:-${i % 2 ? 13 : 24}px;transform-origin:0 50%;transform:rotate(${(360 / n) * i}deg);background:linear-gradient(90deg, rgba(196,73,44,0) 12%, rgba(196,73,44,${i % 2 ? 0.06 : 0.1}) 40%, rgba(196,73,44,0) 100%)"></div>`).join("");
  return page(lines, "transparent", 2400, 2400);
};

const SUN_D = 520;
const HORIZON = H - 170;
const sun = () => page(`<div style="position:absolute;left:40px;top:40px;width:${SUN_D}px;height:${SUN_D}px;border-radius:50%;background:radial-gradient(circle at 50% 30%, #e46a42 0%, ${SUN} 58%, #b23d22 100%);box-shadow:0 0 90px rgba(214,96,52,.35)"></div>`, "transparent", SUN_D + 80, SUN_D + 80);

/** Below the horizon: paper again, so the sun climbs out of the ground and the rays start at it. */
const ground = () => page(`<div style="position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,rgba(196,73,44,.45),transparent)"></div><div style="position:absolute;left:0;right:0;top:2px;bottom:0;background:linear-gradient(${PAPER}, #efe4d4)"></div>`, "transparent", W, H - HORIZON);

/** The words of an open or close card; the sun and the rays move under them. */
const cardWords = ({ kicker = "TOMRADE", en = "", zh = "" }, logo) => page(`
  <div style="position:absolute;left:0;right:0;top:${logo ? 150 : 210}px;text-align:center;color:${INK}">
    ${logo ? `<img src="${logo}" style="width:150px;height:150px;border-radius:34px;box-shadow:0 14px 40px rgba(70,40,20,.25);margin-bottom:34px">` : `<div class="mono" style="font-size:22px;color:${META};margin-bottom:26px">${esc(kicker)}</div>`}
    <div class="serif" style="font-size:${logo ? 64 : 92}px;font-weight:700;line-height:1.08;padding:0 220px">${esc(en)}</div>
    ${zh ? `<div class="zh" style="font-size:38px;margin-top:22px;font-weight:500;color:${INK};opacity:.88">${esc(zh)}</div>` : ""}
  </div>`);

/** A caption as a ticket card; its height is read back for placing it. */
const ticket = ({ kicker = "", en = "", zh = "", note = "", speed = 1 }) => page(`<div id="t" style="position:absolute;left:0;top:0;width:600px;box-sizing:border-box;padding:20px 26px 22px 30px;background:#fffaf3;border-radius:14px;border-left:7px solid ${SUN};box-shadow:0 20px 50px rgba(70,40,20,.24),0 2px 6px rgba(70,40,20,.10)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;min-height:22px">
      <span class="mono" style="font-size:15px;color:${META}">${esc(kicker)}</span>
      ${speed > 1 ? `<span class="mono" style="font-size:14px;color:#fff;background:${SUN};border-radius:999px;padding:3px 10px;letter-spacing:.06em">▶▶ ${speed}×</span>` : ""}
    </div>
    <div class="serif" style="font-size:33px;font-weight:700;line-height:1.18;color:${INK}">${esc(en)}</div>
    <div class="zh" style="font-size:23px;margin-top:9px;color:${INK};opacity:.82;line-height:1.4">${esc(zh)}</div>
    ${note ? `<div class="serif" style="font-size:16px;margin-top:10px;color:${META};font-style:italic;line-height:1.35">${esc(note)}</div>` : ""}
  </div>`, "transparent", 680, 460);

async function draw(win, html, file, size = { width: W, height: H }) {
  win.setContentSize(size.width, size.height);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const box = await win.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 150))).then(() => { const t = document.getElementById('t'); return t ? t.getBoundingClientRect().height : null; })");
  fs.writeFileSync(file, (await win.webContents.capturePage()).resize(size).toPNG());
  return box;
}

const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
};
const encode = ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS)];

/** Smoothstep from one camera box to another over [move] of the part; boxes are in the take's pixels. */
function camera(cam, seconds) {
  const from = cam?.from ?? [0, 0, SRC.w];
  // Even a still part drifts in a little, so nothing on screen is ever frozen.
  const to = cam?.to ?? (cam?.from ? cam.from : [SRC.w * 0.01, SRC.h * 0.01, SRC.w * 0.98]);
  const [s, e] = cam?.move ?? [0, 1];
  const p = `clip((in/${FPS}/${seconds.toFixed(3)}-${s})/${Math.max(0.01, e - s)},0,1)`;
  const ease = `(${p})*(${p})*(3-2*(${p}))`;
  const lerp = (a, b) => `(${a}+(${b - a})*${ease})`;
  // The take is doubled first, so the camera moves in half pixels and never judders.
  return `scale=${SRC.w * 2}:${SRC.h * 2}:flags=lanczos,zoompan=z='${SRC.w}/${lerp(from[2], to[2])}':x='2*${lerp(from[0], to[0])}':y='2*${lerp(from[1], to[1])}':d=1:s=${SRC.w}x${SRC.h}:fps=${FPS}`;
}

/** Where a 600-wide card of height h sits for a corner: over the app's edge, clear of the frame's own. */
function corner(at = "bl", h) {
  const left = at.endsWith("l");
  const top = at.startsWith("t");
  return { x: left ? 70 : W - 70 - 600, y: top ? 90 : H - 70 - h, from: left ? -1 : 1 };
}

async function run() {
  const edit = JSON.parse(fs.readFileSync(editFile, "utf8"));
  const take = JSON.parse(fs.readFileSync(master.replace(/\.mp4$/, ".markers.json"), "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cut-"));
  const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, transparent: true, backgroundColor: "#00000000", webPreferences: { offscreen: true } });
  const logoFile = path.join(dir, "../assets/icon.png");
  const logo = fs.existsSync(logoFile) ? `data:image/png;base64,${fs.readFileSync(logoFile).toString("base64")}` : null;
  const back = path.join(tmp, "back.png");
  const corners = path.join(tmp, "mask.png");
  const rayFile = path.join(tmp, "rays.png");
  const sunFile = path.join(tmp, "sun.png");
  const groundFile = path.join(tmp, "ground.png");
  await draw(win, backdrop(), back);
  await draw(win, mask(), corners, { width: APP.w, height: APP.h });
  await draw(win, rays(), rayFile, { width: 2400, height: 2400 });
  await draw(win, sun(), sunFile, { width: SUN_D + 80, height: SUN_D + 80 });
  await draw(win, ground(), groundFile, { width: W, height: H - HORIZON });

  const clips = [];
  const lengths = [];
  for (const [i, part] of edit.parts.entries()) {
    const clip = path.join(tmp, `p${i}.mp4`);
    const words = path.join(tmp, `w${i}.png`);
    if (part.card) {
      const s = part.card.seconds ?? 2.6;
      await draw(win, cardWords(part.card, part.card.logo ? logo : null), words);
      // Rays turn slowly; the sun climbs to sit on the horizon line; the words rise in once it is up.
      // Its centre ends on the horizon: half a sun, risen out of the ground.
      const sunTop = HORIZON - (SUN_D + 80) / 2;
      ff(["-f", "lavfi", "-i", `color=c=${PAPER}:s=${W}x${H}:r=${FPS}:d=${s}`, "-loop", "1", "-t", String(s), "-i", rayFile, "-loop", "1", "-t", String(s), "-i", sunFile, "-loop", "1", "-t", String(s), "-i", groundFile, "-loop", "1", "-t", String(s), "-i", words,
        "-filter_complex", [
          `[1:v]format=rgba,rotate=a='t*0.05':c=none:ow=2400:oh=2400,fade=in:st=0.2:d=1:alpha=1[r]`,
          `[0:v][r]overlay=x=${(W - 2400) / 2}:y=${HORIZON - 1200}:shortest=1[a]`,
          `[a][2:v]overlay=x=${(W - SUN_D - 80) / 2}:y='${sunTop}+${SUN_D * 0.55}*pow(max(0,1-t/1.3),3)':shortest=1[b]`,
          `[b][3:v]overlay=x=0:y=${HORIZON}:shortest=1[c]`,
          `[4:v]format=rgba,fade=in:st=0.35:d=0.6:alpha=1[w]`,
          `[c][w]overlay=x=0:y='26*pow(max(0,1-(t-0.35)/0.8),3)':shortest=1[v]`
        ].join(";"),
        "-map", "[v]", "-t", String(s), ...encode, clip]);
      lengths.push(s);
    } else {
      const speed = part.speed ?? 1;
      const len = (part.to - part.from) / speed;
      const h = Math.ceil(await draw(win, ticket(part), words, { width: 680, height: 460 }));
      const c = corner(part.at, h);
      ff(["-loop", "1", "-t", String(len), "-i", back, "-ss", String(part.from), "-to", String(part.to), "-i", master, "-loop", "1", "-t", String(len), "-i", corners, "-loop", "1", "-t", String(len), "-i", words,
        "-filter_complex", [
          `[1:v]setpts=(PTS-STARTPTS)/${speed},fps=${FPS},${camera(part.cam, len)},scale=${APP.w}:${APP.h}:flags=lanczos,format=rgba[cam]`,
          `[2:v]format=gray[m]`,
          `[cam][m]alphamerge[app]`,
          `[0:v][app]overlay=${APP.x}:${APP.y}:shortest=1[framed]`,
          // The card's shadow reaches 40 px past it, so it is cut with that margin.
          `[3:v]format=rgba,crop=680:${Math.min(460, h + 60)}:0:0,fade=in:st=0.3:d=0.45:alpha=1[card]`,
          // It slides 60 px in from its own side and settles.
          `[framed][card]overlay=x='${c.x}+${c.from * 60}*pow(max(0,1-(t-0.3)/0.7),3)':y=${c.y}[v]`
        ].join(";"),
        "-map", "[v]", "-t", String(len), ...encode, clip]);
      lengths.push(len);
    }
    clips.push(clip);
    console.log(`part ${i + 1}/${edit.parts.length}: ${lengths.at(-1).toFixed(2)} s`);
  }

  // Parts overlap by T: dissolves between shots; the sunrise opens out of a circle and closes into one.
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0) - i * T);
  const total = starts.at(-1) + lengths.at(-1);
  const chain = [];
  let prev = "[0:v]";
  for (let i = 1; i < clips.length; i++) {
    const kind = edit.parts[i - 1].card ? "circleopen" : edit.parts[i].card ? "circleclose" : "fade";
    chain.push(`${prev}[${i}:v]xfade=transition=${kind}:duration=${T}:offset=${starts[i].toFixed(3)}[x${i}]`);
    prev = `[x${i}]`;
  }
  const silent = path.join(tmp, "video.mp4");
  ff([...clips.flatMap((c) => ["-i", c]), "-filter_complex", chain.join(";"), "-map", prev, ...encode, silent]);

  // Sound: a whoosh at each sunrise, the take's clicks and keys where they land, and the edit's own cues.
  const effects = [];
  const at = (t) => {
    for (const [i, part] of edit.parts.entries()) {
      if (part.card || t < part.from || t >= part.to) continue;
      if ((part.speed ?? 1) > 1) return null;
      return starts[i] + (t - part.from);
    }
    return null;
  };
  edit.parts.forEach((part, i) => {
    if (part.card && i > 0) effects.push({ t: Math.max(0, starts[i] - 0.1), kind: "whoosh" });
    for (const cue of part.sfx ?? []) {
      const times = cue.kind === "typing" ? Array.from({ length: Math.floor((cue.until - cue.at) / 0.05) }, (_, k) => cue.at + k * 0.05) : [cue.at];
      for (const when of times) {
        const t = at(when);
        if (t != null) effects.push({ t, kind: cue.kind === "typing" ? "key" : cue.kind, gain: cue.gain });
      }
    }
  });
  for (const e of take.events ?? []) {
    const t = at(e.t);
    if (t != null) effects.push({ t, kind: e.kind });
  }
  // Keys are felt, not counted: none closer than 80 ms to the last.
  effects.sort((a, b) => a.t - b.t);
  let lastKey = -1;
  const heard = effects.filter((e) => e.kind !== "key" || (e.t - lastKey >= 0.08 && ((lastKey = e.t), true)));
  const sound = path.join(tmp, "sound.wav");
  mix(sound, total, heard, { music: edit.music ?? 0.8 });
  // Social players are loud: -16 LUFS, peaks under -1.5 dB.
  ff(["-i", silent, "-i", sound, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
  console.log(`cut ${out} (${total.toFixed(1)} s, ${heard.length} effects)`);
}

app.whenReady().then(run).then(() => app.exit(0)).catch((e) => { console.error(e); app.exit(1); });
