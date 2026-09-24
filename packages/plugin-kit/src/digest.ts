import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

/** Every regular file under `dir`, as sorted posix paths. A link is refused: a package is its bytes, nothing it points at. */
export function listFiles(dir: string, exclude: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (exclude(childRel)) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${childRel} is a symbolic link; packages hold files only`);
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * One hash for a directory's content: each file's path, size and hash, in
 * path order. Timestamps and permissions do not count, so the same files
 * give the same digest on every machine.
 */
export function treeDigest(dir: string, files = listFiles(dir)): string {
  const lines = files.map((rel) => {
    const bytes = fs.readFileSync(path.join(dir, rel));
    return `${rel}\0${bytes.length}\0${sha256(bytes)}\n`;
  });
  return sha256(lines.join(""));
}
