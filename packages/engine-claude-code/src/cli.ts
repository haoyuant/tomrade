import { execFile, spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export function binaryOk(command: string, args: string[] = ["--version"]): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000 }, (err, stdout) => {
      if (err) resolve({ ok: false, reason: `${command} not found or not responding — is it installed and on PATH?` });
      else resolve({ ok: true, reason: stdout.trim().slice(0, 60) });
    });
  });
}

export interface CliRun {
  child: ChildProcess;
  /** Resolves when the process exits; each stdout line is handed to onLine as parsed JSON. */
  done: Promise<{ code: number | null; stderr: string }>;
}

/** Spawn a JSONL-speaking CLI: stdin closed, stdout parsed by line, SIGINT then SIGKILL on abort. */
export function runJsonl(command: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; signal: AbortSignal; onLine(event: Record<string, unknown>): void }): CliRun {
  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (opts.stdin !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(opts.stdin); }
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    try {
      opts.onLine(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // partial or non-JSON noise between events
    }
  });
  const onAbort = () => {
    child.kill("SIGINT");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3000).unref();
  };
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ code, stderr });
    });
  });
  return { child, done };
}
