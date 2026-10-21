import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The machine a probe or install runs on, replaceable so tests never spawn anything. */
export interface MachineHost {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Runs a command to its end, capturing its output; resolves even when it fails. */
  run(file: string, args: string[], timeoutMs: number): Promise<RunResult>;
  /** Whether this file exists and can be run. */
  executable(file: string): Promise<boolean>;
  /** Makes `dir` visible to every later spawn of this process. */
  adoptPath(dir: string): void;
  wait(ms: number): Promise<void>;
}

export interface RunResult {
  code: number | null;
  /** stdout and stderr interleaved, the last few thousand characters. */
  output: string;
  /** Set when it did not run at all: not found, or stopped. */
  error?: string;
}

export type GitInstallerKind = "xcode-select" | "winget";

export interface GitInstallProgress {
  phase: "running" | "waiting" | "done" | "failed";
  /** Failed: what kind of failure, so the screen can word it. */
  kind?: "exit" | "cancelled" | "timeout";
  /** The failure in the command's own words. */
  message?: string;
  /** The command's full output, for a details fold. */
  output?: string;
}

export interface GitStatus {
  state: "ready" | "missing" | "broken";
  version?: string;
  /** Broken: what the found git said. */
  error?: string;
  /** The binary that answered, or the broken one. */
  path?: string;
  /** The one-click way this platform offers; absent, the download page is the way. */
  installer?: GitInstallerKind;
  install?: GitInstallProgress;
}

const pathDirs = (env: MachineHost["env"]): string[] => (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);

const exeNames = (platform: NodeJS.Platform): string[] => (platform === "win32" ? ["git.exe", "git.cmd"] : ["git"]);

/** Folders installers put git in, looked at after PATH: a GUI-launched app's PATH misses them. */
function knownDirs(host: MachineHost): string[] {
  if (host.platform === "win32") {
    const bases = [host.env.ProgramFiles, host.env["ProgramFiles(x86)"], host.env.LOCALAPPDATA && path.join(host.env.LOCALAPPDATA, "Programs")];
    return bases.filter((base): base is string => !!base).map((base) => path.join(base, "Git", "cmd"));
  }
  if (host.platform === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin"];
  return ["/usr/local/bin"];
}

async function findGit(host: MachineHost): Promise<{ file: string; onPath: boolean } | null> {
  for (const { dirs, onPath } of [
    { dirs: pathDirs(host.env), onPath: true },
    { dirs: knownDirs(host), onPath: false }
  ]) {
    for (const dir of dirs) {
      for (const name of exeNames(host.platform)) {
        const file = path.join(dir, name);
        if (await host.executable(file)) return { file, onPath };
      }
    }
  }
  return null;
}

/** The one-click way to a git on this platform, when it has one. */
export async function installerFor(host: MachineHost): Promise<GitInstallerKind | undefined> {
  if (host.platform === "darwin") return "xcode-select";
  if (host.platform === "win32") {
    // winget lives in WindowsApps, which a GUI-launched app's PATH can miss.
    const dirs = [...pathDirs(host.env), host.env.LOCALAPPDATA && path.join(host.env.LOCALAPPDATA, "Microsoft", "WindowsApps")];
    for (const dir of dirs) {
      if (dir && (await host.executable(path.join(dir, "winget.exe")))) return "winget";
    }
  }
  return undefined;
}

export async function probeGit(host: MachineHost, binary = "git"): Promise<GitStatus> {
  const installer = await installerFor(host);
  const status = (s: Omit<GitStatus, "installer">): GitStatus => ({ ...s, ...(installer ? { installer } : {}) });
  // A configured binary is taken at its word; the default is looked for.
  const found = binary !== "git" ? { file: binary, onPath: true } : await findGit(host);
  if (!found) return status({ state: "missing" });
  // Apple's /usr/bin/git is a shim: run without the Command Line Tools it pops the
  // system's install dialog, so ask xcode-select first instead of ever running it blind.
  if (host.platform === "darwin" && found.file === "/usr/bin/git") {
    const clt = await host.run("/usr/bin/xcode-select", ["-p"], 10_000);
    if (clt.code !== 0) return status({ state: "missing" });
  }
  const version = await host.run(found.file, ["--version"], 15_000);
  if (version.code !== 0) {
    return status({ state: "broken", path: found.file, error: version.error ?? (lastLine(version.output) || `exit ${version.code}`) });
  }
  if (!found.onPath) host.adoptPath(path.dirname(found.file));
  return status({ state: "ready", path: found.file, version: /git version (\S+)/.exec(version.output)?.[1] ?? version.output.trim() });
}

const lastLine = (output: string): string => output.trim().split("\n").at(-1)?.trim() ?? "";

export interface GitInstallDeps {
  host: MachineHost;
  probe(): Promise<GitStatus>;
  report(progress: GitInstallProgress): void;
  signal: AbortSignal;
  /** How often the waiting loop looks again, and for how long at most. */
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Runs the platform's own git install and follows it to a found git: winget
 * installs and returns, while `xcode-select --install` only opens the system's
 * dialog, so that path waits and re-probes until git answers or time runs out.
 */
export async function runGitInstall(kind: GitInstallerKind, deps: GitInstallDeps): Promise<GitInstallProgress> {
  const { host, probe, signal } = deps;
  const report = (progress: GitInstallProgress): GitInstallProgress => {
    deps.report(progress);
    return progress;
  };
  report({ phase: "running" });
  if (kind === "winget") {
    const run = await host.run("winget", ["install", "--id", "Git.Git", "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"], deps.timeoutMs ?? 15 * 60_000);
    if (signal.aborted) return report({ phase: "failed", kind: "cancelled" });
    const now = await probe();
    if (now.state === "ready") return report({ phase: "done" });
    return report({ phase: "failed", kind: "exit", message: run.error ?? lastLine(run.output), output: run.output });
  }
  const run = await host.run("/usr/bin/xcode-select", ["--install"], 60_000);
  // "already installed" exits non-zero: look again rather than read tea leaves.
  if ((await probe()).state === "ready") return report({ phase: "done" });
  if (run.code !== 0) return report({ phase: "failed", kind: "exit", message: run.error ?? lastLine(run.output), output: run.output });
  const until = Date.now() + (deps.timeoutMs ?? 20 * 60_000);
  report({ phase: "waiting" });
  while (Date.now() < until) {
    if (signal.aborted) return report({ phase: "failed", kind: "cancelled" });
    await host.wait(deps.pollMs ?? 5_000);
    if ((await probe()).state === "ready") return report({ phase: "done" });
  }
  return report({ phase: "failed", kind: "timeout" });
}

const OUTPUT_KEEP = 4_000;

export function machineHost(): MachineHost {
  return {
    platform: process.platform,
    env: process.env,
    run: (file, args, timeoutMs) =>
      new Promise((resolve) => {
        let output = "";
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
        } catch (error) {
          return resolve({ code: null, output: "", error: error instanceof Error ? error.message : String(error) });
        }
        const take = (text: Buffer) => {
          output = (output + text.toString()).slice(-OUTPUT_KEEP);
        };
        child.stdout?.on("data", take);
        child.stderr?.on("data", take);
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        timer.unref();
        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({ code: null, output, error: error.message });
        });
        child.on("close", (code, sig) => {
          clearTimeout(timer);
          resolve({ code, output, ...(sig ? { error: `stopped by ${sig}` } : {}) });
        });
      }),
    executable: async (file) => {
      try {
        await fs.promises.access(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    adoptPath: (dir) => {
      const dirs = pathDirs(process.env);
      if (!dirs.includes(dir)) process.env.PATH = [dir, ...dirs].join(path.delimiter);
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}
