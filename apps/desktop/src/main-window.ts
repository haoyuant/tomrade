import type { BrowserWindow } from "electron";

/**
 * Who opens Tomrade's own window. `main.ts` provides it; anything that has to
 * show the person something — a notification click, the tray — asks here, as
 * with the app running in the background there may be no window to find.
 */
let opener: { open(): BrowserWindow; current(): BrowserWindow | undefined } | null = null;
let asked = false;

/** Called once the start's own window, if any, is open; a launch that came while it booted is answered now. */
export function provideMainWindow(provider: NonNullable<typeof opener>): void {
  opener = provider;
  if (asked) {
    asked = false;
    showMainWindow();
  }
}

/** Another launch of Tomrade asks for the window. Before main.ts provides one it is kept, never dropped. */
export function askForMainWindow(): void {
  if (opener) showMainWindow();
  else asked = true;
}

export const hasMainWindow = (): boolean => !!opener?.current();

/** The window that leads — the oldest open — without bringing it forward. */
export const leadWindow = (): BrowserWindow | undefined => opener?.current();

/** The main window brought forward, opened first when there is none. Null before main.ts provides one. */
export function showMainWindow(): BrowserWindow | null {
  if (!opener) return null;
  const win = opener.current() ?? opener.open();
  if (win.isMinimized()) win.restore();
  win.show();
  // show() alone can leave the window behind the app the launch came from, on Windows above all.
  win.moveTop();
  win.focus();
  return win;
}

/** Runs once the renderer can hear a broadcast: now for a loaded window, after the load for a new one. */
export function whenLoaded(win: BrowserWindow, then: () => void): void {
  if (!win.webContents.isLoading()) then();
  // A beat after the load, so the renderer's own subscriptions are in place.
  else win.webContents.once("did-finish-load", () => setTimeout(then, 500));
}

let keptInFront: BrowserWindow | null = null;

/** A start that opens both: the window a plugin opens next comes up behind this one, which stays in front. Undone by what it returns. */
export function keepInFront(win: BrowserWindow): () => void {
  keptInFront = win;
  return () => {
    if (keptInFront === win) keptInFront = null;
  };
}

/** The window a plugin's window opening now stays behind, asked once by that window. */
export function takeKeptInFront(): BrowserWindow | null {
  const win = keptInFront && !keptInFront.isDestroyed() ? keptInFront : null;
  keptInFront = null;
  return win;
}
