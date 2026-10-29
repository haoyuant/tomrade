import { app, type BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Glass frosts for real where the system blurs what is behind a window, so the desktop and the windows
 * behind show through: macOS with its own material, and KDE under X11, where KWin blurs behind a
 * see-through window that asks. Chromium can't ask KWin under Wayland. Elsewhere the page paints its own room.
 */
const kwinBlur = process.platform === "linux" && /\bKDE\b/i.test(process.env.XDG_CURRENT_DESKTOP ?? "") && drawsThroughX11() && onPath("xprop");
export const canFrost = process.platform === "darwin" || kwinBlur;
/** Linux makes a window see-through only when it is created, so where KWin may frost, every window is. */
export const seeThrough = kwinBlur;

const BLUR_REGION = "_KDE_NET_WM_BLUR_BEHIND_REGION";
// KWin only blurs; the window darkens what it blurs as the HUD material does on macOS, so light text reads.
const KWIN_TINT = "#a61d1b19";

/** Each window that takes the material, and how to tell its page whether it wears it now. */
const windows = new Map<BrowserWindow, () => void>();
let frosted = false;
// What a window shows under its page once the material is off again: the theme's ground.
let solid = "#ffffff";

export const isFrosted = (): boolean => frosted;

function wear(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (kwinBlur) {
    win.setBackgroundColor(frosted ? KWIN_TINT : solid);
    blurBehind(win, frosted);
    return;
  }
  // The HUD material stays dark whatever the system's appearance, as Glass is: light text reads on it either way.
  win.setVibrancy(frosted ? "hud" : null);
  win.setBackgroundColor(frosted ? "#00000000" : solid);
}

/** A window that wears the material while Glass is on; `tell` says so to its page again. */
export function takesMaterial(win: BrowserWindow, tell: () => void): void {
  windows.set(win, tell);
  win.once("closed", () => windows.delete(win));
  if (frosted) wear(win);
  else if (seeThrough) win.setBackgroundColor(solid);
}

/** The main window's renderer says the look: frosted or not, and the theme's ground. */
export function setFrosted(want: boolean, ground: string | undefined): void {
  if (ground) solid = ground;
  const next = canFrost && want;
  if (next === frosted) return;
  frosted = next;
  for (const [win, tell] of windows) {
    wear(win);
    tell();
  }
}

/** Asks KWin to blur behind the whole window (a region of no rectangles), or to stop. */
function blurBehind(win: BrowserWindow, on: boolean): void {
  const handle = win.getNativeWindowHandle();
  const id = String(handle.length >= 8 ? handle.readBigUInt64LE() : handle.readUInt32LE());
  const change = on ? ["-f", BLUR_REGION, "32c", "-set", BLUR_REGION, "0"] : ["-remove", BLUR_REGION];
  execFile("xprop", ["-id", id, ...change], () => {});
}

/** Whether Chromium draws through X11: asked to, or no Wayland compositor for it to prefer. */
function drawsThroughX11(): boolean {
  const asked = app.commandLine.getSwitchValue("ozone-platform") || app.commandLine.getSwitchValue("ozone-platform-hint") || process.env.ELECTRON_OZONE_PLATFORM_HINT;
  if (asked && asked !== "auto") return asked === "x11";
  return !process.env.WAYLAND_DISPLAY;
}

function onPath(name: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir !== "" && fs.existsSync(path.join(dir, name)));
}
