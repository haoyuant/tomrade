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
  }
});

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
export async function installerLaunch(installer: EngineInstaller, host: SetupHost): Promise<{ launch: CliLaunch; args: string[] } | { failure: EngineSetupFailure }> {
  if (installer.kind === "npm") {
    const npm = await host.npm();
    if (!npm) return { failure: { kind: "not-found", message: "npm was not found — install Node.js, or update Tomrade, which brings its own" } };
    return { launch: npm, args: ["install", "-g", installer.package] };
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
  const text = `${result.error?.code ?? ""} ${result.error?.message ?? ""} ${result.output}`;
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
  /** Fresh detection, no cached "missing": is the CLI found now, and which version. */
  detect(): Promise<{ ready: boolean; version?: string; error?: string }>;
  report(progress: EngineSetupProgress): void;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Runs one installer command; tests swap it for a fake. */
  exec?: typeof runCommand;
}

/** Ten minutes: enough for npm's cold cache on a slow line, short enough that a hang is seen today. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Install with the first applicable installer that works, then confirm detection sees the CLI. */
export async function runInstall(deps: InstallDeps): Promise<EngineSetupProgress> {
  const step: EngineSetupStep = "install";
  const at = (progress: EngineSetupProgress) => (deps.report(progress), progress);
  const already = await deps.detect();
  if (already.ready) return at({ engineId: deps.engineId, step, phase: "done", ...(already.version ? { version: already.version } : {}) });
  const applicable = await applicableInstallers(deps.installers, deps.host);
  if (!applicable.length) return at({ engineId: deps.engineId, step, phase: "failed", failure: { kind: "unsupported", message: "no installer fits this machine" } });
  let failed: EngineSetupProgress | null = null;
  for (const installer of applicable) {
    if (deps.signal.aborted) break;
    const name = installer.kind;
    at({ engineId: deps.engineId, step, phase: "running", installer: name });
    const resolved = await installerLaunch(installer, deps.host);
    if ("failure" in resolved) {
      failed = { engineId: deps.engineId, step, phase: "failed", installer: name, failure: resolved.failure };
      continue;
    }
    const result = await (deps.exec ?? runCommand)(resolved.launch, resolved.args, { signal: deps.signal, timeoutMs: deps.timeoutMs ?? INSTALL_TIMEOUT_MS, env: deps.host.env });
    if (result.code !== 0) {
      const failure = classifyFailure(result);
      failed = { engineId: deps.engineId, step, phase: "failed", installer: name, failure, output: tail(result.output) };
      if (failure.kind === "cancelled") break;
      continue;
    }
    at({ engineId: deps.engineId, step, phase: "checking", installer: name });
    const found = await deps.detect();
    if (found.ready) return at({ engineId: deps.engineId, step, phase: "done", installer: name, ...(found.version ? { version: found.version } : {}) });
    // The installer said done, but a fresh look does not find a working CLI: say that, not "missing".
    failed = {
      engineId: deps.engineId, step, phase: "failed", installer: name,
      failure: { kind: "not-on-path", message: found.error ?? "installed, but the command is not on PATH" },
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
