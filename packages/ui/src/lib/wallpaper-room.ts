import { logQuietly } from "./api";

declare module "@tomradex/ipc" {
  interface Channels {
    "window.wallpaper": () => string | null;
  }
}

/**
 * Glass on Linux, where the window can't frost: the shell hands over the desktop's wallpaper, already
 * blurred, and it becomes the room (`--glass-wallpaper`, `[data-wallpaper]`). Without one the painted room stays.
 * Returns the undo for an effect.
 */
export function wallpaperRoom(glass: boolean): (() => void) | undefined {
  if (!glass || !window.tomrade) return;
  const root = document.documentElement;
  let live = true;
  void window.tomrade.invoke("window.wallpaper").then((url) => {
    if (!live || !url) return;
    root.style.setProperty("--glass-wallpaper", `url("${url}")`);
    root.toggleAttribute("data-wallpaper", true);
  }).catch(logQuietly("window.wallpaper"));
  return () => {
    live = false;
    root.style.removeProperty("--glass-wallpaper");
    root.removeAttribute("data-wallpaper");
  };
}
