/** Shortcuts read with Mac glyphs on a Mac, and as Ctrl+Shift+… words everywhere else. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);

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
