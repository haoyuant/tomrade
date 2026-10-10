import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Git } from "@tomradex/storage";

const key = "credential.https://github.com.helper";
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The helper sits beside the settings file it reads — `<userData>/bin`, not the
 * Hub. It is machine-local (it execs this machine's Electron and reads this
 * machine's token) and every opted-in checkout's git config names its absolute
 * path, so it must not move when the user picks another Hub folder.
 */
const helperDir = (settings: string): string => path.join(path.dirname(settings), "bin");
const helperPath = (settings: string): string => path.join(helperDir(settings), "tomrade-credential");

const writeHelper = (file: string, content: string, mode: number): void => {
  const temporary = `${file}.${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, content, { mode, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

export function githubHttps(remote: string): boolean {
  try {
    const url = new URL(remote);
    return url.protocol === "https:" && url.host === "github.com" && !url.username && !url.password && !url.search && !url.hash && /^\/[^/]+\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export const credentialCommand = (settings: string): string => `!${quote(helperPath(settings))}`;

export const withGithubCredential = (settings: string, command: string): string => `${quote(helperPath(settings))} run bash -c ${quote(command)}`;

export async function githubEnvironment(git: Git, checkout: string, settings: string): Promise<Record<string, string>> {
  if (!await usesTomradeCredential(git, checkout, settings)) return {};
  const origin = await git(["remote", "get-url", "origin"], { cwd: checkout, ok: true });
  if (!githubHttps(origin.stdout.trim())) return {};
  try {
    const token: unknown = JSON.parse(fs.readFileSync(settings, "utf8")).github?.token;
    if (typeof token === "string" && token.trim() && !/[\r\n\0]/.test(token)) return { GH_TOKEN: token.trim(), GITHUB_TOKEN: token.trim() };
  } catch {}
  throw new Error("Reconnect your GitHub account in Tomrade before continuing this checkout.");
}

export async function usesTomradeCredential(git: Git, checkout: string, settings: string): Promise<boolean> {
  const result = await git(["config", "--local", "--get-all", key], { cwd: checkout, ok: true });
  return result.code === 0 && result.stdout.trimEnd() === `\n${credentialCommand(settings)}`;
}

/** A helper command this plugin wrote, wherever it lived. Earlier versions put it under the Hub. */
const namesOurHelper = (value: string): boolean => /^!.*[/\\]bin[/\\]tomrade-credential'?$/.test(value);

/** Repoint a checkout whose helper still lives under a Hub folder at the userData one. */
export async function migrateGithubCredential(git: Git, checkout: string, settings: string): Promise<boolean> {
  const result = await git(["config", "--local", "--get-all", key], { cwd: checkout, ok: true });
  if (result.code !== 0) return false;
  const current = credentialCommand(settings);
  const stale = result.stdout.split("\n").map((line) => line.trimEnd()).some((line) => !!line && line !== current && namesOurHelper(line));
  if (!stale) return false;
  await installGithubCredential(git, checkout, settings);
  return true;
}

/** The helper reads settings for each request, so token rotation never leaves a stale secret in git config. */
export async function installGithubCredential(git: Git, checkout: string, settings: string): Promise<void> {
  const bin = helperDir(settings);
  fs.mkdirSync(bin, { recursive: true });
  const helper = helperPath(settings);
  const source = `${helper}.cjs`;
  writeHelper(source, [
    'const fs = require("node:fs");',
    'const action = process.argv[2];',
    'if (action !== "get" && action !== "run") process.exit(0);',
    'try {',
    '  if (action === "get") {',
    '    const fields = Object.fromEntries(fs.readFileSync(0, "utf8").split("\\n").filter(Boolean).map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));',
    '    if (fields.protocol !== "https" || fields.host !== "github.com") process.exit(0);',
    '  }',
    `  const token = JSON.parse(fs.readFileSync(${JSON.stringify(path.resolve(settings))}, "utf8")).github?.token;`,
    '  if (typeof token !== "string" || !token.trim() || /[\\r\\n\\0]/.test(token)) process.exit(action === "run" ? 1 : 0);',
    '  if (action === "run") {',
    '    const env = { ...process.env, GH_TOKEN: token.trim(), GITHUB_TOKEN: token.trim() };',
    '    delete env.ELECTRON_RUN_AS_NODE;',
    '    const child = require("node:child_process").spawnSync(process.argv[3], process.argv.slice(4), { env, stdio: "inherit" });',
    '    process.exit(child.status ?? 1);',
    '  }',
    '  process.stdout.write("username=x-access-token\\npassword=" + token.trim() + "\\n\\n");',
    '} catch { process.exit(action === "run" ? 1 : 0); }',
    ''
  ].join("\n"), 0o600);
  writeHelper(helper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(source)} "$@"\n`, 0o700);

  // Linked worktrees share this config. Use git's lock convention so nobody sees half a helper chain.
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: checkout });
  const config = path.join(common.stdout.trim(), "config");
  const lock = `${config}.lock`;
  const fd = fs.openSync(lock, "wx", fs.statSync(config).mode & 0o777);
  try {
    fs.writeFileSync(fd, fs.readFileSync(config));
    fs.closeSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
    throw error;
  }
  try {
    await git(["config", "--file", lock, "--replace-all", key, ""], { cwd: checkout });
    await git(["config", "--file", lock, "--add", key, credentialCommand(settings)], { cwd: checkout });
    fs.renameSync(lock, config);
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
