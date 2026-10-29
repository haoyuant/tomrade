/**
 * Cuts a take from film.mjs into a finished 16:9 clip: the app floats on paper with a caption under it, waits play
 * sped up and say so, and title cards open and close it. Cards and caption plates are drawn as HTML, so the type is
 * the system's own (New York for Latin, PingFang for Chinese).
 *
 *   npx electron scripts/film-cut.mjs <edit.json> <master.mp4> <out.mp4>
 *
 * edit.json: { "parts": [ { "card": { "kicker", "en", "zh", "tone": "paper|rust|ink", "seconds" } }
 *                       | { "from", "to", "speed"?, "en", "zh", "note"? } ] }
 */
import { app, BrowserWindow } from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [editFile, master, out] = process.argv.slice(2);
const W = 1920;
const H = 1080;
const FPS = 30;
// The 1920×1200 app, shown at 70%.
const FRAME = { w: 1344, h: 840, x: 288, y: 44 };
const TONES = { paper: ["#f4ecdf", "#2a211c", "#9a8b7c"], rust: ["#a8432a", "#fbf3e8", "#f0cdb9"], ink: ["#1f1a17", "#f4ecdf", "#9a8b7c"] };
const ACCENT = "#a8432a";
app.disableHardwareAcceleration();

const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const page = (body) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
  .serif{font-family:"New York","Iowan Old Style",Georgia,serif}
  .zh{font-family:"PingFang SC","Hiragino Sans GB",sans-serif}
  .mono{font-family:"SF Mono",Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}
</style><body>${body}</body>`;

const cardHtml = ({ kicker = "", en = "", zh = "", tone = "paper", logo }) => {
  const [bg, fg, meta] = TONES[tone] ?? TONES.paper;
  return page(`<div style="position:absolute;inset:0;background:${bg};color:${fg};padding:0 160px;display:flex;flex-direction:column;justify-content:center">
    ${logo ? `<img src="${logo}" style="width:120px;height:120px;border-radius:26px;margin-bottom:40px">` : ""}
    ${kicker ? `<div class="mono" style="font-size:22px;color:${meta};margin-bottom:28px">${esc(kicker)}</div>` : ""}
    <div class="serif" style="font-size:${logo ? 76 : 104}px;font-weight:600;line-height:1.05;letter-spacing:-.01em">${esc(en)}</div>
    ${zh ? `<div class="zh" style="font-size:40px;margin-top:26px;font-weight:500;opacity:.92">${esc(zh)}</div>` : ""}
  </div>`);
};

const plateHtml = ({ en = "", zh = "", note = "", speed = 1 }) => {
  const [bg, fg, meta] = TONES.paper;
  const f = FRAME;
  return page(`<div style="position:absolute;inset:0;background:${bg}">
    <div style="position:absolute;left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px;border-radius:10px;box-shadow:0 18px 50px rgba(60,40,25,.22),0 2px 6px rgba(60,40,25,.12);outline:1px solid rgba(60,40,25,.14)"></div>
    ${speed > 1 ? `<div class="mono" style="position:absolute;right:${W - f.x - f.w}px;top:${f.y - 34}px;font-size:18px;color:${ACCENT}">▶▶ ${speed}×</div>` : ""}
    <div style="position:absolute;left:0;right:0;top:${f.y + f.h + 26}px;text-align:center;color:${fg}">
      <div class="serif" style="font-size:36px;font-weight:600">${esc(en)}</div>
      <div class="zh" style="font-size:25px;margin-top:8px;color:${fg};opacity:.85">${esc(zh)}</div>
      ${note ? `<div class="serif" style="font-size:17px;margin-top:10px;color:${meta};font-style:italic">${esc(note)}</div>` : ""}
    </div>
  </div>`);
};

async function draw(win, html, file) {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 150)))");
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
}

const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
};
const encode = ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS)];

async function run() {
  const edit = JSON.parse(fs.readFileSync(editFile, "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cut-"));
  const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  const logoFile = path.join(path.dirname(new URL(import.meta.url).pathname), "../build/icon.png");
  const logo = fs.existsSync(logoFile) ? `data:image/png;base64,${fs.readFileSync(logoFile).toString("base64")}` : null;
  const pieces = [];
  for (const [i, part] of edit.parts.entries()) {
    const png = path.join(tmp, `p${i}.png`);
    const clip = path.join(tmp, `p${i}.mp4`);
    if (part.card) {
      await draw(win, cardHtml({ ...part.card, logo: part.card.logo ? logo : null }), png);
      const s = part.card.seconds ?? 2.2;
      ff(["-loop", "1", "-t", String(s), "-i", png, "-vf", `scale=${W}:${H},fade=in:0:8,fade=out:st=${s - 0.27}:d=0.27`, ...encode, clip]);
    } else {
      const speed = part.speed ?? 1;
      await draw(win, plateHtml(part), png);
      const len = (part.to - part.from) / speed;
      const f = FRAME;
      ff(["-loop", "1", "-i", png, "-ss", String(part.from), "-to", String(part.to), "-i", master,
        "-filter_complex", `[0:v]scale=${W}:${H}:flags=lanczos[bg];[1:v]setpts=(PTS-STARTPTS)/${speed},scale=${f.w}:${f.h}:flags=lanczos[app];[bg][app]overlay=${f.x}:${f.y}:shortest=1,fade=in:0:5,fade=out:st=${Math.max(0, len - 0.17)}:d=0.17[v]`,
        "-map", "[v]", "-t", String(len), ...encode, clip]);
    }
    pieces.push(clip);
  }
  const list = path.join(tmp, "list.txt");
  fs.writeFileSync(list, pieces.map((p) => `file '${p}'`).join("\n"));
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  console.log(`cut ${out}`);
}

app.whenReady().then(run).then(() => app.exit(0)).catch((e) => { console.error(e); app.exit(1); });
