// `pnpm install:dev`: builds an unsigned macOS arm64 app from this checkout and installs it over /Applications/Tomrade.app,
// for trying a change in the real app. Its version is the next release plus -dev (0.23.0-dev while 0.22.0 is the latest tag).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");
const target = "/Applications/Tomrade.app";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("install:dev builds for macOS on Apple silicon only.");
  process.exit(1);
}

// A tag with a suffix is a prerelease, so only plain vX.Y.Z counts.
const tags = execFileSync("git", ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  .map((tag) => tag.slice(1).split(".").map(Number))
  .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
const latest = tags.at(-1);
if (!latest) {
  console.error("No release tag (vX.Y.Z) here: run `git fetch --tags` first.");
  process.exit(1);
}
const version = `${latest[0]}.${latest[1] + 1}.0-dev`;
console.log(`Latest release ${latest.join(".")}, building ${version}`);

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...options });

fs.rmSync(path.join(desktop, "release/mac-arm64"), { recursive: true, force: true });
// Without a Developer ID certificate electron-builder would fall back to any other one in the keychain.
run("node", [path.join(desktop, "scripts/package.mjs"), "--mac", "--arm64", "--dir", `-c.extraMetadata.version=${version}`, "-c.mac.identity=null"], {
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
});

const built = path.join(desktop, "release/mac-arm64/Tomrade.app");
if (!fs.existsSync(built)) {
  console.error(`The build left no app at ${built}.`);
  process.exit(1);
}

// Quit gently so it saves its state, then insist: the install replaces the files it runs from.
if (spawnSync("pgrep", ["-f", `${target}/Contents/MacOS/`]).status === 0) {
  console.log("Quitting the running Tomrade (sessions using its MCP server reconnect when the new one starts)");
  spawnSync("osascript", ["-e", 'tell application id "com.tomrade.desktop" to quit']);
  for (let i = 0; i < 20 && spawnSync("pgrep", ["-f", `${target}/Contents/MacOS/`]).status === 0; i++) {
    spawnSync("sleep", ["0.5"]);
  }
  spawnSync("pkill", ["-f", `${target}/Contents/MacOS/`]);
}

fs.rmSync(target, { recursive: true, force: true });
run("ditto", [built, target]);
// Arm64 refuses unsigned code; an ad-hoc signature is enough for a local app.
run("codesign", ["--force", "--deep", "--sign", "-", "--entitlements", path.join(desktop, "assets/entitlements.mac.plist"), target]);

const installed = execFileSync("defaults", ["read", `${target}/Contents/Info`, "CFBundleShortVersionString"], { encoding: "utf8" }).trim();
console.log(`Installed Tomrade ${installed} at ${target}`);
run("open", [target]);
