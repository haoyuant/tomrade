import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHARED = ["cordis", "@tomrade/plugin-sdk", "zod", "zod/v4", "zod/v4/core", "zod/mini"];

/** Call before the first extension is imported; later imports see the hook. */
export function registerExtensionResolution(appRoots: string[]): void {
  const map: Record<string, string> = {};
  for (const name of SHARED) {
    try {
      map[name] = import.meta.resolve(name);
    } catch {
      // A subpath this zod does not export is simply not shared.
    }
  }
  const inside = appRoots.map((root) => pathToFileURL(path.resolve(root) + path.sep).href);
  register("./extension-hooks.js", { parentURL: import.meta.url, data: { map, inside } });
}
