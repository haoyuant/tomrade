/**
 * The packages plugin authors install from npm: @tomrade/domain (the types a
 * plugin sees), @tomrade/plugin-sdk (the contract) and @tomrade/plugin-cli
 * (one bundled file per entry; the host it tests against is inside it).
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

// Each package carries its own license; the repository itself has none.
function licensed(source) {
  const { license } = json(path.join(source, "package.json"));
  if (!license || !fs.existsSync(path.join(source, "LICENSE"))) throw new Error(`${source} needs a "license" field and a LICENSE file`);
  return license;
}

function stage(name, source, files, pkg) {
  const dir = path.join(out, name.replace("@tomrade/", ""));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [from, to] of [...files, [path.join(source, "LICENSE"), "LICENSE"]]) fs.cpSync(from, path.join(dir, to), { recursive: true, filter: (src) => !src.endsWith(".map") && !src.endsWith(".tsbuildinfo") });
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

// The CLI carries the host it tests against. What a plugin shares with the host,
// and what is native, stays a dependency so there is one copy of each.
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
  external: ["cordis", "zod", "zod/*", "@tomrade/plugin-sdk", "@tomrade/domain", "esbuild", "better-sqlite3", ...Object.keys(thirdParty)],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "warning"
});
fs.writeFileSync(path.join(cliDir, "dist/cli.js"), `#!/usr/bin/env node\n${fs.readFileSync(path.join(cliDir, "dist/cli.js"), "utf8").replace(/^#!.*\n/m, "")}`);
fs.chmodSync(path.join(cliDir, "dist/cli.js"), 0o755);
const cliSource = path.join(root, "packages/plugin-cli");
fs.copyFileSync(path.join(cliSource, "README.md"), path.join(cliDir, "README.md"));
fs.copyFileSync(path.join(cliSource, "LICENSE"), path.join(cliDir, "LICENSE"));
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
      dependencies: { "@tomrade/domain": VERSION, "@tomrade/plugin-sdk": VERSION, "better-sqlite3": sqlite, cordis, esbuild: esbuildVersion, zod, ...thirdParty }
    },
    null,
    2
  )}\n`
);

for (const dir of [domain, sdkDir, cliDir]) {
  run("npm", ["pack", "--pack-destination", out], dir);
  if (publish) run("npm", ["publish", "--access", "public"], dir);
}
console.log(`\nstaged and packed in ${path.relative(root, out)}${publish ? "; published" : ""}`);
