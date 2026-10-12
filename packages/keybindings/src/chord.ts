/**
 * One key chord, written the same on every platform: modifiers first, then the
 * key — "Mod+Shift+Z", "Ctrl+Tab", "?". `Mod` is ⌘ on a Mac and Ctrl elsewhere.
 * Kept free of imports: the renderer checks imported files against it too.
 */
export const CHORD = /^(?:(?:Mod|Ctrl|Alt|Shift)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Enter|Escape|Tab|Space|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|[!-/:-@[-`{-~])$/;
