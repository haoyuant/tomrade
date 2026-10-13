import { Menu, type MenuItemConstructorOptions } from "electron";

/**
 * Electron's default menu, but for one key: ⌘W (Ctrl+W) is the renderer's —
 * it closes a file tab, or whatever the person rebound it to — so Close Window
 * moves to ⇧⌘W. A menu accelerator is taken before the page ever hears the key.
 */
export function installAppMenu(): void {
  const mac = process.platform === "darwin";
  const close: MenuItemConstructorOptions = { role: "close", accelerator: "CommandOrControl+Shift+W" };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { label: "File", submenu: mac ? [close] : [close, { role: "quit" }] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu", submenu: mac ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] : [{ role: "minimize" }, { role: "zoom" }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
