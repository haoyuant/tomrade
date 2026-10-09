/**
 * The packages plugin authors install from npm: @tomrade/domain (the types a
 * plugin sees), @tomrade/plugin-sdk (the contract), @tomrade/plugin-cli (one
 * bundled file per entry) and @tomrade/plugin-host (the Tomrade the CLI tests
 * a plugin against, bundled, under the repository's Business Source License).
 * Staged under build/npm/, packed there, and published only with --publish.
 *
 *   node scripts/npm-release.mjs              stage and pack
 *   node scripts/npm-release.mjs --publish    …then npm publish each (npm login first)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// esbuild is the CLI's own dependency; pnpm does not hoist it to the root.
const esbuild = await import(pathToFileURL(createRequire(path.join(root, "packages/plugin-cli/package.json")).resolve("esbuild")).href);
const out = path.join(root, "build", "npm");
const publish = process.argv.includes("--publish");
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const sdk = json(path.join(root, "packages/plugin-sdk/package.json"));
const VERSION = sdk.version;
const zod = sdk.dependencies.zod;
const cordis = json(path.join(root, "packages/plugin-cli/package.json")).dependencies.cordis;
const esbuildVersion = json(path.join(root, "packages/plugin-cli/package.json")).dependencies.esbuild;
const sqlite = json(path.join(root, "packages/db/package.json")).dependencies["better-sqlite3"];
// Third-party code stays a dependency rather than bundled, so each ships with its own license.
const kit = json(path.join(root, "packages/plugin-kit/package.json")).dependencies;
const thirdParty = { "@babel/parser": kit["@babel/parser"], tar: kit.tar };

const common = {
  version: VERSION,
  type: "module",
  author: "Haoyuan Tang",
  ...(process.env.TOMRADE_NPM_HOMEPAGE ? { homepage: process.env.TOMRADE_NPM_HOMEPAGE } : {}),
  engines: { node: ">=22" },
  publishConfig: { access: "public" }
};

// A package with its own LICENSE carries that; everything else is under the repository's root LICENSE.
const licenseFile = (source) => (fs.existsSync(path.join(source, "LICENSE")) ? path.join(source, "LICENSE") : path.join(root, "LICENSE"));
function licensed(source) {
  const { license } = json(path.join(source, "package.json"));
  if (!license) throw new Error(`${source} needs a "license" field`);
  const own = fs.existsSync(path.join(source, "LICENSE"));
  if (license === "BUSL-1.1" && own) throw new Error(`${source} is under the root LICENSE and must not carry its own`);
  if (license !== "BUSL-1.1" && !own) throw new Error(`${source} needs a LICENSE file for ${license}`);
  return license;
}

function stage(name, source, files, pkg) {
  const dir = path.join(out, name.replace("@tomrade/", ""));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [from, to] of [...files, [licenseFile(source), "LICENSE"]]) fs.cpSync(from, path.join(dir, to), { recursive: true, filter: (src) => !src.endsWith(".map") && !src.endsWith(".tsbuildinfo") });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name, ...common, license: licensed(source), ...pkg }, null, 2)}\n`);
  return dir;
}

run("pnpm", ["build:backend"]);
fs.rmSync(out, { recursive: true, force: true });

const domain = stage(
  "@tomrade/domain",
  path.join(root, "packages/domain"),
  [
    [path.join(root, "packages/domain/dist"), "dist"],
    [path.join(root, "packages/domain/README.md"), "README.md"]
  ],
  {
    description: "Tomrade's domain types and schemas: the issues, fields, boards, views and history a plugin reads",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    files: ["dist"],
    dependencies: { zod }
  }
);

const sdkDir = stage(
  "@tomrade/plugin-sdk",
  path.join(root, "packages/plugin-sdk"),
  [
    [path.join(root, "packages/plugin-sdk/dist"), "dist"],
    [path.join(root, "packages/plugin-sdk/README.md"), "README.md"]
  ],
  {
    description: sdk.description,
    keywords: ["tomrade", "tomrade-plugin", "plugin", "sdk"],
    main: "dist/index.js",
    types: "dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    files: ["dist"],
    dependencies: { "@tomrade/domain": VERSION, zod }
  }
);

// The host a plugin is tested against is Tomrade's own code, bundled. What a plugin
// shares with it, and what is native, stays a dependency so there is one copy of each.
const hostSource = path.join(root, "packages/plugin-host");
const hostDir = path.join(out, "plugin-host");
fs.mkdirSync(path.join(hostDir, "dist"), { recursive: true });
await esbuild.build({
  absWorkingDir: root,
  entryPoints: { index: "packages/plugin-host/src/index.ts" },
  outdir: path.join(hostDir, "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["cordis", "zod", "zod/*", "@tomrade/plugin-sdk", "@tomrade/domain", "better-sqlite3"],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "warning"
});
fs.copyFileSync(path.join(hostSource, "README.md"), path.join(hostDir, "README.md"));
fs.copyFileSync(licenseFile(hostSource), path.join(hostDir, "LICENSE"));
fs.writeFileSync(
  path.join(hostDir, "package.json"),
  `${JSON.stringify(
    {
      name: "@tomrade/plugin-host",
      ...common,
      license: licensed(hostSource),
      description: json(path.join(hostSource, "package.json")).description,
      main: "dist/index.js",
      exports: { ".": "./dist/index.js" },
      files: ["dist"],
      dependencies: { "@tomrade/domain": VERSION, "@tomrade/plugin-sdk": VERSION, "better-sqlite3": sqlite, cordis, zod }
    },
    null,
    2
  )}\n`
);

// The CLI is the plugin author's tooling and carries no Tomrade code; the host is a dependency.
const cliDir = path.join(out, "plugin-cli");
fs.mkdirSync(path.join(cliDir, "dist"), { recursive: true });
await esbuild.build({
  absWorkingDir: root,
  entryPoints: {
    cli: "packages/plugin-cli/src/cli.ts",
    index: "packages/plugin-cli/src/index.ts",
    child: "packages/plugin-cli/src/child.ts"
  },
  outdir: path.join(cliDir, "dist"),
  bundle: true,
  splitting: false,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["cordis", "zod", "zod/*", "@tomrade/plugin-sdk", "@tomrade/domain", "@tomrade/plugin-host", "esbuild", ...Object.keys(thirdParty)],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "warning"
});
fs.writeFileSync(path.join(cliDir, "dist/cli.js"), `#!/usr/bin/env node\n${fs.readFileSync(path.join(cliDir, "dist/cli.js"), "utf8").replace(/^#!.*\n/m, "")}`);
fs.chmodSync(path.join(cliDir, "dist/cli.js"), 0o755);
const cliSource = path.join(root, "packages/plugin-cli");
fs.copyFileSync(path.join(cliSource, "README.md"), path.join(cliDir, "README.md"));
fs.copyFileSync(licenseFile(cliSource), path.join(cliDir, "LICENSE"));
fs.writeFileSync(
  path.join(cliDir, "package.json"),
  `${JSON.stringify(
    {
      name: "@tomrade/plugin-cli",
      ...common,
      license: licensed(cliSource),
      description: "tomrade-plugin: scaffold, build, test in a sandbox, check and pack a Tomrade plugin",
      keywords: ["tomrade", "tomrade-plugin", "cli"],
      bin: { "tomrade-plugin": "dist/cli.js" },
      main: "dist/index.js",
      exports: { ".": "./dist/index.js" },
      files: ["dist"],
      dependencies: { "@tomrade/domain": VERSION, "@tomrade/plugin-sdk": VERSION, "@tomrade/plugin-host": VERSION, cordis, esbuild: esbuildVersion, zod, ...thirdParty }
    },
    null,
    2
  )}\n`
);

for (const dir of [domain, sdkDir, hostDir, cliDir]) {
  run("npm", ["pack", "--pack-destination", out], dir);
  if (publish) run("npm", ["publish", "--access", "public"], dir);
}
console.log(`\nstaged and packed in ${path.relative(root, out)}${publish ? "; published" : ""}`);
