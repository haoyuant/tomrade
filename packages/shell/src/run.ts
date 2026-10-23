import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_TIMEOUT_S = 120;
const HEAD_CAP = 4000;
const TAIL_CAP = 12000;
const KILL_GRACE_MS = 2000;

/**
 * The bash this machine has: a usual install place, else PATH. On Windows only Git Bash counts — found
 * beside a git on PATH (Scoop, another drive) or as bash.exe on PATH — never WSL's launcher, which sees another filesystem.
 */
export function findBash(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync
): string | null {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  // Windows env names are case-insensitive ("Path"), while a plain object here is not.
  const get = (name: string) => (win ? Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] : env[name]);
  const dirs = (get("PATH") ?? "").split(win ? ";" : ":").filter(Boolean);
  if (!win) return ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", ...dirs.map((d) => p.join(d, "bash"))].find(exists) ?? null;
  const fixed = [get("ProgramFiles"), get("ProgramFiles(x86)"), get("LOCALAPPDATA") && p.join(get("LOCALAPPDATA")!, "Programs")]
    .filter((dir): dir is string => !!dir)
    .map((dir) => p.join(dir, "Git", "bin", "bash.exe"));
  const scoop = get("SCOOP") ?? (get("USERPROFILE") && p.join(get("USERPROFILE")!, "scoop"));
  if (scoop) fixed.push(p.join(scoop, "apps", "git", "current", "bin", "bash.exe"));
  // git.exe sits in Git\cmd or Git\mingw64\bin; bash.exe in Git\bin.
  const besideGit = dirs.filter((d) => exists(p.join(d, "git.exe"))).flatMap((d) => [p.join(d, "..", "bin", "bash.exe"), p.join(d, "..", "..", "bin", "bash.exe")]);
  const wsl = (file: string) => /\\(system32|windowsapps)\\bash\.exe$/i.test(file);
  const onPath = dirs.map((d) => p.join(d, "bash.exe")).filter((f) => !wsl(f));
  return [...fixed, ...besideGit, ...onPath].find(exists) ?? null;
}

// CSI and OSC sequences: colors, cursor moves, hyperlinks.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Terminal output as text: escapes stripped, and a line redrawn with \r (progress bars) kept at its last state. */
export function plain(text: string): string {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1)!)
    .join("\n");
}

/** The start and the end of a long output; the end is where errors land, so it gets the larger share. */
export class OutputBuffer {
  private head = "";
  private tail = "";
  total = 0;

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < HEAD_CAP) {
      const room = HEAD_CAP - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk) this.tail = (this.tail + chunk).slice(-TAIL_CAP);
  }

  text(): string {
    const omitted = this.total - this.head.length - this.tail.length;
    return omitted > 0 ? `${this.head}\n… (${omitted} characters omitted) …\n${this.tail}` : this.head + this.tail;
  }
}

/**
 * PowerShell that stops what a dead process left behind on Windows: taskkill /T cannot walk from a root that
 * already exited, but its children still name it as their parent. Only processes born after it started count,
 * so a recycled pid's own children are spared; the root's pid itself is never touched, since it may be reused.
 */
export function orphanSweep(rootPid: number, startedAtMs: number): string {
  return [
    "$all = @(Get-CimInstance Win32_Process)",
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(startedAtMs) - 1000}).UtcDateTime`,
    `$tree = [System.Collections.Generic.List[uint32]]::new(); $tree.Add(${rootPid})`,
    "for ($i = 0; $i -lt $tree.Count; $i++) { foreach ($p in $all) { if ($p.ParentProcessId -eq $tree[$i] -and $p.CreationDate.ToUniversalTime() -ge $since -and -not $tree.Contains($p.ProcessId)) { $tree.Add($p.ProcessId) } } }",
    "$tree | Select-Object -Skip 1 | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
  ].join("\n");
}

export interface ShellResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ShellRun {
  bash: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutS?: number;
  signal?: AbortSignal;
}

/**
 * One command in its own process group, so a timeout or a cancelled run takes
 * everything it started with it — and so does finishing: whatever it left
 * running in the background is stopped, since nothing would ever watch it.
 */
export function runShell(command: string, run: ShellRun): Promise<ShellResult> {
  const timeoutS = run.timeoutS ?? DEFAULT_TIMEOUT_S;
  return new Promise((resolve, reject) => {
    if (run.signal?.aborted) return resolve({ exitCode: null, output: "", timedOut: false, cancelled: true });
    const out = new OutputBuffer();
    const decoder = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const startedAt = Date.now();
    const child = spawn(run.bash, ["-c", command], {
      cwd: run.cwd,
      env: { ...process.env, ...run.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", TERM: "dumb", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        // Once bash has exited its pid may belong to someone else; what it left behind is the sweep's.
        if (process.platform === "win32") {
          if (child.exitCode === null && child.signalCode === null) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    const stop = () => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutS * 1000);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    run.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (b: Buffer) => out.push(decoder.stdout.decode(b, { stream: true })));
    child.stderr!.on("data", (b: Buffer) => out.push(decoder.stderr.decode(b, { stream: true })));
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
      kill("SIGKILL");
      if (process.platform === "win32" && child.pid !== undefined)
        spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", orphanSweep(child.pid, startedAt)], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
      child.stdout!.destroy();
      child.stderr!.destroy();
      resolve({ exitCode, output: plain(out.text()), timedOut, cancelled });
    };
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    // "close" waits for every holder of the pipes, which a backgrounded child can keep open forever.
    child.on("exit", (code) => setTimeout(() => finish(code), 100));
    child.on("close", (code) => finish(code));
  });
}

/** What the model reads back. */
export function describeResult(result: ShellResult, timeoutS = DEFAULT_TIMEOUT_S): string {
  const status = result.cancelled
    ? "cancelled — the run was stopped"
    : result.timedOut
      ? `timed out after ${timeoutS} s and was stopped`
      : `exit ${result.exitCode ?? "?"}`;
  const body = result.output.trim();
  return body ? `${status}\n${body}` : `${status} (no output)`;
}
