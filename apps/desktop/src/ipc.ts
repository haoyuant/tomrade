import { BrowserWindow, ipcMain } from "electron";
import { Context, Service } from "cordis";
import type { BroadcastName, ChannelHandler, ChannelName, Ipc } from "@tomradex/ipc";

const PREFIX = "tomrade:";

/** The Electron transport behind ctx.ipc. Handlers registered through it belong to the plugin that registered them. */
export class ElectronIpc extends Service implements Ipc {
  static provide = "ipc";

  constructor(ctx: Context) {
    super(ctx, "ipc");
  }

  handle<K extends ChannelName>(channel: K, handler: ChannelHandler<K>): () => void {
    const name = PREFIX + channel;
    return this.ctx.effect(() => {
      ipcMain.handle(name, (_event, ...args) => (handler as (...args: unknown[]) => unknown)(...args));
      return () => ipcMain.removeHandler(name);
    }, `ipc.handle(${channel})`);
  }

  send<K extends BroadcastName>(channel: K, ...args: unknown[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(PREFIX + channel, ...args);
    }
  }
}

/** A broadcast for one window only: what is true of that window and no other. */
export function sendToWindow<K extends BroadcastName>(win: BrowserWindow, channel: K, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(PREFIX + channel, ...args);
}

export default ElectronIpc;
