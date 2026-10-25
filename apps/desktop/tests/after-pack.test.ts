import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const { pruneSqlite, pruneUnused, requireIcons, restoreSdkDeclarations } = createRequire(import.meta.url)("../scripts/after-pack.cjs") as {
  pruneSqlite: (modules: string, platform: string, arch: string) => void;
  pruneUnused: (modules: string) => void;
  requireIcons: (resources: string) => void;
  restoreSdkDeclarations: (modules: string, source?: string) => void;
};

const PREBUILDS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "linuxmusl-arm64", "linuxmusl-x64", "win32-arm64", "win32-x64"];
const dirs: string[] = [];

/** node_modules holding better-sqlite3 as its package installs it. */
function modules(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-after-pack-"));
  dirs.push(root);
  const pkg = path.join(root, "better-sqlite3");
  for (const sub of ["lib", "prebuilds", "deps/sqlite3", "src", "build/Release"]) fs.mkdirSync(path.join(pkg, sub), { recursive: true });
  for (const name of PREBUILDS) fs.writeFileSync(path.join(pkg, "prebuilds", `${name}.node`), "");
  fs.writeFileSync(path.join(pkg, "lib/binding.js"), "");
  fs.writeFileSync(path.join(pkg, "deps/sqlite3/sqlite3.c"), "");
  fs.writeFileSync(path.join(pkg, "binding.gyp"), "");
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  return root;
}
const left = (root: string) => fs.readdirSync(path.join(root, "better-sqlite3")).sort();
const prebuilds = (root: string) => fs.readdirSync(path.join(root, "better-sqlite3/prebuilds")).sort();

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("the icons the splash draws", () => {
  /** A packaged app's resources folder, with the icons an app carries — or not. */
  function resources(withIcons: string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-after-pack-"));
    dirs.push(root);
    for (const name of withIcons) {
      const file = path.join(root, "app/assets", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    return root;
  }

  it("passes an app carrying both", () => {
    expect(() => requireIcons(resources(["icon.png", "icon-mac.png"]))).not.toThrow();
  });

  it("fails the build when one is missing, or is empty", () => {
    expect(() => requireIcons(resources(["icon.png"]))).toThrow(/no icon-mac\.png/);
    const empty = resources(["icon.png", "icon-mac.png"]);
    fs.writeFileSync(path.join(empty, "app/assets/icon.png"), "");
    expect(() => requireIcons(empty)).toThrow(/no icon\.png/);
  });
});

describe("the plugin SDK's declarations", () => {
  /** The packaged plugin SDK as electron-builder copies it: no declarations. */
  function packaged(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-after-pack-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, "@tomradex/plugin-sdk/dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "@tomradex/plugin-sdk/dist/contract.js"), "");
    return root;
  }

  it("copies the workspace's into the app, contract.d.ts among them", () => {
    const root = packaged();
    restoreSdkDeclarations(root);
    const dist = path.join(root, "@tomradex/plugin-sdk/dist");
    expect(fs.readFileSync(path.join(dist, "contract.d.ts"), "utf8")).toMatch(/export interface PluginContext\b/);
    expect(fs.readdirSync(dist)).toEqual(expect.arrayContaining(["contract.js", "contract.d.ts", "index.d.ts"]));
    expect(fs.readdirSync(dist).filter((name) => name.endsWith(".map"))).toEqual([]);
  });

  it("fails the build when the SDK was built without them", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-after-pack-"));
    dirs.push(source);
    fs.mkdirSync(path.join(source, "dist"));
    expect(() => restoreSdkDeclarations(packaged(), source)).toThrow(/no dist\/contract\.d\.ts/);
  });
});

describe("better-sqlite3 in a packaged app", () => {
  it.each([
    ["darwin", "arm64", ["darwin-arm64.node"]],
    ["darwin", "x64", ["darwin-x64.node"]],
    ["darwin", "universal", ["darwin-arm64.node", "darwin-x64.node"]],
    ["win32", "x64", ["win32-x64.node"]],
    ["linux", "x64", ["linux-x64.node"]],
    ["linux", "arm64", ["linux-arm64.node"]]
  ])("keeps only the binary a %s %s app loads, and nothing that compiles one", (platform, arch, kept) => {
    const root = modules();
    pruneSqlite(root, platform, arch);
    expect(prebuilds(root)).toEqual(kept);
    expect(left(root)).toEqual(["lib", "package.json", "prebuilds"]);
  });

  it("fails the build when the target's binary is missing, leaving the package as it was", () => {
    const root = modules();
    fs.rmSync(path.join(root, "better-sqlite3/prebuilds/win32-arm64.node"));
    expect(() => pruneSqlite(root, "win32", "arm64")).toThrow(/no prebuilt win32-arm64\.node/);
    expect(prebuilds(root)).toHaveLength(PREBUILDS.length - 1);
    expect(left(root)).toContain("deps");
  });

  it("does nothing for an app without it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-after-pack-"));
    dirs.push(root);
    expect(() => pruneSqlite(root, "darwin", "arm64")).not.toThrow();
  });
});

describe("what no running app reads", () => {
  const files = (root: string): string[] => fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();

  it("drops TypeScript sources and declarations, samples, notes, build headers and esbuild's CLI copy, and keeps what runs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-after-pack-"));
    dirs.push(root);
    const write = (rel: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), ""); };
    for (const rel of [
      "zod/package.json", "zod/LICENSE", "zod/README.md", "zod/index.js", "zod/index.d.ts", "zod/index.d.cts",
      "zod/src/v4/classic/schemas.ts", "zod/src/v4/classic/tests/string.test.ts",
      "ajv/dist/core.js", "ajv/dist/core.d.ts", "ajv/lib/core.ts", "ajv/CHANGELOG.md", "ajv/docs/guide.md",
      "@modelcontextprotocol/sdk/dist/esm/server/index.js", "@modelcontextprotocol/sdk/dist/esm/examples/server/simple.js",
      "fast-uri/test/__tests__/uri.js", "fast-uri/index.js", "fast-uri/types/index.d.mts", "fast-uri/lib/scopedChars.mts",
      "node-addon-api/napi.h", "node-addon-api/package.json",
      "esbuild/package.json", "esbuild/lib/main.js", "esbuild/bin/esbuild", "@esbuild/darwin-arm64/bin/esbuild",
      "@tomradex/code-link/package.json", "@tomradex/code-link/tsconfig.json", "@tomradex/code-link/dist/index.js",
      "@tomradex/code-link/dist/index.d.ts", "@tomradex/code-link/src/index.ts", "@tomradex/code-link/playbooks/implement.md",
      "@tomradex/code-link/README.md",
      "@tomradex/plugin-sdk/dist/index.js", "@tomradex/plugin-sdk/dist/contract.d.ts", "@tomradex/plugin-sdk/src/contract.ts",
      "@tomradex/plugin-sdk/src/templates/plugin.json"
    ]) write(rel);

    pruneUnused(root);

    expect(files(root)).toEqual([
      "@esbuild/darwin-arm64/bin/esbuild",
      "@modelcontextprotocol/sdk/dist/esm/server/index.js",
      "@tomradex/code-link/README.md",
      "@tomradex/code-link/dist/index.js",
      "@tomradex/code-link/package.json",
      "@tomradex/code-link/playbooks/implement.md",
      "@tomradex/plugin-sdk/dist/contract.d.ts",
      "@tomradex/plugin-sdk/dist/index.js",
      "@tomradex/plugin-sdk/src/templates/plugin.json",
      "ajv/dist/core.js",
      "ajv/docs/guide.md",
      "esbuild/lib/main.js",
      "esbuild/package.json",
      "fast-uri/index.js",
      "zod/LICENSE",
      "zod/index.js",
      "zod/package.json"
    ]);
    // folders the sources left empty go too
    expect(fs.existsSync(path.join(root, "zod/src"))).toBe(false);
    expect(fs.existsSync(path.join(root, "esbuild/bin"))).toBe(false);
  });
});
