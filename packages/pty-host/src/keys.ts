/** The bytes a program reads for each logical key herdr names, so `pane.send_input` takes the same `keys` here. */
const KEYS: Record<string, string> = {
  enter: "\r",
  esc: "\x1b",
  escape: "\x1b",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  backspace: "\x7f",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D"
};

/** What a logical key writes to the pty; null for a name this host does not know, so nothing half-typed reaches the program. */
export function keyBytes(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (Object.hasOwn(KEYS, key)) return KEYS[key]!;
  const ctrl = /^ctrl\+([a-z])$/.exec(key);
  return ctrl ? String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96) : null;
}
