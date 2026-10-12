// CI builds on one arm64 Mac, where pnpm installs more than one platform's
// optional packages: both arches for the x64 Mac (pnpm install --cpu=arm64
// --cpu=x64), and the Mac's own beside Windows' or Linux's for the cross-built
// apps. Each app keeps only its own: the agent SDK's Claude Code and esbuild's.
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

const platformPackages = {
  "@anthropic-ai": /^claude-agent-sdk-([a-z0-9]+)-([a-z0-9]+)(-musl)?$/,
  "@esbuild": /^([a-z0-9]+)-([a-z0-9]+)$/,
};

exports.default = async ({ electronPlatformName, arch, appOutDir, packager }) => {
  const own = Arch[arch];
  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents/Resources")
      : path.join(appOutDir, "resources");
  const modules = path.join(resources, "app/node_modules");
  for (const [scope, pattern] of Object.entries(platformPackages)) {
    const dir = path.join(modules, scope);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      // An AppImage needs glibc, so a musl build would never run.
      const [, os, cpu, musl] = name.match(pattern) ?? [];
      if (os && (os !== electronPlatformName || cpu !== own || musl)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    }
  }
  // esbuild's install copied the build machine's binary over its CLI. Windows
  // runs @esbuild/win32-x64's esbuild.exe and never reads it.
  if (electronPlatformName !== "win32") {
    fs.copyFileSync(
      path.join(modules, `@esbuild/${electronPlatformName}-${own}/bin/esbuild`),
      path.join(modules, "esbuild/bin/esbuild"),
    );
  }
};
