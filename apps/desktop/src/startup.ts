import fs from "node:fs";
import { app, BrowserWindow, dialog, nativeTheme, Notification } from "electron";
import { DESKTOP_WORDS } from "./words.js";
import { errorMessage } from "@tomradex/contracts";

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

/** How long the start waits for its splash to paint before getting on without it. */
const PAINT_WAIT_MS = 2000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A small window from the first moment. Reading the login shell can take
 * seconds, the plugins load after it, and the main window opens only then:
 * until it does the person would otherwise see nothing, and launch again to no effect.
 *
 * It waits for its own page: the boot work behind it keeps the renderer from painting
 * for seconds, and until then the window holds nothing but its background colour.
 */
export async function showSplash(icon: string): Promise<BrowserWindow> {
  const dark = nativeTheme.shouldUseDarkColors;
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
  await Promise.race([
    win.loadURL(splashPage(icon, words()("starting"))).catch(() => undefined),
    new Promise((done) => setTimeout(done, PAINT_WAIT_MS))
  ]);
  return win;
}

/** The splash says the start waits on the system's keyring dialog, which may sit behind other windows. */
export function splashWaitsForKeyring(win: BrowserWindow, icon: string): void {
  if (win.isDestroyed()) return;
  void win.loadURL(splashPage(icon, words()("keyringWaiting"))).catch(() => undefined);
}

/** The splash's page, as a data: URL; the window runs no script, so new words come as a new page. */
function splashPage(icon: string, text: string): string {
  const dark = nativeTheme.shouldUseDarkColors;
  // The file's own bytes, base64: decoding the icon in the main process drew no
  // logo on Windows, only its white plate.
  let logo = "";
  try {
    const bytes = fs.readFileSync(icon);
    // Read empty, or not a PNG at all: an img with nothing to draw is the white plate again.
    if (bytes.length > PNG.length && bytes.subarray(0, PNG.length).equals(PNG)) {
      logo = `<img src="data:image/png;base64,${bytes.toString("base64")}" width="64" height="64" alt="">`;
    }
  } catch {
    // No icon to draw; the window still says what it is doing.
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Tomrade</title><style>
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font:13px system-ui,-apple-system,"Segoe UI",sans-serif;color:${dark ? "#e8e8e8" : "#1f1f1f"};cursor:default;user-select:none;-webkit-app-region:drag}
p{margin:0 24px;opacity:.65;text-align:center}
img{background:#fff;border-radius:16px;padding:6px}
</style>${logo}<p>${text}</p>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * A start that failed says so, and the caller then quits: left running with
 * no window, the process would also swallow every later launch, which only
 * hands over to it. True when the person takes one start without their own files.
 */
export async function startFailed(error: unknown, opts: { logDir: string; retry: boolean }): Promise<boolean> {
  const w = words();
  const message = errorMessage(error);
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
