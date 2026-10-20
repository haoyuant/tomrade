/** A path as Terminal.app types a dropped file: a backslash before blanks and the shell's special characters. */
export function shellEscape(path: string): string {
  return path.replace(/[\s\\'"`$!&|;<>()[\]{}*?#~=%^]/g, "\\$&");
}

/**
 * What a drop of files types into a terminal: their paths, escaped, one space apart and one after,
 * as a bracketed paste (herdr drops the markers for a program that did not ask for them). Null when
 * no file had a path on disk.
 */
export function droppedPaste(paths: readonly string[]): string | null {
  const usable = paths.filter((p) => p.length > 0);
  if (!usable.length) return null;
  return `\x1b[200~${usable.map(shellEscape).join(" ")} \x1b[201~`;
}
