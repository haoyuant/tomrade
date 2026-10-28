import { app, BrowserWindow } from "electron";
import type { Context } from "cordis";

/** A window counts as seen while it is shown and not minimized; covered by other apps' windows still counts. */
export const anySeen = (windows: Pick<BrowserWindow, "isDestroyed" | "isVisible" | "isMinimized">[]): boolean =>
  windows.some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized());

/**
 * Says `desktop/seen` whenever whether any of the app's windows can be seen changes, so background work (the code
 * scan, sync) can slow down while nobody looks. A window event that never comes leaves it saying seen: the old pace.
 */
export function watchSeen(ctx: Context): void {
  let seen = true;
  const check = () =>
    // A window that is closing still answers for itself on this tick.
    setImmediate(() => {
      const now = anySeen(BrowserWindow.getAllWindows());
      if (now === seen) return;
      seen = now;
      ctx.emit("desktop/seen", now);
    });
  const watch = (win: BrowserWindow) => {
    for (const event of ["show", "hide", "minimize", "restore", "closed"] as const) win.on(event as "show", check);
  };
  for (const win of BrowserWindow.getAllWindows()) watch(win);
  app.on("browser-window-created", (_event, win) => {
    watch(win);
    check();
  });
  check();
}
