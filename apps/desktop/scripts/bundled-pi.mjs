/**
 * The Pi the built-in agent runs, as a packaged app carries it: a check that
 * counts on it fetches it into vendor/pi when a checkout has none yet
 * (fetch-pi.mjs, pinned and checked against npm's integrity hashes).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

export function ensureBundledPi() {
  if (fs.existsSync(path.join(dir, "../vendor/pi/dist/bundle/cli.js"))) return;
  execFileSync(process.execPath, [path.join(dir, "fetch-pi.mjs")], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
}
