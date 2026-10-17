import { execFile } from "node:child_process";
import os from "node:os";

/**
 * An app opened from Finder or the Dock gets launchd's environment, whose PATH
 * is /usr/bin:/bin:/usr/sbin:/sbin — so `claude`, `codex`, `gh` and `npx`,
 * installed by Homebrew, npm or their own installers, are not found, and
 * nothing the person exports in their shell (proxies, keys) arrives either.
 * The fix every Electron editor uses: ask the login shell once, at startup.
 */
type Env = Record<string, string | undefined>;

const MARK = "__TOMRADE_SHELL_ENV__";
// The shell session's own, and switches that would change how Electron starts its children.
const SKIP = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
const skipped = (key: string) => SKIP.has(key) || key.startsWith("ELECTRON_");

/** The shell's environment, or what went wrong reading it. */
export type ShellEnvRead = { env: Env } | { env: null; problem: string };

export function readShellEnv(shell: string, env: Env, timeoutMs = 10_000): Promise<ShellEnvRead> {
  // -i -l: Homebrew's shellenv usually sits in the login profile, nvm and ~/.local/bin in the rc file.
  const script = `printf '%s' '${MARK}'; command env -0; printf '%s' '${MARK}'`;
  return new Promise((resolve) => {
    // An interactive zsh or bash ignores SIGTERM: an rc file waiting for input would outlast the timeout forever.
    execFile(shell, ["-ilc", script], { env: env as NodeJS.ProcessEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const problem = err.killed ? `did not answer within ${timeoutMs / 1000} s` : typeof err.code === "number" ? `exited with code ${err.code}` : `could not run (${err.code ?? err.message})`;
        return resolve({ env: null, problem });
      }
      const body = stdout.split(MARK)[1];
      if (body === undefined) return resolve({ env: null, problem: "printed no environment" });
      const out: Env = {};
      for (const entry of body.split("\0")) {
        const eq = entry.indexOf("=");
        if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      resolve({ env: out });
    });
  });
}

export function mergeShellEnv(current: Env, shell: Env): Env {
  const merged: Env = { ...current };
  for (const [key, value] of Object.entries(shell)) if (!skipped(key)) merged[key] = value;
  const dirs = [...(shell.PATH ?? "").split(":"), ...(current.PATH ?? "").split(":")].filter(Boolean);
  merged.PATH = [...new Set(dirs)].join(":");
  return merged;
}

/**
 * Started from a terminal, the app already has the person's environment.
 * Resolves to what went wrong, for the log once there is one.
 */
export async function adoptShellEnv(): Promise<string | null> {
  if (process.platform === "win32" || process.env.TERM) return null;
  const shell = process.env.SHELL || os.userInfo().shell || "/bin/sh";
  const read = await readShellEnv(shell, process.env);
  if (!read.env) return `the login shell ${shell} ${read.problem}: what its startup files export is missing, and commands they put on PATH (claude, codex, gh…) may not be found`;
  const merged = mergeShellEnv(process.env, read.env);
  for (const [key, value] of Object.entries(merged)) if (value !== undefined) process.env[key] = value;
  return null;
}
