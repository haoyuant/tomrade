import fs from "node:fs";
import path from "node:path";
import type { Host } from "../host.js";

/** Only a file inside the plugin's own package may be shown or run by the renderer: its absolute path, or why not. */
export function packageFile(host: Host, file: string, what: string): string {
  const root = host.identity.root;
  if (!root) throw new Error(`${host.identity.id} has no package directory to open "${file}" from`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(file)) throw new Error(`${what}s must be files inside the plugin, not "${file}"`);
  const resolved = path.resolve(root, file);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${what} "${file}" is outside the plugin`);
  if (!fs.existsSync(resolved)) throw new Error(`${what} "${file}" does not exist`);
  return resolved;
}
