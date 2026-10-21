import fs from "node:fs";
import path from "node:path";

/**
 * A machine without Node still installs and runs npm-based agents: the app
 * bundles npm (scripts/fetch-npm.mjs → vendor/npm) and lends its own binary as
 * Node. Shims named node/npm/npx live under the user data dir and go LAST on
 * the PATH of processes Tomrade starts, so a system Node (nvm, Homebrew, Volta,
 * the official installer) always wins; shell rc files and the system PATH are
 * never touched. Installs land in a prefix of Tomrade's own (NPM_CONFIG_PREFIX),
 * never inside the read-only app bundle, and need no admin rights.
 */

export interface BorrowedNode {
  /** The folder holding the node/npm/npx shims. */
  binDir: string;
  /** Where `npm i -g` through the shims puts packages — the locators read it from TOMRADE_NPM_PREFIX. */
  prefix: string;
  /** Where commands installed there land: `<prefix>/bin`, the prefix itself on Windows. */
  prefixBin: string;
}

export function borrowedNodeDirs(userData: string, platform: NodeJS.Platform = process.platform): BorrowedNode {
  const root = path.join(userData, "borrowed-node");
  const prefix = path.join(root, "global");
  return { binDir: path.join(root, "bin"), prefix, prefixBin: platform === "win32" ? prefix : path.join(prefix, "bin") };
}

/**
 * The shim files to write: name → content. All paths are absolute and baked in,
 * which is why the shims are rewritten at every start — an update moves the app,
 * and an AppImage mounts somewhere new every launch. Without a bundled npm
 * (a checkout that never fetched it) only `node` is written.
 */
export function shimFiles(opts: { runtime: string; npmDir: string | null; prefix: string; platform: NodeJS.Platform }): Record<string, string> {
  const { runtime, npmDir, prefix, platform } = opts;
  if (platform === "win32") {
    const cmd = (lines: string[]) => ["@echo off", "rem Written by Tomrade at every start. Do not edit.", "set ELECTRON_RUN_AS_NODE=1", ...lines, ""].join("\r\n");
    const files: Record<string, string> = { "node.cmd": cmd([`"${runtime}" %*`]) };
    if (npmDir) {
      const npmCmd = (cli: string) => cmd([`if not defined NPM_CONFIG_PREFIX set "NPM_CONFIG_PREFIX=${prefix}"`, `"${runtime}" "${path.win32.join(npmDir, "bin", cli)}" %*`]);
      files["npm.cmd"] = npmCmd("npm-cli.js");
      files["npx.cmd"] = npmCmd("npx-cli.js");
    }
    return files;
  }
  const sh = (lines: string[]) => ["#!/bin/sh", "# Written by Tomrade at every start. Do not edit.", "export ELECTRON_RUN_AS_NODE=1", ...lines, ""].join("\n");
  const files: Record<string, string> = { node: sh([`exec "${runtime}" "$@"`]) };
  if (npmDir) {
    const npmSh = (cli: string) => sh([`if [ -z "\${NPM_CONFIG_PREFIX:-}" ]; then export NPM_CONFIG_PREFIX="${prefix}"; fi`, `exec "${runtime}" "${path.posix.join(npmDir, "bin", cli)}" "$@"`]);
    files.npm = npmSh("npm-cli.js");
    files.npx = npmSh("npx-cli.js");
  }
  return files;
}

/** Append `dirs` to env's PATH after everything already there, once each. */
export function appendPath(env: NodeJS.ProcessEnv, dirs: string[], platform: NodeJS.Platform = process.platform): void {
  const sep = platform === "win32" ? ";" : ":";
  const key = platform === "win32" ? (Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path") : "PATH";
  const norm = (dir: string) => (platform === "win32" ? dir.toLowerCase() : dir);
  const current = (env[key] ?? "").split(sep).filter(Boolean);
  const have = new Set(current.map(norm));
  env[key] = [...current, ...dirs.filter((dir) => !have.has(norm(dir)))].join(sep);
}

export interface BorrowedSetup extends BorrowedNode {
  /** What could not be done, for the log: a folder refusing writes, no bundled npm. */
  problem?: string;
}

/**
 * Regenerate the shims from the app's current paths, make sure the prefix
 * exists, and add both folders last to `env`'s PATH — only processes Tomrade
 * starts see them. TOMRADE_NPM_PREFIX tells the CLI locators where borrowed
 * installs land, and TOMRADE_NODE_SHIMS tells a terminal Tomrade opens where
 * the shims are. The system npm, when there is one, sits earlier on PATH and
 * wins automatically; nothing asks which to use.
 */
export function setUpBorrowedNode(opts: {
  userData: string;
  /** vendor/npm beside the app's code. */
  npmDir: string;
  /** The binary that runs as Node — the Helper on macOS (node-runtime.ts). */
  runtime: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): BorrowedSetup {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const dirs = borrowedNodeDirs(opts.userData, platform);
  const npmDir = fs.existsSync(path.join(opts.npmDir, "bin", "npm-cli.js")) ? opts.npmDir : null;
  let problem = npmDir ? undefined : `no bundled npm at ${opts.npmDir}: without a system npm, npm-based agents cannot be installed`;
  try {
    fs.mkdirSync(dirs.binDir, { recursive: true });
    fs.mkdirSync(dirs.prefixBin, { recursive: true });
    const files = shimFiles({ runtime: opts.runtime, npmDir, prefix: dirs.prefix, platform });
    // The npm bundle gone (or renamed shims from an older build): their shims go too.
    for (const name of fs.readdirSync(dirs.binDir)) if (!(name in files)) fs.rmSync(path.join(dirs.binDir, name), { force: true });
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dirs.binDir, name);
      fs.writeFileSync(file, content);
      if (platform !== "win32") fs.chmodSync(file, 0o755);
    }
    // Which Node the borrowed installs were made with — an Electron upgrade changes it, and a reinstall can read why.
    fs.writeFileSync(path.join(opts.userData, "borrowed-node", "node-version"), `${process.versions.node}\n`);
  } catch (error) {
    problem = `borrowed node not set up: ${error instanceof Error ? error.message : String(error)}`;
  }
  appendPath(env, [dirs.binDir, dirs.prefixBin], platform);
  env.TOMRADE_NPM_PREFIX = dirs.prefix;
  env.TOMRADE_NODE_SHIMS = dirs.binDir;
  return { ...dirs, problem };
}
