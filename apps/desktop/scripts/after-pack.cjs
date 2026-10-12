// CI builds on one arm64 Mac, where pnpm installs more than one platform's
// optional packages: both arches for the x64 Mac (pnpm install --cpu=arm64
// --cpu=x64), and the Mac's own beside Windows' or Linux's for the cross-built
// apps. Each app keeps only its own esbuild.
//
// None keeps the agent SDK's Claude Code (~190 MB, musl builds included): the
// engine always passes the person's own CLI as pathToClaudeCodeExecutable, and
// the SDK reads its bundled copy only without one.
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

exports.default = async ({ electronPlatformName, arch, appOutDir, packager }) => {
  const own = Arch[arch];
  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents/Resources")
      : path.join(appOutDir, "resources");
  const modules = path.join(resources, "app/node_modules");
  const prune = (scope, drop) => {
    const dir = path.join(modules, scope);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (drop(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  };
  prune("@anthropic-ai", (name) => name.startsWith("claude-agent-sdk-"));
  prune("@esbuild", (name) => {
    const [, os, cpu] = name.match(/^([a-z0-9]+)-([a-z0-9]+)$/) ?? [];
    return os && (os !== electronPlatformName || cpu !== own);
  });
  // esbuild's install copied the build machine's binary over its CLI. Windows
  // runs @esbuild/win32-x64's esbuild.exe and never reads it.
  if (electronPlatformName !== "win32") {
    fs.copyFileSync(
      path.join(modules, `@esbuild/${electronPlatformName}-${own}/bin/esbuild`),
      path.join(modules, "esbuild/bin/esbuild"),
    );
  }
};
