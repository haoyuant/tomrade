import { app, BrowserWindow, dialog, nativeImage, nativeTheme, Notification } from "electron";
import { DESKTOP_WORDS } from "./words.js";

// Before boot there are no settings to ask: the system's language.
const words = () => DESKTOP_WORDS(app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en");

/** The last start never got as far as its window: offer one start without the person's own files. True when they take it. */
export async function offerSafeStart(opts: { logDir: string }): Promise<boolean> {
  const w = words();
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Tomrade",
    message: w("startUnfinished"),
    detail: [w("startUnfinishedHint"), w("startLog", { dir: opts.logDir })].join("\n\n"),
    buttons: [w("startWithout"), w("startNormally")],
    defaultId: 0,
    cancelId: 1
  });
  return response === 0;
}

/** A safe start says so once, so nobody wonders where their plugins went. */
export function saySafeStart(): void {
  if (!Notification.isSupported()) return;
  const w = words();
  new Notification({ title: w("startedSafe"), body: w("startedSafeBody"), silent: true }).show();
}

/**
 * A small window from the first moment. Reading the login shell can take
 * seconds, the plugins load after it, and the main window opens only then:
 * until it does the person would otherwise see nothing, and launch again to no effect.
 */
export function showSplash(icon: string): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors;
  const image = nativeImage.createFromPath(icon);
  const logo = image.isEmpty() ? "" : `<img src="${image.resize({ width: 128 }).toDataURL()}" width="64" height="64" alt="">`;
  const html = `<!doctype html><meta charset="utf-8"><title>Tomrade</title><style>
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font:13px system-ui,-apple-system,"Segoe UI",sans-serif;color:${dark ? "#e8e8e8" : "#1f1f1f"};cursor:default;user-select:none;-webkit-app-region:drag}
p{margin:0;opacity:.65}
img{background:#fff;border-radius:16px;padding:6px}
</style>${logo}<p>${words()("starting")}</p>`;
  const win = new BrowserWindow({
    width: 320,
    height: 200,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Tomrade",
    // Shown at once in the page's own colour: waiting for its first paint could show it after a failure hid it.
    backgroundColor: dark ? "#1e1e1e" : "#ffffff",
    webPreferences: { javascript: false, sandbox: true }
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

/**
 * A start that failed says so, and the caller then quits: left running with
 * no window, the process would also swallow every later launch, which only
 * hands over to it. True when the person takes one start without their own files.
 */
export async function startFailed(error: unknown, opts: { logDir: string; retry: boolean }): Promise<boolean> {
  const w = words();
  const message = error instanceof Error ? error.message : String(error);
  const reason = message.length > 800 ? `${message.slice(0, 800)}…` : message;
  // Started at login the app is not in front, and the box must still be seen.
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: "Tomrade",
    message: w("startFailed"),
    detail: [
      reason,
      w("startLog", { dir: opts.logDir }),
      ...(opts.retry ? [w("startWithoutHint")] : [])
    ].join("\n\n"),
    buttons: opts.retry ? [w("startWithout"), w("quit")] : [w("quit")],
    defaultId: 0,
    cancelId: opts.retry ? 1 : 0
  });
  return opts.retry && response === 0;
}
