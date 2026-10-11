import type { ChildProcess } from "node:child_process";
import readline from "node:readline";
import { spawnCli, stopCli, type CliLaunch, type CliLocator } from "./locate.js";

/**
 * Whether a CLI that is installed is also signed in. Only a clear "no" says
 * so: a version without the subcommand, a timeout or an answer that cannot be
 * read is taken as signed in, so the check never locks out an account it does
 * not understand (an API key in the environment, a cloud provider).
 */
export async function signedIn(cli: CliLocator, command: string | undefined, args: string[], says: (output: string) => boolean | null): Promise<boolean> {
  const { stdout, stderr } = await cli.run(command, args, 8000);
  return says(`${stdout}\n${stderr}`) ?? true;
}

/** `claude auth status` prints JSON with `loggedIn`; a first-party account that is not logged in cannot run. */
export function claudeSignedIn(output: string): boolean | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const status = JSON.parse(output.slice(start, end + 1)) as { loggedIn?: unknown; apiProvider?: unknown };
    if (status.loggedIn !== false) return true;
    return status.apiProvider === undefined || status.apiProvider === "firstParty" ? false : null;
  } catch {
    return null;
  }
}

export interface CliRun {
  child: ChildProcess;
  /** Resolves when the process exits; each stdout line is handed to onLine as parsed JSON. */
  done: Promise<{ code: number | null; stderr: string }>;
}

/** Spawn a JSONL-speaking CLI: stdin closed, stdout parsed by line, SIGINT then SIGKILL on abort. */
export function runJsonl(launch: CliLaunch, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; signal: AbortSignal; onLine(event: Record<string, unknown>): void }): CliRun {
  const child = spawnCli(launch, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (opts.stdin !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(opts.stdin); }
  let stderr = "";
  // A CLI that cannot start still closes; its reason belongs with the exit code.
  child.on("error", (error) => {
    stderr = `${stderr}\n${error.message}`.slice(-4000);
  });
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
    // Windows has no SIGINT to ask nicely with; kill() there ends only the top process, not the CLI's own children.
    if (process.platform === "win32") stopCli(child);
    else child.kill("SIGINT");
    setTimeout(() => stopCli(child, "SIGKILL"), 3000).unref();
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
