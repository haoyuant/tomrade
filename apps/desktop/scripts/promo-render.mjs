/**
 * Films the promo (packages/ui/src/promo): builds its page, draws every frame in a window that is never shown, and
 * hands the frames to ffmpeg. The page draws a frame from its number alone, and each frame carries its number as a
 * colour the loop reads back, so a frame is taken only once it is the one asked for: a render is repeatable.
 *
 *   pnpm promo                                    both cuts, English, into out/promo/
 *   pnpm promo --format=tall --locale=zh          one cut (wide | tall), one language (en | zh)
 *   pnpm promo --still=12.5,18                    frames of each cut as PNGs, by their second
 *   pnpm promo --frames=300-480 --no-build        a part of it, from the page already built
 *   pnpm promo --sound                            a second file of each cut with the soundtrack (promo-sound.mjs)
 *
 * Needs ffmpeg on the PATH. `pnpm promo:preview` plays the page in a browser (?format=tall, ?lang=zh, space, arrows).
 */
import { app, BrowserWindow, nativeImage } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { soundtrack } from "./promo-sound.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(dir, "../../..");
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = path.resolve(flag("out") ?? path.join(repo, "out/promo"));
const page = path.join(repo, "out/promo/page/promo.html");
const formats = flag("format") ? [flag("format")] : ["wide", "tall"];
const locale = flag("locale") ?? "en";
const still = flag("still");
/** Rows under the picture that hold the frame's mark. */
const MARK_ROWS = 4;

app.on("window-all-closed", () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The frame number a painted image says it shows, read from the mark under the picture. */
function markOf(bitmap, pxW, k, height) {
  const at = (Math.round((height + MARK_ROWS / 2) * k) * pxW + Math.round(8 * k)) * 4;
  const digit = (value) => Math.round((value - 8) / 16);
  // BGRA
  return (digit(bitmap[at + 2]) << 8) | (digit(bitmap[at + 1]) << 4) | digit(bitmap[at]);
}

async function film(format) {
  const win = new BrowserWindow({ show: false, frame: false, useContentSize: true, width: 800, height: 600, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const wc = win.webContents;
  wc.setFrameRate(60);
  let painted = null;
  let wake = () => {};
  // The image is the compositor's own buffer, drawn over by the frames after it: copied while it still holds this one.
  wc.on("paint", (_event, _dirty, image) => {
    painted = { bitmap: image.toBitmap(), size: image.getSize() };
    wake();
  });
  await win.loadFile(page, { query: { capture: "1", format, lang: locale } });
  const info = await wc.executeJavaScript("new Promise((resolve) => { const wait = () => (window.__film ? resolve({ frames: window.__film.frames, fps: window.__film.fps, width: window.__film.width, height: window.__film.height, cues: window.__film.cues }) : setTimeout(wait, 30)); wait(); })");
  win.setContentSize(info.width, info.height + MARK_ROWS);
  await wc.executeJavaScript("document.fonts.ready.then(() => new Promise((resolve) => { const wait = () => (window.__film.ready() ? resolve(true) : setTimeout(wait, 30)); wait(); }))");
  await sleep(300);

  /** Frame n as painted: asks until the picture that arrives carries n's mark. */
  const frameAt = async (n) => {
    painted = null;
    await wc.executeJavaScript(`window.__film.seek(${n})`);
    // The frame reaches the window a moment after the page drew it; a quiet window is asked to paint again.
    for (const until = Date.now() + 10_000; Date.now() < until;) {
      if (painted) {
        const { bitmap } = painted;
        painted = null;
        const pxW = Math.round(Math.sqrt((bitmap.length / 4) * (info.width / (info.height + MARK_ROWS))));
        const k = pxW / info.width;
        if (markOf(bitmap, pxW, k, info.height) === (n & 4095)) return { bitmap, pxW, pxH: Math.round(info.height * k) };
      }
      const next = new Promise((resolve) => { wake = resolve; });
      if ((await Promise.race([next, sleep(120).then(() => "quiet")])) === "quiet") wc.invalidate();
    }
    throw new Error(`frame ${n} never arrived`);
  };

  fs.mkdirSync(out, { recursive: true });
  const name = `tomrade-promo-${format}-${locale}`;
  if (still !== undefined) {
    for (const second of still.split(",")) {
      const { bitmap, pxW, pxH } = await frameAt(Math.min(info.frames - 1, Math.round(Number(second) * info.fps)));
      const file = path.join(out, `${name}-${second.replace(".", "_")}s.png`);
      fs.writeFileSync(file, nativeImage.createFromBitmap(bitmap.subarray(0, pxW * pxH * 4), { width: pxW, height: pxH }).toPNG());
      console.log(file);
    }
    win.destroy();
    return;
  }

  const [first, last] = (flag("frames") ?? `0-${info.frames - 1}`).split("-").map(Number);
  const scale = Number(flag("scale") ?? 1);
  const file = path.join(out, `${name}.mp4`);
  let ffmpeg = null;
  const started = Date.now();
  for (let n = first; n <= Math.min(last, info.frames - 1); n += 1) {
    const { bitmap, pxW, pxH } = await frameAt(n);
    if (!ffmpeg) {
      ffmpeg = spawn("ffmpeg", [
        "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${pxW}x${pxH}`, "-r", String(info.fps), "-i", "-",
        "-vf", `scale=${info.width * scale}:${info.height * scale}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
        "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-profile:v", "high",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart", file
      ], { stdio: ["pipe", "inherit", "inherit"] });
    }
    if (!ffmpeg.stdin.write(bitmap.subarray(0, pxW * pxH * 4))) await once(ffmpeg.stdin, "drain");
    if ((n - first) % 120 === 0) console.log(`${format} ${locale}: frame ${n} of ${last}, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  ffmpeg.stdin.end();
  const [code] = await once(ffmpeg, "exit");
  if (code !== 0) throw new Error(`ffmpeg left with ${code}`);
  console.log(file);
  win.destroy();
  if (process.argv.includes("--sound") && !flag("frames")) {
    const wav = path.join(out, `${name}.wav`);
    const sounded = path.join(out, `${name}-sound.mp4`);
    fs.writeFileSync(wav, soundtrack(info.cues, info.frames / info.fps));
    const mux = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-i", wav, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", sounded], { stdio: "inherit" });
    if (mux.status !== 0) throw new Error("ffmpeg could not add the soundtrack");
    fs.rmSync(wav);
    console.log(sounded);
  }
}

app.whenReady().then(async () => {
  if (!process.argv.includes("--no-build")) {
    const built = spawnSync("pnpm", ["run", "promo:build"], { cwd: path.join(repo, "packages/ui"), stdio: "inherit" });
    if (built.status !== 0) throw new Error("the promo page did not build");
  }
  for (const format of formats) await film(format);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
