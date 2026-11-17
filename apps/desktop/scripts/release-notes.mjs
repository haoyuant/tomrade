/**
 * Which file holds a version's release notes (release-notes/README.md): its own, or for a prerelease without one,
 * its base version's. Run with a version, it prints the file, or fails saying which one to write — the release
 * workflow asks before any build.
 *
 *   node apps/desktop/scripts/release-notes.mjs 1.2.0
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NOTES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../release-notes");

/** The notes file for a version; null when none is written, or it says nothing. */
export function notesFileFor(version, dir = NOTES_DIR) {
  for (const name of new Set([version, version.split("-")[0]])) {
    const file = path.join(dir, `${name}.md`);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim()) return file;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2] ?? "";
  const file = version ? notesFileFor(version) : null;
  if (!file) {
    console.error(`::error::No release notes for ${version || "(no version given)"}: write apps/desktop/release-notes/${version.split("-")[0] || "<version>"}.md (see apps/desktop/release-notes/README.md)`);
    process.exit(1);
  }
  console.log(path.relative(process.cwd(), file));
}
