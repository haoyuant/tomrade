/**
 * The packages plugin authors install from npm. On the SDK's version line:
 * @tomradex/domain (the types a plugin sees), @tomradex/plugin-sdk (the
 * contract), @tomradex/plugin-cli (one bundled file per entry, with the app's
 * exports for its check) and @tomradex/plugin-host (the Tomrade the CLI tests a
 * plugin against, bundled). On the app's version line, every other package of
 * the app as a full-mode plugin imports it: its declarations only, since
 * Tomrade hands the plugin its own copies at run time. All Apache-2.0, like the
 * rest of the repository. Staged under build/npm/ and packed there.
 *
 *   node scripts/npm-release.mjs              stage and pack
 *   node scripts/npm-release.mjs --verify     …and typecheck a full-mode plugin against the packs, outside the checkout
 *   node scripts/npm-release.mjs --publish    …then npm publish each version npm does not have (npm login or NPM_TOKEN)
 *   … --publish --dry-run                     the same, publishing nothing
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// esbuild is the CLI's own dependency; pnpm does not hoist it to the root.
const esbuild = await import(pathToFileURL(createRequire(path.join(root, "packages/plugin-cli/package.json")).resolve("esbuild")).href);
const out = path.join(root, "build", "npm");
const publish = process.argv.includes("--publish");
const dryRun = process.argv.includes("--dry-run");
const verify = process.argv.includes("--verify");
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

// Every package ships the repository's root LICENSE; the field must agree with it.
const ROOT_LICENSE = json(path.join(root, "package.json")).license;
const licenseFile = () => path.join(root, "LICENSE");
function licensed(source) {
  const { license } = json(path.join(source, "package.json"));
  if (!license) throw new Error(`${source} needs a "license" field`);
  if (license !== ROOT_LICENSE) throw new Error(`${source} is ${license} but ships the root LICENSE (${ROOT_LICENSE})`);
  return license;
}

function stage(name, source, files, pkg) {
  const dir = path.join(out, name.replace("@tomradex/", ""));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [from, to] of [...files, [licenseFile(source), "LICENSE"]]) fs.cpSync(from, path.join(dir, to), { recursive: true, filter: (src) => !src.endsWith(".map") && !src.endsWith(".tsbuildinfo") });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name, ...common, license: licensed(source), ...pkg }, null, 2)}\n`);
  return dir;
}

run("pnpm", ["build:backend"]);
fs.rmSync(out, { recursive: true, force: true });

const domain = stage(
  "@tomradex/domain",
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
  "@tomradex/plugin-sdk",
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
    dependencies: { "@tomradex/domain": VERSION, zod }
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
  external: ["cordis", "zod", "zod/*", "@tomradex/plugin-sdk", "@tomradex/domain", "better-sqlite3"],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "warning"
});
fs.copyFileSync(path.join(hostSource, "README.md"), path.join(hostDir, "README.md"));
fs.copyFileSync(licenseFile(hostSource), path.join(hostDir, "LICENSE"));
fs.writeFileSync(
  path.join(hostDir, "package.json"),
  `${JSON.stringify(
    {
      name: "@tomradex/plugin-host",
      ...common,
      license: licensed(hostSource),
      description: json(path.join(hostSource, "package.json")).description,
      main: "dist/index.js",
      exports: { ".": "./dist/index.js" },
      files: ["dist"],
      dependencies: { "@tomradex/domain": VERSION, "@tomradex/plugin-sdk": VERSION, "better-sqlite3": sqlite, cordis, zod }
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
  external: ["cordis", "zod", "zod/*", "@tomradex/plugin-sdk", "@tomradex/domain", "@tomradex/plugin-host", "esbuild", ...Object.keys(thirdParty)],
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
      name: "@tomradex/plugin-cli",
      ...common,
      license: licensed(cliSource),
      description: "tomrade-plugin: scaffold, build, test in a sandbox, check and pack a Tomrade plugin",
      keywords: ["tomrade", "tomrade-plugin", "cli"],
      bin: { "tomrade-plugin": "dist/cli.js" },
      main: "dist/index.js",
      exports: { ".": "./dist/index.js" },
      files: ["dist"],
      dependencies: { "@tomradex/domain": VERSION, "@tomradex/plugin-sdk": VERSION, "@tomradex/plugin-host": VERSION, cordis, esbuild: esbuildVersion, zod, ...thirdParty }
    },
    null,
    2
  )}\n`
);

// What each of the app's packages exports, so the CLI's check can hold a full-mode plugin's imports to this Tomrade.
const APP_VERSION = json(path.join(root, "apps/desktop/package.json")).version;
const { collectAppExports, APP_EXPORTS_FILE } = await import(pathToFileURL(path.join(root, "packages/plugin-cli/dist/app-exports.js")).href);
fs.writeFileSync(path.join(cliDir, "dist", APP_EXPORTS_FILE), `${JSON.stringify(await collectAppExports(root, APP_VERSION), null, 2)}\n`);

// The app's own packages, declarations only, all at the app's version as dsh's move together.
const SDK_LINE = new Set(["@tomradex/domain", "@tomradex/plugin-sdk", "@tomradex/plugin-cli", "@tomradex/plugin-host"]);
// Types every package leans on stay dependencies; the rest are optional peers, so a types install builds nothing native.
const KEPT = new Set(["cordis", "zod"]);
const typesOut = path.join(out, "types");
const typed = [];
for (const name of fs.readdirSync(path.join(root, "packages")).sort()) {
  const source = path.join(root, "packages", name);
  if (!fs.existsSync(path.join(source, "package.json"))) continue;
  const pkg = json(path.join(source, "package.json"));
  if (!pkg.name?.startsWith("@tomradex/") || SDK_LINE.has(pkg.name) || !pkg.exports) continue;
  const dir = path.join(typesOut, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(source, "dist"), path.join(dir, "dist"), { recursive: true, filter: (src) => fs.statSync(src).isDirectory() || src.endsWith(".d.ts") });
  if (fs.existsSync(path.join(source, "README.md"))) fs.copyFileSync(path.join(source, "README.md"), path.join(dir, "README.md"));
  fs.copyFileSync(licenseFile(source), path.join(dir, "LICENSE"));
  fs.writeFileSync(
    path.join(dir, "dist/runtime.js"),
    `throw new Error(${JSON.stringify(`${pkg.name} is Tomrade's own code: a full-mode plugin gets the running app's copy, so load the plugin in Tomrade`)});\n`
  );
  const exports = Object.fromEntries(Object.entries(pkg.exports).map(([sub, target]) => [sub, { types: typeof target === "string" ? target.replace(/\.js$/, ".d.ts") : target.types, default: "./dist/runtime.js" }]));
  const dependencies = {};
  const peerDependencies = {};
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
    if (dep.startsWith("@tomradex/")) dependencies[dep] = SDK_LINE.has(dep) ? VERSION : APP_VERSION;
    else if (KEPT.has(dep)) dependencies[dep] = range;
    else peerDependencies[dep] = range;
  }
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: pkg.name,
        ...common,
        version: APP_VERSION,
        license: licensed(source),
        description: `${pkg.description ?? pkg.name} — declarations for full-mode plugins; Tomrade provides the code at run time`,
        keywords: ["tomrade", "tomrade-plugin", "types"],
        types: exports["."]?.types,
        exports,
        files: ["dist"],
        dependencies,
        ...(Object.keys(peerDependencies).length ? { peerDependencies, peerDependenciesMeta: Object.fromEntries(Object.keys(peerDependencies).map((d) => [d, { optional: true }])) } : {})
      },
      null,
      2
    )}\n`
  );
  typed.push(dir);
}

const packs = path.join(out, "packs");
fs.mkdirSync(packs, { recursive: true });
for (const dir of [domain, sdkDir, hostDir, cliDir, ...typed]) run("npm", ["pack", "--pack-destination", packs, "--silent"], dir);

if (verify) {
  // A full-mode plugin as an author writes it, far from the checkout, with nothing but the packs and the registry.
  const sample = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tomrade-full-plugin-"));
  const tarballs = Object.fromEntries(fs.readdirSync(packs).map((f) => [f.replace(/^tomradex-/, "@tomradex/").replace(/-\d+\.\d+\.\d+.*\.tgz$/, ""), `file:${path.join(packs, f)}`]));
  fs.writeFileSync(path.join(sample, "package.json"), JSON.stringify({ name: "sample", private: true, type: "module", devDependencies: { ...tarballs, typescript: json(path.join(root, "packages/plugin-sdk/package.json")).devDependencies.typescript, "@types/node": json(path.join(root, "packages/llm/package.json")).devDependencies["@types/node"] }, overrides: tarballs }, null, 2));
  fs.writeFileSync(path.join(sample, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true, types: ["node"] }, include: ["index.ts"] }, null, 2));
  fs.writeFileSync(
    path.join(sample, "index.ts"),
    `import type { Context } from "cordis";
import { Llm, type ModelProviderSpec } from "@tomradex/llm";
import { WebSearch } from "@tomradex/web-search";

const echo = {} as ModelProviderSpec;

export default {
  name: "sample",
  inject: ["llm", "webSearch"],
  apply(ctx: Context) {
    const own: boolean = ctx.llm instanceof Llm && ctx.webSearch instanceof WebSearch;
    const off: () => void = ctx.llm.registerProvider(echo);
    const searching: string[] = ctx.webSearch.providers().map((p) => p.id);
    // the declarations are real, not any: a wrong call is an error
    // @ts-expect-error a provider spec, not a string
    ctx.llm.registerProvider("echo");
    return { own, off, searching };
  }
};
`
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], sample);
  run("npx", ["tsc", "-p", "."], sample);
  console.log(`a full-mode plugin typechecks against the packs, outside the checkout (${sample})`);
}

if (publish) {
  if (APP_VERSION === "0.1.0") throw new Error("apps/desktop is at a checkout's 0.1.0: set the release's version first (npm pkg set version=…)");
  const deferred = [];
  for (const dir of [domain, sdkDir, hostDir, cliDir, ...typed]) {
    const { name, version } = json(path.join(dir, "package.json"));
    // A version is published once; the SDK line's often stays as it was over several app releases.
    const listed = (() => {
      try {
        return execFileSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === version;
      } catch {
        return false;
      }
    })();
    if (listed) {
      console.log(`${name}@${version} is on npm already`);
      continue;
    }
    // npm backs off up to a minute on each retry; a refused new package would hold the job for that long, one by one.
    const published = spawnSync("npm", ["publish", "--access", "public", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=3000", ...(dryRun ? ["--dry-run"] : [])], { cwd: dir, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
    process.stderr.write(published.stderr ?? "");
    if (published.status === 0) continue;
    // npm limits how many new packages an account creates in a while; the rest wait for .github/workflows/npm-packages.yml.
    if (/\bE429\b|429 Too Many Requests/.test(published.stderr ?? "")) deferred.push(`${name}@${version}`);
    else throw new Error(`npm publish ${name}@${version} failed (exit ${published.status})`);
  }
  if (deferred.length) console.log(`::warning::npm refused ${deferred.length} new package(s) for now (429); the daily npm packages workflow publishes them once it allows: ${deferred.join(", ")}`);
}
console.log(`\nstaged and packed in ${path.relative(root, out)} (SDK ${VERSION}, app ${APP_VERSION}, ${typed.length} declaration packages)${publish ? (dryRun ? "; publish dry run" : "; published") : ""}`);
