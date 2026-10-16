import type { BrowserWindow } from "electron";

/**
 * Who opens Tomrade's own window. `main.ts` provides it; anything that has to
 * show the person something — a notification click, the tray — asks here, as
 * with the app running in the background there may be no window to find.
 */
let opener: { open(): BrowserWindow; current(): BrowserWindow | undefined } | null = null;

export function provideMainWindow(provider: NonNullable<typeof opener>): void {
  opener = provider;
}

export const hasMainWindow = (): boolean => !!opener?.current();

/** The main window brought forward, opened first when there is none. Null before main.ts provides one. */
export function showMainWindow(): BrowserWindow | null {
  if (!opener) return null;
  const win = opener.current() ?? opener.open();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

/** Runs once the renderer can hear a broadcast: now for a loaded window, after the load for a new one. */
export function whenLoaded(win: BrowserWindow, then: () => void): void {
  if (!win.webContents.isLoading()) then();
  // A beat after the load, so the renderer's own subscriptions are in place.
  else win.webContents.once("did-finish-load", () => setTimeout(then, 500));
}
