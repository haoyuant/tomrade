import fs from "node:fs";
import path from "node:path";
import { LOCK_FILE } from "@tomradex/plugin-kit";

/** Start once without the person's own files: their patch file and the plugins they installed. */
export const SAFE_FLAG = "--safe";

/** Put down as a start begins and taken away once it is up: still there, the last start never got that far. */
export const STARTING_FILE = "starting";
/** Left by a restart that asked for the next start to be a safe one. */
export const SAFE_REQUEST_FILE = "start-safe";

/** Marks this start as begun. True when the start before it never finished. */
export function beginStart(file: string): boolean {
  const unfinished = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(Date.now()));
  return unfinished;
}

export function startFinished(file: string): void {
  fs.rmSync(file, { force: true });
}

/** Asks for the next start to be a safe one, whoever starts it: a relaunch, or the dev launcher. */
export function requestSafeStart(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(Date.now()));
}

/** Whether a safe start was asked for, taking the request: it holds for one start. */
export function takeSafeRequest(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** Whether a start without the person's own files would leave anything out. */
export function hasOwnPlugins(patchFile: string, pluginsRoot: string): boolean {
  if (fs.existsSync(patchFile)) return true;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(pluginsRoot, LOCK_FILE), "utf8")) as { plugins?: unknown[] };
    return Array.isArray(lock.plugins) && lock.plugins.length > 0;
  } catch {
    return false;
  }
}
