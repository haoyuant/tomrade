import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliAttempt, CliCheck, CliSource, LocalCliStatus } from "@tomradex/agent";

/**
 * Finding a local agent's CLI the way a person's terminal would, and starting
 * it the way that terminal would. An app opened from the Dock or the Start menu
 * has a thinner PATH than the terminal the CLI was installed from, and on
 * Windows npm installs `codex.cmd`, which Node can neither find without PATHEXT
 * nor start without a shell.
 */

/** What the locator needs from the machine; tests swap it for a fake one. */
export interface CliHost {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** PATH as a new terminal would see it now: the registry on Windows, a login shell elsewhere. */
  freshPath(): Promise<string[]>;
  /** Where `npm i -g` puts commands, if npm answers. */
  npmPrefix(): Promise<string | null>;
  /** The CLI's path inside WSL, when Windows has WSL and the CLI is installed there. */
  wsl(name: string): Promise<string | null>;
  /** Where Windows' installed-apps list says apps whose display name matches were installed; none elsewhere. */
  installs(displayName: RegExp): Promise<string[]>;
  run(launch: CliLaunch, args: string[], timeoutMs: number): Promise<CliRunResult>;
}

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when there was no exit to report: the file did not start, or it was stopped for taking too long. */
  error?: { code?: string | number | null; killed?: boolean; message: string };
}

/** How to start one resolved CLI file. */
export interface CliLaunch {
  file: string;
  /** The program and arguments that run `file` with these arguments. */
  argv(args: string[]): { command: string; args: string[]; verbatim?: boolean };
  /** The environment to start it with: the CLI's own folder (and its node) first on PATH. */
  env(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

const RUNNABLE_EXTS = [".com", ".exe", ".bat", ".cmd"];
const TTL_MS = 30_000;

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

/** Windows env names are case-insensitive; a spawned child may carry `Path` rather than `PATH`. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const hit = Object.keys(env).find((k) => k.toUpperCase() === key.toUpperCase());
  return hit ? env[hit] : undefined;
}

function pathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return platform === "win32" ? (Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path") : "PATH";
}

export function splitPath(value: string | undefined, platform: NodeJS.Platform): string[] {
  return (value ?? "").split(platform === "win32" ? ";" : ":").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

/** The file names a bare command may have in one directory: PATHEXT's runnable kinds on Windows. */
export function fileNames(name: string, platform: NodeJS.Platform, pathext?: string): string[] {
  if (platform !== "win32") return [name];
  if (RUNNABLE_EXTS.includes(path.win32.extname(name).toLowerCase())) return [name];
  const listed = (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => RUNNABLE_EXTS.includes(e));
  return (listed.length ? listed : RUNNABLE_EXTS).map((ext) => name + ext);
}

function isFile(file: string, platform: NodeJS.Platform): boolean {
  return whyNot(file, platform) === null;
}

/** Why a path cannot be run as a program, or null when it can. */
function whyNot(file: string, platform: NodeJS.Platform): string | null {
  try {
    if (!fs.statSync(file).isFile()) return "not a file";
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EACCES" ? "not executable (no execute permission)" : "file not found";
  }
}

/** `%APPDATA%\npm` → the folder itself. Unknown names stay as written, like cmd does. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => envValue(env, name) ?? whole);
}

/** The Path value out of `reg query … /v Path`. */
export function parseRegPath(output: string): string | null {
  const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
  return match ? match[1].trim() : null;
}

/**
 * The install folders in `reg query …\Uninstall /s` output of the apps whose
 * DisplayName matches: InstallLocation, else the folder of the icon or the uninstaller.
 */
export function parseRegInstalls(output: string, displayName: RegExp): string[] {
  const w = path.win32;
  const dirs: string[] = [];
  for (const block of output.split(/\r?\n(?=HKEY_)/)) {
    const values = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const match = /^\s+(\S.*?)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
      if (match) values.set(match[1].toLowerCase(), match[2].trim());
    }
    if (!displayName.test(values.get("displayname") ?? "")) continue;
    // DisplayIcon is `"C:\…\App.exe",0`; UninstallString is `"C:\…\Uninstall App.exe" /currentuser`.
    const exe = (value?: string) => value && /^"?([^"]+?\.exe)/i.exec(value)?.[1];
    const location = values.get("installlocation")?.replace(/^"|"$/g, "");
    const file = exe(values.get("displayicon")) || exe(values.get("uninstallstring"));
    const dir = location ? w.normalize(location).replace(/\\+$/, "") : file ? w.dirname(file) : undefined;
    if (dir && !dirs.some((d) => d.toLowerCase() === dir.toLowerCase())) dirs.push(dir);
  }
  return dirs;
}

/**
 * npm, pnpm and yarn install a command on Windows as a `.cmd` file that runs
 * `node <script> %*`. Read the script out of it, so the CLI can be started as
 * node + script — no cmd.exe in between to mangle arguments or outlive a cancel.
 */
export function shimTarget(shim: string, text: string): string | null {
  const dir = path.win32.dirname(shim);
  const targets = [...text.matchAll(/"%(?:~dp0|dp0%)[\\/]?([^"%]+)"/gi)].map((m) => m[1]).filter((t) => !/(^|[\\/])node\.exe$/i.test(t));
  const last = targets.at(-1);
  return last ? path.win32.resolve(dir, last) : null;
}

/** Whether the shim hands its script to node: npm's `_prog` set to node or node.exe, pnpm's `node "…"` and `"…\node.exe" "…"`. */
export function shimRunsNode(text: string): boolean {
  return /_prog=(?:[^"\r\n]*[\\/])?node(?:\.exe)?"|\bnode(?:\.exe)?"?\s+"%(?:~dp0|dp0%)/i.test(text);
}

/** A script that starts with a `#!…node` line, as an npm bin without a .js name does. */
export function nodeShebang(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(128);
    const line = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)).toString("utf8").split(/\r?\n/)[0];
    return /^#!.*\bnode\b/.test(line);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for `cmd /s /c "…"` reaching a batch file that hands `%*` on — the escaping cross-spawn uses. */
export function cmdArgument(arg: string): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  out = `"${out}"`;
  return out.replace(META, "^$1").replace(META, "^$1");
}

export function cmdLine(file: string, args: string[]): string {
  return [path.win32.normalize(file).replace(META, "^$1"), ...args.map(cmdArgument)].join(" ");
}

const isScript = (file: string) => /\.(c|m)?js$/i.test(file);
const isBatch = (file: string) => /\.(cmd|bat)$/i.test(file);

/** How to start `file` on this platform, with `dirs` put ahead of PATH for the CLI and whatever it starts. */
export function launchFor(file: string, host: Pick<CliHost, "platform" | "env">, dirs: string[] = [], depth = 0): CliLaunch {
  const p = pathFor(host.platform);
  const front = [p.dirname(file), ...dirs];
  let argv: CliLaunch["argv"] = (args) => ({ command: file, args });
  if (host.platform === "win32" && isBatch(file)) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8").slice(0, 64 * 1024);
    } catch {}
    const target = shimTarget(file, text);
    // yarn's global shim hands over to the package's own .cmd shim.
    if (target && isBatch(target) && depth < 3 && isFile(target, "win32")) return launchFor(target, host, [p.dirname(file), ...dirs], depth + 1);
    // An npm bin need not be named .js (CodeBuddy's has no extension), and Windows cannot start a script as a program.
    const viaNode = !!target && !isBatch(target) && (isScript(target) || shimRunsNode(text) || nodeShebang(target));
    const node = target && viaNode ? findNode(p.dirname(file), [...dirs, ...splitPath(envValue(host.env, "PATH"), "win32")], host.env) : null;
    if (target && isFile(target, "win32") && !viaNode && !isBatch(target)) argv = (args) => ({ command: target, args });
    else if (target && node && isFile(target, "win32")) {
      front.push(p.dirname(node));
      argv = (args) => ({ command: node, args: [target, ...args] });
    } else {
      const comspec = envValue(host.env, "ComSpec") ?? "cmd.exe";
      argv = (args) => ({ command: comspec, args: ["/d", "/s", "/c", `"${cmdLine(file, args)}"`], verbatim: true });
    }
  }
  return {
    file,
    argv,
    env(base = host.env) {
      const key = pathKey(base, host.platform);
      const dirsNow = [...front, ...splitPath(envValue(base, "PATH"), host.platform)];
      return { ...base, [key]: [...new Set(dirsNow)].join(host.platform === "win32" ? ";" : ":") };
    }
  };
}

function findNode(shimDir: string, dirs: string[], env: NodeJS.ProcessEnv): string | null {
  const known = [envValue(env, "NVM_SYMLINK"), envValue(env, "ProgramFiles") && path.win32.join(envValue(env, "ProgramFiles")!, "nodejs")];
  for (const dir of [shimDir, ...dirs, ...known]) {
    if (!dir) continue;
    const file = path.win32.join(dir, "node.exe");
    if (isFile(file, "win32")) return file;
  }
  return null;
}

/** A CLI shipped inside a desktop app as a Node script, which that app's own Electron binary runs as Node. */
export interface BundledCli {
  file: string;
  /** The app's binary that runs `file` as Node; absent when `file` is the app's own launcher script, run as it is. */
  runtime?: string;
}

/** Where a desktop app may keep its copy of the CLI — every place looked, installed there or not. */
export type BundledApps = (host: CliHost) => BundledCli[] | Promise<BundledCli[]>;

/** How to start a bundled CLI: the app's binary with `ELECTRON_RUN_AS_NODE`, so the machine needs no Node of its own. */
export function bundledLaunch(cli: Required<BundledCli>, host: Pick<CliHost, "platform" | "env">): CliLaunch {
  const plain = launchFor(cli.file, host);
  return { file: cli.file, argv: (args) => ({ command: cli.runtime, args: [cli.file, ...args] }), env: (base) => ({ ...plain.env(base), ELECTRON_RUN_AS_NODE: "1" }) };
}

/** Start a resolved CLI: no console window on Windows, its own folder first on PATH. */
export function spawnCli(launch: CliLaunch, args: string[], options: SpawnOptions & { env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const spec = launch.argv(args);
  return spawn(spec.command, spec.args, { ...options, env: launch.env(options.env), windowsHide: true, windowsVerbatimArguments: spec.verbatim });
}

/** On Windows a signal reaches only the process itself; a CLI's own children (node → codex.exe) need the tree taken down. */
export function stopCli(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const kill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    kill.on("error", () => child.kill(signal));
    return;
  }
  child.kill(signal);
}

function runOnce(launch: CliLaunch, args: string[], timeoutMs: number): Promise<CliRunResult> {
  const spec = launch.argv(args);
  return new Promise((resolve) => {
    execFile(spec.command, spec.args, { timeout: timeoutMs, env: launch.env(), windowsHide: true, windowsVerbatimArguments: spec.verbatim, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      // A non-zero exit is an answer; a spawn failure or a timeout is not.
      const exited = typeof error?.code === "number";
      resolve({ code: !error ? 0 : exited ? (error.code as number) : null, stdout: String(stdout), stderr: String(stderr), error: error && (error.killed || !exited) ? error : undefined });
    });
  });
}

const MARK = "__TOMRADE_PATH__";

/** The login shell did not answer in time, so the folders its startup files add to PATH are unknown. */
export class ShellTimeout extends Error {
  constructor(readonly shell: string) {
    super(`${shell} did not answer in time`);
  }
}

function readLoginPath(env: NodeJS.ProcessEnv): Promise<string[]> {
  const shell = env.SHELL || os.userInfo().shell || "/bin/sh";
  return new Promise((resolve, reject) => {
    // An interactive zsh or bash ignores SIGTERM: an rc file waiting for input would outlast the timeout forever.
    execFile(shell, ["-ilc", `printf '%s' "${MARK}$PATH${MARK}"`], { env, timeout: 10_000, killSignal: "SIGKILL" }, (error, stdout) => {
      if (error?.killed) return reject(new ShellTimeout(shell));
      const body = error ? undefined : String(stdout).split(MARK)[1];
      resolve(splitPath(body, process.platform));
    });
  });
}

function readRegistryPath(env: NodeJS.ProcessEnv): Promise<string[]> {
  const query = (key: string) =>
    new Promise<string | null>((resolve) => {
      execFile("reg.exe", ["query", key, "/v", "Path"], { windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? null : parseRegPath(String(stdout))));
    });
  // Windows builds a new process's PATH as the machine's, then the user's.
  return Promise.all([query("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"), query("HKCU\\Environment")]).then((values) =>
    values.flatMap((value) => splitPath(value ? expandWindowsVars(value, env) : "", "win32"))
  );
}

const UNINSTALL_KEYS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
];

function readRegistryInstalls(env: NodeJS.ProcessEnv, displayName: RegExp): Promise<string[]> {
  // reg.exe writes in the console's code page; UTF-8 keeps a folder like D:\软件 intact.
  const query = (key: string) =>
    new Promise<string>((resolve) => {
      execFile(envValue(env, "ComSpec") ?? "cmd.exe", ["/d", "/s", "/c", `chcp 65001 >nul & reg query ${key} /s`], { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout)));
    });
  return Promise.all(UNINSTALL_KEYS.map(query)).then((outputs) => parseRegInstalls(outputs.join("\r\n"), displayName));
}

export const machineHost = (): CliHost => ({
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  home: os.homedir(),
  freshPath: () => (process.platform === "win32" ? readRegistryPath(process.env) : readLoginPath(process.env)),
  npmPrefix: () =>
    process.platform !== "win32"
      ? Promise.resolve(null)
      : new Promise((resolve) => {
          execFile(envValue(process.env, "ComSpec") ?? "cmd.exe", ["/d", "/s", "/c", "npm prefix -g"], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
            const dir = String(stdout).trim().split(/\r?\n/).at(-1)?.trim();
            resolve(error || !dir ? null : dir);
          });
        }),
  wsl: (name) => {
    const wsl = path.win32.join(envValue(process.env, "SystemRoot") ?? "C:\\Windows", "System32", "wsl.exe");
    if (process.platform !== "win32" || !isFile(wsl, "win32")) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(wsl, ["-e", "bash", "-lic", `command -v ${name}`], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        const found = String(stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("/"));
        resolve(error ? null : (found ?? null));
      });
    });
  },
  installs: (displayName) => (process.platform === "win32" ? readRegistryInstalls(process.env, displayName) : Promise.resolve([])),
  run: runOnce
});

/** Version-manager folders hold one bin per installed Node; the newest is the likeliest to have the CLI. */
function versionDirs(root: string | undefined, inner: string, p: typeof path.posix): string[] {
  if (!root) return [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const key = (name: string) => (name.match(/\d+/g) ?? []).map(Number);
  names.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  return names.map((name) => p.join(root, name, inner));
}

/** Where installers and version managers put commands when PATH does not (yet) say so. */
export async function knownDirs(host: CliHost): Promise<string[]> {
  return installDirs(host, host.platform === "win32" ? await host.npmPrefix() : null);
}

/** `knownDirs` without asking npm for its prefix, for a lookup that cannot wait. */
export function installDirs(host: Pick<CliHost, "env" | "home" | "platform">, prefix: string | null = null): string[] {
  const { env, home, platform } = host;
  if (platform === "win32") {
    const w = path.win32;
    const appData = envValue(env, "APPDATA") ?? w.join(home, "AppData", "Roaming");
    const local = envValue(env, "LOCALAPPDATA") ?? w.join(home, "AppData", "Local");
    return [
      w.join(appData, "npm"),
      ...(prefix ? [prefix] : []),
      w.join(local, "pnpm"),
      w.join(local, "Volta", "bin"),
      w.join(home, "scoop", "shims"),
      ...(envValue(env, "NVM_SYMLINK") ? [envValue(env, "NVM_SYMLINK")!] : []),
      // Claude Code's own installer.
      w.join(home, ".local", "bin"),
      w.join(home, ".bun", "bin"),
      // Tomrade's own prefix, where agents installed with the borrowed npm land (the desktop app sets it; npm on Windows puts commands in the prefix itself).
      ...(envValue(env, "TOMRADE_NPM_PREFIX") ? [envValue(env, "TOMRADE_NPM_PREFIX")!] : [])
    ];
  }
  const p = path.posix;
  return [
    p.join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    p.join(home, ".npm-global/bin"),
    p.join(home, ".volta/bin"),
    p.join(home, ".bun/bin"),
    p.join(home, ".claude/local"),
    // OpenCode's own installer.
    p.join(home, ".opencode/bin"),
    ...(platform === "darwin" ? [p.join(home, "Library/pnpm")] : [p.join(home, ".local/share/pnpm")]),
    ...versionDirs(p.join(env.NVM_DIR ?? p.join(home, ".nvm"), "versions/node"), "bin", p),
    ...versionDirs(env.FNM_DIR ? p.join(env.FNM_DIR, "node-versions") : undefined, "installation/bin", p),
    ...versionDirs(p.join(home, ".local/share/fnm/node-versions"), "installation/bin", p),
    ...(platform === "darwin" ? versionDirs(p.join(home, "Library/Application Support/fnm/node-versions"), "installation/bin", p) : []),
    // Tomrade's own prefix, where agents installed with the borrowed npm land (the desktop app sets it) — last, like the shims on PATH.
    ...(env.TOMRADE_NPM_PREFIX ? [p.join(env.TOMRADE_NPM_PREFIX, "bin")] : [])
  ];
}

/** PATH, then the install folders that exist: an app opened from the Dock or the Start menu lacks them. */
export function searchPath(host: Pick<CliHost, "env" | "home" | "platform"> = machineHost()): string[] {
  const norm = (dir: string) => (host.platform === "win32" ? dir.toLowerCase() : dir);
  const dirs = splitPath(envValue(host.env, "PATH"), host.platform);
  for (const dir of installDirs(host)) if (!dirs.some((d) => norm(d) === norm(dir)) && fs.existsSync(dir)) dirs.push(dir);
  return dirs;
}

/** The first runnable `name` on `searchPath`, found without running it; null when there is none. */
export function findCommand(name: string, host: Pick<CliHost, "env" | "home" | "platform"> = machineHost()): string | null {
  const p = pathFor(host.platform);
  const names = fileNames(name, host.platform, envValue(host.env, "PATHEXT"));
  for (const dir of searchPath(host)) for (const n of names) if (isFile(p.join(dir, n), host.platform)) return p.join(dir, n);
  return null;
}

/** The version a CLI printed, or why it did not answer — short enough for a settings row. */
export function describeRun(result: CliRunResult, timeoutMs: number): { ok: boolean; detail: string } {
  if (result.code === 0) {
    const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
    return { ok: true, detail: (line.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0] ?? line).slice(0, 80) };
  }
  const err = result.error;
  if (err?.killed) return { ok: false, detail: `did not answer --version within ${timeoutMs / 1000}s` };
  if (err?.code === "ENOENT") return { ok: false, detail: "file not found" };
  if (err?.code === "EACCES") return { ok: false, detail: "not executable (permission denied)" };
  if (err?.code) return { ok: false, detail: `${err.code}: ${err.message}`.slice(0, 200) };
  const last = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
  return { ok: false, detail: `exited with code ${result.code ?? "?"}${last ? `: ${last.slice(0, 160)}` : ""}` };
}

interface Candidate {
  file: string;
  source: CliSource;
}

/** The desktop app a bundled copy ships in, as its folder names it: `Name.app` on macOS, the folder holding `resources` elsewhere. */
function appOf(file: string): string {
  const parts = file.split(/[\\/]+/).filter(Boolean);
  const bundle = parts.find((part) => part.endsWith(".app"));
  if (bundle) return bundle.slice(0, -".app".length);
  const resources = parts.findIndex((part) => part.toLowerCase() === "resources");
  return parts[resources > 0 ? resources - 1 : parts.length - 2] ?? file;
}

const shared = new Map<string, CliLocator>();
const noBundled: BundledApps = () => [];

/**
 * One locator per CLI for the whole app, so the engine's views and its turns
 * share what was found. `bundled` names copies that ship inside a desktop app,
 * tried after every folder a terminal would search; null says there are none,
 * and leaving it out keeps whatever finder the locator has.
 */
export function localCli(name: string, opts: { bundled?: BundledApps | null } = {}): CliLocator {
  let locator = shared.get(name);
  if (!locator) shared.set(name, (locator = new CliLocator(name, machineHost(), undefined, opts.bundled ?? noBundled)));
  // A plugin loaded again (an update) brings its own finder, or none; the old one belongs to the code it replaced.
  else if (opts.bundled !== undefined) locator.findBundled(opts.bundled ?? noBundled);
  return locator;
}

/**
 * Looks for one CLI — `claude`, `codex` — in the order a person would expect:
 * the path they chose, PATH, PATH as a new terminal sees it, then the folders
 * installers use. Each file found is run with `--version`; the first that
 * answers wins. Results are kept briefly so every view and turn does not spawn.
 */
export class CliLocator {
  private cache = new Map<string, { at: number; status: LocalCliStatus; dirs: string[] }>();
  private pending = new Map<string, Promise<{ status: LocalCliStatus; dirs: string[] }>>();

  constructor(
    readonly name: string,
    private host: CliHost = machineHost(),
    private timeoutMs = host.platform === "win32" ? 15_000 : 10_000,
    private bundled: BundledApps = noBundled
  ) {}

  // Looking for app installs may read the registry, so a turn reuses what the last search saw.
  private apps?: Promise<BundledCli[]>;

  findBundled(bundled: BundledApps): void {
    if (bundled === this.bundled) return;
    this.bundled = bundled;
    this.apps = undefined;
    this.cache.clear();
  }
  private bundledApps(fresh = false): Promise<BundledCli[]> {
    if (fresh || !this.apps) this.apps = Promise.resolve().then(() => this.bundled(this.host)).catch(() => []);
    return this.apps;
  }

  /** How to start `file`: through its app's runtime when it is a bundled copy, the way a terminal would otherwise. */
  private async launchOf(file: string, dirs: string[] = []): Promise<CliLaunch> {
    const same = (a: string, b: string) => (this.host.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    const copy = (await this.bundledApps()).find((cli) => same(cli.file, file));
    return copy?.runtime ? bundledLaunch({ file: copy.file, runtime: copy.runtime }, this.host) : launchFor(file, this.host, dirs);
  }

  /** A command setting that names something other than the default is the person's choice. */
  manualOf(command: string | undefined): string | undefined {
    const value = command?.trim();
    return value && value !== this.name ? value : undefined;
  }

  async locate(opts: { manual?: string; fresh?: boolean } = {}): Promise<LocalCliStatus> {
    return (await this.found(opts)).status;
  }

  /** How a turn starts the CLI that `command` names — the located file when there is one. */
  async launch(command?: string): Promise<CliLaunch> {
    const manual = this.manualOf(command);
    const known = this.cache.get(manual ?? "");
    if (known?.status.path) return this.launchOf(known.status.path, known.dirs);
    if (manual) {
      // Not probed yet: trust the person's path rather than spend a --version on every cold turn.
      const file = this.manualCandidates(manual).find((c) => isFile(c.file, this.host.platform))?.file ?? manual;
      return this.launchOf(file);
    }
    const { status, dirs } = await this.found({});
    return this.launchOf(status.path ?? this.name, dirs);
  }

  async check(file: string): Promise<CliCheck> {
    const candidates = this.manualCandidates(file.trim());
    const candidate = candidates.find((c) => isFile(c.file, this.host.platform));
    if (!candidate) return { ok: false, path: file, error: (candidates.length && whyNot(candidates.at(-1)!.file, this.host.platform)) || "file not found" };
    const result = describeRun(await this.host.run(await this.launchOf(candidate.file), ["--version"], this.timeoutMs), this.timeoutMs);
    return result.ok ? { ok: true, path: candidate.file, version: result.detail } : { ok: false, path: candidate.file, error: result.detail };
  }

  /** Runs `args` on the CLI `command` names — a sign-in check. */
  async run(command: string | undefined, args: string[], timeoutMs: number, envFor?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv): Promise<CliRunResult> {
    const launch = await this.launch(command);
    return this.host.run(envFor ? { ...launch, env: (base) => envFor(launch.env(base)) } : launch, args, timeoutMs);
  }

  private found(opts: { manual?: string; fresh?: boolean }): Promise<{ status: LocalCliStatus; dirs: string[] }> {
    const key = opts.manual ?? "";
    const hit = this.cache.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit);
    const running = this.pending.get(key);
    if (running) return running;
    const next = this.search(opts.manual)
      .then((result) => {
        this.cache.set(key, { ...result, at: Date.now() });
        return result;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, next);
    return next;
  }

  private manualCandidates(manual: string): Candidate[] {
    const { platform, env, home } = this.host;
    const p = pathFor(platform);
    const expanded = manual.startsWith("~") ? p.join(home, manual.slice(1)) : platform === "win32" ? expandWindowsVars(manual, env) : manual;
    if (!/[\\/]/.test(expanded)) return this.inDirs(splitPath(envValue(env, "PATH"), platform), "manual", expanded);
    const file = p.resolve(expanded.replace(/^"(.*)"$/, "$1"));
    const ext = p.extname(file);
    // npm leaves codex, codex.cmd and codex.ps1 side by side; only the .cmd runs without a shell, whichever was picked.
    const names = platform === "win32" && !RUNNABLE_EXTS.includes(ext.toLowerCase())
      ? [...fileNames(p.basename(file, ext), platform, envValue(env, "PATHEXT")), p.basename(file)]
      : [p.basename(file)];
    return names.map((name) => ({ file: p.join(p.dirname(file), name), source: "manual" as const }));
  }

  private inDirs(dirs: string[], source: CliSource, name = this.name): Candidate[] {
    const p = pathFor(this.host.platform);
    const names = fileNames(name, this.host.platform, envValue(this.host.env, "PATHEXT"));
    return dirs.flatMap((dir) => names.map((n) => ({ file: p.join(dir, n), source })));
  }

  private async search(manual?: string): Promise<{ status: LocalCliStatus; dirs: string[] }> {
    const { platform, env } = this.host;
    const processPath = splitPath(envValue(env, "PATH"), platform);
    const searched: string[] = [];
    const attempts: CliAttempt[] = [];
    const tried = new Set<string>();
    const norm = (file: string) => (platform === "win32" ? file.toLowerCase() : file);
    const status = (fields: Partial<LocalCliStatus>): LocalCliStatus => ({
      name: this.name,
      state: "missing",
      attempts,
      searched,
      platform,
      arch: this.host.arch,
      pathEnv: envValue(env, "PATH") ?? "",
      ...fields
    });
    let manualError: LocalCliStatus["manual"];
    let extra: string[] = [];

    const tryAll = async (candidates: Candidate[]): Promise<CliAttempt | null> => {
      for (const c of candidates) {
        if (tried.has(norm(c.file)) || !isFile(c.file, platform)) continue;
        tried.add(norm(c.file));
        const result = describeRun(await this.host.run(await this.launchOf(c.file, extra), ["--version"], this.timeoutMs), this.timeoutMs);
        const attempt = { path: c.file, source: c.source, ok: result.ok, detail: result.detail };
        attempts.push(attempt);
        if (result.ok) return attempt;
      }
      return null;
    };
    const ready = (hit: CliAttempt, fields: Partial<LocalCliStatus> = {}) =>
      ({ status: status({ state: "ready", path: hit.path, source: hit.source, version: hit.detail, manual: manualError, ...(extra.length ? { pathDirs: extra } : {}), ...fields }), dirs: extra });

    if (manual) {
      const candidates = this.manualCandidates(manual);
      const hit = await tryAll(candidates);
      if (hit) return ready(hit);
      const failed = attempts.at(-1);
      const file = candidates.at(-1)?.file ?? manual;
      manualError = failed ? { path: failed.path, error: failed.detail } : { path: file, error: whyNot(file, platform) ?? "file not found" };
    }
    searched.push(...processPath);
    let hit = await tryAll(this.inDirs(processPath, "path"));
    if (hit) return ready(hit);

    let shellTimedOut: string | undefined;
    const freshPath = await this.host.freshPath().catch((error: unknown) => {
      if (error instanceof ShellTimeout) shellTimedOut = error.shell;
      return [];
    });
    const fresh = freshPath.filter((dir) => !searched.some((d) => norm(d) === norm(dir)));
    searched.push(...fresh);
    // Folders a new terminal would have also go on the CLI's PATH: it may start node, git or its own helpers from them.
    extra = fresh;
    hit = await tryAll(this.inDirs(fresh, "login-path"));
    if (hit) return ready(hit);

    const known = (await knownDirs(this.host)).filter((dir) => !searched.some((d) => norm(d) === norm(dir)));
    searched.push(...known);
    hit = await tryAll(this.inDirs(known, "known"));
    if (hit) return ready(hit);

    const p = pathFor(platform);
    // Every app folder looked in goes on the list, so a person can see where their install was not.
    const bundled = await this.bundledApps(true);
    searched.push(...bundled.map((cli) => p.dirname(cli.file)).filter((dir, i, all) => all.findIndex((d) => norm(d) === norm(dir)) === i));
    hit = await tryAll(bundled.filter((cli) => isFile(cli.runtime ?? cli.file, platform)).map((cli) => ({ file: cli.file, source: "known" as const })));
    if (hit) return ready(hit, { insideApp: appOf(hit.path) });

    const broken = attempts.find((a) => a.source !== "manual") ?? attempts[0];
    if (broken) return { status: status({ state: "broken", path: broken.path, source: broken.source, error: broken.detail, manual: manualError }), dirs: extra };
    const wsl = platform === "win32" ? await this.host.wsl(this.name).catch(() => null) : null;
    return { status: status({ state: "missing", manual: manualError, ...(wsl ? { wsl } : {}), ...(shellTimedOut ? { shellTimedOut } : {}) }), dirs: extra };
  }
}

/** The English line for logs and errors; the app words each state itself. */
export function cliReason(title: string, cli: LocalCliStatus, install: string): string {
  if (cli.state === "broken") return `${title} was found at ${cli.path} but does not run: ${cli.error}`;
  if (cli.wsl) return `${cli.name} is installed only inside WSL (${cli.wsl}), which Tomrade on Windows cannot run — install it on Windows or choose its path in Settings`;
  return `${cli.name} CLI not found — ${install}`;
}
