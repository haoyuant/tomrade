/**
 * Launching Tomrade again brings its window forward (TOM-504), through the
 * real single-instance lock and a real second process on this platform:
 * - a launch while the first one still boots is answered once it has a window;
 * - with the last window closed and the app running on, a launch opens one,
 *   a plugin's own window up or not;
 * - a minimized window comes back restored;
 * - a quit a window calls off hands the windows back, so a launch is not
 *   ignored as one arriving mid-quit (takes about 15s).
 *
 *   pnpm build:backend   then
 *   pnpm --filter @tomrade/desktop test:second-instance
 */
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askForMainWindow, provideMainWindow } from "../dist/main-window.js";
import { finishQuit, leaving, prepareToQuit } from "../dist/quit.js";

const script = fileURLToPath(import.meta.url);
const second = process.argv.indexOf("--second");
const work = second > 0 ? process.argv[second + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-second-instance-"));
app.setPath("userData", work);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};
const finish = () => {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.rmSync(work, { recursive: true, force: true });
  app.exit(failed.length ? 1 : 0);
};

/** Another launch on the same data folder, as a double-click on the shortcut starts one; resolves once it has gone. */
const launchAgain = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--second", work], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code));
  });
const waitFor = async (cond, ms = 3000) => {
  for (let waited = 0; waited < ms; waited += 50) {
    if (cond()) return true;
    await sleep(50);
  }
  return false;
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // As main.ts: listened for from the first moment, before anything has booted.
  app.on("second-instance", () => {
    if (!leaving()) askForMainWindow();
  });
  // The app runs on with no window, as with background running on.
  app.on("window-all-closed", () => {});
  const mains = new Set();
  const open = () => {
    const win = new BrowserWindow({ width: 800, height: 600, title: "Tomrade" });
    mains.add(win);
    win.on("closed", () => mains.delete(win));
    void win.loadURL("data:text/html,<h1>Tomrade</h1>");
    return win;
  };
  const lead = () => [...mains].find((w) => !w.isDestroyed());
  const shown = () => {
    const win = lead();
    return !!win && win.isVisible() && !win.isMinimized();
  };

  app.whenReady().then(async () => {
    // Still booting: no window to show yet.
    check("the second launch exits at once", (await launchAgain()) === 0);
    await sleep(300);
    check("nothing opens before the first launch can show it", mains.size === 0);
    provideMainWindow({ open, current: lead });
    check("a launch during boot is answered once the window is provided", await waitFor(shown), mains.size);

    for (const win of [...mains]) win.close();
    await waitFor(() => mains.size === 0);
    await launchAgain();
    check("with the last window closed, a launch opens one", await waitFor(shown), mains.size);

    const plugin = new BrowserWindow({ width: 400, height: 300, title: "Terminal" });
    void plugin.loadURL("data:text/html,<h1>Terminal</h1>");
    for (const win of [...mains]) win.close();
    await waitFor(() => mains.size === 0);
    await launchAgain();
    check("and with a plugin's own window still up, it opens Tomrade's, not the plugin's", await waitFor(shown) && lead() !== plugin, mains.size);
    plugin.destroy();

    lead().minimize();
    await waitFor(() => lead().isMinimized());
    await launchAgain();
    check("a minimized window comes back restored", await waitFor(shown), { minimized: lead().isMinimized() });
    check("without a second window", mains.size === 1, mains.size);

    // A window that cannot close calls off a quit, as a stuck surface would.
    const stuck = new BrowserWindow({ width: 300, height: 200, closable: false, title: "stuck" });
    void stuck.loadURL("data:text/html,stuck");
    let quitWent = false;
    app.once("will-quit", (event) => {
      quitWent = true;
      event.preventDefault();
      console.log("NOTE: this platform did not call the quit off; the called-off checks are moot here");
      stuck.destroy();
      finish();
    });
    check("the quit is approved", await prepareToQuit({ get: () => undefined }));
    finishQuit();
    await sleep(500);
    if (quitWent) return;
    await launchAgain();
    await sleep(500);
    check("a launch while the quit is under way is left alone", !shown());
    check("once the quit has been called off, the app is no longer leaving", await waitFor(() => !leaving(), 20_000));
    await launchAgain();
    check("and the next launch brings the window forward", await waitFor(shown), mains.size);
    stuck.setClosable(true);
    stuck.destroy();
    finish();
  }).catch((e) => {
    console.error(e);
    app.exit(1);
  });
}
