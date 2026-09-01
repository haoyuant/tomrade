import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {} from "@tomrade/storage";
import { boot } from "./boot.js";
import { createWindow } from "./window.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const patchFlag = argv.indexOf("--patch");

const iconPath = path.join(here, "../assets/icon.png");

app.whenReady().then(async () => {
  // BrowserWindow's `icon` option is a no-op for the Dock on macOS since dev mode
  // runs Electron's own bundled app; the Dock icon has to be set explicitly.
  if (process.platform === "darwin") app.dock?.setIcon(iconPath);

  const userData = app.getPath("userData");
  const { ctx, dump } = await boot({
    configFile: path.join(here, "../tomrade.yml"),
    patchFiles: [path.join(userData, "tomrade.patch.yml"), ...(patchFlag >= 0 ? [argv[patchFlag + 1]] : [])],
    vars: { userData }
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
    const storage = ctx.get("storage");
    if (flushed || !storage) return;
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
      uiIndex: path.join(here, "../../../packages/ui/dist/index.html"),
      icon: iconPath,
      devServerUrl: process.env.VITE_DEV_SERVER_URL
    });
  open();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) open();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
