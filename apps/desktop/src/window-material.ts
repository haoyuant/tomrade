import { release } from "node:os";
import { nativeTheme, type BrowserWindow } from "electron";

// Acrylic as a system backdrop arrived with Windows 11 22H2 (build 22621); older builds ignore it.
const acrylic = process.platform === "win32" && Number(release().split(".")[2]) >= 22621;

/**
 * Glass on macOS and on Windows 11 22H2+: Tomrade's windows wear the system's own frosted material
 * (HUD vibrancy, Acrylic), so the desktop and the windows behind show through, blurred by the system
 * rather than by the page. Elsewhere the page paints its own room, as it did.
 */
export const canFrost = process.platform === "darwin" || acrylic;

/** Each window that takes the material, and how to tell its page whether it wears it now. */
const windows = new Map<BrowserWindow, () => void>();
let frosted = false;
// What a window shows under its page once the material is off again: the theme's ground.
let solid = "#ffffff";

export const isFrosted = (): boolean => frosted;

function wear(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  // The HUD material stays dark whatever the system's appearance, as Glass is: light text reads on it either way.
  if (process.platform === "darwin") win.setVibrancy(frosted ? "hud" : null);
  else win.setBackgroundMaterial(frosted ? "acrylic" : "auto");
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
  // Acrylic tints by the window's dark mode, which follows nativeTheme; Glass is a dark theme.
  if (acrylic) nativeTheme.themeSource = frosted ? "dark" : "system";
  for (const [win, tell] of windows) {
    wear(win);
    tell();
  }
}
