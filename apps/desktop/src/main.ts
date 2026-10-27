import { app, BrowserWindow, session } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aboutInfo } from "./about.js";
import { APP_ICON_FILE, appIconPath, readAppIcon, wearAppIcon } from "./app-icon.js";
import { AccountFolders, machineRoots, restart } from "./accounts.js";
import { cameBack, keepsRunning, launchMode, PREFS_FILE } from "./background.js";
import { boot, ConfigUnreadable, type Booted } from "./boot.js";
import { setUpBorrowedNode } from "./borrowed-node.js";
import { openKeyring } from "./cipher.js";
import { deliverDeepLink, registerScheme, SCHEME } from "./deep-link.js";
import { installDesktopEntry } from "./desktop-entry.js";
import { registerExtensionResolution } from "./extension-resolve.js";
import { clearSwitchOffOnce } from "./loader.js";
import { installAppMenu } from "./menu.js";
import { loginItem } from "./login-item.js";
import { askForMainWindow, provideMainWindow } from "./main-window.js";
import { nodeRuntime } from "./node-runtime.js";
import { finishQuit, leaveOnSignal, leaving, prepareToQuit, quitApproved } from "./quit.js";
import { adoptShellEnv } from "./shell-env.js";
import { offerSafeStart, saySafeStart, showSplash, splashWaitsForKeyring, startFailed } from "./startup.js";
import { beginStart, hasOwnPlugins, SAFE_FLAG, SAFE_REQUEST_FILE, STARTING_FILE, startFinished, takeSafeRequest } from "./safe-start.js";
import { followSystemProxy } from "./system-proxy.js";
import { trustedKeys } from "./trust.js";
import { TomradeWindows, type TabTarget } from "./windows.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const patchFlag = argv.indexOf("--patch");

const iconPath = path.join(here, "../assets/icon.png");
// The Windows app is packed into app.asar, its vendor/ and official-plugins/ kept as files in app.asar.unpacked:
// npm and Pi are started by path, by cmd and by the app's own binary, which see only real folders.
const appDir = path.resolve(here, "..").replace(/app\.asar$/, "app.asar.unpacked");

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
  // From the first moment: a launch while this one still boots, or runs hidden, is answered once there is a window to show.
  app.on("second-instance", (_event, args) => {
    if (leaving()) return;
    for (const arg of args) deliverDeepLink(arg);
    askForMainWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });
  for (const arg of argv) deliverDeepLink(arg);
}

// Everything under the app's own roots resolves as usual; anything else is an extension.
registerExtensionResolution([path.resolve(here, "../../.."), app.getAppPath()]);

let splash: BrowserWindow | null = null;

app.whenReady().then(async () => {
  if (!primary) return;
  const machine = machineRoots();
  // The icon chosen in Settings, read before boot so the Dock wears it from the start.
  const appIcon = readAppIcon(path.join(machine.userData, APP_ICON_FILE));
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
  wearAppIcon(appIcon);
  // Linux desktops take the windows' icon, and tomrade: links their handler, from this entry; an AppImage installs none.
  if (process.platform === "linux" && app.isPackaged) {
    try {
      installDesktopEntry(SCHEME, iconPath);
    } catch (error) {
      console.error("Could not write the desktop entry:", error);
    }
  }
  installAppMenu({ restartWithoutPlugins: () => restart({ safe: true }) });
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

  // Until the main window opens; a start at login has nobody waiting for one.
  if (mode === "window" && !argv.includes("--dump-config")) splash = await showSplash(appIconPath(appIcon));
  // Before anything reads a secret: a keyring that asks the person first would hold the start without a word.
  await openKeyring(() => {
    if (splash) splashWaitsForKeyring(splash, appIconPath(appIcon));
  });
  // Before boot: plugins spawn CLIs (MCP servers, agents, git) from the first moment.
  const shellProblem = await adoptShellEnv();
  // After the shell's PATH, so its folders stay ahead and a system Node always wins over the borrowed one.
  const borrowed = setUpBorrowedNode({ userData: machine.userData, npmDir: path.join(appDir, "vendor/npm"), runtime: nodeRuntime(), agentsDir: path.join(machine.userData, "agents") });
  // After it, so a proxy the shell sets stands.
  await followSystemProxy((url) => session.defaultSession.resolveProxy(url));

  // Plugins and their switches belong to the machine; projects and settings to the account last signed in.
  const accounts = new AccountFolders(machine);
  const { userData, hubDir } = accounts.dirs(accounts.active);
  const pluginsRoot = process.env.TOMRADE_PLUGINS_DIR ?? path.join(machine.tomradeDir, "plugins");
  const pluginsDevRoot = path.join(machine.tomradeDir, "plugins-dev");
  const logDir = path.join(machine.userData, "logs");
  // 0.19 and 0.20 could not load app-icon (TOM-625), and a flip of its failed row there switched it off for good.
  try {
    clearSwitchOffOnce(path.join(machine.userData, "tomrade.patch.yml"), "app-icon", path.join(machine.userData, "app-icon-switch-cleared"));
  } catch (error) {
    console.error("Could not clear app-icon's old switch:", error);
  }
  // Without the person's own files: none read, and no switch written back to them.
  const start = (safe: boolean) =>
    boot({
      configFile: path.join(here, "../tomrade.yml"),
      patchFiles: safe ? [] : [path.join(machine.userData, "tomrade.patch.yml"), ...(patchFlag >= 0 ? [argv[patchFlag + 1]] : [])],
      // What a first run is written in, before the person has picked a language.
      vars: {
        appDir, userData, hubDir, pluginsRoot, pluginsDevRoot, logDir, appVersion: app.getVersion(), locale: app.getLocale(),
        instanceKind: app.isPackaged ? "packaged" : "dev",
        // A checkout fills only links nobody made: the agents linked to the installed app keep reaching it.
        linkAgents: app.isPackaged ? "true" : "missing",
        // Where the renderer's own pages are, for a built-in's window: the dev server, the packaged copy, or a checkout's build.
        uiPages: process.env.VITE_DEV_SERVER_URL ? new URL("./", process.env.VITE_DEV_SERVER_URL).href : pathToFileURL(app.isPackaged ? path.join(here, "../ui/") : path.join(here, "../../../packages/ui/dist/")).href,
        // A checkout runs beside the installed app; on a port of its own, agents set up for the app keep reaching it.
        mcpPort: process.env.TOMRADE_MCP_PORT ?? (app.isPackaged ? "19090" : "19091")
      },
      // A checkout is always 0.1.0, so only a release holds full-mode plugins to the Tomrade versions they name.
      extensions: safe ? undefined : { root: pluginsRoot, trustedKeys: trustedKeys(), appVersion: app.isPackaged ? app.getVersion() : null }
    });
  // A plugin with the app's whole context can stop a start before it gets anywhere; the next start notices.
  const dumping = argv.includes("--dump-config");
  const startingFile = path.join(machine.userData, STARTING_FILE);
  const unfinished = !dumping && beginStart(startingFile);
  let safe = argv.includes(SAFE_FLAG) || takeSafeRequest(path.join(machine.userData, SAFE_REQUEST_FILE));
  if (!safe && unfinished && mode === "window" && hasOwnPlugins(path.join(machine.userData, "tomrade.patch.yml"), pluginsRoot)) {
    splash?.hide();
    safe = await offerSafeStart({ logDir });
    splash?.show();
  }
  let booted: Booted;
  try {
    booted = await start(safe);
  } catch (error) {
    // Nothing has started yet, so this process can try once more without the files the person controls.
    if (safe || !(error instanceof ConfigUnreadable) || dumping) throw error;
    splash?.hide();
    if (!(await startFailed(error, { logDir, retry: true }))) return app.quit();
    splash?.show();
    booted = await start(true);
    safe = true;
  }
  if (safe) {
    booted.ctx.logger("boot").warn("started without tomrade.patch.yml and installed plugins, as asked");
    if (!dumping) saySafeStart();
  }
  const { ctx, dump } = booted;
  if (shellProblem) ctx.logger("shell-env").warn(shellProblem);
  if (borrowed.problem) ctx.logger("borrowed-node").warn(borrowed.problem);

  if (argv.includes("--dump-config")) {
    process.stdout.write(dump());
    app.exit(0);
    return;
  }

  app.on("before-quit", (event) => {
    if (quitApproved()) return;
    event.preventDefault();
    void prepareToQuit(ctx).then((ok) => ok && finishQuit());
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void leaveOnSignal(ctx).finally(() => app.exit(0)));

  // A window a tab moved into stands where the last one was left: a place of the machine's, like its screens.
  const windows = new TomradeWindows(
    ctx,
    {
      preload: path.join(here, "../preload.cjs"),
      // A packaged build carries the renderer beside dist/; a checkout builds it in packages/ui.
      uiIndex: app.isPackaged ? path.join(here, "../ui/index.html") : path.join(here, "../../../packages/ui/dist/index.html"),
      icon: iconPath,
      devServerUrl: process.env.VITE_DEV_SERVER_URL
    },
    path.join(machine.userData, "window-places.json")
  );
  const openMain = (tab?: TabTarget) => {
    const win = windows.open(tab);
    cameBack(win);
    // Closing the last Tomrade window quits, on macOS too, whatever surfaces are
    // still up; it waits on the quit so that cancelling it keeps the window.
    // With background running on it only closes, and the process stays.
    win.on("close", (event) => {
      if (quitApproved() || keepsRunning() || windows.all().some((other) => other !== win)) return;
      event.preventDefault();
      app.quit();
    });
    return win;
  };
  ctx.ipc.handle("windows.openTab", (tab) => void openMain(tab));
  // Reached only with background running on: any other last close became a quit.
  app.on("window-all-closed", () => {});
  // The start got as far as a window that loaded, or as far as it goes without one.
  if (mode === "window") openMain().webContents.once("did-finish-load", () => startFinished(startingFile));
  else startFinished(startingFile);
  // After the start's own window, so a launch that came meanwhile brings that one forward rather than a second.
  provideMainWindow({ open: openMain, current: () => windows.lead() });
  // After the main window is up, so there is never a moment with none.
  splash?.destroy();
  splash = null;
  registerScheme();
  app.on("activate", () => {
    if (leaving()) return;
    // Auxiliary plugin surfaces are top-level BrowserWindows too; only a real
    // Tomrade window satisfies application activation.
    if (!windows.lead()) openMain();
  });
}).catch(async (error: unknown) => {
  console.error(error);
  if (argv.includes("--dump-config")) return app.exit(1);
  splash?.hide();
  await startFailed(error, { logDir: path.join(app.getPath("userData"), "logs"), retry: false });
  app.quit();
});
