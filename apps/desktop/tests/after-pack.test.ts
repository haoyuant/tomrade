import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const { pruneSqlite } = createRequire(import.meta.url)("../scripts/after-pack.cjs") as { pruneSqlite: (modules: string, platform: string, arch: string) => void };

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
