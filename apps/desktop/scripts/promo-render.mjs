/**
 * Films the promos (packages/ui/src/promo): builds their page, draws every frame in a window that is never shown,
 * and hands the frames to ffmpeg with the soundtrack written from the film's own cues (promo-sound.mjs). The page
 * draws a frame from its number alone, and each frame carries its number as a colour the loop reads back, so a frame
 * is taken only once it is the one asked for: a render is repeatable.
 *
 *   pnpm promo                                    every film, both cuts, English, into out/promo/
 *   pnpm promo --film=main,night                  only these films (the page lists them: films.ts)
 *   pnpm promo --format=tall --locale=zh          one cut (wide | tall), one language (en | zh)
 *   pnpm promo --still=12.5,18                    frames of each cut as PNGs, by their second
 *   pnpm promo --frames=300-480 --no-build        a part of it, silent, from the page already built
 *   pnpm promo --look=sunrise                     in Sunrise throughout instead of the night (files end in -sunrise);
 *                                                 --look=dawn draws them in Dawn's warm paper
 *   pnpm promo --silent                           without the soundtrack
 *   pnpm promo --index                            only rewrite out/promo/INDEX.md from what is there
 *
 * A film's renders go in its own folder under out/promo/, by what kind of film it is: 1-launch/ (the launch films,
 * each style in two lengths), 2-stories/ (one story, told whole), 3-features/ (one feature each). INDEX.md there
 * lists every render with its length, and is rewritten after each run. _page/ is the built page, _archive/ is yours.
 *
 * Needs ffmpeg on the PATH. `pnpm promo:preview` plays the page in a browser (?film=main, ?format=tall, ?lang=zh,
 * space, arrows).
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
const page = path.join(repo, "out/promo/_page/promo.html");
const formats = flag("format") ? [flag("format")] : ["wide", "tall"];
const locale = flag("locale") ?? "en";
const still = flag("still");
/** The look to draw in (packages/ui/src/promo/look.ts), when not the films' own night. */
const look = flag("look");
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

/** The films the page knows. */
async function filmsOf() {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(page, { query: { capture: "1" } });
  const films = await win.webContents.executeJavaScript("new Promise((resolve) => { const wait = () => (window.__film ? resolve(window.__film.films) : setTimeout(wait, 30)); wait(); })");
  win.destroy();
  return films;
}

async function film(id, format) {
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
  await win.loadFile(page, { query: { capture: "1", film: id, format, lang: locale, ...(look ? { look } : {}) } });
  const info = await wc.executeJavaScript("new Promise((resolve) => { const wait = () => (window.__film ? resolve({ shelf: window.__film.shelf, formats: window.__film.formats, poster: window.__film.poster, frames: window.__film.frames, fps: window.__film.fps, width: window.__film.width, height: window.__film.height, cues: window.__film.cues, song: window.__film.song }) : setTimeout(wait, 30)); wait(); })");
  if (!info.formats.includes(format)) {
    console.log(`${id} has no ${format} cut yet`);
    win.destroy();
    return;
  }
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

  // Its own folder, unless the run was told where to put things.
  const to = flag("out") ? out : path.join(out, info.shelf);
  fs.mkdirSync(to, { recursive: true });
  const png = ({ bitmap, pxW, pxH }) => nativeImage.createFromBitmap(bitmap.subarray(0, pxW * pxH * 4), { width: pxW, height: pxH }).toPNG();
  const name = `tomrade-${id}-${format}-${locale}${look ? `-${look}` : ""}`;
  if (still !== undefined) {
    for (const second of still.split(",")) {
      const file = path.join(to, `${name}-${second.replace(".", "_")}s.png`);
      fs.writeFileSync(file, png(await frameAt(Math.min(info.frames - 1, Math.round(Number(second) * info.fps)))));
      console.log(file);
    }
    win.destroy();
    return;
  }

  if (!flag("frames")) fs.writeFileSync(path.join(to, `${name}-poster.png`), png(await frameAt(info.poster)));
  const [first, last] = (flag("frames") ?? `0-${info.frames - 1}`).split("-").map(Number);
  const scale = Number(flag("scale") ?? 1);
  const file = path.join(to, `${name}.mp4`);
  const sound = !process.argv.includes("--silent") && !flag("frames");
  const picture = sound ? path.join(to, `${name}.picture.mp4`) : file;
  let ffmpeg = null;
  const started = Date.now();
  for (let n = first; n <= Math.min(last, info.frames - 1); n += 1) {
    const { bitmap, pxW, pxH } = await frameAt(n);
    if (!ffmpeg) {
      ffmpeg = spawn("ffmpeg", [
        "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${pxW}x${pxH}`, "-r", String(info.fps), "-i", "-",
        "-vf", `scale=${info.width * scale}:${info.height * scale}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
        "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-profile:v", "high",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart", picture
      ], { stdio: ["pipe", "inherit", "inherit"] });
    }
    if (!ffmpeg.stdin.write(bitmap.subarray(0, pxW * pxH * 4))) await once(ffmpeg.stdin, "drain");
    if ((n - first) % 300 === 0) console.log(`${id} ${format} ${locale}: frame ${n} of ${last}, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  ffmpeg.stdin.end();
  const [code] = await once(ffmpeg, "exit");
  if (code !== 0) throw new Error(`ffmpeg left with ${code}`);
  win.destroy();
  if (sound) {
    const wav = path.join(to, `${name}.wav`);
    fs.writeFileSync(wav, soundtrack(info.cues, info.frames / info.fps, info.song));
    const mux = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", picture, "-i", wav, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", file], { stdio: "inherit" });
    if (mux.status !== 0) throw new Error("ffmpeg could not add the soundtrack");
    fs.rmSync(wav);
    fs.rmSync(picture);
  }
  console.log(file);
}

const SHELVES = [
  ["1-launch", "Launch films", "One film that says what Tomrade is and shows its core features, then asks for the download. Each style comes short and long (`-60`)."],
  ["2-stories", "Stories", "One film, one whole story, each told its own way."],
  ["3-features", "Feature films", "One feature each: for posting one at a time, or beside the matching section of the site."]
];

/** Writes INDEX.md: every render under the output folder, by shelf and film, with its length. */
function index() {
  const lines = ["# Promo films", "", "Rewritten by `pnpm promo` after every run. `_archive/` holds what you set aside; `_page/` is the page the films are drawn from.", ""];
  for (const [shelf, title, about] of SHELVES) {
    const dir = path.join(out, shelf);
    if (!fs.existsSync(dir)) continue;
    lines.push(`## ${title} (\`${shelf}/\`)`, "", about, "", "| Film | Cut | Language | Look | Length | File |", "|---|---|---|---|---|---|");
    for (const name of fs.readdirSync(dir).sort()) {
      const films = fs.existsSync(path.join(dir, name)) && fs.statSync(path.join(dir, name)).isDirectory() ? fs.readdirSync(path.join(dir, name)).filter((file) => file.endsWith(".mp4") && !file.includes(".picture.")).sort() : [];
      for (const file of films) {
        const [, id, format, locale, , drawn] = file.match(/^tomrade-(.+)-(wide|tall)-([a-z]{2})(-(dawn|sunrise))?\.mp4$/) ?? [];
        if (!id) continue;
        const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(dir, name, file)], { encoding: "utf8" });
        lines.push(`| ${id} | ${format} | ${locale} | ${drawn ?? "night"} | ${Math.round(Number(probe.stdout))} s | \`${shelf}/${name}/${file}\` |`);
      }
    }
    lines.push("");
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "INDEX.md"), lines.join("\n"));
  console.log(path.join(out, "INDEX.md"));
}

app.whenReady().then(async () => {
  if (process.argv.includes("--index")) {
    index();
    app.quit();
    return;
  }
  if (!process.argv.includes("--no-build")) {
    const built = spawnSync("pnpm", ["run", "promo:build"], { cwd: path.join(repo, "packages/ui"), stdio: "inherit" });
    if (built.status !== 0) throw new Error("the promo page did not build");
  }
  const known = await filmsOf();
  const films = flag("film")?.split(",") ?? known;
  const unknown = films.filter((id) => !known.includes(id));
  if (unknown.length) throw new Error(`no such film: ${unknown.join(", ")} (there are ${known.join(", ")})`);
  for (const id of films) for (const format of formats) await film(id, format);
  if (!flag("out") && still === undefined && !flag("frames")) index();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
