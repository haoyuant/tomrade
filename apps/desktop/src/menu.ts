import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { sendToWindow } from "./ipc.js";
import { showMainWindow, whenLoaded } from "./main-window.js";
import { DESKTOP_WORDS } from "./words.js";

declare module "@tomradex/ipc" {
  interface Broadcasts {
    /** Help › What Tomrade can do: the main window shows its cards. */
    "app.capabilities": () => void;
  }
}

/**
 * Electron's default menu, but for one key: ⌘W (Ctrl+W) is the renderer's —
 * it closes a file tab, or whatever the person rebound it to — so Close Window
 * moves to ⇧⌘W. A menu accelerator is taken before the page ever hears the key.
 * File also restarts without plugins: the menu is the app's own, so it stays in
 * reach when a plugin has broken the window. Help opens "What Tomrade can do".
 */
export function installAppMenu(opts: { restartWithoutPlugins: () => void }): void {
  const mac = process.platform === "darwin";
  const w = DESKTOP_WORDS(app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en");
  const close: MenuItemConstructorOptions = { role: "close", accelerator: "CommandOrControl+Shift+W" };
  const safe: MenuItemConstructorOptions = { label: w("restartWithoutPlugins"), click: opts.restartWithoutPlugins };
  const capabilities: MenuItemConstructorOptions = {
    label: w("whatTomradeCanDo"),
    click: () => {
      const win = showMainWindow();
      if (win) whenLoaded(win, () => sendToWindow(win, "app.capabilities"));
    }
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { label: "File", submenu: mac ? [close, { type: "separator" }, safe] : [close, { type: "separator" }, safe, { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu", submenu: mac ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] : [{ role: "minimize" }, { role: "zoom" }] },
    { role: "help", submenu: [capabilities] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
