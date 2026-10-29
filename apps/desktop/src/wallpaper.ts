import { nativeImage } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

let kept: { file: string; url: string | null } | null = null;

/**
 * Glass's room on Linux where the window can't frost: the desktop's own wallpaper, shrunk and blurred,
 * as a data URL the page scales back up. GNOME (and the desktops on its settings) and KDE Plasma name it;
 * elsewhere there is none and the page paints its made-up room.
 */
export async function wallpaperRoom(): Promise<string | null> {
  const file = await wallpaperFile().catch(() => null);
  if (!file) return null;
  if (kept?.file !== file) kept = { file, url: soften(file) };
  return kept.url;
}

async function wallpaperFile(): Promise<string | null> {
  const desktop = process.env.XDG_CURRENT_DESKTOP ?? "";
  if (/\bKDE\b/i.test(desktop)) return plasmaWallpaper();
  if (!/GNOME|Unity|Budgie|Pantheon/i.test(desktop)) return null;
  const dark = (await gsetting("org.gnome.desktop.interface", "color-scheme")) === "prefer-dark";
  const uri = (dark && (await gsetting("org.gnome.desktop.background", "picture-uri-dark"))) || (await gsetting("org.gnome.desktop.background", "picture-uri"));
  // An .xml is a slideshow, not a picture.
  return uri.startsWith("file://") && !uri.endsWith(".xml") ? fileURLToPath(uri) : null;
}

async function gsetting(schema: string, key: string): Promise<string> {
  try {
    const { stdout } = await run("gsettings", ["get", schema, key], { timeout: 2000 });
    // A string comes back in GVariant's quotes.
    return stdout.trim().replace(/^'(.*)'$/, "$1");
  } catch {
    return "";
  }
}

/** The first desktop's picture in Plasma's config, else Plasma's own default. */
function plasmaWallpaper(): string | null {
  const config = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "plasma-org.kde.plasma.desktop-appletsrc");
  let text = "";
  try {
    text = fs.readFileSync(config, "utf8");
  } catch {
    // No config yet: Plasma shows its default.
  }
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("[")) section = line;
    else if (section.endsWith("[Wallpaper][org.kde.image][General]") && line.startsWith("Image=")) {
      const image = line.slice("Image=".length).trim();
      return pictureOf(image.startsWith("file://") ? fileURLToPath(image) : image);
    }
  }
  return pictureOf("/usr/share/wallpapers/Next");
}

/** A picture, or the largest picture of a wallpaper package (a folder of sizes under contents/images). */
function pictureOf(target: string): string | null {
  let images: string[];
  try {
    if (!fs.statSync(target).isDirectory()) return target;
    images = fs.readdirSync(path.join(target, "contents/images"));
  } catch {
    return null;
  }
  const pixels = (name: string) => /^(\d+)x(\d+)\./.exec(name)?.slice(1).reduce((a, b) => a * Number(b), 1) ?? 0;
  const largest = images.filter((name) => /\.(png|jpe?g)$/i.test(name)).sort((a, b) => pixels(b) - pixels(a))[0];
  return largest ? path.join(target, "contents/images", largest) : null;
}

/** Shrunk to a few dozen pixels and blurred there: scaled back up by the page, it is the room out of focus. */
function soften(file: string): string | null {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return null;
  const small = image.resize({ width: 64, quality: "better" });
  const { width, height } = small.getSize();
  const pixels = small.toBitmap();
  for (let pass = 0; pass < 3; pass++) {
    boxBlur(pixels, height, width, (line, i) => (line * width + i) * 4);
    boxBlur(pixels, width, height, (line, i) => (i * width + line) * 4);
  }
  return nativeImage.createFromBitmap(pixels, { width, height }).toDataURL();
}

/** One box-blur pass along each of `lines` lines of `length` pixels; three passes come close to a Gaussian. */
function boxBlur(pixels: Buffer, lines: number, length: number, at: (line: number, i: number) => number, radius = 2): void {
  const copy = new Float32Array(length * 4);
  for (let line = 0; line < lines; line++) {
    for (let i = 0; i < length; i++) for (let c = 0; c < 4; c++) copy[i * 4 + c] = pixels[at(line, i) + c]!;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += copy[Math.min(length - 1, Math.max(0, i + k)) * 4 + c]!;
        pixels[at(line, i) + c] = Math.round(sum / (2 * radius + 1));
      }
    }
  }
}
