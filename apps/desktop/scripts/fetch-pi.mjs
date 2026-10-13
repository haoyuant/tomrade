/**
 * Puts the Pi coding agent that the built-in agent runs into vendor/pi: the
 * npm package's bundle, plus the two packages it still loads at run time —
 * photon for resizing images, jiti for loading extensions (Tomrade's MCP
 * bridge is one). All are pinned and checked against npm's integrity hashes. The app runs the
 * bundle with its own binary as Node, so a machine needs neither Node nor npm.
 *
 *   pnpm --filter @tomrade/desktop fetch:pi
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../vendor/pi");
const PACKAGES = [
  {
    spec: "@earendil-works/pi-coding-agent@1.1.0",
    integrity: "sha512-SeEi/4hdcHNgA9UWlefZl7ZZpm3dzi2OoxNjDHsBJ9o298LNOtbL4DGKgitlEj6uCTccvtw6f2hlCkTPVJ2RXg==",
    into: ".",
    // Its system prompt points the model at the README and docs.
    keep: ["package.json", "README.md", "docs", "dist/bundle"]
  },
  {
    spec: "@silvia-odwyer/photon-node@0.3.4",
    integrity: "sha512-bnly4BKB3KDTFxrUIcgCLbaeVVS8lrAkri1pEzskpmxu9MdfGQTy8b8EgcD83ywD3RPMsIulY8xJH5Awa+t9fA==",
    into: "node_modules/@silvia-odwyer/photon-node",
    keep: null
  },
  {
    spec: "jiti@2.7.0",
    integrity: "sha512-AC/7JofJvZGrrneWNaEnJeOLUx+JlGt7tNa0wZiRPT4MY1wmfKjt2+6O2p2uz2+skll8OZZmJMNqeke7kKbNgQ==",
    into: "node_modules/jiti",
    keep: null
  }
];

const stamp = path.join(target, ".fetched");
const wanted = PACKAGES.map((p) => `${p.spec} ${p.integrity}`).join("\n");
if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === wanted) {
  console.log("vendor/pi is up to date");
  process.exit(0);
}

/** Pi loading an extension, the way the built-in agent starts it: a module the bundle needs at run time and lacks fails here, not in someone's first turn. */
function smokeTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-smoke-"));
  try {
    const extension = path.join(dir, "smoke.ts");
    fs.writeFileSync(extension, "export default function (pi) {}\n");
    const out = execFileSync(process.execPath, [path.join(target, "dist/bundle/cli.js"), "--mode", "rpc", "-e", extension], {
      cwd: dir,
      input: '{"type":"get_state","id":"smoke"}\n',
      env: { ...process.env, HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: path.join(dir, ".pi") },
      encoding: "utf8",
      timeout: 30_000
    });
    if (!out.split(/\r?\n/).some((line) => line.includes('"id":"smoke"') && line.includes('"success":true'))) throw new Error(`Pi did not answer:\n${out}`);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error(`vendor/pi does not start with an extension: ${error.stderr || error.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-fetch-pi-"));
// npm brings the registry and proxy the machine is set up with; npm is a .cmd on Windows.
const npm = (args) => execFileSync("npm", args, { cwd: scratch, encoding: "utf8", shell: process.platform === "win32" });
try {
  fs.rmSync(target, { recursive: true, force: true });
  for (const pkg of PACKAGES) {
    const file = path.join(scratch, npm(["pack", pkg.spec, "--silent"]).trim().split(/\r?\n/).at(-1));
    const actual = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;
    if (actual !== pkg.integrity) throw new Error(`${pkg.spec}: integrity ${actual} does not match the pinned ${pkg.integrity}`);
    const unpacked = path.join(scratch, path.basename(file, ".tgz"));
    fs.mkdirSync(unpacked);
    execFileSync("tar", ["-xzf", file, "-C", unpacked]);
    const from = path.join(unpacked, "package");
    const into = path.join(target, pkg.into);
    for (const entry of pkg.keep ?? fs.readdirSync(from)) {
      fs.cpSync(path.join(from, entry), path.join(into, entry), { recursive: true });
    }
  }
  // The npm package ships no licence file; this is the one from its v1.1.0 tag.
  fs.copyFileSync(path.join(here, "vendor/pi-LICENSE"), path.join(target, "LICENSE"));
  smokeTest();
  fs.writeFileSync(stamp, wanted);
  console.log(`vendor/pi: ${PACKAGES.map((p) => p.spec).join(", ")}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
