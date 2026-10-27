import { isMac } from "../lib/keys";
import { formatChord, matchesChord } from "../lib/keybindings";

type Direction = "left" | "right" | "up" | "down";
export type WindowKey = "splitRight" | "splitDown" | "close" | Direction | "previous" | "next" | "fold" | "palette";

/**
 * The window's own keys: iTerm2's for panes on a Mac, and ⌘B for the sidebar as in the app. Elsewhere Ctrl+Shift
 * chords and Alt+arrows, as Linux terminals use them — Ctrl alone and ⌃ on a Mac belong to the shell (Ctrl+D,
 * Ctrl+W, and Ctrl+B for tmux), so they are never taken. ⌘K is the app's palette here too; a Mac terminal's "clear" is in it.
 */
const WINDOW_KEYS: Record<"mac" | "other", Record<WindowKey, string>> = {
  mac: {
    splitRight: "Mod+D",
    splitDown: "Mod+Shift+D",
    close: "Mod+W",
    left: "Mod+Alt+ArrowLeft",
    right: "Mod+Alt+ArrowRight",
    up: "Mod+Alt+ArrowUp",
    down: "Mod+Alt+ArrowDown",
    previous: "Mod+[",
    next: "Mod+]",
    fold: "Mod+B",
    palette: "Mod+K"
  },
  other: {
    splitRight: "Mod+Shift+D",
    splitDown: "Mod+Shift+O",
    close: "Mod+Shift+W",
    left: "Alt+ArrowLeft",
    right: "Alt+ArrowRight",
    up: "Alt+ArrowUp",
    down: "Alt+ArrowDown",
    previous: "Mod+Shift+Tab",
    next: "Mod+Tab",
    fold: "Mod+Shift+B",
    palette: "Mod+Shift+K"
  }
};

type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & { isComposing?: boolean };

/** The window key a key press is, or null for every other key, which the terminal gets as it is. */
export function windowKey(e: KeyEventLike, mac = isMac): WindowKey | null {
  if (e.isComposing) return null;
  const table = WINDOW_KEYS[mac ? "mac" : "other"];
  for (const id of Object.keys(table) as WindowKey[]) if (matchesChord(e, table[id], { mac })) return id;
  return null;
}

/** A window key's chord on this platform, for lists that write it themselves. */
export const windowChord = (id: WindowKey, mac = isMac): string => WINDOW_KEYS[mac ? "mac" : "other"][id];

/** A window key as this platform writes it: "⇧⌘D" on a Mac, "Ctrl+Shift+O" elsewhere. */
export const keyLabel = (id: WindowKey, mac = isMac): string => formatChord(WINDOW_KEYS[mac ? "mac" : "other"][id], mac);

/** The modifiers the pane arrows take, as this platform writes them: "⌥⌘" on a Mac, "Alt" elsewhere. */
export const arrowsLabel = (mac = isMac): string => keyLabel("left", mac).replace(/[←→↑↓]/g, "").replace(/\+$/, "").trim();

/** Ctrl+Enter or Shift+Enter, which xterm types as a plain Enter: the backend sends them as the pane's program reads keys. */
export function modifiedEnter(e: KeyEventLike): "ctrl+enter" | "shift+enter" | null {
  if (e.key !== "Enter" || e.isComposing || e.altKey || e.metaKey || e.ctrlKey === e.shiftKey) return null;
  return e.ctrlKey ? "ctrl+enter" : "shift+enter";
}
