import { app, autoUpdater, BrowserWindow, ipcMain, screen, shell, type IpcMainEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "cordis";
import type { DesktopSurface, DesktopSurfaceHost, DesktopSurfaceSpec, SurfaceBounds, SurfaceCapabilities, SurfaceLook } from "@tomradex/desktop-surface";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/settings";
import { cameBack } from "./background.js";
import { leadWindow, showMainWindow, takeKeptInFront } from "./main-window.js";
import { SurfaceBoundsStore, placeWindow } from "./surface-bounds.js";

const STATE_CHANNEL = "tomrade-surface:state";
const INTERACTIVE_CHANNEL = "tomrade-surface:interactive";
const MESSAGE_CHANNEL = "tomrade-surface:message";
const PUSH_CHANNEL = "tomrade-surface:push";
const LOOK_CHANNEL = "tomrade-surface:look";
const here = path.dirname(fileURLToPath(import.meta.url));

declare module "@tomradex/ipc" {
  interface Channels {
    /** The main window says how the app looks now; every surface document hears it. */
    "surfaces.look": (look: SurfaceLook) => void;
  }
}

interface OpenSurface {
  spec: DesktopSurfaceSpec;
  win: BrowserWindow;
  contentsId: number;
  state: unknown;
  loaded: boolean;
  /** Posts made before the document loaded, sent in order once it has. */
  queued: unknown[];
  controller: DesktopSurface;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isWayland = (): boolean =>
  process.platform === "linux" &&
  (process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" || Boolean(process.env.WAYLAND_DISPLAY));

const capabilities = (): SurfaceCapabilities => ({
  programmaticPosition: !isWayland(),
  // Electron's forwarding option is implemented on macOS and Windows. On
  // Linux the small, tightly-sized surface stays interactive so it can drag.
  forwardedMouseMoves: process.platform === "darwin" || process.platform === "win32"
});

function readLook(file: string): SurfaceLook | null {
  try {
    const look = JSON.parse(fs.readFileSync(file, "utf8")) as SurfaceLook;
    return look && typeof look === "object" && look.tokens && typeof look.tokens === "object" ? look : null;
  } catch {
    return null;
  }
}

function writeLook(file: string, look: SurfaceLook): void {
  try {
    fs.writeFileSync(file, JSON.stringify(look));
  } catch {
    // The next window waits for the renderer's look, as it always did.
  }
}

/** Electron mechanics for auxiliary plugin surfaces; it owns no feature lifecycle. */
export class ElectronDesktopSurfaces extends Service implements DesktopSurfaceHost {
  static provide = "desktopSurfaces";

  private openByContents = new Map<number, OpenSurface>();
  private openById = new Map<string, OpenSurface>();
  // The main window's renderer says the look; kept on disk so a window that opens before it (a start on the Terminal window) wears the last one.
  private readonly lookFile = path.join(app.getPath("userData"), "surface-look.json");
  private look: SurfaceLook | null = readLook(this.lookFile);
  private readonly places = new SurfaceBoundsStore(path.join(app.getPath("userData"), "surface-bounds.json"));

  constructor(ctx: Context) {
    super(ctx, "desktopSurfaces");
  }

  [Service.init]() {
    const onInteractive = (event: IpcMainEvent, interactive: unknown) => {
      const surface = this.openByContents.get(event.sender.id);
      if (!surface?.spec.clickThrough || !surface.controller.capabilities.forwardedMouseMoves || surface.win.isDestroyed()) return;
      surface.win.setIgnoreMouseEvents(!interactive, { forward: true });
    };
    const onMessage = (event: IpcMainEvent, message: unknown) => this.openByContents.get(event.sender.id)?.spec.onMessage?.(message);
    // On macOS a window that can't be closed calls off a quit, update installs included.
    const onQuit = () => {
      for (const surface of this.openById.values()) if (!surface.win.isDestroyed()) surface.win.setClosable(true);
    };
    ipcMain.on(INTERACTIVE_CHANNEL, onInteractive);
    ipcMain.on(MESSAGE_CHANNEL, onMessage);
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("surfaces.look", (look) => {
        if (JSON.stringify(look) !== JSON.stringify(this.look)) writeLook(this.lookFile, look);
        this.look = look;
        for (const surface of this.openById.values()) if (surface.loaded && !surface.win.isDestroyed()) surface.win.webContents.send(LOOK_CHANNEL, look);
      });
    });
    // A surface that asks for Settings is outside the window; the window comes forward to show it.
    // Running in the background there may be none yet, and one opens.
    this.ctx.on("settings/show", () => void showMainWindow());
    // A GPU process that died blanks every WebGL pane at once; say so in the log.
    const onChildGone = (_event: unknown, details: { type: string; reason: string; exitCode: number }) => {
      if (details.type === "GPU" && details.reason !== "clean-exit") this.ctx.logger("surfaces").error(`GPU process gone: ${details.reason} (exit ${details.exitCode})`);
    };
    app.on("child-process-gone", onChildGone);
    app.on("before-quit", onQuit);
    autoUpdater.on("before-quit-for-update", onQuit);
    return () => {
      app.off("child-process-gone", onChildGone);
      ipcMain.off(INTERACTIVE_CHANNEL, onInteractive);
      ipcMain.off(MESSAGE_CHANNEL, onMessage);
      app.off("before-quit", onQuit);
      autoUpdater.off("before-quit-for-update", onQuit);
      for (const surface of [...this.openById.values()]) this.destroy(surface);
    };
  }

  open(spec: DesktopSurfaceSpec): DesktopSurface {
    if (this.openById.has(spec.id)) throw new Error(`desktop surface "${spec.id}" is already open`);

    const caps = capabilities();
    const window = spec.kind === "window";
    let ahead = window ? takeKeptInFront() : null;
    const webPreferences = { preload: path.join(here, "../surface-preload.cjs"), contextIsolation: true, nodeIntegration: false };
    const place = window ? placeWindow(this.places.get(spec.id), spec, [screen.getPrimaryDisplay().workArea, ...screen.getAllDisplays().map((d) => d.workArea)]) : null;
    const win = window
      ? new BrowserWindow({
          ...(caps.programmaticPosition ? { x: place!.x, y: place!.y } : {}),
          width: place!.width,
          height: place!.height,
          ...(spec.minWidth ? { minWidth: spec.minWidth } : {}),
          ...(spec.minHeight ? { minHeight: spec.minHeight } : {}),
          show: false,
          title: spec.title,
          backgroundColor: this.look?.tokens["--bg"] || undefined,
          webPreferences
        })
      : new BrowserWindow({
          width: spec.width,
          height: spec.height,
          useContentSize: true,
          show: false,
          frame: false,
          transparent: spec.transparent ?? false,
          backgroundColor: spec.transparent ? "#00000000" : undefined,
          resizable: false,
          movable: true,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          closable: false,
          focusable: spec.focusable ?? false,
          skipTaskbar: true,
          hasShadow: false,
          acceptFirstMouse: true,
          title: spec.title,
          webPreferences
        });
    win.setMenuBarVisibility(false);
    // A page link never opens an app window: web links go to the system browser, anything else nowhere.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    if (window) {
      // A plugin's own window keeps the Dock icon, as a Tomrade window does; an overlay never does.
      cameBack(win);
      // The title is the host's — the plugin's name in it — never the document's own <title>.
      win.on("page-title-updated", (event) => event.preventDefault());
      let saving: NodeJS.Timeout | null = null;
      const remember = () => {
        if (saving) clearTimeout(saving);
        saving = setTimeout(() => {
          if (!win.isDestroyed() && !win.isMinimized() && !win.isFullScreen() && !win.isMaximized()) this.places.set(spec.id, win.getBounds());
        }, 300);
      };
      win.on("resize", remember);
      win.on("move", remember);
      win.on("close", () => {
        if (saving) clearTimeout(saving);
        if (!win.isMinimized() && !win.isFullScreen() && !win.isMaximized()) this.places.set(spec.id, win.getBounds());
      });
    } else {
      if (spec.alwaysOnTop) win.setAlwaysOnTop(true, "floating");
      if (spec.visibleOnAllWorkspaces) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      if (spec.clickThrough && caps.forwardedMouseMoves) win.setIgnoreMouseEvents(true, { forward: true });
      const initialArea = screen.getPrimaryDisplay().workArea;
      if (caps.programmaticPosition) win.setPosition(initialArea.x + initialArea.width - spec.width - 24, initialArea.y + initialArea.height - spec.height - 18, false);
    }

    let record!: OpenSurface;
    const controller: DesktopSurface = {
      id: spec.id,
      capabilities: caps,
      bounds: () => {
        const b = win.getBounds();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      },
      workArea: () => {
        const a = screen.getDisplayMatching(win.getBounds()).workArea;
        return { x: a.x, y: a.y, width: a.width, height: a.height };
      },
      setPosition: (x, y) => {
        if (caps.programmaticPosition && !win.isDestroyed()) win.setPosition(Math.round(x), Math.round(y), false);
      },
      setState: (state) => {
        record.state = state;
        if (record.loaded && !win.isDestroyed()) win.webContents.send(STATE_CHANNEL, state);
      },
      post: (message) => {
        if (win.isDestroyed()) return;
        if (record.loaded) win.webContents.send(PUSH_CHANNEL, message);
        else record.queued.push(message);
      },
      focus: () => {
        if (win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        // show() alone can leave a window behind the one the click came from.
        win.moveTop();
        win.focus();
      },
      close: () => this.destroy(record)
    };
    record = { spec, win, contentsId: win.webContents.id, state: spec.initialState, loaded: false, queued: [], controller };
    this.openById.set(spec.id, record);
    this.openByContents.set(record.contentsId, record);
    // Registered first, so the search for the app window cannot land on this surface.
    if (!window && spec.anchor && caps.programmaticPosition) void this.anchorOf(spec.anchor).then((at) => {
      if (!at || win.isDestroyed()) return;
      const area = screen.getDisplayMatching({ x: at.x, y: at.y, width: 1, height: 1 }).workArea;
      const x = Math.max(area.x, Math.min(area.x + area.width - spec.width, at.x));
      const y = Math.max(area.y, Math.min(area.y + area.height - spec.height, at.y - spec.height));
      win.setPosition(Math.round(x), Math.round(y), false);
    });

    // A gone renderer leaves a blank window that only a restart cleared; reload it, but not in a loop.
    const log = this.ctx.logger("surfaces");
    let gone: number[] = [];
    win.webContents.on("render-process-gone", (_event, details) => {
      log.error(`${spec.id}: renderer gone: ${details.reason} (exit ${details.exitCode})`);
      if (win.isDestroyed() || details.reason === "clean-exit") return;
      const now = Date.now();
      gone = [...gone.filter((at) => now - at < 60_000), now];
      if (gone.length > 3) return;
      record.loaded = false;
      win.webContents.reload();
    });
    win.on("unresponsive", () => log.warn(`${spec.id}: window unresponsive`));

    win.webContents.on("did-finish-load", () => {
      if (win.isDestroyed()) return;
      record.loaded = true;
      if (this.look) win.webContents.send(LOOK_CHANNEL, this.look);
      win.webContents.send(STATE_CHANNEL, record.state);
      for (const message of record.queued.splice(0)) win.webContents.send(PUSH_CHANNEL, message);
      if (window && ahead && !ahead.isDestroyed()) {
        // The start's "both": shown behind the main window, which keeps the lead.
        win.showInactive();
        ahead.moveTop();
        ahead.focus();
        ahead = null;
      } else if (window) controller.focus();
      else if (spec.focusable) win.show();
      else win.showInactive();
    });
    // destroy() guarantees "closed" too, so every way out passes here.
    win.on("closed", () => {
      this.forget(record);
      spec.onClose?.();
    });
    void win.loadURL(spec.url);

    this.ctx.effect(() => () => this.destroy(record), `desktopSurfaces.open(${spec.id})`);
    return controller;
  }

  /** The Tomrade window, the leading one of several: not a surface, not a dialog. */
  private mainWindow(): BrowserWindow | undefined {
    return leadWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.getParentWindow() && w.isFocusable() && !this.openByContents.has(w.webContents.id));
  }

  /** The anchor's top-left on screen, once the window has drawn it; null when it never shows. */
  private async anchorOf(name: string): Promise<{ x: number; y: number } | null> {
    const win = this.mainWindow();
    if (!win || win.isMinimized() || !win.isVisible()) return null;
    const selector = JSON.stringify(`[data-surface-anchor=${JSON.stringify(name)}]`);
    const js = `(() => { const r = document.querySelector(${selector})?.getBoundingClientRect(); return r && r.width ? { x: r.left, y: r.top } : null; })()`;
    // At launch the window may still be loading or routing; give it a few seconds.
    for (let tries = 0; tries < 20 && !win.isDestroyed(); tries++) {
      const at = win.webContents.isLoading() ? null : ((await win.webContents.executeJavaScript(js, true).catch(() => null)) as { x: number; y: number } | null);
      if (at) {
        const content = win.getContentBounds();
        const zoom = win.webContents.getZoomFactor();
        return { x: content.x + at.x * zoom, y: content.y + at.y * zoom };
      }
      await sleep(250);
    }
    return null;
  }

  private forget(surface: OpenSurface): void {
    if (this.openById.get(surface.spec.id) === surface) this.openById.delete(surface.spec.id);
    if (this.openByContents.get(surface.contentsId) === surface) this.openByContents.delete(surface.contentsId);
  }

  private destroy(surface: OpenSurface): void {
    this.forget(surface);
    if (!surface.win.isDestroyed()) surface.win.destroy();
  }
}

export default ElectronDesktopSurfaces;
