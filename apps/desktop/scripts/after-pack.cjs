// CI builds on one arm64 Mac, where pnpm installs more than one platform's
// optional packages: both arches for the x64 Mac (pnpm install --cpu=arm64
// --cpu=x64), and the Mac's own beside Windows' or Linux's for the cross-built
// apps. Each app keeps only its own esbuild.
//
// better-sqlite3 brings a prebuilt binary for every platform and SQLite's
// sources to compile one; each app keeps only the binary it loads. node-pty
// (the built-in terminal) is the same, and only the Windows app keeps it.
//
// Nor does it keep what only a build or an editor reads: TypeScript sources and
// declarations, examples and tests, readmes and changelogs, node-addon-api's
// headers, or esbuild's CLI copy of its binary.
//
// electron-builder leaves every .d.ts out of node_modules, the plugin SDK's
// too; Plugin Studio hands the agent its contract.d.ts, so it is copied back.
//
// None keeps the agent SDK's Claude Code (~190 MB, musl builds included): the
// engine always passes the person's own CLI as pathToClaudeCodeExecutable, and
// the SDK reads its bundled copy only without one.
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

/**
 * Leave better-sqlite3 only what an app on `platform`/`arch` loads: its own prebuilt binary (lib/binding.js picks
 * `<platform>-<arch>.node`), not the other platforms' nor what compiles one. The AppImage needs glibc, so a
 * Linux app never loads the musl builds. A universal Mac app keeps both Mac arches.
 */
function pruneSqlite(modules, platform, arch) {
  const dir = path.join(modules, "better-sqlite3");
  if (!fs.existsSync(dir)) return;
  const keep = new Set((arch === "universal" ? ["x64", "arm64"] : [arch]).map((cpu) => `${platform}-${cpu}.node`));
  const prebuilds = path.join(dir, "prebuilds");
  const missing = [...keep].filter((name) => !fs.existsSync(path.join(prebuilds, name)));
  // without its binary the app could not open a database: fail the build, not the first start
  if (missing.length) throw new Error(`better-sqlite3 has no prebuilt ${missing.join(", ")}`);
  for (const name of fs.readdirSync(prebuilds)) if (!keep.has(name)) fs.rmSync(path.join(prebuilds, name), { force: true });
  for (const name of ["deps", "src", "build", "binding.gyp"]) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}
exports.pruneSqlite = pruneSqlite;

/** What node-pty loads over ConPTY with useConptyDll, beside its lib: the rest is winpty, debug symbols and sources. */
const CONPTY_FILES = ["conpty.node", "conpty_console_list.node", "conpty/OpenConsole.exe", "conpty/conpty.dll"];

/**
 * The built-in terminal is Windows' alone: other apps carry none of it. A Windows app keeps node-pty's lib and its
 * own arch's ConPTY runtime, not winpty, the .pdb files, other platforms' prebuilds or the sources.
 */
function pruneConpty(modules, platform, arch) {
  const dir = path.join(modules, "node-pty");
  if (platform !== "win32") {
    for (const gone of ["node-pty", "@xterm/headless", "@tomradex/pty-host"]) fs.rmSync(path.join(modules, gone), { recursive: true, force: true });
    return;
  }
  const prebuilds = path.join(dir, "prebuilds");
  const own = path.join(prebuilds, `win32-${arch}`);
  const missing = CONPTY_FILES.filter((file) => !fs.existsSync(path.join(own, file)));
  // without it no terminal opens in the Terminal window: fail the build, not the first terminal
  if (missing.length) throw new Error(`node-pty has no prebuilt win32-${arch} ${missing.join(", ")}`);
  for (const name of fs.readdirSync(prebuilds)) if (name !== `win32-${arch}`) fs.rmSync(path.join(prebuilds, name), { recursive: true, force: true });
  const keep = new Set(CONPTY_FILES.map((file) => path.normalize(file)));
  const walk = (at, rel) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const name = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(full, name);
      else if (!keep.has(name)) fs.rmSync(full, { force: true });
    }
  };
  walk(own, "");
  for (const name of ["deps", "src", "third_party", "scripts", "typings", "build", "binding.gyp"]) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  for (const name of fs.readdirSync(path.join(dir, "lib"))) if (/\.test\.js$/.test(name)) fs.rmSync(path.join(dir, "lib", name), { force: true });
}
exports.pruneConpty = pruneConpty;

const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const NOTES = /^(?:readme|changelog|history)(?:\.(?:md|markdown|txt))?$/i;
const SAMPLES = new Set(["examples", "__tests__"]);

/** The splash draws its logo from these, one for each icon the app may wear. */
const ICON_FILES = ["icon.png", "icon-mac.png"];

/**
 * Both icons have to reach the packaged app: one missing there leaves the splash with
 * nothing to draw, which the person meets as a white plate. Fail the build, not the first start.
 */
function requireIcons(resources) {
  const missing = ICON_FILES.filter((name) => {
    const file = path.join(resources, "app/assets", name);
    return !fs.existsSync(file) || fs.statSync(file).size === 0;
  });
  if (missing.length) throw new Error(`the packaged app carries no ${missing.join(", ")}`);
}
exports.requireIcons = requireIcons;

/** The plugin SDK as the workspace built it, which electron-builder copied without its declarations. */
const SDK_SOURCE = path.join(__dirname, "../node_modules/@tomradex/plugin-sdk");

/**
 * Copy the plugin SDK's declarations into the packaged app. Without contract.d.ts, Plugin Studio's plugin_reference
 * answers "(not built)": fail the build, not the agent.
 */
function restoreSdkDeclarations(modules, source = SDK_SOURCE) {
  const from = path.join(source, "dist");
  if (!fs.existsSync(path.join(from, "contract.d.ts"))) throw new Error(`the plugin SDK has no dist/contract.d.ts in ${source}`);
  const to = path.join(modules, "@tomradex/plugin-sdk/dist");
  for (const name of fs.readdirSync(from)) if (DECLARATION.test(name)) fs.copyFileSync(path.join(from, name), path.join(to, name));
}
exports.restoreSdkDeclarations = restoreSdkDeclarations;

/**
 * Drop from node_modules what no running app reads. Tomrade's own packages keep their non-TS files (playbooks are
 * Markdown); the plugin SDK keeps its declarations, which Plugin Studio hands the agent (contract.d.ts).
 */
function pruneUnused(modules) {
  for (const gone of ["node-addon-api", "esbuild/bin/esbuild"]) fs.rmSync(path.join(modules, gone), { recursive: true, force: true });
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      const own = at.startsWith("@tomradex/");
      if (entry.isDirectory()) {
        if (!own && SAMPLES.has(entry.name)) fs.rmSync(full, { recursive: true, force: true });
        else {
          walk(full, at);
          if (!fs.readdirSync(full).length) fs.rmdirSync(full);
        }
      } else if (
        DECLARATION.test(entry.name) ? !at.startsWith("@tomradex/plugin-sdk/")
          : TS_SOURCE.test(entry.name) || (own ? at.split("/").length === 3 && entry.name === "tsconfig.json" : NOTES.test(entry.name))
      ) fs.rmSync(full, { force: true });
    }
  };
  walk(modules, "");
}
exports.pruneUnused = pruneUnused;

exports.default = async ({ electronPlatformName, arch, appOutDir, packager }) => {
  const own = Arch[arch];
  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents/Resources")
      : path.join(appOutDir, "resources");
  const modules = path.join(resources, "app/node_modules");
  requireIcons(resources);
  const prune = (scope, drop) => {
    const dir = path.join(modules, scope);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (drop(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  };
  prune("@anthropic-ai", (name) => name.startsWith("claude-agent-sdk-"));
  pruneSqlite(modules, electronPlatformName, own);
  pruneConpty(modules, electronPlatformName, own);
  restoreSdkDeclarations(modules);
  prune("@esbuild", (name) => {
    const [, os, cpu] = name.match(/^([a-z0-9]+)-([a-z0-9]+)$/) ?? [];
    return os && (os !== electronPlatformName || cpu !== own);
  });
  // esbuild's install copied the build machine's binary over its CLI; its API
  // runs @esbuild/<platform>'s and nothing runs the CLI, so pruneUnused drops it.
  pruneUnused(modules);
};
