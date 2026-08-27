import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "./boot.js";
import { createWindow } from "./window.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const patchFlag = argv.indexOf("--patch");

app.whenReady().then(async () => {
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

  const open = () =>
    createWindow(ctx, {
      preload: path.join(here, "../preload.cjs"),
      uiIndex: path.join(here, "../../../packages/ui/dist/index.html"),
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
