/**
 * Cuts a take from film.mjs into a finished 16:9 clip. The app floats on paper; inside its frame a camera eases in
 * on what matters and back out. Captions rise in under it, waits play sped up and say so, title cards slide their
 * words in, and parts dissolve or glide into each other — never through black. Music and effects come from
 * film-audio.mjs, the clicks and keys at the times the take logged them.
 *
 *   npx electron scripts/film-cut.mjs <edit.json> <master.mp4> <out.mp4>
 *
 * edit.json parts, in order:
 *   { "card": { "kicker", "en", "zh", "tone": "paper|rust|ink", "seconds", "logo": true } }
 *   { "from", "to", "speed"?, "en", "zh", "note"?, "cam"?: { "from": [x, y, w], "to": [x, y, w], "move"?: [start, end] },
 *     "sfx"?: [{ "at": <take time>, "kind": "chime|undo|click" }] }
 * Camera boxes are in the take's 1920×1200 pixels: top-left and width (the height follows); `move` is the share of
 * the part the camera spends travelling, 0–1.
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
const FPS = 30;
const SRC = { w: 1920, h: 1200 };
// The app, shown at 70%.
const FRAME = { w: 1344, h: 840, x: 288, y: 40 };
const T = 0.45;
const TONES = { paper: ["#f4ecdf", "#2a211c", "#9a8b7c"], rust: ["#a8432a", "#fbf3e8", "#f0cdb9"], ink: ["#1f1a17", "#f4ecdf", "#9a8b7c"] };
const ACCENT = "#a8432a";
app.disableHardwareAcceleration();

const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const page = (body, bg = "transparent") => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${bg}}
  .serif{font-family:"New York","Iowan Old Style",Georgia,serif}
  .zh{font-family:"PingFang SC","Hiragino Sans GB",sans-serif}
  .mono{font-family:"SF Mono",Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}
</style><body>${body}</body>`;

const cardText = ({ kicker = "", en = "", zh = "", tone = "paper" }, logo) => {
  const [, fg, meta] = TONES[tone] ?? TONES.paper;
  return page(`<div style="position:absolute;inset:0;color:${fg};padding:0 160px;display:flex;flex-direction:column;justify-content:center">
    ${logo ? `<img src="${logo}" style="width:112px;height:112px;border-radius:24px;margin-bottom:38px;box-shadow:0 10px 30px rgba(0,0,0,.18)">` : ""}
    ${kicker ? `<div class="mono" style="font-size:22px;color:${meta};margin-bottom:28px">${esc(kicker)}</div>` : ""}
    <div class="serif" style="font-size:${logo ? 72 : 100}px;font-weight:600;line-height:1.06;letter-spacing:-.01em;max-width:1500px">${esc(en)}</div>
    ${zh ? `<div class="zh" style="font-size:40px;margin-top:26px;font-weight:500;opacity:.92">${esc(zh)}</div>` : ""}
  </div>`);
};

const plate = () => {
  const [bg] = TONES.paper;
  const f = FRAME;
  return page(`<div style="position:absolute;left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px;border-radius:12px;box-shadow:0 22px 60px rgba(60,40,25,.20),0 3px 8px rgba(60,40,25,.10);outline:1px solid rgba(60,40,25,.12);background:#fff"></div>`, bg);
};

const caption = ({ en = "", zh = "", note = "", speed = 1 }) => {
  const [, fg, meta] = TONES.paper;
  const f = FRAME;
  return page(`
    ${speed > 1 ? `<div class="mono" style="position:absolute;right:${W - f.x - f.w}px;top:${f.y + f.h + 14}px;font-size:17px;color:${ACCENT}">▶▶ ${speed}×</div>` : ""}
    <div style="position:absolute;left:0;right:0;top:${f.y + f.h + 30}px;text-align:center;color:${fg}">
      <div class="serif" style="font-size:36px;font-weight:600">${esc(en)}</div>
      <div class="zh" style="font-size:25px;margin-top:8px;opacity:.85">${esc(zh)}</div>
      ${note ? `<div class="serif" style="font-size:17px;margin-top:9px;color:${meta};font-style:italic">${esc(note)}</div>` : ""}
    </div>`);
};

async function draw(win, html, file) {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 150)))");
  fs.writeFileSync(file, (await win.webContents.capturePage()).resize({ width: W, height: H }).toPNG());
}

const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
};
const encode = ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS)];

/** Smoothstep from one camera box to another over [move] of the part; boxes are in the take's pixels. */
function camera(cam, seconds) {
  const from = cam?.from ?? [0, 0, SRC.w];
  // Even a still part drifts in a little, so nothing on screen is ever frozen.
  const to = cam?.to ?? (cam?.from ? cam.from : [SRC.w * 0.012, SRC.h * 0.012, SRC.w * 0.976]);
  const [s, e] = cam?.move ?? [0, 1];
  const p = `clip((in/${FPS}/${seconds.toFixed(3)}-${s})/${Math.max(0.01, e - s)},0,1)`;
  const ease = `(${p})*(${p})*(3-2*(${p}))`;
  const lerp = (a, b) => `(${a}+(${b - a})*${ease})`;
  // The take is doubled first, so the camera moves in half pixels and never judders.
  return `scale=${SRC.w * 2}:${SRC.h * 2}:flags=lanczos,zoompan=z='${SRC.w}/${lerp(from[2], to[2])}':x='2*${lerp(from[0], to[0])}':y='2*${lerp(from[1], to[1])}':d=1:s=${SRC.w}x${SRC.h}:fps=${FPS}`;
}

async function run() {
  const edit = JSON.parse(fs.readFileSync(editFile, "utf8"));
  const take = JSON.parse(fs.readFileSync(master.replace(/\.mp4$/, ".markers.json"), "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cut-"));
  const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, transparent: true, backgroundColor: "#00000000", webPreferences: { offscreen: true } });
  const logoFile = path.join(dir, "../assets/icon.png");
  const logo = fs.existsSync(logoFile) ? `data:image/png;base64,${fs.readFileSync(logoFile).toString("base64")}` : null;
  const base = path.join(tmp, "plate.png");
  await draw(win, plate(), base);

  const clips = [];
  const lengths = [];
  for (const [i, part] of edit.parts.entries()) {
    const clip = path.join(tmp, `p${i}.mp4`);
    const words = path.join(tmp, `w${i}.png`);
    if (part.card) {
      const s = part.card.seconds ?? 2.4;
      const [bg] = TONES[part.card.tone] ?? TONES.paper;
      await draw(win, cardText(part.card, part.card.logo ? logo : null), words);
      // The words rise 30 px and fade in once the card has settled.
      ff(["-f", "lavfi", "-i", `color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${s}`, "-loop", "1", "-t", String(s), "-i", words,
        "-filter_complex", `[1:v]format=rgba,fade=in:st=0.2:d=0.6:alpha=1[w];[0:v][w]overlay=x=0:y='30*pow(max(0,1-(t-0.2)/0.8),3)':shortest=1[v]`,
        "-map", "[v]", "-t", String(s), ...encode, clip]);
      lengths.push(s);
    } else {
      const speed = part.speed ?? 1;
      const len = (part.to - part.from) / speed;
      await draw(win, caption(part), words);
      const f = FRAME;
      ff(["-loop", "1", "-t", String(len), "-i", base, "-ss", String(part.from), "-to", String(part.to), "-i", master, "-loop", "1", "-t", String(len), "-i", words,
        "-filter_complex", [
          `[1:v]setpts=(PTS-STARTPTS)/${speed},fps=${FPS},${camera(part.cam, len)},scale=${f.w}:${f.h}:flags=lanczos[app]`,
          `[0:v][app]overlay=${f.x}:${f.y}:shortest=1[framed]`,
          `[2:v]format=rgba,fade=in:st=0.25:d=0.5:alpha=1[cap]`,
          `[framed][cap]overlay=x=0:y='14*pow(max(0,1-(t-0.25)/0.6),3)'[v]`
        ].join(";"),
        "-map", "[v]", "-t", String(len), ...encode, clip]);
      lengths.push(len);
    }
    clips.push(clip);
    console.log(`part ${i + 1}/${edit.parts.length}: ${lengths.at(-1).toFixed(2)} s`);
  }

  // Parts overlap by T: dissolves between shots, a glide into and out of each card.
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0) - i * T);
  const total = starts.at(-1) + lengths.at(-1);
  const chain = [];
  let prev = "[0:v]";
  for (let i = 1; i < clips.length; i++) {
    const card = !!edit.parts[i].card || !!edit.parts[i - 1].card;
    chain.push(`${prev}[${i}:v]xfade=transition=${card ? "smoothleft" : "fade"}:duration=${T}:offset=${starts[i].toFixed(3)}[x${i}]`);
    prev = `[x${i}]`;
  }
  const silent = path.join(tmp, "video.mp4");
  ff([...clips.flatMap((c) => ["-i", c]), "-filter_complex", chain.join(";") || "[0:v]null[x0]", "-map", clips.length > 1 ? prev : "[x0]", ...encode, silent]);

  // Sound: a whoosh into each card, the take's clicks and keys where they land, and the edit's own cues.
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
    if (part.card && i > 0) effects.push({ t: Math.max(0, starts[i] - 0.15), kind: "whoosh" });
    for (const cue of part.sfx ?? []) {
      // "typing" from at to until: a key every 50 ms, for takes filmed before keys were logged.
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
  const sound = path.join(tmp, "sound.wav");
  mix(sound, total, effects, { music: edit.music ?? 0.8 });
  // Social players are loud: -16 LUFS, peaks under -1.5 dB.
  ff(["-i", silent, "-i", sound, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
  console.log(`cut ${out} (${total.toFixed(1)} s, ${effects.length} effects)`);
}

app.whenReady().then(run).then(() => app.exit(0)).catch((e) => { console.error(e); app.exit(1); });
