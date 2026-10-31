// `pnpm install:dev`: builds Tomrade from this checkout and installs it over the installed app, for trying a change in
// the real app: an unsigned macOS arm64 app over /Applications/Tomrade.app, which updates to the next release by delta,
// or on Windows an unsigned NSIS installer run silently over the existing install, or on Linux an AppImage for this
// machine's arch over the one Tomrade's desktop entry starts. Its version is the next release plus -dev (0.23.0-dev while
// 0.22.0 is the latest tag).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");

const mac = process.platform === "darwin" && process.arch === "arm64";
const win = process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64");
const linux = process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64");
if (!mac && !win && !linux) {
  console.error("install:dev builds for macOS on Apple silicon, or Windows or Linux (x64, arm64) only.");
  process.exit(1);
}

// A tag with a suffix is a prerelease, so only plain vX.Y.Z counts.
const tags = execFileSync("git", ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*"], { cwd: root, encoding: "utf8" })
  .split(/\r?\n/)
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

if (mac) installMac();
else if (win) installWindows();
else installLinux();

function installMac() {
  const target = "/Applications/Tomrade.app";
  fs.rmSync(path.join(desktop, "release/mac-arm64"), { recursive: true, force: true });
  // The zip, not --dir: only an installer target writes app-update.yml, and the zip and its blockmap seed the
  // differential download of the next release.
  // Without a Developer ID certificate electron-builder would fall back to any other one in the keychain.
  run("node", [path.join(desktop, "scripts/package.mjs"), "--mac", "zip", "--arm64", `-c.extraMetadata.version=${version}`, "-c.mac.identity=null"], {
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  });

  const built = path.join(desktop, "release/mac-arm64/Tomrade.app");
  const zip = path.join(desktop, "release", `Tomrade-${version}-mac-arm64.zip`);
  for (const file of [built, zip, `${zip}.blockmap`]) {
    if (!fs.existsSync(file)) {
      console.error(`The build left no ${file}.`);
      process.exit(1);
    }
  }
  // The updater's cache, named in app-update.yml (electron-builder derives it from the package name).
  const appUpdate = fs.readFileSync(path.join(built, "Contents/Resources/app-update.yml"), "utf8");
  const cacheName = /^updaterCacheDirName: '?([^'\n]+)'?$/m.exec(appUpdate)?.[1];
  if (!cacheName) {
    console.error("app-update.yml names no updaterCacheDirName.");
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
  const entitlements = path.join(desktop, "assets/entitlements.mac.plist");
  run("codesign", ["--force", "--deep", "--sign", "-", "--entitlements", entitlements, target]);
  // Squirrel installs only an update that meets the running app's designated requirement, which ad-hoc is its own
  // cdhash. Naming the bundle id instead lets a release, signed with the Developer ID, replace it.
  run("codesign", ["--force", "--sign", "-", "--entitlements", entitlements, "-r=designated => identifier \"com.tomrade.desktop\"", target]);

  // electron-updater takes the previous update.zip and its blockmap from here and downloads only the blocks a release changed.
  const updaterCache = path.join(os.homedir(), "Library/Caches", cacheName);
  fs.mkdirSync(updaterCache, { recursive: true });
  fs.copyFileSync(zip, path.join(updaterCache, "update.zip"));
  fs.copyFileSync(`${zip}.blockmap`, path.join(updaterCache, "current.blockmap"));

  const installed = execFileSync("defaults", ["read", `${target}/Contents/Info`, "CFBundleShortVersionString"], { encoding: "utf8" }).trim();
  console.log(`Installed Tomrade ${installed} at ${target}`);
  run("open", [target]);
}

function installWindows() {
  const arch = process.arch;
  fs.rmSync(path.join(desktop, "release", arch === "x64" ? "win-unpacked" : `win-${arch}-unpacked`), { recursive: true, force: true });
  // No certificate is configured for a local build, so the installer comes out unsigned.
  run("node", [path.join(desktop, "scripts/package.mjs"), "--win", `--${arch}`, `-c.extraMetadata.version=${version}`]);

  const installer = path.join(desktop, "release", `Tomrade-${version}-win-${arch}.exe`);
  if (!fs.existsSync(installer)) {
    console.error(`The build left no installer at ${installer}.`);
    process.exit(1);
  }

  // Windows has no way to ask it to quit from outside (closing its windows only hides them), so it is stopped:
  // the installer replaces the files it runs from.
  const before = windowsInstall();
  if (before && powershell(`@(${tomradeIn(before.dir)}).Count`) !== "0") {
    console.log("Stopping the running Tomrade (sessions using its MCP server reconnect when the new one starts)");
    powershell(`${tomradeIn(before.dir)} | Stop-Process -Force; Start-Sleep -Milliseconds 500`);
  }

  // Silent, it installs where the last install went (the installer's default the first time).
  run(installer, ["/S"]);

  const after = windowsInstall();
  if (!after) {
    console.error("The installer left no Tomrade install behind.");
    process.exit(1);
  }
  const exe = path.join(after.dir, "Tomrade.exe");
  console.log(`Installed Tomrade ${after.version} at ${after.dir}`);
  // From an administrator terminal it would inherit those rights, and so would the terminal host it starts, which a
  // Tomrade opened normally afterwards may not open: Explorer starts it as the signed-in user.
  if (elevated()) {
    console.log("Starting Tomrade without this terminal's administrator rights");
    spawn("explorer.exe", [exe], { detached: true, stdio: "ignore" }).unref();
  } else spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
}

function installLinux() {
  const arch = process.arch;
  fs.rmSync(path.join(desktop, "release", arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`), { recursive: true, force: true });
  run("node", [path.join(desktop, "scripts/package.mjs"), "--linux", `--${arch}`, `-c.extraMetadata.version=${version}`]);

  const built = path.join(desktop, "release", `Tomrade-${version}-linux-${arch}.AppImage`);
  if (!fs.existsSync(built)) {
    console.error(`The build left no AppImage at ${built}.`);
    process.exit(1);
  }

  // An AppImage installs nowhere: the installed one is the copy the desktop entry starts, else ~/Applications, where
  // AppImage tools keep them.
  const target = linuxInstall() ?? path.join(os.homedir(), "Applications", "Tomrade.AppImage");

  // Any running AppImage, not only the target: its single-instance lock would leave the new one just bringing it forward.
  // SIGTERM saves its state first (src/main.ts), then it is insisted on.
  const running = runningAppImages();
  if (running.length > 0) {
    console.log("Quitting the running Tomrade (sessions using its MCP server reconnect when the new one starts)");
    for (const pid of running) signal(pid, "SIGTERM");
    for (let i = 0; i < 20 && running.some(alive); i++) spawnSync("sleep", ["0.5"]);
    for (const pid of running.filter(alive)) signal(pid, "SIGKILL");
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const next = `${target}.new`;
  fs.copyFileSync(built, next);
  fs.chmodSync(next, 0o755);
  fs.renameSync(next, target);
  console.log(`Installed Tomrade ${version} at ${target}`);
  spawn(target, [], { detached: true, stdio: "ignore" }).unref();
}

/** The AppImage Tomrade's desktop entry starts (apps/desktop/src/desktop-entry.ts), if it is one. */
function linuxInstall() {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  let text;
  try {
    text = fs.readFileSync(path.join(data, "applications", "tomrade.desktop"), "utf8");
  } catch {
    return null;
  }
  // quoteExec's quoting: the path in double quotes, with " ` $ \ escaped.
  const quoted = /^Exec="((?:\\.|[^"\\])*)"/m.exec(text)?.[1];
  const file = quoted?.replace(/\\(.)/g, "$1");
  return file?.endsWith(".AppImage") ? file : null;
}

/**
 * The main process of every running Tomrade AppImage: tomrade run from an AppImage's mount (AppRun beside it), with no
 * --type=. Chromium's process title writes over /proc/<pid>/environ, so APPIMAGE can't tell, and joins the command
 * line with spaces.
 */
function runningAppImages() {
  const pids = [];
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const exe = fs.readlinkSync(`/proc/${pid}/exe`);
      if (path.basename(exe) !== "tomrade" || !fs.existsSync(path.join(path.dirname(exe), "AppRun"))) continue;
      if (!/[\0 ]--type=/.test(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"))) pids.push(Number(pid));
    } catch {
      // Gone since the listing, or another user's.
    }
  }
  return pids;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

function elevated() {
  return powershell("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)") === "True";
}

/** The installed Tomrade's folder and version, from the uninstall entry its installer wrote (per user or per machine). */
function windowsInstall() {
  const keys = ["HKCU:", "HKLM:"].map((hive) => `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*`).join(",");
  const out = powershell(
    `Get-ItemProperty ${keys} -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Tomrade *' } | Select-Object -First 1 DisplayVersion, UninstallString | ConvertTo-Json -Compress`,
  );
  if (!out) return null;
  const entry = JSON.parse(out);
  const uninstaller = /^"([^"]+)"/.exec(entry.UninstallString ?? "")?.[1];
  return uninstaller ? { dir: path.dirname(uninstaller), version: entry.DisplayVersion } : null;
}

function tomradeIn(dir) {
  return `Get-Process Tomrade -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${dir.replaceAll("'", "''")}\\*' }`;
}

function powershell(command) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" }).trim();
}
