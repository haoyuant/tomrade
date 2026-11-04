import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProgram } from "@tomradex/testkit";
import { appendPath, borrowedNodeDirs, setUpBorrowedNode, shimFiles } from "../src/borrowed-node.js";

const roots: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-borrowed-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeNpm(root: string): string {
  const npmDir = path.join(root, "vendor", "npm");
  fs.mkdirSync(path.join(npmDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(npmDir, "bin", "npm-cli.js"), "console.log('fake npm', process.env.NPM_CONFIG_PREFIX, ...process.argv.slice(2))\n");
  fs.writeFileSync(path.join(npmDir, "bin", "npx-cli.js"), "console.log('fake npx')\n");
  return npmDir;
}

describe("the borrowed node and npm", () => {
  it("writes node, npm and npx shims that run the app's binary as Node, and puts them last on PATH", () => {
    const root = tempDir();
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    const setup = setUpBorrowedNode({ userData: root, npmDir: fakeNpm(root), runtime: "/Applications/T.app/Helper", platform: "darwin", env });

    expect(setup.problem).toBeUndefined();
    const names = fs.readdirSync(setup.binDir).sort();
    expect(names).toEqual(["node", "npm", "npx"]);
    const node = fs.readFileSync(path.join(setup.binDir, "node"), "utf8");
    expect(node).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(node).toContain('exec "/Applications/T.app/Helper" "$@"');
    const npm = fs.readFileSync(path.join(setup.binDir, "npm"), "utf8");
    expect(npm).toContain("npm-cli.js");
    expect(npm).toContain(`NPM_CONFIG_PREFIX="${setup.prefix}"`);
    expect(fs.statSync(path.join(setup.binDir, "npm")).mode & 0o100).toBeTruthy();
    // Last on PATH, so a system Node always wins; the prefix's bin too, so installed agents are found.
    expect(env.PATH).toBe(`/usr/bin:/bin:${setup.binDir}:${setup.prefixBin}`);
    expect(env.TOMRADE_NPM_PREFIX).toBe(setup.prefix);
    expect(env.TOMRADE_NODE_SHIMS).toBe(setup.binDir);
    expect(fs.existsSync(setup.prefixBin)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("the npm shim runs npm-cli.js with the prefix set, through a path with spaces", () => {
    const root = tempDir();
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    // The runtime path has a space, like /Applications/Tomrade.app/…/Tomrade Helper.
    // A script standing in for the binary: copying node itself trips macOS's slow first-spawn check under load.
    const runtime = path.join(root, "My App", "helper");
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    const runnable = fakeProgram(runtime, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    const setup = setUpBorrowedNode({ userData: root, npmDir: fakeNpm(root), runtime: runnable, platform: process.platform, env });

    const out = execFileSync(path.join(setup.binDir, "npm"), ["install", "-g", "x"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(out.trim()).toBe(`fake npm ${setup.prefix} install -g x`);
    // A prefix the person set themselves stands.
    const theirs = execFileSync(path.join(setup.binDir, "npm"), ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", NPM_CONFIG_PREFIX: "/their/own" } });
    expect(theirs.trim()).toBe("fake npm /their/own --version");
  });

  it("rewrites the shims from the app's current path at every start, and drops npm ones when the bundle is gone", () => {
    const root = tempDir();
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const npmDir = fakeNpm(root);
    setUpBorrowedNode({ userData: root, npmDir, runtime: "/mount/a/tomrade", platform: "linux", env });
    // The AppImage mounted somewhere new.
    const moved = setUpBorrowedNode({ userData: root, npmDir, runtime: "/mount/b/tomrade", platform: "linux", env });
    expect(fs.readFileSync(path.join(moved.binDir, "node"), "utf8")).toContain("/mount/b/tomrade");
    // PATH already carries the folders; they are not added again.
    expect(env.PATH).toBe(`/usr/bin:${moved.binDir}:${moved.prefixBin}`);

    fs.rmSync(npmDir, { recursive: true });
    const without = setUpBorrowedNode({ userData: root, npmDir, runtime: "/mount/c/tomrade", platform: "linux", env });
    expect(without.problem).toContain("no bundled npm");
    expect(fs.readdirSync(without.binDir)).toEqual(["node"]);
  });

  it("writes .cmd shims for Windows that hand the prefix and arguments on", () => {
    const files = shimFiles({ runtime: "C:\\Program Files\\Tomrade\\Tomrade.exe", npmDir: "C:\\Program Files\\Tomrade\\resources\\vendor\\npm", prefix: "C:\\Users\\a b\\AppData\\Roaming\\Tomrade\\borrowed-node\\global", platform: "win32" });
    expect(Object.keys(files).sort()).toEqual(["node.cmd", "npm.cmd", "npx.cmd"]);
    expect(files["node.cmd"]).toContain('"C:\\Program Files\\Tomrade\\Tomrade.exe" %*');
    expect(files["npm.cmd"]).toContain("set ELECTRON_RUN_AS_NODE=1");
    expect(files["npm.cmd"]).toContain('if not defined NPM_CONFIG_PREFIX set "NPM_CONFIG_PREFIX=C:\\Users\\a b\\AppData\\Roaming\\Tomrade\\borrowed-node\\global"');
    expect(files["npm.cmd"]).toContain('"C:\\Program Files\\Tomrade\\resources\\vendor\\npm\\bin\\npm-cli.js" %*');
  });

  it("puts the prefix beside the Windows commands, where npm installs them", () => {
    const dirs = borrowedNodeDirs("C:\\data", "win32");
    expect(dirs.prefixBin).toBe(dirs.prefix);
    expect(borrowedNodeDirs("/data", "linux").prefixBin).toBe(path.join("/data", "borrowed-node", "global", "bin"));
  });

  it("appends to PATH once, keeping what is already there ahead", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/a:/b" };
    appendPath(env, ["/c", "/a"], "linux");
    expect(env.PATH).toBe("/a:/b:/c");
    const win: NodeJS.ProcessEnv = { Path: "C:\\x" };
    appendPath(win, ["C:\\X", "C:\\y"], "win32");
    expect(win.Path).toBe("C:\\x;C:\\y");
  });
});
