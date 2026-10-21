/**
 * Puts the npm the app lends to machines without Node into vendor/npm. The app
 * runs it with its own binary as Node (src/borrowed-node.ts), so npm-based
 * agents install on a machine that has neither Node nor npm. Pinned and checked
 * against npm's integrity hash, like fetch-pi.mjs.
 *
 *   pnpm --filter @tomrade/desktop fetch:npm
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../vendor/npm");
// The version verified against the app's Electron Node (v24); npm's own engines allow ^20.17.0 || >=22.9.0.
const SPEC = "npm@11.12.1";
const INTEGRITY = "sha512-zcoUuF1kezGSAo0CqtvoLXX3mkRqzuqYdL6Y5tdo8g69NVV3CkjQ6ZBhBgB4d7vGkPcV6TcvLi3GRKPDFX+xTA==";
// What the CLI runs from; man pages and docs stay out of the installer.
const KEEP = ["bin", "lib", "node_modules", "index.js", "package.json", "LICENSE"];

const stamp = path.join(target, ".fetched");
const wanted = `${SPEC} ${INTEGRITY}`;
if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === wanted) {
  console.log("vendor/npm is up to date");
  process.exit(0);
}

/** The bundled npm answering --version with a prefix and cache of its own: broken, it fails here, not in someone's first install. */
function smokeTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-npm-smoke-"));
  try {
    const out = execFileSync(process.execPath, [path.join(target, "bin/npm-cli.js"), "--version"], {
      cwd: dir,
      env: { ...process.env, NPM_CONFIG_PREFIX: path.join(dir, "global"), npm_config_cache: path.join(dir, "cache") },
      encoding: "utf8",
      timeout: 30_000
    });
    const version = SPEC.split("@").at(-1);
    if (out.trim() !== version) throw new Error(`npm answered "${out.trim()}", not ${version}`);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error(`vendor/npm does not run: ${error.stderr || error.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-fetch-npm-"));
// npm brings the registry and proxy the machine is set up with; npm is a .cmd on Windows.
const npm = (args) => execFileSync("npm", args, { cwd: scratch, encoding: "utf8", shell: process.platform === "win32" });
try {
  fs.rmSync(target, { recursive: true, force: true });
  const file = path.join(scratch, npm(["pack", SPEC, "--silent"]).trim().split(/\r?\n/).at(-1));
  const actual = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;
  if (actual !== INTEGRITY) throw new Error(`${SPEC}: integrity ${actual} does not match the pinned ${INTEGRITY}`);
  const unpacked = path.join(scratch, path.basename(file, ".tgz"));
  fs.mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", file, "-C", unpacked]);
  const from = path.join(unpacked, "package");
  for (const entry of KEEP) {
    fs.cpSync(path.join(from, entry), path.join(target, entry), { recursive: true });
  }
  smokeTest();
  fs.writeFileSync(stamp, wanted);
  console.log(`vendor/npm: ${SPEC}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
