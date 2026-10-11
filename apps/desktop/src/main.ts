import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aboutInfo } from "./about.js";
import { AccountFolders, machineRoots } from "./accounts.js";
import { boot } from "./boot.js";
import { registerExtensionResolution } from "./extension-resolve.js";
import { prepareToQuit, quitApproved } from "./quit.js";
import { adoptShellEnv } from "./shell-env.js";
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
  // The app menu's About item, which a checkout would otherwise credit to Electron.
  void aboutInfo(path.resolve(here, "../../..")).then((info) =>
    app.setAboutPanelOptions({
      applicationName: "Tomrade",
      applicationVersion: info.version,
      ...(info.commit ? { version: info.commit } : {}),
      copyright: "Copyright © Tomrade",
      website: "https://tomrade.com",
      iconPath
    })
  );

  // Before boot: plugins spawn CLIs (MCP servers, agents, git) from the first moment.
  await adoptShellEnv();

  const machine = machineRoots();
  // Plugins and their switches belong to the machine; projects and settings to the account last signed in.
  const accounts = new AccountFolders(machine);
  const { userData, hubDir } = accounts.dirs(accounts.active);
  const pluginsRoot = process.env.TOMRADE_PLUGINS_DIR ?? path.join(machine.tomradeDir, "plugins");
  const pluginsDevRoot = path.join(machine.tomradeDir, "plugins-dev");
  const { ctx, dump } = await boot({
    configFile: path.join(here, "../tomrade.yml"),
    patchFiles: [path.join(machine.userData, "tomrade.patch.yml"), ...(patchFlag >= 0 ? [argv[patchFlag + 1]] : [])],
    // What a first run is written in, before the person has picked a language.
    vars: { userData, hubDir, pluginsRoot, pluginsDevRoot, locale: app.getLocale() },
    extensions: { root: pluginsRoot, trustedKeys: trustedKeys() }
  });

  if (argv.includes("--dump-config")) {
    process.stdout.write(dump());
    app.exit(0);
    return;
  }

  app.on("before-quit", (event) => {
    if (quitApproved()) return;
    event.preventDefault();
    void prepareToQuit(ctx).then((ok) => ok && app.quit());
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
