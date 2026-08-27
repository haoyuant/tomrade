import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitMissingError extends Error {
  constructor(public readonly binary: string) {
    super(`git not found (looked for "${binary}"). Set the git binary in Settings, or install the command line tools.`);
    this.name = "GitMissingError";
  }
}

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly stderr: string
  ) {
    // A token reaches us inside a remote URL — in git's own output AND in the
    // arguments we passed it. Both must be scrubbed before this reaches a log,
    // a toast or a status line.
    const scrub = (text: string) => text.replace(/\/\/[^@\s/]*@/g, "//");
    super(`git ${scrub(args.join(" "))} failed: ${scrub(stderr).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
    this.name = "GitError";
  }
}

/**
 * A GUI-launched Electron app has a minimal PATH and no terminal: git must never
 * be allowed to sit waiting for a password, or a flush hangs for ever.
 */
const ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GCM_INTERACTIVE: "never"
};

export interface Git {
  (args: string[], opts?: { cwd?: string; ok?: boolean }): Promise<{ stdout: string; code: number }>;
}

export function gitRunner(binary: string, defaultCwd?: string): Git {
  return async (args, opts = {}) => {
    try {
      const { stdout } = await exec(binary, args, { cwd: opts.cwd ?? defaultCwd, env: { ...process.env, ...ENV }, maxBuffer: 16 * 1024 * 1024 });
      return { stdout: stdout.toString(), code: 0 };
    } catch (error) {
      const e = error as { code?: number | string; stderr?: string | Buffer; stdout?: string | Buffer };
      if (e.code === "ENOENT") throw new GitMissingError(binary);
      // `ok` means a non-zero exit is an answer, not a failure — `diff --quiet`, say.
      if (opts.ok) return { stdout: String(e.stdout ?? ""), code: typeof e.code === "number" ? e.code : 1 };
      throw new GitError(args, String(e.stderr ?? ""));
    }
  };
}

/** Never used to reach a remote — only to name a local clone directory. */
export const shortHash = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};
