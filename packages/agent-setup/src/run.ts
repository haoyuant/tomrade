import type { EngineInstaller, EngineSetupFailure, EngineSetupProgress, EngineSetupStep } from "@tomradex/agent";
import path from "node:path";
import { archiveFolder, localCli, spawnCli, stopCli, type CliLaunch } from "@tomradex/engine-kit";
import { ArchiveError, unpackArchive } from "./archive.js";

/**
 * Running one setup step the way the person would, but watched: an install in
 * the background with its output kept, a sign-in whose browser address is
 * caught and whose finish is noticed by the engine's own probe. No terminal
 * window, no admin rights; cancel stops the child.
 */

/** What the runner needs from the machine; tests swap it for a fake one. */
export interface SetupHost {
  platform: NodeJS.Platform;
  /** `process.arch` names it; an archive installer declares the one its zip fits. */
  arch?: string;
  env: NodeJS.ProcessEnv;
  /** Whether this command answers `--version` from PATH — is Homebrew here, does the system npm run. */
  answers(command: string): Promise<boolean>;
  /** How `npm` runs on this machine: the first one that answers, the borrowed shims included (they sit last on PATH). */
  npm(): Promise<CliLaunch | null>;
  /** How fast npm's configured registry answers (`npm ping`); absent, no check runs. */
  pingRegistry?(npm: CliLaunch, signal: AbortSignal): Promise<RegistryPing>;
  /** Fetches an archive installer's zip; the server's answer, no status check. Absent, `fetch`. */
  download?(url: string, signal: AbortSignal): Promise<ArchiveResponse>;
  /** Where an archive installer unpacks, under Tomrade's own data folder: one per engine and version. */
  archiveDir?(engineId: string, url: string): string;
}

/** The part of a download an archive install reads. */
export interface ArchiveResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Read as it arrives, so the bytes received can be shown; absent, the whole answer at once. */
  body?: ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
}

export interface RegistryPing {
  /** The registry npm is configured with, as it named it. */
  registry?: string;
  /** Its round trip; null when it did not answer in time. */
  ms: number | null;
}

export interface SetupRunResult {
  code: number | null;
  /** The last few thousand characters of stdout and stderr together. */
  output: string;
  error?: { code?: string | number | null; message: string; killed?: boolean };
}

const OUTPUT_KEEP = 4000;
/** How long the installer's group has to end after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3000;

/** A signal to the whole process group, which is gone already once everyone in it has exited. */
const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: nothing is left in it.
  }
};

/** One command to its end, output kept, stopped by the signal or the timeout. */
export function runCommand(launch: CliLaunch, args: string[], opts: { signal: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv; onOutput?(text: string): void }): Promise<SetupRunResult> {
  return new Promise((resolve) => {
    // On POSIX its own process group, so a stop reaches what it started too: `curl … | bash` and the inner bash, npm's scripts.
    const group = process.platform !== "win32";
    const child = spawnCli(launch, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: group });
    // A running install does not hold the app open on quit; its close below is still awaited.
    if (group) child.unref();
    let output = "";
    let failed: SetupRunResult["error"];
    let timedOut = false;
    const take = (chunk: Buffer) => {
      const text = chunk.toString();
      output = (output + text).slice(-OUTPUT_KEEP);
      opts.onOutput?.(text);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => {
      failed = { message: error.message, code: (error as NodeJS.ErrnoException).code ?? null };
    });
    let killing = false;
    const stop = () => {
      const pid = child.pid;
      if (!group || !pid) return stopCli(child);
      signalGroup(pid, "SIGTERM");
      // Not cleared on close: one that ignored SIGTERM and let go of the pipes is still in the group.
      if (!killing) setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS).unref();
      killing = true;
    };
    opts.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs);
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", stop);
      clearTimeout(timer);
      if (opts.signal.aborted) resolve({ code: null, output, error: { message: "cancelled", killed: true } });
      else if (timedOut) resolve({ code: null, output, error: { message: `timed out after ${opts.timeoutMs / 1000}s`, killed: true } });
      else if (failed) resolve({ code: null, output, error: failed });
      else resolve({ code, output });
    });
  });
}

/** A launch for a bare command, resolved by the system (`bash`, `brew`, `powershell.exe`). */
export const bareLaunch = (command: string, env: NodeJS.ProcessEnv = process.env): CliLaunch => ({ file: command, argv: (args) => ({ command, args }), env: (base = env) => base });

export const machineSetupHost = (): SetupHost => ({
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  // Its `bin` folders are read by the locators too, so the unpacked file is found without anyone editing Settings.
  ...(process.env.TOMRADE_AGENTS_DIR ? { archiveDir: (engineId: string, url: string) => path.join(process.env.TOMRADE_AGENTS_DIR!, archiveFolder(engineId, url)) } : {}),
  answers: async (command) => (await localCli(command).locate()).state === "ready",
  // The locator probes each candidate with --version: a system npm that is present but broken is passed
  // over for the next one on PATH — the app's borrowed shims, which sit last (TOM-507).
  npm: async () => {
    const cli = localCli("npm");
    return (await cli.locate()).state === "ready" ? cli.launch() : null;
  },
  pingRegistry: async (npm, signal) => {
    const result = await runCommand(npm, ["ping"], { signal, timeoutMs: PING_TIMEOUT_MS });
    const registry = /PING\s+(\S+)/.exec(result.output)?.[1];
    const pong = /PONG\s+(\d+)\s*ms/.exec(result.output)?.[1];
    return { ...(registry ? { registry } : {}), ms: result.code === 0 && pong ? Number(pong) : null };
  }
});

const PING_TIMEOUT_MS = 10_000;

/** The installers this machine can run, in the declared order; the rest are left out. */
export async function applicableInstallers(installers: EngineInstaller[], host: SetupHost): Promise<EngineInstaller[]> {
  const kept: EngineInstaller[] = [];
  const arch = host.arch ?? process.arch;
  const native = installers.some((installer) => installer.kind === "archive" && installer.platform.os === host.platform && installer.platform.arch === arch);
  // Windows and macOS on arm64 run x64 programs too; a native archive still wins.
  const runs = !native && arch === "arm64" && (host.platform === "win32" || host.platform === "darwin") ? ["arm64", "x64"] : [arch];
  for (const installer of installers) {
    if (installer.kind === "script" && (installer.shell === "powershell") !== (host.platform === "win32")) continue;
    if (installer.kind === "brew" && (host.platform !== "darwin" || !(await host.answers("brew")))) continue;
    if (installer.kind === "archive" && (installer.platform.os !== host.platform || !runs.includes(installer.platform.arch))) continue;
    kept.push(installer);
  }
  return kept;
}

/**
 * Why an archive could not be used, in words a person can act on: what
 * failed (the download, the archive, the file inside it), at which address.
 */
export function archiveFailure(error: unknown, url: string): EngineSetupFailure {
  if (error instanceof ArchiveError) return { kind: error.kind, message: `${error.message} (${url})` };
  const words = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const kind: EngineSetupFailure["kind"] =
    code === "ENOSPC" ? "disk-full"
    : code === "EACCES" || code === "EPERM" ? "permission"
    : /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ERR_SOCKET|getaddrinfo|fetch failed|network|proxy/i.test(`${code ?? ""} ${words}`) ? "network"
    : "exit";
  return { kind, message: `could not download ${url}: ${words} — check your connection or proxy, then retry` };
}

/** How one installer runs, or why it cannot here. */
export async function installerLaunch(installer: EngineInstaller, host: SetupHost, registry?: string, prefix?: string): Promise<{ launch: CliLaunch; args: string[] } | { failure: EngineSetupFailure }> {
  if (installer.kind === "npm") {
    const npm = await host.npm();
    if (!npm) return { failure: { kind: "not-found", message: "npm was not found — install Node.js, or update Tomrade, which brings its own" } };
    // Piped, npm prints nothing until it ends; at `http` it prints a line per fetch, which is what shows it moving.
    return { launch: npm, args: ["install", "-g", "--loglevel", "http", ...(registry ? ["--registry", registry] : []), ...(prefix ? ["--prefix", prefix] : []), installer.package] };
  }
  if (installer.kind === "script") {
    return host.platform === "win32"
      ? { launch: bareLaunch("powershell.exe", host.env), args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${installer.url} | iex`] }
      : { launch: bareLaunch("bash", host.env), args: ["-c", `curl -fsSL ${installer.url} | bash`] };
  }
  if (installer.kind === "archive") return { failure: { kind: "unsupported", message: `Tomrade downloads and unpacks ${installer.url} itself; there is no command to run` } };
  return { launch: bareLaunch("brew", host.env), args: ["install", ...(installer.cask ? ["--cask"] : []), installer.name] };
}

/**
 * An archive installer run without Node, npm or a shell: download the zip for
 * this machine, unpack the one file the plugin names under Tomrade's own data
 * folder, and say where it landed — the engine finds it there by itself.
 */
export interface ArchiveDeps {
  engineId: string;
  host: SetupHost;
  signal: AbortSignal;
  say?(line: string): void;
  /** Bytes received so far, and the whole size when the server said. */
  received?(received: number, size?: number): void;
  /** Called once the download is in and unpacking starts. */
  unpacking?(): void;
}

/** The whole answer, reported chunk by chunk as it arrives when it can be read that way. */
async function readAll(answer: ArchiveResponse, report: (received: number, size?: number) => void): Promise<Buffer> {
  const declared = Number(answer.headers?.get("content-length"));
  const size = Number.isFinite(declared) && declared > 0 ? declared : undefined;
  if (!answer.body) {
    const bytes = Buffer.from(await answer.arrayBuffer());
    report(bytes.length, size);
    return bytes;
  }
  const reader = answer.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  report(0, size);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    report(received, size);
  }
  return Buffer.concat(chunks);
}

export async function runArchive(installer: Extract<EngineInstaller, { kind: "archive" }>, deps: ArchiveDeps): Promise<{ file: string; say(line: string): void } | { failure: EngineSetupFailure }> {
  const url = installer.url;
  const { host, signal } = deps;
  const say = deps.say ?? (() => {});
  if (!host.archiveDir) return { failure: { kind: "unsupported", message: `Tomrade has no folder of its own to unpack ${installer.file} into (${url})` } };
  say(`Downloading ${url}`);
  let bytes: Buffer;
  try {
    const answer = await (host.download ?? ((at: string, stop: AbortSignal) => fetch(at, { signal: stop })))(url, signal);
    if (!answer.ok) return { failure: { kind: answer.status === 403 || answer.status === 404 ? "not-found" : "network", message: `the server answered ${answer.status} for ${url} — the release may have moved; check the agent's download page` } };
    bytes = await readAll(answer, (received, size) => deps.received?.(received, size));
  } catch (error) {
    if (signal.aborted) return { failure: { kind: "cancelled", message: "cancelled" } };
    return { failure: archiveFailure(error, url) };
  }
  deps.unpacking?.();
  say(`Downloaded ${Math.max(1, Math.round(bytes.length / 1024))} KB — unpacking ${installer.file}`);
  try {
    const landed = unpackArchive(bytes, installer.file, { dir: host.archiveDir(deps.engineId, url), file: installer.file }, host.platform);
    say(`Unpacked to ${landed.file}`);
    return { file: landed.file, say };
  } catch (error) {
    return { failure: archiveFailure(error, url) };
  }
}

/** The concrete kind of a failure, read from the tool's own words. */
export function classifyFailure(result: SetupRunResult): EngineSetupFailure {
  // npm's lines for fetches that worked name the registry, which says nothing about why it failed.
  const output = result.output.replace(/^npm http (?:fetch \S+ [23]\d\d|cache) .*$/gm, "");
  const text = `${result.error?.code ?? ""} ${result.error?.message ?? ""} ${output}`;
  const message = result.error?.message && result.code === null ? result.error.message : `exited with code ${result.code ?? "?"}`;
  const kind: EngineSetupFailure["kind"] =
    result.error?.message === "cancelled" ? "cancelled"
    : result.error?.killed ? "timeout"
    : /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ERR_SOCKET|getaddrinfo|network|proxy|fetch failed|Could not resolve host/i.test(text) ? "network"
    : /E403|403 Forbidden|ENOTCACHED|registry/i.test(text) ? "registry"
    : /EACCES|EPERM|permission denied|Access is denied|EROFS/i.test(text) ? "permission"
    : /ENOSPC|no space left/i.test(text) ? "disk-full"
    : /EBADPLATFORM|[Uu]nsupported (platform|architecture|OS)|not supported on/i.test(text) ? "unsupported"
    : result.error?.code === "ENOENT" ? "not-found"
    : "exit";
  return { kind, message };
}

const tail = (output: string) => output.split(/\r?\n/).filter((line) => line.trim()).slice(-12).join("\n");

type SetupStage = NonNullable<EngineSetupProgress["stage"]>;

/** npm at `--loglevel http`: a line per metadata or package fetch, cached or not. */
const NPM_FETCH = /^npm http (?:fetch \S+ \d{3}|cache) (\S+)/;

/**
 * What one line of an installer's output says it is doing, only where it says
 * so plainly: npm's fetch lines, and the words official scripts and Homebrew
 * print before downloading, unpacking and putting the command in place.
 */
export function stageOf(installer: EngineInstaller["kind"], line: string): SetupStage | null {
  if (installer === "npm") {
    const fetched = NPM_FETCH.exec(line)?.[1];
    if (!fetched) return null;
    return /\.tgz(?:$|\?)/.test(fetched) ? "fetch" : "resolve";
  }
  if (/\b(?:downloading|fetching)\b/i.test(line)) return "download";
  if (/\b(?:extracting|unpacking|unzipping|decompressing|pouring)\b/i.test(line)) return "unpack";
  if (/\b(?:linking|symlinking|setting up|installing (?:to|into)|moving app|successfully installed)\b/i.test(line)) return "link";
  return null;
}

/** How often a moving step is pushed to the screens at most: often enough to look live, not once per line. */
const PACE_MS = 300;

/** What a screen words differently: a change in it is pushed at once, the rest (output, bytes, counts) folds into the next push. */
const shapeOf = (p: EngineSetupProgress) =>
  [p.step, p.phase, p.installer, p.attempt, p.prefix, p.stage, p.stalled, p.mirror, p.url, p.terminal, p.method].join("|");

/**
 * Progress pushed at most once per `ms`: a new phase, installer or stage goes
 * out at once, and the moves within one are folded into the latest, sent when
 * the interval is up — so a chatty installer never floods the screens and a
 * quiet one is never held back.
 */
export function paced(send: (progress: EngineSetupProgress) => void, ms = PACE_MS): (progress: EngineSetupProgress) => void {
  let last = -Infinity;
  let shape = "";
  let pending: EngineSetupProgress | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    const next = pending;
    pending = null;
    last = Date.now();
    send(next);
  };
  return (progress) => {
    const next = shapeOf(progress);
    const changed = next !== shape;
    shape = next;
    pending = progress;
    const ended = progress.phase === "done" || progress.phase === "failed";
    if (changed || ended || Date.now() - last >= ms) return flush();
    timer ??= setTimeout(flush, ms - (Date.now() - last));
  };
}

export interface InstallDeps {
  engineId: string;
  installers: EngineInstaller[];
  host: SetupHost;
  /** Fresh detection, no cached "missing": is the CLI found now, and which version — or which file was found that does not run, and why in a kind. */
  detect(): Promise<{ ready: boolean; version?: string; path?: string; error?: string; kind?: EngineSetupFailure["kind"] }>;
  report(progress: EngineSetupProgress): void;
  signal: AbortSignal;
  timeoutMs?: number;
  /** A registry for npm, for this install only (`--registry`): the person's npm config is never changed. */
  registry?: string;
  /** Silence this long reads as stalled. */
  stallMs?: number;
  /** Runs one installer command; tests swap it for a fake. */
  exec?: typeof runCommand;
  /** How each installer runs; absent, the way `installerLaunch` says. Not asked for an archive, which `runArchive` unpacks. */
  resolve?: (installer: EngineInstaller, registry?: string) => ReturnType<typeof installerLaunch>;
  /** Unpacks an archive installer; tests swap it for a fake. Absent, `runArchive`. */
  unpack?: typeof runArchive;
  /** An unpacked file that was not found by the engine's own lookup becomes its `command`; absent, never. */
  adopt?(file: string): Promise<void>;
}

/** Ten minutes: enough for npm's cold cache on a slow line, short enough that a hang is seen today. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/**
 * Two minutes without a line or a byte: npm prints a line per fetch only once
 * it is in, and official scripts download their binary silently, so a big one
 * on a slow line is quiet that long. The screen says it is quiet well before.
 */
const STALL_MS = 120_000;
const SLOW_PING_MS = 3000;
/** A mirror of npmjs that is reachable where npmjs is slow or blocked, mainland China among them. */
export const NPM_MIRROR = "https://registry.npmmirror.com";
const NPMJS = /^https?:\/\/registry\.npmjs\.org\/?$/;
const MIRROR_KINDS: EngineSetupFailure["kind"][] = ["network", "registry", "timeout"];

/** Install with the first applicable installer that works, then confirm detection sees the CLI. */
export async function runInstall(deps: InstallDeps): Promise<EngineSetupProgress> {
  const step: EngineSetupStep = "install";
  // Offered once npmjs looks unreachable or slow; not when the person's npm uses another registry, nor on a run that already has one.
  let mirror: string | undefined;
  let mirrorFits = !deps.registry;
  const offerMirror = () => {
    if (mirrorFits) mirror = NPM_MIRROR;
  };
  const at = (progress: EngineSetupProgress) => {
    const shown = mirror && progress.phase !== "done" ? { ...progress, mirror } : progress;
    deps.report(shown);
    return shown;
  };
  const already = await deps.detect();
  if (already.ready) return at({ engineId: deps.engineId, step, phase: "done", ...(already.version ? { version: already.version } : {}) });
  // The registry means something to npm only, so a retry on one runs just the npm installers.
  const applicable = (await applicableInstallers(deps.installers, deps.host)).filter((installer) => !deps.registry || installer.kind === "npm");
  if (!applicable.length) return at({ engineId: deps.engineId, step, phase: "failed", failure: { kind: "unsupported", message: "no installer fits this machine" } });
  let failed: EngineSetupProgress | null = null;
  // Where the system npm's global folder is root-owned (distro Node, the macOS .pkg), Tomrade's own prefix takes the install; the locators look there too.
  const ownPrefix = deps.host.env.TOMRADE_NPM_PREFIX;
  const attempts: { installer: EngineInstaller; prefix?: string }[] = applicable.map((installer) => ({ installer }));
  for (let i = 0; i < attempts.length; i++) {
    if (deps.signal.aborted) break;
    const { installer, prefix } = attempts[i]!;
    const name = installer.kind;
    // The one before gave way: the screen says whether it failed or did not fit here.
    const previous: EngineSetupProgress["previous"] = failed?.installer && failed.failure ? { installer: failed.installer, kind: failed.failure.kind } : undefined;
    const tried: Pick<EngineSetupProgress, "installer" | "prefix" | "attempt" | "attempts" | "previous"> = { installer: name, ...(prefix ? { prefix } : {}), attempt: i + 1, attempts: attempts.length, ...(previous ? { previous } : {}) };
    const startedAt = Date.now();
    let output = "";
    let partial = "";
    let stalled = false;
    let stage: SetupStage | undefined;
    let packages = 0;
    let bytes: { received: number; size?: number } | undefined;
    let lastOutputAt: number | undefined;
    // The lines report after a completion too, so the next progress carries what the unpack said.
    const show = () => {
      at({
        engineId: deps.engineId, step, phase: "running", ...tried, startedAt,
        ...(stage ? { stage } : {}), ...(packages ? { packages } : {}), ...bytes, ...(lastOutputAt ? { lastOutputAt } : {}),
        ...(output ? { output: tail(output) } : {}), ...(stalled ? { stalled } : {})
      });
    };
    const npm = installer.kind === "npm";
    let silence: ReturnType<typeof setTimeout> | undefined;
    const listen = () => {
      clearTimeout(silence);
      silence = setTimeout(() => {
        stalled = true;
        if (npm) offerMirror();
        show();
      }, deps.stallMs ?? STALL_MS);
    };
    const heard = () => {
      lastOutputAt = Date.now();
      stalled = false;
      listen();
    };
    // Output kept, and each finished line read for the stage it names.
    const take = (text: string) => {
      output = (output + text).slice(-OUTPUT_KEEP);
      const lines = (partial + text).split(/\r\n|\r|\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const named = stageOf(name, line);
        if (named) stage = named;
        if (named === "fetch") packages++;
      }
      heard();
      show();
    };
    show();
    listen();
    if (installer.kind === "archive") {
      // No command and no PATH: the zip is downloaded and unpacked where the engine's own lookup finds it.
      const unpacked = await (deps.unpack ?? runArchive)(installer, {
        engineId: deps.engineId,
        host: deps.host,
        signal: deps.signal,
        say: (line) => take(`${line}\n`),
        received: (received, size) => {
          stage = "download";
          bytes = size ? { received, size } : { received };
          heard();
          show();
        },
        unpacking: () => {
          stage = "unpack";
          show();
        }
      });
      clearTimeout(silence);
      if ("failure" in unpacked) {
        failed = { engineId: deps.engineId, step, phase: "failed", ...tried, failure: unpacked.failure, ...(output ? { output: tail(output) } : {}) };
        if (unpacked.failure.kind === "cancelled") break;
        continue;
      }
      at({ engineId: deps.engineId, step, phase: "checking", ...tried, ...(output ? { output: tail(output) } : {}) });
      const unpackedFound = await deps.detect();
      const atUnpacked = { engineId: deps.engineId, step, ...tried, ...(output ? { output: tail(output) } : {}) };
      if (unpackedFound.ready) return at({ ...atUnpacked, phase: "done", ...(unpackedFound.version ? { version: unpackedFound.version } : {}) });
      // The engine may have been given the unpacked path as its command: write it there, once, so the next look starts from it.
      if (unpackedFound.path) {
        unpacked.say(`It did not run yet — Settings → ${deps.engineId} → command is now ${unpackedFound.path}`);
        await deps.adopt?.(unpacked.file);
      }
      failed = {
        ...atUnpacked, phase: "failed",
        failure: { kind: unpackedFound.kind ?? "not-on-path", message: unpackedFound.error ?? `unpacked ${unpacked.file}, but the command is not on PATH`, ...(unpackedFound.path ? { path: unpackedFound.path } : {}) },
        ...(output ? { output: tail(output) } : {})
      };
      continue;
    }
    const resolved = await (deps.resolve ?? ((it, registry) => installerLaunch(it, deps.host, registry, prefix)))(installer, deps.registry);
    if ("failure" in resolved) {
      clearTimeout(silence);
      failed = { engineId: deps.engineId, step, phase: "failed", ...tried, failure: resolved.failure };
      continue;
    }
    const ping = new AbortController();
    if (npm && mirrorFits && deps.host.pingRegistry) {
      void deps.host.pingRegistry(resolved.launch, ping.signal).then((answer) => {
        if (ping.signal.aborted) return;
        if (answer.registry && !NPMJS.test(answer.registry)) mirrorFits = false;
        else if (answer.ms === null || answer.ms > SLOW_PING_MS) {
          offerMirror();
          show();
        }
      }, () => {});
    }
    const result = await (deps.exec ?? runCommand)(resolved.launch, resolved.args, {
      signal: deps.signal,
      timeoutMs: deps.timeoutMs ?? INSTALL_TIMEOUT_MS,
      env: deps.host.env,
      onOutput: take
    });
    clearTimeout(silence);
    ping.abort();
    if (result.code !== 0) {
      const failure = classifyFailure(result);
      if (npm && MIRROR_KINDS.includes(failure.kind)) offerMirror();
      failed = { engineId: deps.engineId, step, phase: "failed", ...tried, failure, output: tail(result.output) };
      if (failure.kind === "cancelled") break;
      if (npm && failure.kind === "permission" && ownPrefix && !prefix) attempts.splice(i + 1, 0, { installer, prefix: ownPrefix });
      continue;
    }
    at({ engineId: deps.engineId, step, phase: "checking", ...tried });
    const found = await deps.detect();
    if (found.ready) return at({ engineId: deps.engineId, step, phase: "done", ...tried, ...(found.version ? { version: found.version } : {}) });
    // The installer said done, but a fresh look does not find a working CLI: say that, not "missing".
    failed = {
      engineId: deps.engineId, step, phase: "failed", ...tried,
      failure: { kind: found.kind ?? "not-on-path", message: found.error ?? "installed, but the command is not on PATH", ...(found.path ? { path: found.path } : {}) },
      output: tail(result.output)
    };
  }
  return at(failed ?? { engineId: deps.engineId, step, phase: "failed", failure: { kind: "cancelled", message: "cancelled" } });
}

export interface SignInDeps {
  engineId: string;
  /** Starts the engine's own sign-in command; null when signing in takes its terminal session. */
  start: (() => { result: Promise<SetupRunResult>; onOutput(take: (text: string) => void): void }) | null;
  /** The engine's signed-in probe, fresh. */
  probe(): Promise<boolean>;
  report(progress: EngineSetupProgress): void;
  signal: AbortSignal;
  pollMs?: number;
  timeoutMs?: number;
}

/** A sign-in finishes in a browser or terminal at the person's pace; past this it has gone stale. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

const URL_IN_OUTPUT = /https:\/\/[^\s"'<>\])]+/;
/** What a CLI says when it has no such subcommand: an older version than the one that signs in by itself. */
const NO_SUCH_COMMAND = /unknown (?:sub)?command|unrecognized (?:sub)?command|no such (?:sub)?command|^\s*usage:/im;

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

/**
 * Sign in as automatically as the engine allows: run its login command and
 * catch the browser address from its output, or leave the typing to a terminal —
 * also when the CLI turns out too old for that command. Either way the
 * engine's own probe turning true is what finishes the step.
 */
export async function runSignIn(deps: SignInDeps): Promise<EngineSetupProgress> {
  const step: EngineSetupStep = "sign-in";
  const at = (progress: EngineSetupProgress) => (deps.report(progress), progress);
  // What the person already has is reused: signed in means nothing to do.
  if (await deps.probe()) return at({ engineId: deps.engineId, step, phase: "done" });
  const startedAt = Date.now();
  const deadline = startedAt + (deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
  const pollMs = deps.pollMs ?? 3000;
  let url: string | undefined;
  // In a box: assigned from the command's own promise, which flow analysis cannot see.
  const ended: { result: SetupRunResult | null } = { result: null };
  const run = deps.start?.();
  if (run) {
    let phase: EngineSetupProgress["phase"] = "running";
    let output = "";
    // What the login command prints shows too, so the screen has its latest line while the person signs in.
    const show = () => at({ engineId: deps.engineId, step, phase, startedAt, ...(url ? { url } : {}), ...(output ? { output: tail(output) } : {}) });
    at({ engineId: deps.engineId, step, phase, startedAt });
    run.onOutput((text) => {
      output = (output + text).slice(-OUTPUT_KEEP);
      const seen = URL_IN_OUTPUT.exec(text)?.[0];
      if (seen && !url) {
        url = seen;
        phase = "waiting";
      }
      show();
    });
    void run.result.then((result) => { ended.result = result; });
  } else {
    at({ engineId: deps.engineId, step, phase: "waiting", terminal: true, startedAt });
  }
  for (;;) {
    if (await deps.probe()) return at({ engineId: deps.engineId, step, phase: "done", ...(url ? { url } : {}) });
    if (deps.signal.aborted) return at({ engineId: deps.engineId, step, phase: "failed", failure: { kind: "cancelled", message: "cancelled" } });
    // Its login command failing is the answer; exiting 0 only means the command is done, the probe decides.
    const over = ended.result;
    if (over && over.code !== 0 && !(await deps.probe())) {
      if (url || !NO_SUCH_COMMAND.test(over.output)) {
        return at({ engineId: deps.engineId, step, phase: "failed", failure: classifyFailure(over), output: tail(over.output), ...(url ? { url } : {}) });
      }
      ended.result = null;
      at({ engineId: deps.engineId, step, phase: "waiting", terminal: true, startedAt });
    }
    if (Date.now() > deadline) return at({ engineId: deps.engineId, step, phase: "failed", failure: { kind: "timeout", message: "sign-in was not finished in time" }, ...(url ? { url } : {}) });
    await wait(pollMs, deps.signal);
  }
}
