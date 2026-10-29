import type { BrowserWindow } from "electron";

/**
 * Glass on macOS: Tomrade's windows wear the system's own frosted material, so the desktop and the
 * windows behind show through, blurred by the window server rather than by the page. Elsewhere the
 * page paints its own room, as it did.
 */
export const canFrost = process.platform === "darwin";

/** Each window that takes the material, and how to tell its page whether it wears it now. */
const windows = new Map<BrowserWindow, () => void>();
let frosted = false;
// What a window shows under its page once the material is off again: the theme's ground.
let solid = "#ffffff";

export const isFrosted = (): boolean => frosted;

function wear(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  // The HUD material stays dark whatever the system's appearance, as Glass is: light text reads on it either way.
  win.setVibrancy(frosted ? "hud" : null);
  win.setBackgroundColor(frosted ? "#00000000" : solid);
}

/** A window that wears the material while Glass is on; `tell` says so to its page again. */
export function takesMaterial(win: BrowserWindow, tell: () => void): void {
  windows.set(win, tell);
  win.once("closed", () => windows.delete(win));
  if (frosted) wear(win);
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
