import { createRequire } from "node:module";
import { release } from "node:os";
import { nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions } from "electron";

// Acrylic as a system backdrop arrived with Windows 11 22H2 (build 22621); older builds ignore it.
const acrylic = process.platform === "win32" && Number(release().split(".")[2]) >= 22621;
// Before it DWM still blurs behind a window that asks (SetWindowCompositionAttribute), but a page shows through only a
// window born transparent, and Electron gives such a window no frame: no edge to resize by, no title bar, no menu bar.
const blurBehind = process.platform === "win32" && !acrylic;

/** Each window that takes the material, and how to tell its page whether it wears it now. */
const windows = new Map<BrowserWindow, () => void>();
let frosted = false;
// What a window shows under its page once the material is off again: the theme's ground.
let solid = "#ffffff";
// Windows 10: whether this run's windows are born transparent, which they are for all their life. The first look the
// shell hears of decides: the last run's, when it kept one.
let clear: boolean | undefined;
// DWM turned the blur away: those windows paint the room for the rest of the run.
let refused = false;

/**
 * Glass on macOS, on Windows 11 22H2+, and on older Windows when Glass was on as the app started: Tomrade's windows
 * wear the system's own frosted material (HUD vibrancy, Acrylic, DWM's acrylic blur), so the desktop and the windows
 * behind show through, blurred by the system rather than by the page. Elsewhere the page paints its own room, as it did.
 */
const canFrost = (): boolean => process.platform === "darwin" || acrylic || (clear === true && !refused);

/** Whether `win` wears the material now: its page then leaves its own background off. */
export const isFrosted = (win: BrowserWindow): boolean => frosted && windows.has(win);

const WCA_ACCENT_POLICY = 19;
const ACCENT_DISABLED = 0;
const ACCENT_ENABLE_BLURBEHIND = 3;
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
// The tint (GradientColor) applies only with this flag.
const ACCENT_TINTED = 2;
const WM_ENTERSIZEMOVE = 0x0231;
const WM_EXITSIZEMOVE = 0x0232;
/** As tall as Windows 10's own caption, which the overlay's buttons replace. */
const CAPTION_HEIGHT = 32;

type Accent = (win: BrowserWindow, state: number, tint: number) => boolean;
let accentBinding: Accent | null | undefined;

/** SetWindowCompositionAttribute, undocumented and so reached through koffi; null where it cannot be loaded. */
function accent(): Accent | null {
  if (accentBinding !== undefined) return accentBinding;
  try {
    const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
    const policyType = koffi.struct({ AccentState: "int", AccentFlags: "int", GradientColor: "uint32", AnimationId: "int" });
    const dataType = koffi.struct({ Attribute: "int", Data: "void *", SizeOfData: "size_t" });
    const set = koffi.load("user32.dll").func("__stdcall", "SetWindowCompositionAttribute", "int", ["intptr_t", koffi.pointer(dataType)]);
    const policy: unknown = koffi.alloc(policyType, 1);
    accentBinding = (win, state, tint) => {
      try {
        const handle = win.getNativeWindowHandle();
        koffi.encode(policy, policyType, { AccentState: state, AccentFlags: ACCENT_TINTED, GradientColor: tint, AnimationId: 0 });
        return set(handle.length === 8 ? handle.readBigInt64LE() : handle.readInt32LE(), { Attribute: WCA_ACCENT_POLICY, Data: policy, SizeOfData: koffi.sizeof(policyType) }) !== 0;
      } catch {
        return false;
      }
    };
  } catch {
    accentBinding = null;
  }
  return accentBinding;
}

/** The theme's ground as red, green and blue; Glass's own when it is not a hex colour. */
function rgb(color: string): [number, number, number] {
  let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1] ?? "2b2826";
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** DWM tints the blur with the ground, as 0xAABBGGRR: dark enough under Glass for its light text to read. */
function tint(): number {
  const [r, g, b] = rgb(solid);
  return (0xa0 << 24 | b << 16 | g << 8 | r) >>> 0;
}

/** The caption buttons the overlay draws read on the ground: light on a dark one. */
function symbols(): string {
  const [r, g, b] = rgb(solid);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "#ffffff" : "#000000";
}

/**
 * Whether a window must be born for the material (Windows 10): then only a page that keeps a caption strip at its top
 * (`env(titlebar-area-height)`, draggable) can wear it, as its window has no frame.
 */
export function bornForMaterial(): boolean {
  clear ??= false;
  return clear;
}

/** What a window takes at its birth to be able to wear the material later: on Windows 10, transparency and caption buttons over its page. */
export function materialOptions(): BrowserWindowConstructorOptions {
  if (!bornForMaterial()) return {};
  return { transparent: true, backgroundColor: "#00000000", titleBarStyle: "hidden", titleBarOverlay: { color: "#00000000", symbolColor: symbols(), height: CAPTION_HEIGHT } };
}

/** Puts the material on or off `win`; false when the system turned it away. */
function wear(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return true;
  // The HUD material stays dark whatever the system's appearance, as Glass is: light text reads on it either way.
  if (process.platform === "darwin") win.setVibrancy(frosted ? "hud" : null);
  else if (acrylic) win.setBackgroundMaterial(frosted ? "acrylic" : "auto");
  else if (clear) {
    win.setTitleBarOverlay({ symbolColor: symbols() });
    const worn = accent()?.(win, frosted ? ACCENT_ENABLE_ACRYLICBLURBEHIND : ACCENT_DISABLED, tint()) ?? false;
    if (frosted && !worn) return false;
  }
  win.setBackgroundColor(frosted ? "#00000000" : solid);
  return true;
}

/** Puts the material on or off every window, as `frosted` says, and tells each page; off everywhere if one turns it away. */
function wearAll(): void {
  if ([...windows.keys()].some((win) => !wear(win))) {
    frosted = false;
    refused = true;
    for (const win of windows.keys()) wear(win);
  }
  for (const tell of windows.values()) tell();
}

/** A window that wears the material while Glass is on; `tell` says so to its page again. */
export function takesMaterial(win: BrowserWindow, tell: () => void): void {
  windows.set(win, tell);
  win.once("closed", () => windows.delete(win));
  if (clear) {
    // Acrylic blur trails the window while it is dragged on some Windows 10 builds; plain blur keeps up.
    win.hookWindowMessage(WM_ENTERSIZEMOVE, () => {
      if (frosted) accent()?.(win, ACCENT_ENABLE_BLURBEHIND, tint());
    });
    win.hookWindowMessage(WM_EXITSIZEMOVE, () => {
      if (frosted) accent()?.(win, ACCENT_ENABLE_ACRYLICBLURBEHIND, tint());
    });
  }
  if (frosted && !wear(win)) wearAll();
}

/** The main window's renderer says the look: frosted or not, and the theme's ground. */
export function setFrosted(want: boolean, ground: string | undefined): void {
  if (ground) solid = ground;
  // Only Glass needs the binding: it is loaded for none other.
  if (blurBehind && clear === undefined) clear = want && accent() !== null;
  const next = canFrost() && want;
  if (next === frosted) return;
  frosted = next;
  // Acrylic tints by the window's dark mode, which follows nativeTheme; Glass is a dark theme.
  if (acrylic) nativeTheme.themeSource = frosted ? "dark" : "system";
  wearAll();
}
