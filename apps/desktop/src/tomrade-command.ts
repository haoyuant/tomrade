import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "cordis";
import type {} from "@tomradex/settings";
import { errorMessage } from "@tomradex/contracts";
import { DESKTOP_WORDS } from "./words.js";

/** What the command reads each time it runs: where Tomrade answers, what starts it, the language it speaks. */
export interface CommandConfig {
  /** The MCP port's base, `http://127.0.0.1:19090`. */
  url: string;
  /** What starts Tomrade when it is not running: the .app on macOS, the executable elsewhere; empty for a checkout. */
  open: string;
  locale: string;
}

/** Where the `tomrade` command goes and what it runs. Every path is injected, so tests and checks never touch the person's own. */
export interface CommandPlace {
  platform: NodeJS.Platform;
  /** The person's home: their shell's files and `~/.local/bin`. */
  home: string;
  /** zsh's folder for its files, when the person set ZDOTDIR. */
  zdotdir?: string;
  /** The person's login shell. */
  shell: string;
  /** The folders on the person's PATH, as their shell sets it. */
  pathDirs: string[];
  /** Tomrade's own folder for the command: the launcher and its config. */
  dir: string;
  /** The binary that runs the script as Node. */
  runtime: string;
  /** The command itself: the app's dist/tomrade-cli.js. */
  script: string;
  /** Linux: the AppImage the runtime is mounted from, in a folder of that run alone. */
  appImage?: string;
  config: CommandConfig;
}

/** What placing it did: a link in a folder already on PATH, a line in the shell's files, the Windows user PATH; or taken off. */
export interface Placed {
  how: "link" | "profile" | "userPath" | "off";
  /** The files it changed. */
  where: string[];
}

/** Runs a program and resolves when it ends; rejects when it fails. Injected for Windows' registry and for tests. */
export type Runner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;

const runFile: Runner = (file, args, env) =>
  new Promise((resolve, reject) => execFile(file, args, { env, timeout: 30_000, windowsHide: true }, (error) => (error ? reject(error) : resolve())));

const BEGIN = "# >>> tomrade command >>>";
const END = "# <<< tomrade command <<<";
const NOTE = "# Put here by Tomrade (Settings › Sessions); turning that setting off takes these lines out.";
const MARKER = "placed.json";

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const dq = (s: string) => `"${s.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
const fishq = (s: string) => `'${s.replace(/[\\']/g, (c) => `\\${c}`)}'`;
const batch = (s: string) => s.replace(/%/g, "%%");

export const launcherName = (platform: NodeJS.Platform) => (platform === "win32" ? "tomrade.cmd" : "tomrade");

/** The launcher: the app's binary running the command's script as Node, told where its config is. */
export function launcherText(place: CommandPlace): string {
  const config = path.join(place.dir, "cli.json");
  if (place.platform === "win32")
    return ["@echo off", "rem The tomrade command, written by Tomrade (Settings > Sessions). Turning that setting off removes it.", "setlocal", `set "TOMRADE_CLI_CONFIG=${batch(config)}"`, "set ELECTRON_RUN_AS_NODE=1", `"${batch(place.runtime)}" "${batch(place.script)}" %*`, ""].join("\r\n");
  const lines = ["#!/bin/sh", "# The tomrade command, written by Tomrade (Settings › Sessions). Turning that setting off removes it.", `export TOMRADE_CLI_CONFIG=${sq(config)}`];
  if (place.appImage) {
    // An AppImage runs from a folder of that run alone, gone while Tomrade is not running: start it, and run again once it wrote this file anew.
    const said = DESKTOP_WORDS(place.config.locale)("cliDidNotStart");
    lines.push(
      `if [ ! -x ${sq(place.runtime)} ]; then`,
      `  if [ -z "\${TOMRADE_CLI_AGAIN:-}" ]; then`,
      `    ${sq(place.appImage)} >/dev/null 2>&1 &`,
      "    i=0",
      `    while [ "$i" -lt 90 ] && grep -qF ${sq(place.runtime)} "$0"; do sleep 1; i=$((i + 1)); done`,
      `    TOMRADE_CLI_AGAIN=1 exec "$0" "$@"`,
      "  fi",
      `  echo ${sq(said)} >&2`,
      "  exit 1",
      "fi"
    );
  }
  lines.push("export ELECTRON_RUN_AS_NODE=1", `exec ${sq(place.runtime)} ${sq(place.script)} "$@"`, "");
  return lines.join("\n");
}

/** The lines a POSIX shell's file gets: the command's folder last on PATH, once. */
export function profileBlock(dir: string): string {
  return [BEGIN, NOTE, `case ":$PATH:" in *${sq(`:${dir}:`)}*) ;; *) export PATH="$PATH:"${dq(dir)} ;; esac`, END, ""].join("\n");
}

/** fish reads a file of its own from conf.d; it goes whole. */
export function fishFile(dir: string): string {
  return [NOTE.replace("these lines out", "this file away"), `if not contains -- ${fishq(dir)} $PATH`, `    set -gx PATH $PATH ${fishq(dir)}`, "end", ""].join("\n");
}

/** A file's text without the block Tomrade put there; the same text when it has none. */
export function withoutBlock(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && line.trim() === BEGIN) inside = true;
    else if (inside && line.trim() === END) inside = false;
    else if (!inside) out.push(line);
  }
  return out.join("\n");
}

const read = (file: string) => fs.readFile(file, "utf8").catch(() => null);
const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

/** Writes only what changed, so a start with nothing to do writes nothing. */
async function writeIfChanged(file: string, text: string, mode?: number): Promise<boolean> {
  if ((await read(file)) === text) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, mode ? { mode } : undefined);
  if (mode) await fs.chmod(file, mode);
  return true;
}

const fishPath = (place: CommandPlace) => path.join(place.home, ".config", "fish", "conf.d", "tomrade.fish");
const linkPath = (place: CommandPlace) => path.join(place.home, ".local", "bin", "tomrade");

/** Every shell file a block may be in, for taking it out wherever an earlier shell put it. */
const allProfiles = (place: CommandPlace) => [...new Set([path.join(place.zdotdir ?? place.home, ".zshrc"), path.join(place.home, ".zshrc"), ...[".bashrc", ".bash_profile", ".bash_login", ".profile"].map((f) => path.join(place.home, f))])];

/** The files the person's shell reads for an interactive session: zsh's rc, bash's rc and the login file it reads, or the POSIX profile. */
async function profilesFor(place: CommandPlace): Promise<string[]> {
  const shell = path.basename(place.shell);
  if (shell === "zsh") return [path.join(place.zdotdir ?? place.home, ".zshrc")];
  if (shell === "bash") {
    // A login bash reads the first of these it finds; making a .bash_profile beside a .profile would hide that one.
    const login = [".bash_profile", ".bash_login", ".profile"].map((f) => path.join(place.home, f));
    const found = (await Promise.all(login.map(exists))).findIndex(Boolean);
    return [path.join(place.home, ".bashrc"), login[found < 0 ? 0 : found]!];
  }
  return [path.join(place.home, ".profile")];
}

async function takeBlockOut(file: string): Promise<boolean> {
  const text = await read(file);
  if (text === null || !text.includes(BEGIN)) return false;
  const rest = withoutBlock(text);
  // A file that held only the block was made for it; left empty, a .bash_profile would hide the person's .profile.
  if (rest.trim()) await fs.writeFile(file, rest);
  else await fs.rm(file, { force: true });
  return true;
}

async function putBlockIn(file: string, dir: string): Promise<boolean> {
  const text = (await read(file)) ?? "";
  const bare = withoutBlock(text);
  const next = `${bare}${bare === "" || bare.endsWith("\n") ? "" : "\n"}${profileBlock(dir)}`;
  if (next === text) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, next);
  return true;
}

/** Our link: a symlink to this launcher. Anything else at that path is someone else's. */
async function ourLink(link: string, launcher: string): Promise<boolean> {
  try {
    return path.resolve(path.dirname(link), await fs.readlink(link)) === launcher;
  } catch {
    return false;
  }
}

/** Off a POSIX PATH: the link if it is ours, the blocks, the fish file. */
async function unplacePosix(place: CommandPlace, launcher: string, keep?: "link" | "profile"): Promise<string[]> {
  const changed: string[] = [];
  const link = linkPath(place);
  if (keep !== "link" && (await ourLink(link, launcher))) {
    await fs.rm(link, { force: true });
    changed.push(link);
  }
  if (keep !== "profile") {
    for (const file of allProfiles(place)) if (await takeBlockOut(file)) changed.push(file);
    const fish = fishPath(place);
    if ((await read(fish))?.includes("Put here by Tomrade")) {
      await fs.rm(fish, { force: true });
      changed.push(fish);
    }
  }
  return changed;
}

/**
 * The Windows user PATH, read and written in the registry as the kind it is (an expandable string keeps its
 * %USERPROFILE%), then announced so new terminals see it. The folder comes in an environment variable, unquoted.
 */
const USER_PATH_SCRIPT = [
  "$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$old = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "$d = $env:TOMRADE_CLI_DIR.TrimEnd('\\')",
  "$parts = @($old -split ';' | Where-Object { $_ -ne '' })",
  "$rest = @($parts | Where-Object { $_.TrimEnd('\\') -ine $d })",
  "if ($env:TOMRADE_CLI_ON -eq '1') { if ($rest.Count -lt $parts.Count) { exit 0 }; $next = @($parts) + $d } else { if ($rest.Count -eq $parts.Count) { exit 0 }; $next = $rest }",
  "$kind = if ($k.GetValueNames() -contains 'Path') { $k.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }",
  "if ($next.Count) { $k.SetValue('Path', ($next -join ';'), $kind) } else { $k.DeleteValue('Path', $false) }",
  // Setting any user variable through .NET tells every window the environment changed.
  "[Environment]::SetEnvironmentVariable('TOMRADE_CLI_PATH_CHANGED', $null, 'User')"
].join("\n");

const userPath = (on: boolean, dir: string, run: Runner) =>
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", USER_PATH_SCRIPT], { ...process.env, TOMRADE_CLI_DIR: dir, TOMRADE_CLI_ON: on ? "1" : "0" });

/**
 * Puts the `tomrade` command on the person's PATH, or takes it off, without admin rights. macOS and Linux: a link in
 * `~/.local/bin` when that folder is on their PATH, else a marked block in their shell's file adding Tomrade's own
 * folder; Windows: that folder on the user PATH. Off takes out whatever is ours, and the folder itself. Idempotent:
 * run again it changes nothing.
 */
export async function placeCommand(on: boolean, place: CommandPlace, run: Runner = runFile): Promise<Placed> {
  const launcher = path.join(place.dir, launcherName(place.platform));
  const marker = path.join(place.dir, MARKER);
  if (!on) {
    const where: string[] = [];
    if (place.platform === "win32") {
      // Only once it was put there: nothing is read from the registry at every start for nothing.
      if (await exists(place.dir)) {
        await userPath(false, place.dir, run);
        where.push("HKCU\\Environment\\Path");
      }
    } else where.push(...(await unplacePosix(place, launcher)));
    if (await exists(place.dir)) {
      await fs.rm(place.dir, { recursive: true, force: true });
      where.push(place.dir);
    }
    return { how: "off", where };
  }
  await writeIfChanged(launcher, launcherText(place), place.platform === "win32" ? undefined : 0o755);
  await writeIfChanged(path.join(place.dir, "cli.json"), `${JSON.stringify(place.config, null, 2)}\n`);
  if (place.platform === "win32") {
    const done = await read(marker);
    if (done !== place.dir) {
      await userPath(true, place.dir, run);
      await fs.writeFile(marker, place.dir);
    }
    return { how: "userPath", where: ["HKCU\\Environment\\Path"] };
  }
  const link = linkPath(place);
  const bin = path.dirname(link);
  const onPath = place.pathDirs.some((d) => path.resolve(d) === bin);
  if (onPath && ((await ourLink(link, launcher)) || !(await exists(link)))) {
    if (!(await ourLink(link, launcher))) {
      await fs.mkdir(bin, { recursive: true });
      await fs.symlink(launcher, link);
    }
    await unplacePosix(place, launcher, "link");
    return { how: "link", where: [link] };
  }
  const shell = path.basename(place.shell);
  const files = shell === "fish" ? [fishPath(place)] : await profilesFor(place);
  if (shell === "fish") await writeIfChanged(fishPath(place), fishFile(place.dir));
  else for (const file of files) await putBlockIn(file, place.dir);
  // A link left from when ~/.local/bin was on PATH goes; blocks in files this shell does not read stay, harmless and ours to take out when off.
  if (await ourLink(link, launcher)) await fs.rm(link, { force: true });
  return { how: "profile", where: files };
}

/**
 * Keeps the command placed as Settings › Sessions says: once a while after the start, never on its own path, and again
 * whenever settings change in a way that matters (the switch, the language, the port). Runs one at a time.
 */
export function keepCommandPlaced(ctx: Context, place: () => CommandPlace, on: () => boolean, delayMs = 5_000, run?: Runner): void {
  const log = ctx.logger("tomrade-command");
  let applied: string | null = null;
  let chain = Promise.resolve();
  const sync = () => {
    chain = chain.then(async () => {
      const target = place();
      const want = on();
      const key = JSON.stringify([want, target]);
      if (key === applied) return;
      try {
        const done = await placeCommand(want, target, run);
        applied = key;
        if (done.where.length) log.info(`the tomrade command ${want ? `is on PATH (${done.how})` : "is off PATH"}: ${done.where.join(", ")}`);
      } catch (error) {
        log.warn(`the tomrade command was not ${want ? "put on" : "taken off"} PATH: ${errorMessage(error)}`);
      }
    });
  };
  const timer = setTimeout(sync, delayMs);
  timer.unref?.();
  ctx.on("settings/changed", sync);
}
