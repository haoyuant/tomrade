/** Shortcuts read with Mac glyphs on a Mac, and as Ctrl+Shift+… words everywhere else. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
/** Windows, from the same navigator.platform ("Win32"); neither this nor `isMac` means Linux. */
export const isWindows = typeof navigator !== "undefined" && /^Win/i.test(navigator.platform);

const MODIFIERS: Record<string, string> = { "⌃": "Ctrl", "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
const ORDER = ["Ctrl", "Alt", "Shift"];

/** "⇧⌘Z" as this platform writes it — unchanged on a Mac, "Ctrl+Shift+Z" elsewhere. Works on whole sentences. */
export function shortcut(text: string, mac = isMac): string {
  if (mac) return text;
  return text.replace(/[⌃⌥⇧⌘]+(?:↵|[^\s⌃⌥⇧⌘—·,.;:)]|,(?=\s|$|\)))?/g, (combo) => {
    const mods = new Set<string>();
    let key = "";
    for (const ch of combo) {
      if (MODIFIERS[ch]) mods.add(MODIFIERS[ch]);
      else key += ch;
    }
    return [...ORDER.filter((m) => mods.has(m)), key === "↵" ? "Enter" : key].filter(Boolean).join("+");
  });
}

type KeyEventLike = { key: string; keyCode?: number; isComposing?: boolean; nativeEvent?: { isComposing?: boolean } };

/** An IME is still composing: its Enter picks a candidate. 229 covers the keydown some engines send just after composition ends. */
export function isComposing(e: KeyEventLike): boolean {
  return !!(e.isComposing || e.nativeEvent?.isComposing) || e.keyCode === 229;
}

/** Enter that commits what was typed — never the Enter that confirms an IME candidate. */
export function isCommitKey(e: KeyEventLike): boolean {
  return e.key === "Enter" && !isComposing(e);
}

/** Escape that cancels an edit or closes a layer — never the Escape that dismisses an IME candidate list. */
export function isCancelKey(e: KeyEventLike): boolean {
  return e.key === "Escape" && !isComposing(e);
}
