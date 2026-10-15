import { app, autoUpdater, BrowserWindow, ipcMain, screen, type IpcMainEvent } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "cordis";
import type { DesktopSurface, DesktopSurfaceHost, DesktopSurfaceSpec, SurfaceBounds, SurfaceCapabilities } from "@tomradex/desktop-surface";

const STATE_CHANNEL = "tomrade-surface:state";
const INTERACTIVE_CHANNEL = "tomrade-surface:interactive";
const MESSAGE_CHANNEL = "tomrade-surface:message";
const here = path.dirname(fileURLToPath(import.meta.url));

interface OpenSurface {
  spec: DesktopSurfaceSpec;
  win: BrowserWindow;
  contentsId: number;
  state: unknown;
  loaded: boolean;
  controller: DesktopSurface;
}

const isWayland = (): boolean =>
  process.platform === "linux" &&
  (process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" || Boolean(process.env.WAYLAND_DISPLAY));

const capabilities = (): SurfaceCapabilities => ({
  programmaticPosition: !isWayland(),
  // Electron's forwarding option is implemented on macOS and Windows. On
  // Linux the small, tightly-sized surface stays interactive so it can drag.
  forwardedMouseMoves: process.platform === "darwin" || process.platform === "win32"
});

/** Electron mechanics for auxiliary plugin surfaces; it owns no feature lifecycle. */
export class ElectronDesktopSurfaces extends Service implements DesktopSurfaceHost {
  static provide = "desktopSurfaces";

  private openByContents = new Map<number, OpenSurface>();
  private openById = new Map<string, OpenSurface>();

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
    app.on("before-quit", onQuit);
    autoUpdater.on("before-quit-for-update", onQuit);
    return () => {
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
    const win = new BrowserWindow({
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
      webPreferences: {
        preload: path.join(here, "../surface-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    win.setMenuBarVisibility(false);
    if (spec.alwaysOnTop) win.setAlwaysOnTop(true, "floating");
    if (spec.visibleOnAllWorkspaces) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (spec.clickThrough && caps.forwardedMouseMoves) win.setIgnoreMouseEvents(true, { forward: true });

    const initialArea = screen.getPrimaryDisplay().workArea;
    if (caps.programmaticPosition) win.setPosition(initialArea.x + initialArea.width - spec.width - 24, initialArea.y + initialArea.height - spec.height - 18, false);

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
      close: () => this.destroy(record)
    };
    record = { spec, win, contentsId: win.webContents.id, state: spec.initialState, loaded: false, controller };
    this.openById.set(spec.id, record);
    this.openByContents.set(record.contentsId, record);

    win.webContents.on("did-finish-load", () => {
      if (win.isDestroyed()) return;
      record.loaded = true;
      win.webContents.send(STATE_CHANNEL, record.state);
      if (spec.focusable) win.show();
      else win.showInactive();
    });
    win.on("closed", () => this.forget(record));
    void win.loadURL(spec.url);

    this.ctx.effect(() => () => this.destroy(record), `desktopSurfaces.open(${spec.id})`);
    return controller;
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
