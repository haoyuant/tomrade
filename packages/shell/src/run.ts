import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_TIMEOUT_S = 120;
const HEAD_CAP = 4000;
const TAIL_CAP = 12000;
const KILL_GRACE_MS = 2000;

/** The bash this machine has; on Windows only Git Bash counts, since WSL's bash.exe sees another filesystem. */
export function findBash(): string | null {
  const candidates =
    process.platform === "win32"
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]
          .filter((dir): dir is string => !!dir)
          .map((dir) => path.join(dir, "Git", "bin", "bash.exe"))
      : ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
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
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-child.pid, signal);
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
