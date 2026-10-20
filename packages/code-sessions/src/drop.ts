import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A path as Terminal.app types a dropped file: a backslash before blanks and the shell's special characters. */
export function shellEscape(file: string): string {
  return file.replace(/[\s\\'"`$!&|;<>()[\]{}*?#~=%^]/g, "\\$&");
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

// macOS gives /var as /private/var too.
const bare = (p: string) => path.resolve(p).replace(/^\/private(?=\/var\/)/, "");

/**
 * Whether a dropped file sits in the temp folder's TemporaryItems, where macOS keeps what is dragged out of a
 * screenshot's thumbnail: only the app it was dropped on may read it there, not the programs in its terminals.
 */
export const heldForDrop = (file: string, tmp = os.tmpdir()): boolean => bare(file).startsWith(`${bare(tmp)}/TemporaryItems/`);

/**
 * The dropped paths as a terminal's programs can read them: each file held for Tomrade alone is copied, under
 * its own name, into a new folder in `into`; one that cannot be copied keeps its own path.
 */
export async function readableDrops(paths: readonly string[], into: string, tmp = os.tmpdir()): Promise<string[]> {
  return Promise.all(
    paths.map(async (file) => {
      if (!file || !heldForDrop(file, tmp)) return file;
      try {
        await fs.mkdir(into, { recursive: true });
        const copy = path.join(await fs.mkdtemp(path.join(into, "drop-")), path.basename(file));
        await fs.cp(file, copy, { recursive: true });
        return copy;
      } catch {
        return file;
      }
    })
  );
}
