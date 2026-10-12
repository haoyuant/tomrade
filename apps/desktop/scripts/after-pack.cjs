// Both Macs are built on one arm64 Mac, where CI installs both arches'
// optional packages (pnpm install --cpu=arm64 --cpu=x64). Each app keeps only
// its own arch's binaries: the agent SDK's Claude Code and esbuild's.
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

exports.default = async ({ electronPlatformName, arch, appOutDir, packager }) => {
  if (electronPlatformName !== "darwin") return;
  const own = Arch[arch];
  const other = own === "arm64" ? "x64" : "arm64";
  const modules = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents/Resources/app/node_modules");
  for (const pkg of [`@anthropic-ai/claude-agent-sdk-darwin-${other}`, `@esbuild/darwin-${other}`]) {
    fs.rmSync(path.join(modules, pkg), { recursive: true, force: true });
  }
  // esbuild's install copied the build machine's binary over its CLI.
  fs.copyFileSync(path.join(modules, `@esbuild/darwin-${own}/bin/esbuild`), path.join(modules, "esbuild/bin/esbuild"));
};
