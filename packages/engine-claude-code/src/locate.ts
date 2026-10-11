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
    const node = target && isScript(target) ? findNode(p.dirname(file), [...dirs, ...splitPath(envValue(host.env, "PATH"), "win32")], host.env) : null;
    if (target && isFile(target, "win32") && !isScript(target) && !isBatch(target)) argv = (args) => ({ command: target, args });
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

function readLoginPath(env: NodeJS.ProcessEnv): Promise<string[]> {
  const shell = env.SHELL || os.userInfo().shell || "/bin/sh";
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", `printf '%s' "${MARK}$PATH${MARK}"`], { env, timeout: 10_000 }, (error, stdout) => {
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
  const { env, home, platform } = host;
  if (platform === "win32") {
    const w = path.win32;
    const appData = envValue(env, "APPDATA") ?? w.join(home, "AppData", "Roaming");
    const local = envValue(env, "LOCALAPPDATA") ?? w.join(home, "AppData", "Local");
    const prefix = await host.npmPrefix();
    return [
      w.join(appData, "npm"),
      ...(prefix ? [prefix] : []),
      w.join(local, "pnpm"),
      w.join(local, "Volta", "bin"),
      w.join(home, "scoop", "shims"),
      ...(envValue(env, "NVM_SYMLINK") ? [envValue(env, "NVM_SYMLINK")!] : []),
      // Claude Code's own installer.
      w.join(home, ".local", "bin"),
      w.join(home, ".bun", "bin")
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
    ...(platform === "darwin" ? [p.join(home, "Library/pnpm")] : [p.join(home, ".local/share/pnpm")]),
    ...versionDirs(p.join(env.NVM_DIR ?? p.join(home, ".nvm"), "versions/node"), "bin", p),
    ...versionDirs(env.FNM_DIR ? p.join(env.FNM_DIR, "node-versions") : undefined, "installation/bin", p),
    ...versionDirs(p.join(home, ".local/share/fnm/node-versions"), "installation/bin", p),
    ...(platform === "darwin" ? versionDirs(p.join(home, "Library/Application Support/fnm/node-versions"), "installation/bin", p) : [])
  ];
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

const shared = new Map<string, CliLocator>();

/** One locator per CLI for the whole app, so the engine's views and its turns share what was found. */
export function localCli(name: string): CliLocator {
  let locator = shared.get(name);
  if (!locator) shared.set(name, (locator = new CliLocator(name)));
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
    private timeoutMs = host.platform === "win32" ? 15_000 : 10_000
  ) {}

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
    if (known?.status.path) return launchFor(known.status.path, this.host, known.dirs);
    if (manual) {
      // Not probed yet: trust the person's path rather than spend a --version on every cold turn.
      const file = this.manualCandidates(manual).find((c) => isFile(c.file, this.host.platform))?.file ?? manual;
      return launchFor(file, this.host);
    }
    const { status, dirs } = await this.found({});
    return launchFor(status.path ?? this.name, this.host, dirs);
  }

  async check(file: string): Promise<CliCheck> {
    const candidates = this.manualCandidates(file.trim());
    const candidate = candidates.find((c) => isFile(c.file, this.host.platform));
    if (!candidate) return { ok: false, path: file, error: (candidates.length && whyNot(candidates.at(-1)!.file, this.host.platform)) || "file not found" };
    const result = describeRun(await this.host.run(launchFor(candidate.file, this.host), ["--version"], this.timeoutMs), this.timeoutMs);
    return result.ok ? { ok: true, path: candidate.file, version: result.detail } : { ok: false, path: candidate.file, error: result.detail };
  }

  /** Runs `args` on the CLI `command` names — a sign-in check. */
  async run(command: string | undefined, args: string[], timeoutMs: number): Promise<CliRunResult> {
    return this.host.run(await this.launch(command), args, timeoutMs);
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
        const result = describeRun(await this.host.run(launchFor(c.file, this.host, extra), ["--version"], this.timeoutMs), this.timeoutMs);
        const attempt = { path: c.file, source: c.source, ok: result.ok, detail: result.detail };
        attempts.push(attempt);
        if (result.ok) return attempt;
      }
      return null;
    };
    const ready = (hit: CliAttempt) =>
      ({ status: status({ state: "ready", path: hit.path, source: hit.source, version: hit.detail, manual: manualError }), dirs: extra });

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

    const fresh = (await this.host.freshPath().catch(() => [])).filter((dir) => !searched.some((d) => norm(d) === norm(dir)));
    searched.push(...fresh);
    // Folders a new terminal would have also go on the CLI's PATH: it may start node, git or its own helpers from them.
    extra = fresh;
    hit = await tryAll(this.inDirs(fresh, "login-path"));
    if (hit) return ready(hit);

    const known = (await knownDirs(this.host)).filter((dir) => !searched.some((d) => norm(d) === norm(dir)));
    searched.push(...known);
    hit = await tryAll(this.inDirs(known, "known"));
    if (hit) return ready(hit);

    const broken = attempts.find((a) => a.source !== "manual") ?? attempts[0];
    if (broken) return { status: status({ state: "broken", path: broken.path, source: broken.source, error: broken.detail, manual: manualError }), dirs: extra };
    const wsl = platform === "win32" ? await this.host.wsl(this.name).catch(() => null) : null;
    return { status: status({ state: "missing", manual: manualError, ...(wsl ? { wsl } : {}) }), dirs: extra };
  }
}

/** The English line for logs and errors; the app words each state itself. */
export function cliReason(title: string, cli: LocalCliStatus, install: string): string {
  if (cli.state === "broken") return `${title} was found at ${cli.path} but does not run: ${cli.error}`;
  if (cli.wsl) return `${cli.name} is installed only inside WSL (${cli.wsl}), which Tomrade on Windows cannot run — install it on Windows or choose its path in Settings`;
  return `${cli.name} CLI not found — ${install}`;
}
