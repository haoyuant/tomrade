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

// A file in one of these may be copied whole at drop time; a bigger one keeps its path.
export const PRIVATE_COPY_MAX = 100 * 1024 * 1024;

/**
 * The folders macOS keeps to the apps the person allowed and to the app a file from them was dropped on (Tomrade).
 * A terminal's programs count as whichever app started herdr, often neither. None off macOS.
 */
export function privateFolders(home: string | null = process.platform === "darwin" ? os.homedir() : null): string[] {
  if (!home) return [];
  return [...["Downloads", "Desktop", "Documents", "Library/Mobile Documents"].map((d) => bare(path.join(home, d))), "/Volumes"];
}

const inside = (file: string, folders: readonly string[]) => folders.some((d) => bare(file).startsWith(`${d}/`));

/**
 * The dropped paths as a terminal's programs can read them: each file held for Tomrade alone is copied, under
 * its own name, into a new folder in `into` — anything held for a drop, and from a private folder a file up to
 * PRIVATE_COPY_MAX. One that cannot be copied, and a folder or bigger file from a private folder, keeps its own path.
 */
export async function readableDrops(paths: readonly string[], into: string, tmp = os.tmpdir(), folders = privateFolders()): Promise<string[]> {
  return Promise.all(
    paths.map(async (file) => {
      if (!file) return file;
      try {
        if (!heldForDrop(file, tmp)) {
          if (!inside(file, folders)) return file;
          const stat = await fs.stat(file);
          if (!stat.isFile() || stat.size > PRIVATE_COPY_MAX) return file;
        }
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
