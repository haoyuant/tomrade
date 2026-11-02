/**
 * One key chord, written the same on every platform: modifiers first, then the
 * key — "Mod+Shift+Z", "Ctrl+Tab", "?". `Mod` is ⌘ on a Mac and Ctrl elsewhere.
 * Kept free of imports: the renderer checks imported files against it too.
 */
export const CHORD = /^(?:(?:Mod|Ctrl|Alt|Shift)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Enter|Escape|Tab|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|[!-/:-@[-`{-~])$/;

/**
 * Each command's keys until the person rebinds them, by command id. The
 * renderer runs the commands; the main process quotes these keys where it
 * writes text that teaches them, such as the sample project.
 */
export const DEFAULT_KEYS = {
  palette: ["Mod+K"],
  newTicket: ["Mod+N", "N"],
  switchProject: ["Mod+P"],
  sidebar: ["Mod+B"],
  assistant: ["Mod+J"],
  terminalWindow: ["Mod+Shift+T"],
  // A key the whole computer gives Tomrade: none until the person picks one.
  terminalWindowGlobal: [] as string[],
  sessionBar: ["Mod+\\"],
  nextWaiting: ["Alt+ArrowDown"],
  settings: ["Mod+,"],
  undo: ["Mod+Z"],
  redo: ["Mod+Shift+Z", "Mod+Y"],
  searchNotes: ["Mod+Shift+F"],
  shortcuts: ["?"],
  closeTab: ["Mod+W"],
  nextTab: ["Ctrl+Tab"],
  prevTab: ["Ctrl+Shift+Tab"],
  backlogTab: ["Mod+1"],
  searchTickets: ["Mod+F", "/"],
  readWrite: ["Mod+E"],
  saveBody: ["Mod+Enter"],
  // In the Terminal window. Ctrl+C copies only a selection, else it is the shell's interrupt; Ctrl+V stays the
  // program's (agents paste images on it), and ⌘V on a Mac is the Edit menu's.
  terminalCopy: ["Mod+C", "Mod+Shift+C", "Ctrl+Insert"],
  terminalPaste: ["Mod+Shift+V", "Shift+Insert"]
} satisfies Record<string, string[]>;
