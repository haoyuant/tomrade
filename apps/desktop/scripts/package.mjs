/**
 * Builds everything the app runs from, copies the renderer into the app, and
 * hands the rest to electron-builder. Extra arguments go to electron-builder:
 *
 *   pnpm --filter @tomrade/desktop package             installers for this OS
 *   pnpm --filter @tomrade/desktop package -- --dir    an unpacked app, to try
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const root = path.resolve(desktop, "../..");
// pnpm is a .cmd on Windows, which Node runs only through a shell.
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

run("pnpm", ["build:backend"]);
run("node", [path.join(here, "fetch-pi.mjs")]);
run("pnpm", ["--filter", "@tomradex/ui", "build"]);
fs.rmSync(path.join(desktop, "ui"), { recursive: true, force: true });
fs.cpSync(path.join(root, "packages/ui/dist"), path.join(desktop, "ui"), { recursive: true });
// The About pane names the build; extraMetadata lands in the packaged package.json.
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const stamp = [`-c.extraMetadata.commit=${commit}`, `-c.extraMetadata.builtAt=${new Date().toISOString()}`];
run("pnpm", ["exec", "electron-builder", ...stamp, ...process.argv.slice(2).filter((a) => a !== "--")], desktop);
