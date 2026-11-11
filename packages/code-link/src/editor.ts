import fs from "node:fs";
import path from "node:path";
import { fileNames, launchFor, spawnCli, splitPath } from "@tomradex/engine-kit";

/** The code editors a changed file opens in, by their command, in the order they are looked for. */
export const EDITORS = ["cursor", "code"] as const;
export type Editor = (typeof EDITORS)[number];

/** Where a changed file was opened: an editor's command took it, or none is on PATH and `file` is the caller's to open. */
export type EditorOpened = { editor: Editor } | { editor: null; file: string };

/** The first editor whose command is on PATH. */
export function findEditor(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = fs.existsSync): { editor: Editor; file: string } | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = splitPath(Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1], platform);
  for (const editor of EDITORS) {
    for (const dir of dirs) {
      const file = fileNames(editor, platform, env.PATHEXT).map((name) => p.join(dir, name)).find(exists);
      if (file) return { editor, file };
    }
  }
  return null;
}

/** `file` inside `root`, as a path on disk; null when it leaves the folder or is not there (a deleted file). */
export function fileInside(root: string, file: string): string | null {
  const full = path.resolve(root, file);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return fs.existsSync(full) ? full : null;
}

/** Hands the file to the editor's command with its folder as the workspace; false when the command would not start. */
export function openInEditor(command: string, root: string, file: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawnCli(launchFor(command, { platform: process.platform, env: process.env }), [root, "--goto", file], { cwd: root, stdio: "ignore", detached: process.platform !== "win32" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
