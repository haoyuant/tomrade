import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { DESKTOP_WORDS } from "./words.js";

/**
 * Electron's default menu, but for one key: ⌘W (Ctrl+W) is the renderer's —
 * it closes a file tab, or whatever the person rebound it to — so Close Window
 * moves to ⇧⌘W. A menu accelerator is taken before the page ever hears the key.
 * File also restarts without plugins: the menu is the app's own, so it stays in
 * reach when a plugin has broken the window.
 */
export function installAppMenu(opts: { restartWithoutPlugins: () => void }): void {
  const mac = process.platform === "darwin";
  const w = DESKTOP_WORDS(app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en");
  const close: MenuItemConstructorOptions = { role: "close", accelerator: "CommandOrControl+Shift+W" };
  const safe: MenuItemConstructorOptions = { label: w("restartWithoutPlugins"), click: opts.restartWithoutPlugins };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { label: "File", submenu: mac ? [close, { type: "separator" }, safe] : [close, { type: "separator" }, safe, { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu", submenu: mac ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] : [{ role: "minimize" }, { role: "zoom" }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
