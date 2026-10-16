import { app, BrowserWindow, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aboutInfo } from "./about.js";
import { AccountFolders, machineRoots } from "./accounts.js";
import { cameBack, keepsRunning, launchMode, PREFS_FILE, wentAway } from "./background.js";
import { boot } from "./boot.js";
import { deliverDeepLink, registerScheme } from "./deep-link.js";
import { registerExtensionResolution } from "./extension-resolve.js";
import { installAppMenu } from "./menu.js";
import { loginItem } from "./login-item.js";
import { provideMainWindow } from "./main-window.js";
import { leaveOnSignal, leaving, prepareToQuit, quitApproved } from "./quit.js";
import { adoptShellEnv } from "./shell-env.js";
import { followSystemProxy } from "./system-proxy.js";
import { trustedKeys } from "./trust.js";
import { createWindow } from "./window.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const patchFlag = argv.indexOf("--patch");

const iconPath = path.join(here, "../assets/icon.png");

// A second checkout can run beside the real one without sharing — or migrating — its database.
if (process.env.TOMRADE_USER_DATA) app.setPath("userData", path.resolve(process.env.TOMRADE_USER_DATA));

// One process per data folder. Two would share the caches, the Hub catalog and
// the project folders while each kept its own copy in memory, writing over the
// other's. A second launch hands over to the running one, which comes forward.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  console.error("Tomrade is already running on this data folder; bringing that window forward.");
  app.quit();
}

// tomrade:// links: macOS hands them over as events, from launch on; elsewhere they arrive as arguments.
if (primary) {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });
  for (const arg of argv) deliverDeepLink(arg);
}

// Everything under the app's own roots resolves as usual; anything else is an extension.
registerExtensionResolution([path.resolve(here, "../../.."), app.getAppPath()]);

app.whenReady().then(async () => {
  if (!primary) return;
  const machine = machineRoots();
  // At login, or a restart that left with no window: the background part only.
  const mode = launchMode(argv, path.join(machine.userData, PREFS_FILE), loginItem());
  if (mode === "stale") {
    // Background running was switched off since this entry was made; it goes, and so does this start.
    try {
      loginItem().set(false);
    } catch {
      // nothing left to remove
    }
    app.quit();
    return;
  }
  if (mode === "hidden" && process.platform === "darwin") app.dock?.hide();
  // BrowserWindow's `icon` option is a no-op for the Dock on macOS since dev mode
  // runs Electron's own bundled app; the Dock icon has to be set explicitly.
  if (process.platform === "darwin") app.dock?.setIcon(iconPath);
  installAppMenu();
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
  // After it, so a proxy the shell sets stands.
  await followSystemProxy((url) => session.defaultSession.resolveProxy(url));

  // Plugins and their switches belong to the machine; projects and settings to the account last signed in.
  const accounts = new AccountFolders(machine);
  const { userData, hubDir } = accounts.dirs(accounts.active);
  const pluginsRoot = process.env.TOMRADE_PLUGINS_DIR ?? path.join(machine.tomradeDir, "plugins");
  const pluginsDevRoot = path.join(machine.tomradeDir, "plugins-dev");
  const { ctx, dump } = await boot({
    configFile: path.join(here, "../tomrade.yml"),
    patchFiles: [path.join(machine.userData, "tomrade.patch.yml"), ...(patchFlag >= 0 ? [argv[patchFlag + 1]] : [])],
    // What a first run is written in, before the person has picked a language.
    vars: {
      userData, hubDir, pluginsRoot, pluginsDevRoot, logDir: path.join(machine.userData, "logs"), appVersion: app.getVersion(), locale: app.getLocale(),
      instanceKind: app.isPackaged ? "packaged" : "dev",
      // A checkout runs beside the installed app; on a port of its own, agents set up for the app keep reaching it.
      mcpPort: process.env.TOMRADE_MCP_PORT ?? (app.isPackaged ? "19090" : "19091")
    },
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
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void leaveOnSignal(ctx).finally(() => app.exit(0)));

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
    cameBack();
    const win = open();
    mainWindows.add(win);
    // Closing the last Tomrade window quits, on macOS too, whatever surfaces are
    // still up; it waits on the quit so that cancelling it keeps the window.
    // With background running on it only closes, and the process stays.
    win.on("close", (event) => {
      if (quitApproved() || keepsRunning() || [...mainWindows].some((other) => other !== win && !other.isDestroyed())) return;
      event.preventDefault();
      app.quit();
    });
    win.on("closed", () => {
      mainWindows.delete(win);
      if (!leaving() && !quitApproved() && ![...mainWindows].some((w) => !w.isDestroyed())) wentAway();
    });
    return win;
  };
  provideMainWindow({ open: openMain, current: () => [...mainWindows].find((w) => !w.isDestroyed()) });
  // Reached only with background running on: any other last close became a quit.
  app.on("window-all-closed", () => {});
  if (mode === "window") openMain();
  registerScheme();
  app.on("second-instance", (_event, args) => {
    if (leaving()) return;
    for (const arg of args) deliverDeepLink(arg);
    const win = [...mainWindows].find((w) => !w.isDestroyed()) ?? openMain();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on("activate", () => {
    if (leaving()) return;
    // Auxiliary plugin surfaces are top-level BrowserWindows too; only a real
    // Tomrade window satisfies application activation.
    if (![...mainWindows].some((win) => !win.isDestroyed())) openMain();
  });
});
