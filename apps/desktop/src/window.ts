import { BrowserWindow } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/ipc";
import type { SurfaceBounds } from "@tomradex/desktop-surface";
import { sendToWindow } from "./ipc.js";

interface WindowChrome {
  /** macOS draws the traffic lights over the renderer's header while windowed. */
  trafficLights: boolean;
  /** The window app-wide prompts land in, the one the shell brings forward; the others leave them be. */
  lead: boolean;
}

declare module "@tomradex/ipc" {
  interface Broadcasts {
    "window.chrome": (state: WindowChrome) => void;
  }
}

/** Where a window stands, and whether it fills its screen. */
export interface WindowPlace extends SurfaceBounds {
  maximized?: boolean;
}

/** What the preload reads off a window a tab moved into. */
const DETACHED_ARG = "--tomrade-window=detached";

export interface WindowOptions {
  preload: string;
  uiIndex: string;
  icon: string;
  devServerUrl?: string;
  /** A window a tab moved into: the route it opens on and where it stands. */
  detached?: { route: string; place: WindowPlace };
  /** Whether this window leads, asked each time it is told. */
  lead: (win: BrowserWindow) => boolean;
}

/** Tells a window how its chrome stands now. */
export function sayChrome(win: BrowserWindow, lead: boolean): void {
  if (win.isDestroyed()) return;
  sendToWindow(win, "window.chrome", { trafficLights: process.platform === "darwin" && !win.isFullScreen(), lead } satisfies WindowChrome);
}

export function createWindow(ctx: Context, opts: WindowOptions): BrowserWindow {
  const place = opts.detached?.place;
  const win = new BrowserWindow({
    ...(place ? { x: place.x, y: place.y, width: place.width, height: place.height } : { width: 1440, height: 900 }),
    minWidth: 900,
    minHeight: 600,
    title: "Tomrade",
    icon: opts.icon,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: opts.preload, contextIsolation: true, nodeIntegration: false, ...(opts.detached ? { additionalArguments: [DETACHED_ARG] } : {}) }
  });
  if (!place || place.maximized) win.maximize();

  const sendChrome = () => sayChrome(win, opts.lead(win));
  win.webContents.on("did-finish-load", sendChrome);
  // The renderer's own failures belong in the log the troubleshooter reads.
  const log = ctx.logger("renderer");
  win.webContents.on("console-message", (event) => { if (event.level === "error" || String(event.level) === "3") log.warn(`${event.message} (${event.sourceId}:${event.lineNumber})`); });
  win.webContents.on("render-process-gone", (_event, details) => log.error(`renderer gone: ${details.reason} (exit ${details.exitCode})`));
  win.on("enter-full-screen", sendChrome);
  win.on("leave-full-screen", sendChrome);

  const route = opts.detached?.route;
  if (opts.devServerUrl) void win.loadURL(route ? `${opts.devServerUrl.replace(/#.*$/, "")}#${route}` : opts.devServerUrl);
  else void win.loadFile(opts.uiIndex, route ? { hash: route } : undefined);
  return win;
}
