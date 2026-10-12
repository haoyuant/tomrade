import { BrowserWindow } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/ipc";

export interface WindowChrome {
  /** macOS draws the traffic lights over the renderer's header while windowed. */
  trafficLights: boolean;
}

declare module "@tomradex/ipc" {
  interface Broadcasts {
    "window.chrome": (state: WindowChrome) => void;
  }
}

export interface WindowOptions {
  preload: string;
  uiIndex: string;
  icon: string;
  devServerUrl?: string;
}

export function createWindow(ctx: Context, opts: WindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Tomrade",
    icon: opts.icon,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: opts.preload, contextIsolation: true, nodeIntegration: false }
  });
  win.maximize();

  const sendChrome = () => {
    if (win.isDestroyed()) return;
    ctx.get("ipc")?.send("window.chrome", { trafficLights: process.platform === "darwin" && !win.isFullScreen() });
  };
  win.webContents.on("did-finish-load", sendChrome);
  // The renderer's own failures belong in the log the troubleshooter reads.
  const log = ctx.logger("renderer");
  win.webContents.on("console-message", (event) => { if (event.level === "error" || String(event.level) === "3") log.warn(`${event.message} (${event.sourceId}:${event.lineNumber})`); });
  win.webContents.on("render-process-gone", (_event, details) => log.error(`renderer gone: ${details.reason} (exit ${details.exitCode})`));
  win.on("enter-full-screen", sendChrome);
  win.on("leave-full-screen", sendChrome);

  if (opts.devServerUrl) void win.loadURL(opts.devServerUrl);
  else void win.loadFile(opts.uiIndex);
  return win;
}
