import { app, BrowserWindow, dialog } from "electron";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {} from "@tomrade/agent";
import type {} from "@tomrade/storage";
import { boot } from "./boot.js";
import { registerExtensionResolution } from "./extension-resolve.js";
import { trustedKeys } from "./trust.js";
import { createWindow } from "./window.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const patchFlag = argv.indexOf("--patch");

const iconPath = path.join(here, "../assets/icon.png");

// A second checkout can run beside the real one without sharing — or migrating — its database.
if (process.env.TOMRADE_USER_DATA) app.setPath("userData", path.resolve(process.env.TOMRADE_USER_DATA));

// Everything under the app's own roots resolves as usual; anything else is an extension.
registerExtensionResolution([path.resolve(here, "../../.."), app.getAppPath()]);

app.whenReady().then(async () => {
  // BrowserWindow's `icon` option is a no-op for the Dock on macOS since dev mode
  // runs Electron's own bundled app; the Dock icon has to be set explicitly.
  if (process.platform === "darwin") app.dock?.setIcon(iconPath);

  const userData = app.getPath("userData");
  // A separate checkout keeps its own extensions, as it keeps its own database.
  const tomradeDir = process.env.TOMRADE_USER_DATA ? userData : path.join(os.homedir(), "Tomrade");
  const pluginsRoot = process.env.TOMRADE_PLUGINS_DIR ?? path.join(tomradeDir, "plugins");
  const pluginsDevRoot = path.join(tomradeDir, "plugins-dev");
  const { ctx, dump } = await boot({
    configFile: path.join(here, "../tomrade.yml"),
    patchFiles: [path.join(userData, "tomrade.patch.yml"), ...(patchFlag >= 0 ? [argv[patchFlag + 1]] : [])],
    vars: { userData, pluginsRoot, pluginsDevRoot },
    extensions: { root: pluginsRoot, trustedKeys: trustedKeys() }
  });

  if (argv.includes("--dump-config")) {
    process.stdout.write(dump());
    app.exit(0);
    return;
  }

  // A write never waits on a push, so the last quiet window has to be published
  // on the way out — with a deadline, because quitting must not hang on a remote.
  let flushed = false;
  app.on("before-quit", (event) => {
    if (flushed) return;
    // A coding run in flight dies with the process. Its session is kept and the
    // ticket offers Continue afterwards, but the person decides — no daemon.
    const active = ctx.get("agent")?.activeRuns() ?? [];
    if (active.length) {
      const code = active.filter((a) => a.thread.itemId).length;
      const choice = dialog.showMessageBoxSync({
        type: "warning",
        buttons: ["Quit", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: `${active.length} agent run${active.length === 1 ? " is" : "s are"} in progress`,
        detail: code ? `${code} of them implement${code === 1 ? "s" : ""} a ticket. Quitting interrupts them; each ticket keeps its branch and offers Continue.` : "Quitting interrupts them."
      });
      if (choice === 1) {
        event.preventDefault();
        return;
      }
    }
    const storage = ctx.get("storage");
    if (!storage) return;
    event.preventDefault();
    const done = () => {
      flushed = true;
      app.quit();
    };
    void Promise.race([storage.flushAll("quit"), new Promise((resolve) => setTimeout(resolve, 5_000))]).then(done, done);
  });

  const open = () =>
    createWindow(ctx, {
      preload: path.join(here, "../preload.cjs"),
      // A packaged build carries the renderer beside dist/; a checkout builds it in packages/ui.
      uiIndex: app.isPackaged ? path.join(here, "../ui/index.html") : path.join(here, "../../../packages/ui/dist/index.html"),
      icon: iconPath,
      devServerUrl: process.env.VITE_DEV_SERVER_URL
    });
  const mainWindows = new Set<BrowserWindow>();
  const openMain = () => {
    const win = open();
    mainWindows.add(win);
    win.on("closed", () => mainWindows.delete(win));
    return win;
  };
  openMain();
  app.on("activate", () => {
    // Auxiliary plugin surfaces are top-level BrowserWindows too; only a real
    // Tomrade window satisfies application activation.
    if (![...mainWindows].some((win) => !win.isDestroyed())) openMain();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
