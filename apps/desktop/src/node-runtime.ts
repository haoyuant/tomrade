import fs from "node:fs";
import path from "node:path";

/**
 * The binary child processes run as Node (with `ELECTRON_RUN_AS_NODE`). On macOS that is the app's
 * Helper: the main binary registers as a foreground app, so each child would show in the Dock.
 */
export function nodeRuntime(execPath = process.execPath, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = fs.existsSync): string {
  if (platform !== "darwin") return execPath;
  const name = path.basename(execPath);
  const helper = path.join(path.dirname(execPath), "..", "Frameworks", `${name} Helper.app`, "Contents", "MacOS", `${name} Helper`);
  return exists(helper) ? path.normalize(helper) : execPath;
}
