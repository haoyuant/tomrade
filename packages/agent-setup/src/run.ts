import type { EngineInstaller, EngineSetupFailure, EngineSetupProgress, EngineSetupStep } from "@tomradex/agent";
import { localCli, spawnCli, stopCli, type CliLaunch } from "@tomradex/engine-kit";

/**
 * Running one setup step the way the person would, but watched: an install in
 * the background with its output kept, a sign-in whose browser address is
 * caught and whose finish is noticed by the engine's own probe. No terminal
 * window, no admin rights; cancel stops the child.
 */

/** What the runner needs from the machine; tests swap it for a fake one. */
export interface SetupHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Whether this command answers `--version` from PATH — is Homebrew here, does the system npm run. */
  answers(command: string): Promise<boolean>;
  /** How `npm` runs on this machine: the first one that answers, the borrowed shims included (they sit last on PATH). */
  npm(): Promise<CliLaunch | null>;
  /** How fast npm's configured registry answers (`npm ping`); absent, no check runs. */
  pingRegistry?(npm: CliLaunch, signal: AbortSignal): Promise<RegistryPing>;
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

/** One command to its end, output kept, stopped by the signal or the timeout. */
export function runCommand(launch: CliLaunch, args: string[], opts: { signal: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv; onOutput?(text: string): void }): Promise<SetupRunResult> {
  return new Promise((resolve) => {
    const child = spawnCli(launch, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
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
    const stop = () => stopCli(child);
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
  env: process.env,
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
  for (const installer of installers) {
    if (installer.kind === "script" && (installer.shell === "powershell") !== (host.platform === "win32")) continue;
    if (installer.kind === "brew" && (host.platform !== "darwin" || !(await host.answers("brew")))) continue;
    kept.push(installer);
  }
  return kept;
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
  return { launch: bareLaunch("brew", host.env), args: ["install", ...(installer.cask ? ["--cask"] : []), installer.name] };
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

export interface InstallDeps {
  engineId: string;
  installers: EngineInstaller[];
  host: SetupHost;
  /** Fresh detection, no cached "missing": is the CLI found now, and which version — or which file was found that does not run. */
  detect(): Promise<{ ready: boolean; version?: string; path?: string; error?: string }>;
  report(progress: EngineSetupProgress): void;
  signal: AbortSignal;
  timeoutMs?: number;
  /** A registry for npm, for this install only (`--registry`): the person's npm config is never changed. */
  registry?: string;
  /** Silence this long reads as stalled. */
  stallMs?: number;
  /** Runs one installer command; tests swap it for a fake. */
  exec?: typeof runCommand;
}

/** Ten minutes: enough for npm's cold cache on a slow line, short enough that a hang is seen today. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** npm prints a line per fetch, so a minute without one is worth saying. */
const STALL_MS = 60_000;
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
    const tried = prefix ? { installer: name, prefix } : { installer: name };
    const startedAt = Date.now();
    let output = "";
    let stalled = false;
    let running = true;
    const show = () => {
      if (running) at({ engineId: deps.engineId, step, phase: "running", ...tried, startedAt, ...(output ? { output: tail(output) } : {}), ...(stalled ? { stalled } : {}) });
    };
    show();
    const resolved = await installerLaunch(installer, deps.host, deps.registry, prefix);
    if ("failure" in resolved) {
      failed = { engineId: deps.engineId, step, phase: "failed", ...tried, failure: resolved.failure };
      continue;
    }
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
    listen();
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
      onOutput: (text) => {
        output = (output + text).slice(-OUTPUT_KEEP);
        stalled = false;
        listen();
        show();
      }
    });
    running = false;
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
      failure: { kind: "not-on-path", message: found.error ?? "installed, but the command is not on PATH", ...(found.path ? { path: found.path } : {}) },
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

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

/**
 * Sign in as automatically as the engine allows: run its login command and
 * catch the browser address from its output, or leave the typing to a terminal —
 * either way the engine's own probe turning true is what finishes the step.
 */
export async function runSignIn(deps: SignInDeps): Promise<EngineSetupProgress> {
  const step: EngineSetupStep = "sign-in";
  const at = (progress: EngineSetupProgress) => (deps.report(progress), progress);
  // What the person already has is reused: signed in means nothing to do.
  if (await deps.probe()) return at({ engineId: deps.engineId, step, phase: "done" });
  const deadline = Date.now() + (deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
  const pollMs = deps.pollMs ?? 3000;
  let url: string | undefined;
  // In a box: assigned from the command's own promise, which flow analysis cannot see.
  const ended: { result: SetupRunResult | null } = { result: null };
  const run = deps.start?.();
  if (run) {
    at({ engineId: deps.engineId, step, phase: "running" });
    run.onOutput((text) => {
      const seen = URL_IN_OUTPUT.exec(text)?.[0];
      if (seen && !url) {
        url = seen;
        at({ engineId: deps.engineId, step, phase: "waiting", url });
      }
    });
    void run.result.then((result) => { ended.result = result; });
  } else {
    at({ engineId: deps.engineId, step, phase: "waiting", terminal: true });
  }
  for (;;) {
    if (await deps.probe()) return at({ engineId: deps.engineId, step, phase: "done", ...(url ? { url } : {}) });
    if (deps.signal.aborted) return at({ engineId: deps.engineId, step, phase: "failed", failure: { kind: "cancelled", message: "cancelled" } });
    // Its login command failing is the answer; exiting 0 only means the command is done, the probe decides.
    const over = ended.result;
    if (over && over.code !== 0 && !(await deps.probe())) {
      return at({ engineId: deps.engineId, step, phase: "failed", failure: classifyFailure(over), output: tail(over.output), ...(url ? { url } : {}) });
    }
    if (Date.now() > deadline) return at({ engineId: deps.engineId, step, phase: "failed", failure: { kind: "timeout", message: "sign-in was not finished in time" }, ...(url ? { url } : {}) });
    await wait(pollMs, deps.signal);
  }
}
